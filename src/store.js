"use strict";

/**
 * In-memory, per-chat store of cleaned credentials.
 *
 * Telegram cloud hosts restart the process occasionally, so this is intentionally
 * ephemeral: each chat accumulates cleaned lines until they /combine or /clear.
 * A global cap keeps memory bounded on free tiers.
 */

const DEFAULT_MAX_LINES = 10_000_000; // 10M default credentials per chat
function getMaxLinesPerChat() {
    if (process.env.MAX_LINES_PER_CHAT !== undefined) {
        const val = Number(process.env.MAX_LINES_PER_CHAT);
        if (Number.isFinite(val)) {
            return val <= 0 ? Infinity : Math.floor(val);
        }
    }
    return DEFAULT_MAX_LINES;
}

function getMaxChats() {
    if (process.env.MAX_CHATS !== undefined) {
        const val = Number(process.env.MAX_CHATS);
        if (Number.isFinite(val) && val > 0) return Math.floor(val);
    }
    return 500;
}

/** @type {Map<number, { lines: Set<string>, totalKept: number, files: number, updatedAt: number }>} */
const chats = new Map();

/**
 * @param {number} chatId
 */
function getChat(chatId) {
    let chat = chats.get(chatId);
    if (!chat) {
        chat = {
            lines: new Set(),
            totalKept: 0,
            files: 0,
            sites: new Map(),
            customName: null,
            customDomains: new Set(),
            ulpDays: 5,
            updatedAt: Date.now(),
        };
        chats.set(chatId, chat);
        evictIfNeeded();
    }
    return chat;
}

function evictIfNeeded() {
    const maxChats = getMaxChats();
    if (chats.size <= maxChats) return;
    // Drop the least-recently-updated chats.
    const entries = [...chats.entries()].sort(
        (a, b) => a[1].updatedAt - b[1].updatedAt,
    );
    const toRemove = chats.size - maxChats;
    for (let i = 0; i < toRemove; i += 1) {
        chats.delete(entries[i][0]);
    }
}

/**
 * Add cleaned lines to a chat. Deduplicates against everything already stored.
 *
 * @param {number} chatId
 * @param {string[]} lines
 * @param {string} [site] detected site slug this batch of lines belongs to
 * @param {{ countFile?: boolean }} [options]
 * @returns {{ added: number, duplicates: number, capped: boolean, size: number }}
 */
function addLines(chatId, lines, site, options = {}) {
    const chat = getChat(chatId);
    let added = 0;
    let duplicates = 0;
    let capped = false;
    const maxLines = getMaxLinesPerChat();

    for (const line of lines) {
        if (chat.lines.size >= maxLines) {
            capped = true;
            break;
        }
        if (chat.lines.has(line)) {
            duplicates += 1;
        } else {
            chat.lines.add(line);
            added += 1;
        }
    }

    chat.totalKept += added;
    if (options.countFile === true || (options.countFile !== false && lines.length > 0 && !options.isTextResponse)) {
        chat.files += 1;
    }
    if (site && added > 0) {
        // Track *lines* per site (not files) for the /sites breakdown.
        chat.sites.set(site, (chat.sites.get(site) || 0) + added);
    }
    chat.updatedAt = Date.now();

    return { added, duplicates, capped, size: chat.lines.size };
}

/**
 * @param {number} chatId
 * @returns {{ size: number, files: number, totalKept: number }|null}
 */
function getStats(chatId) {
    const chat = chats.get(chatId);
    if (!chat) return null;
    return {
        size: chat.lines.size,
        files: chat.files,
        totalKept: chat.totalKept,
        sites: getSites(chatId).length,
    };
}

/**
 * Get the distinct site slugs stored for a chat, in insertion order.
 * Variants of the same site ("netflix.com" vs "netflix" from differently
 * named files) collapse into one, keeping the longest slug of the group.
 * @param {number} chatId
 * @returns {string[]}
 */
function getSites(chatId) {
    const chat = chats.get(chatId);
    if (!chat) return [];
    const groups = new Map(); // first label -> longest slug
    for (const slug of chat.sites.keys()) {
        const key = String(slug).split(".")[0].toLowerCase();
        const existing = groups.get(key);
        if (!existing || slug.length > existing.length) {
            groups.set(key, slug);
        }
    }
    return [...groups.values()];
}

/**
 * Per-site line counts for a chat, biggest first. Variants of the same site
 * ("netflix.com" vs "netflix") collapse together, summing their counts.
 * @param {number} chatId
 * @returns {Array<{ site: string, count: number }>}
 */
function getSiteCounts(chatId) {
    const chat = chats.get(chatId);
    if (!chat || chat.sites.size === 0) return [];
    // Collapse slug variants by first label, keep longest slug per group.
    const groups = new Map(); // key -> { site, count }
    for (const [slug, count] of chat.sites) {
        const key = String(slug).split(".")[0].toLowerCase();
        const g = groups.get(key);
        if (!g) {
            groups.set(key, { site: slug, count });
        } else {
            g.count += count;
            if (slug.length > g.site.length) g.site = slug;
        }
    }
    return [...groups.values()].sort((a, b) => b.count - a.count);
}

/**
 * Direct access to the raw chat object (for customName overrides).
 * @param {number} chatId
 */
function getRawChat(chatId) {
    return chats.get(chatId) || null;
}

/**
 * Search a chat's stored lines for a case-insensitive substring match.
 *
 * @param {number} chatId
 * @param {string} query
 * @param {number} [limit] max matches to return
 * @returns {{ total: number, matches: string[] }}
 */
function searchLines(chatId, query, limit = 20) {
    const chat = chats.get(chatId);
    const q = String(query || "").trim();
    if (!chat || !q) return { total: 0, matches: [] };
    const qLower = q.toLowerCase();
    const matches = [];
    let total = 0;
    for (const line of chat.lines) {
        if (typeof line === "string" && line.toLowerCase().includes(qLower)) {
            total += 1;
            if (matches.length < limit) matches.push(line);
        }
    }
    return { total, matches };
}

function getLines(chatId) {
    const chat = chats.get(chatId);
    if (!chat) return [];
    return [...chat.lines];
}

/**
 * Cleared a chat's store.
 * @param {number} chatId
 * @returns {boolean} true if there was something to clear
 */
function clear(chatId) {
    const existed = chats.has(chatId);
    chats.delete(chatId);
    return existed;
}

function clearAll() {
    chats.clear();
    lastCombinedCache.clear();
}

/**
 * Cache of the most recent combined file per chat (retained across store.clear).
 * Allows users to download their search output even if the active batch was automatically cleared.
 */
const lastCombinedCache = new Map(); // chatId -> { buffer, filename, linesCount, site, timestamp }

function setLastCombined(chatId, data) {
    if (!chatId || !data) return;
    lastCombinedCache.set(chatId, { ...data, timestamp: Date.now() });
    if (lastCombinedCache.size > 200) {
        const oldest = lastCombinedCache.keys().next().value;
        lastCombinedCache.delete(oldest);
    }
}

function getLastCombined(chatId, maxAgeMs = 30 * 60 * 1000) {
    const item = lastCombinedCache.get(chatId);
    if (!item) return null;
    if (Date.now() - item.timestamp > maxAgeMs) {
        lastCombinedCache.delete(chatId);
        return null;
    }
    return item;
}

function clearLastCombined(chatId) {
    if (chatId) return lastCombinedCache.delete(chatId);
    lastCombinedCache.clear();
    return true;
}

/**
 * Overview of global memory usage across all active chats and cache.
 */
function getMemoryStats() {
    let totalStoredLines = 0;
    for (const chat of chats.values()) {
        totalStoredLines += chat.lines.size;
    }
    return {
        activeChats: chats.size,
        maxChats: getMaxChats(),
        totalLines: totalStoredLines,
        maxLinesPerChat: getMaxLinesPerChat(),
        cachedCombinedFiles: lastCombinedCache.size,
    };
}

/**
 * Get saved custom ULP domains for a chat.
 * @param {number} chatId
 * @returns {string[]}
 */
function getCustomDomains(chatId) {
    if (!chatId) return [];
    const chat = getChat(chatId);
    return Array.from(chat.customDomains || []);
}

/**
 * Add a custom ULP domain to a chat's presets.
 * @param {number} chatId
 * @param {string} domain
 * @returns {boolean}
 */
function addCustomDomain(chatId, domain) {
    if (!chatId || !domain) return false;
    const clean = String(domain).toLowerCase().trim();
    if (!clean) return false;
    const chat = getChat(chatId);
    if (!chat.customDomains) chat.customDomains = new Set();
    if (chat.customDomains.size >= 30) return false;
    chat.customDomains.add(clean);
    chat.updatedAt = Date.now();
    return true;
}

/**
 * Remove a custom ULP domain from a chat's presets.
 * @param {number} chatId
 * @param {string} domain
 * @returns {boolean}
 */
function removeCustomDomain(chatId, domain) {
    if (!chatId || !domain) return false;
    const clean = String(domain).toLowerCase().trim();
    const chat = getChat(chatId);
    if (!chat.customDomains) return false;
    const deleted = chat.customDomains.delete(clean);
    chat.updatedAt = Date.now();
    return deleted;
}

/**
 * Clear all custom ULP domains for a chat.
 * @param {number} chatId
 * @returns {boolean}
 */
function clearCustomDomains(chatId) {
    if (!chatId) return false;
    const chat = getChat(chatId);
    if (chat.customDomains) {
        chat.customDomains.clear();
        chat.updatedAt = Date.now();
    }
    return true;
}

/**
 * Get active ULP search days for a chat.
 * @param {number} chatId
 * @returns {number}
 */
function getUlpDays(chatId) {
    if (!chatId) return 5;
    const chat = getChat(chatId);
    return chat.ulpDays || 5;
}

/**
 * Set active ULP search days for a chat.
 * @param {number} chatId
 * @param {number} days
 * @returns {number}
 */
function setUlpDays(chatId, days) {
    if (!chatId) return 5;
    const chat = getChat(chatId);
    const d = Math.max(1, Math.min(90, Number(days) || 5));
    chat.ulpDays = d;
    chat.updatedAt = Date.now();
    return d;
}

/**
 * Remove all lines containing a domain from a chat's batch, and update site counts.
 * @param {number} chatId
 * @param {string} domain
 * @returns {{ removed: number, remaining: number }}
 */
function removeDomain(chatId, domain) {
    const chat = chats.get(chatId);
    if (!chat) return { removed: 0, remaining: 0 };
    const target = String(domain || "").trim().toLowerCase();
    if (!target) return { removed: 0, remaining: chat.lines.size };

    let removed = 0;
    for (const line of chat.lines) {
        if (line.toLowerCase().includes(target)) {
            chat.lines.delete(line);
            removed++;
        }
    }

    // Clean matching site entries
    for (const [site] of chat.sites.entries()) {
        if (site.toLowerCase().includes(target) || target.includes(site.toLowerCase())) {
            chat.sites.delete(site);
        }
    }

    chat.totalKept = Math.max(0, chat.totalKept - removed);
    chat.updatedAt = Date.now();
    return { removed, remaining: chat.lines.size };
}

module.exports = {
    addLines,
    getStats,
    getLines,
    getSites,
    getSiteCounts,
    getRawChat,
    searchLines,
    clear,
    clearAll,
    removeDomain,
    setLastCombined,
    getLastCombined,
    clearLastCombined,
    getMemoryStats,
    getMaxLinesPerChat,
    getMaxChats,
    getCustomDomains,
    addCustomDomain,
    removeCustomDomain,
    clearCustomDomains,
    getUlpDays,
    setUlpDays,
    get MAX_LINES_PER_CHAT() {
        return getMaxLinesPerChat();
    },
};