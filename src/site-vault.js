"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { registrableDomain, sanitizeSiteSlug } = require("./sites");
const { cleanUserPassOnly } = require("./cleaner");

const MAX_EXACT_DEDUP_BYTES = 256 * 1024 * 1024;

function vaultRoot(root) {
    return path.resolve(root || process.env.LOCAL_PROCESSED_ROOT || "/var/data/processed", "sites");
}

function chatDir(chatId, root) {
    const id = String(chatId || "0").replace(/[^\d-]/g, "") || "0";
    return path.join(vaultRoot(root), id);
}

function indexPath(chatId, root) {
    return path.join(chatDir(chatId, root), "index.json");
}

function readIndex(chatId, root) {
    try {
        const raw = fs.readFileSync(indexPath(chatId, root), "utf8");
        const data = JSON.parse(raw);
        if (data && typeof data === "object") {
            data.sites = data.sites && typeof data.sites === "object" ? data.sites : {};
            return data;
        }
    } catch {
        // missing or corrupt index starts empty
    }
    return { active: null, sites: {} };
}

function writeIndex(chatId, root, data) {
    const dir = chatDir(chatId, root);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, "index.json.tmp");
    fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
    fs.renameSync(tmp, indexPath(chatId, root));
}

/**
 * Turn user input into the site key the vault stores.
 * `https://login.htzone.co.il/x` and `htzone.co.il` both become `htzone.co.il`.
 * @param {string} raw
 * @returns {string|null}
 */
function normalizeSite(raw) {
    const text = String(raw || "").trim().toLowerCase();
    if (!text || text.length > 200) return null;
    const hostish = text
        .replace(/^https?:\/\//, "")
        .replace(/^www\d*\./, "")
        .split(/[/?#\s]/)[0]
        .replace(/:\d+$/, "");
    return registrableDomain(hostish) || registrableDomain(text) || null;
}

function siteFile(chatId, site, root) {
    const slug = sanitizeSiteSlug(site) || "site";
    return path.join(chatDir(chatId, root), `${slug}.txt`);
}

function setActive(chatId, site, root) {
    const key = normalizeSite(site);
    if (!key) return null;
    const data = readIndex(chatId, root);
    data.active = key;
    if (!data.sites[key]) {
        data.sites[key] = { lines: 0, bytes: 0, updatedAt: 0 };
    }
    writeIndex(chatId, root, data);
    return key;
}

function clearActive(chatId, root) {
    const data = readIndex(chatId, root);
    data.active = null;
    writeIndex(chatId, root, data);
}

function getActive(chatId, root) {
    return readIndex(chatId, root).active || null;
}

function listSites(chatId, root) {
    const data = readIndex(chatId, root);
    return Object.entries(data.sites)
        .map(([site, info]) => ({
            site,
            lines: Number(info.lines) || 0,
            bytes: Number(info.bytes) || 0,
            updatedAt: Number(info.updatedAt) || 0,
            file: siteFile(chatId, site, root),
            active: data.active === site,
        }))
        .sort((a, b) => b.lines - a.lines || b.bytes - a.bytes || a.site.localeCompare(b.site));
}

function largest(chatId, root) {
    const sites = listSites(chatId, root).filter((s) => s.lines > 0);
    return sites[0] || null;
}

function getSite(chatId, site, root) {
    const key = normalizeSite(site) || sanitizeSiteSlug(site);
    if (!key) return null;
    return listSites(chatId, root).find((s) => s.site === key) || null;
}

function lineBelongsToSite(line, site) {
    if (!line || !site) return false;
    return String(line).toLowerCase().includes(String(site).toLowerCase());
}

async function loadSeen(file) {
    const seen = new Set();
    if (!fs.existsSync(file)) return seen;
    const stat = fs.statSync(file);
    if (stat.size > MAX_EXACT_DEDUP_BYTES) {
        const err = new Error("SITE_VAULT_TOO_LARGE");
        err.size = stat.size;
        throw err;
    }
    const input = fs.createReadStream(file, { encoding: "utf8" });
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of rl) {
        if (line) seen.add(line);
    }
    return seen;
}

/**
 * Add cleaned lines to a site file. Existing lines are skipped.
 * @param {number|string} chatId
 * @param {string} site
 * @param {string[]} lines
 * @param {string} [root]
 * @returns {Promise<{ site: string, added: number, duplicates: number, size: number, file: string }>}
 */
async function appendLines(chatId, site, lines, root, options = {}) {
    const key = normalizeSite(site);
    if (!key) throw new Error("Not a website");
    const file = siteFile(chatId, key, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const seen = await loadSeen(file);
    const fresh = [];
    let duplicates = 0;
    const incoming = Array.isArray(lines) ? lines : [];
    // A pinned save already knows the site. Cleaned lines no longer contain it,
    // so requiring the domain here dropped every line of a real dump.
    const requireMention = !(options && options.pinned);
    for (let i = 0; i < incoming.length; i++) {
        const raw = incoming[i];
        const cleaned = cleanUserPassOnly(raw);
        if (!cleaned) continue;
        if (requireMention && !lineBelongsToSite(raw, key) && !lineBelongsToSite(cleaned, key)) continue;
        if (seen.has(cleaned)) {
            duplicates++;
            continue;
        }
        seen.add(cleaned);
        fresh.push(cleaned);
    }
    if (fresh.length) {
        fs.appendFileSync(file, `${fresh.join("\n")}\n`, "utf8");
    }
    const bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
    const data = readIndex(chatId, root);
    data.sites[key] = {
        lines: seen.size,
        bytes,
        updatedAt: Date.now(),
    };
    writeIndex(chatId, root, data);
    return { site: key, added: fresh.length, duplicates, size: seen.size, file, bytes };
}

function peekLines(file, limit = 12) {
    if (!file || !fs.existsSync(file)) return [];
    const fd = fs.openSync(file, "r");
    try {
        const buf = Buffer.alloc(64 * 1024);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        return buf
            .subarray(0, n)
            .toString("utf8")
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(0, limit);
    } finally {
        fs.closeSync(fd);
    }
}

module.exports = {
    vaultRoot,
    normalizeSite,
    setActive,
    clearActive,
    getActive,
    listSites,
    largest,
    getSite,
    appendLines,
    peekLines,
    lineBelongsToSite,
    siteFile,
};
