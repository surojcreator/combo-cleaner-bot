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
// Two-label public suffixes that must not be collapsed (bbc.co.uk -> bbc.co.uk,
// not co.uk). Common combo-dump ccTLDs only — not a full PSL.
const MULTI_SUFFIXES = new Set([
    "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk",
    "com.au", "net.au", "org.au", "edu.au", "gov.au", "asn.au",
    "co.il", "org.il", "ac.il", "net.il", "gov.il", "muni.il",
    "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz",
    "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
    "com.br", "net.br", "org.br", "gov.br",
    "com.mx", "gob.mx", "org.mx", "net.mx",
    "com.tr", "org.tr", "net.tr", "gov.tr",
    "com.ar", "com.ua", "com.tw", "com.sg", "com.hk",
    "co.in", "net.in", "org.in", "gen.in",
    "com.cn", "net.cn", "org.cn", "gov.cn",
    "com.eg", "com.sa", "com.pk", "com.ng", "com.ph", "com.vn",
    "com.my", "com.co", "com.pe", "co.za", "org.za", "co.kr", "ne.kr",
    "com.es", "org.es", "nom.es", "co.id", "go.id", "or.id",
]);

const IPV4_HOST_RE =
    /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

// Hosts that show up in dumps as delivery or login infrastructure, not the
// website the credentials belong to.
const INFRA_HOSTS = new Set([
    "cloudfront.net", "amazonaws.com", "googleusercontent.com", "gstatic.com",
    "googleapis.com", "akamaihd.net", "akamai.net", "cloudflare.com",
    "cloudflareinsights.com", "fastly.net", "azureedge.net", "msecnd.net",
    "doubleclick.net", "googlesyndication.com", "google-analytics.com",
    "facebook.net", "fbcdn.net", "twimg.com", "ytimg.com", "ggpht.com",
    "microsoftonline.com", "live.com", "microsoft.com", "windows.net",
    "google.com", "googleapis.com", "gstatic.com", "apple.com", "icloud.com",
]);

const ANDROID_SITES = {
    youtube: "youtube.com",
    spotify: "spotify.com",
    netflix: "netflix.com",
    instagram: "instagram.com",
    facebook: "facebook.com",
    whatsapp: "whatsapp.com",
    tiktok: "tiktok.com",
    paypal: "paypal.com",
    amazon: "amazon.com",
    discord: "discord.com",
    twitter: "twitter.com",
    snapchat: "snapchat.com",
};

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
    "aim.com",
    "aol.co.uk",
    "aol.de",
    "aol.fr",
    "aol.jp",
    "aol.it",
    "aol.es",
    "aol.ca",
    "love.com",
    "games.com",
    "wow.com",
    "verizon.net",
    "netscape.net",
    "netscape.com",
    "wmconnect.com",
    "cs.com",
    "compuserve.com",
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
    "yahoo.fr",
    "yahoo.de",
    "yahoo.es",
    "yahoo.it",
    "yahoo.ca",
    "yahoo.com.br",
    "yahoo.co.in",
    "ymail.com",
    "rocketmail.com",
    "att.net",
    "sbcglobal.net",
    "bellsouth.net",
    "comcast.net",
    "cox.net",
    "charter.net",
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
    const clean = domain.trim().toLowerCase().replace(/\.+$/, "").split(":")[0].replace(/^www\d*\./, "");
    if (FREEMAIL.has(clean)) return true;
    // mail.google.com is still the login provider, not the target site.
    const labels = clean.split(".");
    if (labels.length > 2 && FREEMAIL.has(labels.slice(1).join("."))) return true;
    if (labels.length > 3 && FREEMAIL.has(labels.slice(2).join("."))) return true;
    return false;
}

let tldSet = null;
function validTlds() {
    if (!tldSet) {
        // Lazy: cleaner requires nothing from sites, so this cannot cycle at load.
        tldSet = require("./cleaner").VALID_TLDS;
    }
    return tldSet;
}

/**
 * Collapse a host to the site it actually belongs to.
 * `login0.netflix.com` and `www2.netflix.com` -> `netflix.com`.
 * `shop.htzone.co.il` stays `htzone.co.il`. IPs and fake TLDs return null.
 * @param {string} raw
 * @returns {string|null}
 */
function registrableDomain(raw) {
    if (!raw || typeof raw !== "string") return null;
    let host = raw.trim().toLowerCase();
    if (!host || host.includes("@") || host.includes(" ")) return null;
    host = host.replace(/^[([{"']+/, "").replace(/[)\\]}'"]+$/, "");
    host = host.replace(/\.+$/, "");
    const slash = host.search(/[/?#]/);
    if (slash !== -1) host = host.slice(0, slash);
    const colon = host.indexOf(":");
    if (colon !== -1) host = host.slice(0, colon);
    host = host.replace(/^(?:www\d*|web|m|mobile|secure|login|auth|accounts?|signin|sign-in|sso|id|my|app|apps|portal)\./, "");
    if (!host || host.length < 4 || !host.includes(".")) return null;
    if (IPV4_HOST_RE.test(host)) return null;

    const labels = host.split(".").filter(Boolean);
    if (labels.length < 2) return null;
    const tld = labels[labels.length - 1];
    if (tld.length < 2 || !validTlds().has(tld)) return null;
    for (let i = 0; i < labels.length - 1; i++) {
        const label = labels[i];
        if (!label || label.length > 63 || label.startsWith("-") || label.endsWith("-")) return null;
        if (!/^[a-z0-9-]+$/.test(label)) return null;
    }

    const suffix2 = labels.slice(-2).join(".");
    if (labels.length >= 3 && MULTI_SUFFIXES.has(suffix2)) {
        return labels.slice(-3).join(".");
    }
    return suffix2;
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
        .replace(/[[\](){}]+/g, " ")
        .toLowerCase();

    // Domains: KEEP dots, replace other separators, then match domain tokens.
    // Matching against the stripped base (not the raw name) means the
    // extension can never leak in as a fake domain ("dump.zip").
    const domainBase = stripped.replace(/[_\-\s]+/g, " ");
    const domains = (domainBase.match(DOMAIN_LIKE_RE) || [])
        .map((d) => registrableDomain(d.replace(/^www\./, "").replace(/^\.+|\.+$/g, "")))
        .filter((d) => d && !isFreemail(d) && !isInfra(d));
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
function isInfra(domain) {
    const d = String(domain || "").toLowerCase();
    if (INFRA_HOSTS.has(d)) return true;
    const labels = d.split(".");
    return labels.length > 2 && INFRA_HOSTS.has(labels.slice(-2).join("."));
}

function hostFromScheme(value) {
    const scheme = value.indexOf("://");
    if (scheme < 0) return null;
    const schemeName = value.slice(0, scheme).replace(/.*[^a-z]/, "");
    let rest = value.slice(scheme + 3);
    // user:pass@host and android://token@package — the host is after the last @.
    const at = rest.lastIndexOf("@");
    if (at !== -1 && at < 120) rest = rest.slice(at + 1);
    rest = rest.split(/[/?#\s|;]/)[0];
    const colon = rest.indexOf(":");
    if (colon !== -1) rest = rest.slice(0, colon);
    if (!rest || rest.includes("@")) return null;
    const labels = rest.toLowerCase().split(".").filter(Boolean);
    if (schemeName === "android" && labels.length >= 2) {
        const app = labels.find((label) => ANDROID_SITES[label]);
        if (app) return ANDROID_SITES[app];
        if (labels[0] === "com" || labels[0] === "org" || labels[0] === "net") {
            const flipped = `${labels[1]}.${labels[0]}`;
            if (registrableDomain(flipped) && !isInfra(registrableDomain(flipped))) return flipped;
        }
    }
    return rest;
}

function scoreDomains(rawText) {
    const counts = new Map();
    const emailCounts = new Map();
    const text = typeof rawText === "string" ? rawText : String(rawText || "");
    const sample = text.length > 256 * 1024 ? text.slice(0, 256 * 1024) : text;

    const bump = (domain, weight, kind) => {
        const d = registrableDomain(domain);
        if (!d) return;
        const map = kind === "email" ? emailCounts : counts;
        const prev = map.get(d) || 0;
        map.set(d, prev + (isFreemail(d) ? weight * 0.25 : weight));
    };

    let start = 0;
    while (start < sample.length) {
        let end = sample.indexOf("\n", start);
        if (end === -1) end = sample.length;
        let line = sample.slice(start, end);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        start = end + 1;
        if (!line || line.length < 4) continue;

        const lower = line.toLowerCase();
        let scoredHost = false;

        const schemeAt = lower.indexOf("://");
        if (schemeAt > 0 && schemeAt <= 80) {
            const tokenStart = Math.max(
                lower.lastIndexOf(" ", schemeAt),
                lower.lastIndexOf("|", schemeAt),
                lower.lastIndexOf(";", schemeAt),
            ) + 1;
            bump(hostFromScheme(lower.slice(tokenStart)), WEIGHT_URL);
            scoredHost = true;
        }

        // "URL: https://site.com" / "Host: site.com" stealer labels.
        if (!scoredHost) {
            const label = lower.match(/^(?:url|uri|host|hostname|site|website|link)\s*[:=|]\s*(.+)$/);
            if (label) {
                const value = label[1].trim();
                const fromScheme = hostFromScheme(value);
                bump(fromScheme || value.split(/[/?#\s|]/)[0], WEIGHT_URL);
                scoredHost = true;
            }
        }

        // site.com:user:pass or site.com|user|pass, including after a space.
        if (!scoredHost) {
            const lead = lower.match(/(?:^|[\s|])((?:[a-z0-9-]+\.)+[a-z]{2,})(?=\s*[:|])/);
            if (lead) {
                bump(lead[1], WEIGHT_LINE_LEAD);
                scoredHost = true;
            }
        }

        // Email domains only when the line didn't already name a host. They
        // are the weak signal and mostly freemail noise.
        if (!scoredHost) {
            const at = lower.lastIndexOf("@");
            if (at !== -1) {
                const tail = lower.slice(at + 1).split(/[\s:|;,]/)[0];
                if (tail.includes(".")) bump(tail, WEIGHT_EMAIL, "email");
            }
        }
    }

    let best = null;
    let bestScore = 0;
    let bestNonFreemail = null;
    let bestNonFreemailScore = 0;
    let bestTarget = null;
    let bestTargetScore = 0;
    for (const [domain, score] of counts) {
        if (score > bestScore) {
            best = domain;
            bestScore = score;
        }
        if (!isFreemail(domain) && score > bestNonFreemailScore) {
            bestNonFreemail = domain;
            bestNonFreemailScore = score;
        }
        if (!isFreemail(domain) && !isInfra(domain) && score > bestTargetScore) {
            bestTarget = domain;
            bestTargetScore = score;
        }
    }
    let bestEmailTarget = null;
    let bestEmailScore = 0;
    for (const [domain, score] of emailCounts) {
        if (isFreemail(domain) || isInfra(domain)) continue;
        if (score > bestEmailScore) {
            bestEmailTarget = domain;
            bestEmailScore = score;
        }
    }
    return {
        best,
        bestScore,
        bestNonFreemail,
        bestNonFreemailScore,
        bestTarget,
        bestTargetScore,
        bestEmailTarget,
        bestEmailScore,
        counts,
    };
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

    const scored = scoreDomains(rawText || "");
    // A real target site beats login hosts and CDNs even when those score higher.
    const contentBest = scored.bestTarget || scored.bestEmailTarget || null;
    const contentScore = scored.bestTarget ? scored.bestTargetScore : (scored.bestEmailScore || 0);

    if (contentBest && contentScore >= nameScore) return contentBest;
    if (nameHint && !isInfra(nameHint) && !isFreemail(nameHint)) return nameHint;
    return contentBest;
}

module.exports = {
    detectSite,
    siteFromFileName,
    domainFromFileName,
    sanitizeSiteSlug,
    isFreemail,
    registrableDomain,
};
