"use strict";

/**
 * Combolist cleaner.
 *
 * Real-world dumps are messy. Common shapes we must handle:
 *
 *   user@example.com:password123                 -> user@example.com:password123
 *   15551234567:password123                      -> 15551234567:password123
 *   https://site.com/path/:027223395:Wekselma7   -> 027223395:Wekselma7
 *   https://site.com/page 027152230:dani1234     -> 027152230:dani1234
 *   site.com:user@mail.com:pass                  -> user@mail.com:pass
 *   https://site.com/|043154756|saarofri2014     -> 043154756:saarofri2014
 *   site.com:weintraubetattoo:weintraube867      -> weintraubetattoo:weintraube867
 *   https://site.com:443                         -> (dropped: URL/domain)
 *
 * Strategy: scan the line for every `token:separator` candidate (separator is
 * ':' or '|'), then keep the FIRST candidate whose token is a valid login:
 *   - an email, or
 *   - a phone number, or
 *   - a plain username (letters/digits/._-, 4+ chars, not a URL scheme/domain).
 * Everything after the separator is the password. URL/domain prefixes and other
 * junk are discarded.
 */

// A candidate token followed by a ':' or '|' separator. The lookbehind ensures
// the token starts at a boundary (start of line or a non-token char) WITHOUT
// consuming that boundary, so back-to-back candidates are all found.
const CANDIDATE_RE =
    /(?<=^|[\s/:|])([A-Za-z0-9._%+@+-]+)[ \t]*[:|][ \t]*/g;

// URL schemes we must never treat as a username login.
const SCHEMES = new Set([
    "http",
    "https",
    "ftp",
    "ftps",
    "sftp",
    "ssh",
    "ws",
    "wss",
    "telnet",
    "smtp",
    "imap",
    "pop3",
    "ldap",
    "file",
    "data",
    "mailto",
    "javascript",
]);

// Matches an email address.
const EMAIL_RE = /^[^\s@:|]+@[^\s@:|]+\.[^\s@:|]+$/;

// Matches a phone number: optional leading +, then 7-15 digits with separators.
const PHONE_RE = /^\+?[\d][\d\s().-]{5,}\d$/;

// Matches a plain username login.
const USERNAME_RE = /^[A-Za-z][A-Za-z0-9._-]{3,}$/;

// Matches a URL with an explicit scheme, e.g. http://, https://, ftp://
const SCHEME_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

// Matches a bare domain / host, optionally with a port.
const DOMAIN_RE =
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?$/i;

// Matches an IPv4 address, optionally with a port.
const IPV4_RE =
    /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?::\d{1,5})?$/;

/**
 * Strip a leading BOM and trim whitespace.
 * @param {string} line
 * @returns {string}
 */
function normalizeLine(line) {
    return line.replace(/^\uFEFF/, "").trim();
}

/**
 * Decide whether a token is a URL / domain / host.
 * @param {string} left
 * @returns {boolean}
 */
function isUrlOrDomain(left) {
    const value = left.trim();
    if (!value) return false;
    if (SCHEME_URL_RE.test(value)) return true;
    if (IPV4_RE.test(value)) return true;
    if (DOMAIN_RE.test(value)) return true;
    return false;
}

/**
 * @param {string} left
 * @returns {boolean}
 */
function isEmail(left) {
    return EMAIL_RE.test(left.trim());
}

/**
 * @param {string} left
 * @returns {boolean}
 */
function isPhone(left) {
    const value = left.trim();
    if (!PHONE_RE.test(value)) return false;
    const digits = value.replace(/\D/g, "");
    return digits.length >= 7 && digits.length <= 15;
}

/**
 * Decide whether a token is a usable plain-username login.
 * @param {string} login
 * @param {string} password
 * @returns {boolean}
 */
function isUsername(login, password) {
    if (!USERNAME_RE.test(login)) return false;
    if (SCHEMES.has(login.toLowerCase())) return false;
    if (isUrlOrDomain(login)) return false;
    // A scheme like "https" is followed by "//"; reject that shape.
    if (password.startsWith("//")) return false;
    return true;
}

/**
 * Collect every `token<sep>password` candidate on a line.
 *
 * @param {string} line
 * @returns {{ login: string, password: string }[]}
 */
function extractCandidates(line) {
    const out = [];
    CANDIDATE_RE.lastIndex = 0;
    let match;
    while ((match = CANDIDATE_RE.exec(line)) !== null) {
        const password = line.slice(match.index + match[0].length).trim();
        out.push({ login: match[1], password });
    }
    return out;
}

/**
 * Extract a `login:password` credential from a messy line.
 *
 * @param {string} rawLine
 * @returns {string|null} normalized `login:password`, or null to drop the line.
 */
function cleanLine(rawLine) {
    const line = normalizeLine(rawLine);
    if (!line) return null;

    const candidates = extractCandidates(line);

    // Pass 1: prefer an email or number login anywhere on the line. Scanning the
    // whole line (not just the first token) is what lets us skip URL/domain
    // prefixes and grab the real credential in "url:login:pass" dumps.
    for (const { login, password } of candidates) {
        if (!password) continue;
        if (isEmail(login) || isPhone(login)) {
            return `${login}:${password}`;
        }
    }

    // Pass 2: fall back to a plain username login (only if no email/number was
    // found), skipping URL schemes and domains.
    for (const { login, password } of candidates) {
        if (!password) continue;
        if (isUsername(login, password)) {
            return `${login}:${password}`;
        }
    }

    return null;
}

/**
 * Clean a whole text blob.
 *
 * @param {string} text
 * @param {{ dedupe?: boolean }} [options]
 * @returns {{ lines: string[], stats: { total: number, kept: number, dropped: number, duplicates: number } }}
 */
function cleanText(text, options = {}) {
    const dedupe = options.dedupe !== false;
    const rawLines = String(text).split(/\r?\n/);

    const seen = new Set();
    const lines = [];
    let kept = 0;
    let dropped = 0;
    let duplicates = 0;

    for (const raw of rawLines) {
        const cleaned = cleanLine(raw);
        if (cleaned === null) {
            if (normalizeLine(raw) !== "") dropped += 1;
            continue;
        }
        if (dedupe) {
            if (seen.has(cleaned)) {
                duplicates += 1;
                continue;
            }
            seen.add(cleaned);
        }
        lines.push(cleaned);
        kept += 1;
    }

    return {
        lines,
        stats: {
            total: rawLines.length,
            kept,
            dropped,
            duplicates,
        },
    };
}

module.exports = {
    cleanLine,
    cleanText,
    isUrlOrDomain,
    isEmail,
    isPhone,
    normalizeLine,
};