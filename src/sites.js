"use strict";

/**
 * Website detection for cleaned combo dumps.
 *
 * Combolists are usually named after (or contain references to) the site the
 * credentials belong to, e.g. "netflix.com_dump.txt" or lines that start with
 * "https://site.com/...". We score candidate domains found in:
 *   - URLs (https://site.com/...)             -> strong signal (+3 each)
 *   - domains leading a line before a ':'/'|' -> medium signal (+2)
 *   - email domains (user@site.com)           -> weak signal (+1)
 *   - a domain in the file name               -> strong hint (+3)
 *   - a brand word in the file name           -> medium hint (+2)
 *
 * Freemail providers (gmail.com, yahoo.com, ...) are login *providers* in most
 * dumps, not the target site, so they are discounted to 25% and never returned
 * on their own.
 */

// Common freemail providers — rarely the site the dump is for.
const FREEMAIL = new Set([
    "gmail.com",
    "googlemail.com",
    "yahoo.com",
    "yahoo.co.uk",
    "hotmail.com",
    "hotmail.co.uk",
    "outlook.com",
    "outlook.sa",
    "live.com",
    "msn.com",
    "aol.com",
    "icloud.com",
    "me.com",
    "mail.com",
    "protonmail.com",
    "proton.me",
    "pm.me",
    "yandex.com",
    "yandex.ru",
    "ya.ru",
    "mail.ru",
    "bk.ru",
    "inbox.ru",
    "list.ru",
    "gmx.com",
    "gmx.net",
    "gmx.de",
    "web.de",
    "zoho.com",
    "qq.com",
    "163.com",
    "126.com",
    "sina.com",
    "fastmail.com",
    "tutanota.com",
]);

// Domains in URLs with an explicit scheme: https://site.com/... (strong signal).
const URL_DOMAIN_RE = /(?:https?|ftp):\/\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,})/gi;

// Email domains.
const EMAIL_DOMAIN_RE = /@((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,})/gi;

// Any domain-like token, used for parsing file names.
const DOMAIN_LIKE_RE = /(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}/gi;

// Domains leading a line, optionally followed by a separator (site.com:...).
const LINE_LEAD_DOMAIN_RE = /^\s*((?:[a-z0-9-]+\.)+[a-z]{2,})(?=\s*[:|])/gim;

// Junk words stripped from file names when looking for a brand/site token.
const NAME_JUNK_WORDS = new Set([
    "combo", "combos", "combolist", "combolists", "list", "lists", "dump",
    "dumps", "dumped", "pass", "passes", "password", "passwords", "user",
    "users", "usernames", "creds", "credentials", "valid", "checked",
    "unchecked", "mixed", "free", "premium", "accounts", "account", "acc",
    "db", "database", "leak", "leaked", "leaks", "new", "latest", "hq",
    "private", "fresh", "onlyfans", "data", "site", "sites", "txt", "log",
    "logs", "full", "final", "good", "hits", "hit",
    // TLD / URL tokens that aren't brands.
    "com", "net", "org", "co", "io", "me", "us", "uk", "www", "http", "https",
]);

// Weights for each signal.
const WEIGHT_URL = 3; // https://site.com/... in content
const WEIGHT_LINE_LEAD = 2; // site.com:user:pass line-leading domain
const WEIGHT_EMAIL = 1; // user@site.com email domain
const WEIGHT_NAME_DOMAIN = 3; // domain found in the file name
const WEIGHT_NAME_BRAND = 2; // brand word found in the file name

/**
 * Is this domain a common freemail provider?
 * @param {string} domain
 * @returns {boolean}
 */
function isFreemail(domain) {
    if (typeof domain !== "string") return false;
    const clean = domain.trim().toLowerCase().replace(/\.+$/, "").split(":")[0];
    return FREEMAIL.has(clean);
}

/**
 * Sanitize an arbitrary string into a filename-safe slug.
 * @param {string} raw
 * @returns {string}
 */
function sanitizeSiteSlug(raw) {
    return String(raw || "")
        .toLowerCase()
        .replace(/[^a-z0-9.-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .replace(/_{2,}/g, "_")
        .slice(0, 64);
}

/**
 * Try to extract a site hint from a source file name, e.g.
 * "netflix.com_dump.txt" -> "netflix.com" (domain preferred),
 * "spotify_combo.zip" -> "spotify" (brand word fallback).
 * @param {string} fileName
 * @returns {string|null}
 */
/**
 * Parse a source file name into a domain hint and a brand-word hint.
 * e.g. "netflix.com_dump.txt" -> { domain: "netflix.com", brand: "netflix" }
 *      "spotify_combo.zip"    -> { domain: null,         brand: "spotify" }
 * @param {string} fileName
 * @returns {{ domain: string|null, brand: string|null }}
 */
function parseFileName(fileName) {
    if (!fileName) return { domain: null, brand: null };
    const stripped = String(fileName)
        .replace(/\.(zip|txt|csv|tsv|log|lst|list|dat|json|xml|html?|md)$/i, "")
        .toLowerCase();

    // Domains: KEEP dots, replace other separators, then match domain tokens.
    // Matching against the stripped base (not the raw name) means the
    // extension can never leak in as a fake domain ("dump.zip").
    const domainBase = stripped.replace(/[_\-\s]+/g, " ");
    const domains = (domainBase.match(DOMAIN_LIKE_RE) || [])
        .map((d) => d.replace(/^www\./, "").replace(/^\.+|\.+$/g, ""))
        .filter((d) => d.includes(".") && !isFreemail(d) && d.length >= 4);
    const domain = domains.length
        ? domains.sort((a, b) => b.length - a.length)[0]
        : null;

    // Brand: split on every separator (dots included) and drop junk words.
    const words = stripped.replace(/[_\-.]+/g, " ").split(/\s+/).filter(Boolean);
    const brands = words.filter((w) => !NAME_JUNK_WORDS.has(w) && w.length >= 3);
    const brand = brands.length ? brands[0] : null;

    return { domain, brand };
}

/**
 * Site hint from a file name: domain preferred, brand word as fallback.
 * @param {string} fileName
 * @returns {string|null}
 */
function siteFromFileName(fileName) {
    const { domain, brand } = parseFileName(fileName);
    return domain || brand;
}

/**
 * Domain hint from a file name (strong signal), e.g.
 * "hulu.com_dumps.txt" -> "hulu.com".
 * @param {string} fileName
 * @returns {string|null}
 */
function domainFromFileName(fileName) {
    return parseFileName(fileName).domain;
}

/**
 * Score all candidate domains in a raw dump sample.
 * @param {string} rawText
 * @returns {{ best: string|null, counts: Map<string, number> }}
 */
function scoreDomains(rawText) {
    const counts = new Map();
    const text = typeof rawText === "string" ? rawText : String(rawText || "");

    const bump = (domain, weight) => {
        const d = domain.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
        if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(d)) return;
        if (d.length < 4) return;
        const prev = counts.get(d) || 0;
        counts.set(d, prev + (isFreemail(d) ? weight * 0.25 : weight));
    };

    // URL domains (strongest content signal).
    let m;
    URL_DOMAIN_RE.lastIndex = 0;
    while ((m = URL_DOMAIN_RE.exec(text)) !== null) bump(m[1], WEIGHT_URL);

    // Domains leading lines before a separator ("site.com:user:pass").
    LINE_LEAD_DOMAIN_RE.lastIndex = 0;
    while ((m = LINE_LEAD_DOMAIN_RE.exec(text)) !== null) bump(m[1], WEIGHT_LINE_LEAD);

    // Email domains (weak).
    EMAIL_DOMAIN_RE.lastIndex = 0;
    while ((m = EMAIL_DOMAIN_RE.exec(text)) !== null) bump(m[1], WEIGHT_EMAIL);

    let best = null;
    let bestScore = 0;
    for (const [domain, score] of counts) {
        if (score > bestScore) {
            best = domain;
            bestScore = score;
        }
    }
    return { best, bestScore, counts };
}

/**
 * Detect the website a dump belongs to.
 *
 * Signals (freemail domains are always discounted to 25%):
 *   content: URL in lines +3 each, line-leading domain +2, email domain +1
 *   name:    domain in file name +3, brand word in file name +2
 *
 * Content wins only when its best non-freemail domain scores at least as high
 * as the file-name hint. Freemail-only results (gmail.com, ...) are never
 * returned — that's the login provider, not the target site.
 *
 * @param {string} rawText raw (uncleaned) dump text sample
 * @param {string} [sourceName] source file / zip name, e.g. "netflix_dump.zip"
 * @returns {string|null} e.g. "netflix.com" or "spotify"
 */
function detectSite(rawText, sourceName) {
    const nameDomain = domainFromFileName(sourceName || "");
    const nameHint = nameDomain || siteFromFileName(sourceName || "");
    const nameScore = nameDomain ? WEIGHT_NAME_DOMAIN : nameHint ? WEIGHT_NAME_BRAND : 0;

    const { best, bestScore } = scoreDomains(String(rawText || "").slice(0, 512 * 1024));
    const contentBest = best && !isFreemail(best) ? best : null;

    if (contentBest && bestScore >= nameScore) return contentBest;
    if (nameHint) return nameHint;
    return contentBest;
}

module.exports = {
    detectSite,
    siteFromFileName,
    domainFromFileName,
    sanitizeSiteSlug,
    isFreemail,
};