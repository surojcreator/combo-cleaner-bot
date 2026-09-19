"use strict";

/**
 * In-memory, per-chat store of cleaned credentials.
 *
 * Telegram cloud hosts restart the process occasionally, so this is intentionally
 * ephemeral: each chat accumulates cleaned lines until they /combine or /clear.
 * A global cap keeps memory bounded on free tiers.
 */

const MAX_LINES_PER_CHAT = 2_000_000; // ~2M credentials per chat
const MAX_CHATS = 500; // max concurrent chats tracked

/** @type {Map<number, { lines: Set<string>, totalKept: number, files: number, updatedAt: number }>} */
const chats = new Map();

/**
 * @param {number} chatId
 */
function getChat(chatId) {
    let chat = chats.get(chatId);
    if (!chat) {
        chat = { lines: new Set(), totalKept: 0, files: 0, sites: new Map(), updatedAt: Date.now() };
        chats.set(chatId, chat);
        evictIfNeeded();
    }
    return chat;
}

function evictIfNeeded() {
    if (chats.size <= MAX_CHATS) return;
    // Drop the least-recently-updated chats.
    const entries = [...chats.entries()].sort(
        (a, b) => a[1].updatedAt - b[1].updatedAt,
    );
    const toRemove = chats.size - MAX_CHATS;
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
 * @returns {{ added: number, duplicates: number, capped: boolean, size: number }}
 */
function addLines(chatId, lines, site) {
    const chat = getChat(chatId);
    let added = 0;
    let duplicates = 0;
    let capped = false;

    for (const line of lines) {
        if (chat.lines.size >= MAX_LINES_PER_CHAT) {
            capped = true;
            break;
        }
        if (chat.lines.has(line)) {
            duplicates += 1;
            continue;
        }
        chat.lines.add(line);
        added += 1;
    }

    chat.totalKept += added;
    chat.files += 1;
    if (site) {
        chat.sites.set(site, (chat.sites.get(site) || 0) + 1);
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
 * Get all stored lines for a chat.
 * @param {number} chatId
 * @returns {string[]}
 */
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

module.exports = {
    addLines,
    getStats,
    getLines,
    getSites,
    clear,
    MAX_LINES_PER_CHAT,
};