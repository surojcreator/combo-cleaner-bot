"use strict";

/**
 * Combolist cleaner.
 *
 * Real-world dumps are messy. Common shapes we must handle:
 *
 *   user@example.com:password123                 -> user@example.com:password123
 *   15551234567:password123                      -> 15551234567:password123
 *   4111111111111111|08|27|123|XX/IN| [VISA/CREDIT/NA] {BANK}| Name
 *                                                -> 4111111111111111|08|27|123
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
    return String(line || "")
        .replace(/^\uFEFF/, "")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/\u00A0/g, " ")
        .trim();
}

/**
 * Normalize a 2- or 4-digit expiry year down to YY.
 * @param {string} y raw year field (digits only)
 * @returns {string|null} two-digit year, or null if invalid
 */
function normalizeYear(y) {
    const d = String(y).replace(/\D/g, "");
    if (/^\d{2}$/.test(d)) return d;
    if (/^\d{4}$/.test(d)) return d.slice(2); // 2027 -> 27
    return null;
}

/**
 * Try to extract a card line shaped like:
 *   number|mm|yy|cvv|XX/IN| [VISA/CREDIT/NA] {BANK ...}| Name ...
 *   or number|mm/yy|cvv|...
 * and strip it down to just `number|mm|yy|cvv`.
 *
 * Tolerates `|` (primary) as well as `:` / `;` separators, stray spaces,
 * dashes/spaces inside the PAN, a 1-digit month ("3" -> "03") and a
 * 4-digit year ("2027" -> "27"). Scans every consecutive 4-field window so
 * URL/domain prefixes or other junk before the card don't break it.
 *
 * @param {string} line already-trimmed line
 * @returns {string|null} normalized `number|mm|yy|cvv`, or null
 */
function cleanCcLine(line) {
    if (!line || !/[|:;]/.test(line)) {
        return null;
    }
    // Split on any of the common separators, keeping the fields in order.
    const fields = String(line).split(/[|;:]/).map((f) => f.trim());
    if (fields.length < 3) return null;

    // Check for 3-field format where expiry is combined as MM/YY: pan | mm/yy | cvv
    for (let i = 0; i + 2 < fields.length; i++) {
        const rawPan = fields[i];
        const rawExpiry = fields[i + 1];
        const rawCvv = fields[i + 2];

        if (rawExpiry && rawExpiry.includes("/")) {
            const pan = rawPan.replace(/[\s-]/g, "");
            if (/^\d{12,19}$/.test(pan)) {
                const parts = rawExpiry.split("/");
                const mmDigits = parts[0].replace(/\D/g, "");
                const mmNum = parseInt(mmDigits, 10);
                if (mmNum >= 1 && mmNum <= 12) {
                    const mm = mmDigits.padStart(2, "0");
                    const yy = normalizeYear(parts[1]);
                    if (yy !== null) {
                        const cvvMatch = rawCvv.match(/^(\d{3,4})\b/);
                        if (cvvMatch) {
                            return `${pan}|${mm}|${yy}|${cvvMatch[1]}`;
                        }
                    }
                }
            }
        }
    }

    // Standard 4-field format: pan | mm | yy | cvv
    if (fields.length < 4) return null;

    for (let i = 0; i + 3 < fields.length; i++) {
        const rawPan = fields[i];
        const rawMm = fields[i + 1];
        const rawYy = fields[i + 2];
        const rawCvv = fields[i + 3];

        // PAN: 12-19 digits (allow spaces/dashes inside, e.g. "4111 1111 1111 1111").
        const pan = rawPan.replace(/[\s-]/g, "");
        if (!/^\d{12,19}$/.test(pan)) continue;

        // Month: 1-12, 1 or 2 digits.
        const mmDigits = rawMm.replace(/\D/g, "");
        if (!/^\d{1,2}$/.test(mmDigits)) continue;
        const mmNum = parseInt(mmDigits, 10);
        if (mmNum < 1 || mmNum > 12) continue;
        const mm = mmDigits.padStart(2, "0");

        // Year: 2 digits, or 4 digits (normalized to last 2).
        const yy = normalizeYear(rawYy);
        if (yy === null) continue;

        // CVV: 3-4 digits. Take leading digits so "123 " or "1234" both work,
        // but reject when the field has no leading 3-4 digit run.
        const cvvMatch = rawCvv.match(/^(\d{3,4})\b/);
        if (!cvvMatch) continue;
        const cvv = cvvMatch[1];

        return `${pan}|${mm}|${yy}|${cvv}`;
    }

    return null;
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
function cleanLine(rawLine, options = {}) {
    const keepUrl = Boolean(options && options.keepUrl);
    const line = normalizeLine(rawLine);
    if (!line) return null;

    // Fast reject lines with no candidate separator
    const hasColon = line.includes(":");
    const hasPipe = line.includes("|");
    if (!hasColon && !hasPipe) return null;

    // Fast path: standard email:password or phone:password lines with no URL/pipe
    if (!hasPipe) {
        const firstSep = line.indexOf(":");
        if (firstSep > 0) {
            const firstToken = line.slice(0, firstSep).trim();
            const rest = line.slice(firstSep + 1).trim();
            if (rest && !rest.startsWith("//")) {
                if (firstToken.includes("@") && isEmail(firstToken)) {
                    return keepUrl ? line : `${firstToken}:${rest}`;
                }
                if (isPhone(firstToken)) {
                    return keepUrl ? line : `${firstToken}:${rest}`;
                }
            }
        }
    }

    // Pass 0: card dumps like `number|mm|yy|cvv|...extras` strip down to
    // just the first four fields, normalized to `number|mm|yy|cvv`.
    const cc = cleanCcLine(line);
    if (cc !== null) return cc;

    const candidates = extractCandidates(line);

    // Pass 1: prefer an email or number login anywhere on the line. Scanning the
    // whole line (not just the first token) is what lets us skip URL/domain
    // prefixes and grab the real credential in "url:login:pass" dumps.
    for (const { login, password } of candidates) {
        if (!password) continue;
        if (isEmail(login) || isPhone(login)) {
            return keepUrl ? line : `${login}:${password}`;
        }
    }

    // Pass 2: fall back to a plain username login (only if no email/number was
    // found), skipping URL schemes and domains.
    for (const { login, password } of candidates) {
        if (!password) continue;
        if (isUsername(login, password)) {
            return keepUrl ? line : `${login}:${password}`;
        }
    }

    // Pass 3: when keepUrl is enabled, also support shorter or non-standard
    // usernames (1-3 chars) preceded by a URL or domain, so ULP dumps like
    // "https://site.com:sam:pass" or "site.com:bob:pass" are kept intact.
    if (keepUrl) {
        for (const { login, password } of candidates) {
            if (!password) continue;
            if (
                !SCHEMES.has(login.toLowerCase()) &&
                !isUrlOrDomain(login) &&
                !password.startsWith("//") &&
                login.length >= 1
            ) {
                return line;
            }
        }
    }

    return null;
}

/**
 * Clean a whole text blob.
 *
 * @param {string} text
 * @param {{ dedupe?: boolean, keepUrl?: boolean }} [options]
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
        const cleaned = cleanLine(raw, options);
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

function isCcLine(line) {
    return cleanCcLine(line) !== null;
}

module.exports = {
    cleanLine,
    cleanCcLine,
    isCcLine,
    isCreditCardLine: isCcLine,
    cleanText,
    isUrlOrDomain,
    isEmail,
    isPhone,
    normalizeLine,
};