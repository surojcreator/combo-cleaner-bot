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

// Labels that represent metadata / form headers and are NEVER valid usernames.
const PURE_FIELD_LABELS = new Set([
    "url", "uri", "link", "href", "host", "site", "website", "page", "target", "domain", "server", "address",
    "action", "form_action", "form", "submit", "submit_url", "post_url", "login_url", "auth_url",
    "soft", "software", "browser", "app", "application", "client",
    "hwid", "ip", "country", "time", "date", "token", "cookie", "cookies", "profile", "path", "port",
    "id", "category", "data", "info", "note", "notes", "type", "stat", "status"
]);

// Labels that indicate credential fields (user:, pass:) in key-value dumps.
const CREDENTIAL_LABELS = new Set([
    "user", "username", "login", "account", "acc", "usr", "user_name", "user_login", "userid", "user_id", "login_id",
    "email", "mail",
    "pass", "password", "pwd", "passwd", "passw", "secret"
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

// Fast check for special whitespace/BOM characters
const SPECIAL_WS_RE = /[\u200B-\u200D\uFEFF\u00A0]/;

/**
 * Strip a leading BOM and trim whitespace with fast-path for clean strings.
 * @param {string} line
 * @returns {string}
 */
function normalizeLine(line) {
    if (!line) return "";
    let s = typeof line === "string" ? line : String(line);
    if (SPECIAL_WS_RE.test(s)) {
        s = s
            .replace(/^\uFEFF/, "")
            .replace(/[\u200B-\u200D\uFEFF]/g, "")
            .replace(/\u00A0/g, " ");
    }
    return s.trim();
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
 * Strip trailing metadata tags attached to passwords in stealer logs,
 * e.g. "secret123 | IP: 1.2.3.4", "pass [Google Chrome]", "secret;".
 *
 * @param {string} password
 * @returns {string}
 */
function stripTrailingMetadata(password) {
    if (!password) return "";
    let p = String(password).trim();
    p = p.replace(
        /\s+[|;,]\s*(?:ip|hwid|country|soft|software|browser|date|time|token|cookie|cookies|profile|status|note)\s*[:=].*$/i,
        "",
    );
    p = p.replace(
        /\s+(?:\[|\()(?:google\s+)?(?:chrome|firefox|edge|opera|brave|safari|chromium|yandex|vivaldi)[\w\s.-]*(?:\]|\)).*$/i,
        "",
    );
    p = p.replace(/[|;]+$/, "").trim();
    return p;
}

/**
 * Decide whether a token is a usable plain-username login.
 * Rejects pure metadata field labels, scheme words, passwords, and URLs.
 *
 * @param {string} login
 * @param {string} password
 * @returns {boolean}
 */
function isUsername(login, password) {
    if (!USERNAME_RE.test(login)) return false;
    const lower = login.toLowerCase();
    if (SCHEMES.has(lower)) return false;
    if (PURE_FIELD_LABELS.has(lower)) return false;
    if (
        lower === "login" ||
        lower === "password" ||
        lower === "pass" ||
        lower === "pwd" ||
        lower === "passwd" ||
        lower === "secret"
    ) {
        return false;
    }
    if (isUrlOrDomain(login)) return false;
    // A scheme like "https" is followed by "//"; reject that shape.
    if (password.startsWith("//")) return false;
    return true;
}

/**
 * Attempt to extract login:password from explicit key-value label pairs on a single line,
 * e.g. "USER: admin PASS: secret", "Host: site.com | User: bob | Pass: 123", "action: ... user: bob pass: 123".
 *
 * @param {string} line
 * @param {{ keepUrl?: boolean }} [options]
 * @returns {string|null}
 */
function extractFromKeyValueLabels(line, options = {}) {
    const keepUrl = Boolean(options && options.keepUrl);

    const userMatch = line.match(
        /(?:^|[\s|;,:])(?:user(?:name|_name|_login)?|login(?:_id)?|account|acc|usr|email|mail)\s*[:=]\s*([^\s|;,:]+)/i,
    );
    const passMatch = line.match(
        /(?:^|[\s|;,:])(?:pass(?:word|wd|w)?|pwd|secret)\s*[:=]\s*(.+)$/i,
    );

    if (userMatch && passMatch) {
        const user = userMatch[1].trim();
        let pass = user === passMatch[1].trim() ? "" : passMatch[1].trim();
        pass = stripTrailingMetadata(pass);

        const nextLabelMatch = pass.match(
            /\s+(?:ip|hwid|date|time|browser|soft|country|token|cookie|profile|url|host)\s*[:=]/i,
        );
        if (nextLabelMatch) {
            pass = pass.slice(0, nextLabelMatch.index).trim();
        }

        if (user && pass) {
            const userLower = user.toLowerCase();
            if (!PURE_FIELD_LABELS.has(userLower) && userLower !== "http" && userLower !== "https") {
                if (keepUrl) {
                    const urlMatch = line.match(
                        /(?:^|[\s|;,])(?:url|uri|host|site|website|link|action|form_action)\s*[:=]\s*([^\s|;,]+)/i,
                    );
                    if (urlMatch && isUrlOrDomain(urlMatch[1])) {
                        return `${urlMatch[1]}:${user}:${pass}`;
                    }
                }
                return `${user}:${pass}`;
            }
        }
    }
    return null;
}

/**
 * Strips leading metadata labels like "action:", "form_action:", "url:", "user:", "login:".
 *
 * @param {string} line
 * @returns {{ line: string, strippedLabel: string|null }}
 */
function stripLabelPrefixes(line) {
    const LEADING_LABEL_RE =
        /^(?:action|form_action|form|submit|submit_url|post_url|login_url|url|uri|host|site|website|page|target|domain|user|username|login|account|acc|usr|user_name|user_login|email|mail|soft|software|browser|app|application|client)\s*[:=|]\s*/i;

    let s = line;
    let lastStripped = null;

    while (true) {
        const m = s.match(LEADING_LABEL_RE);
        if (!m) break;

        const token = m[0].split(/[:=|]/)[0].trim().toLowerCase();
        if (SCHEMES.has(token)) break;

        const remainder = s.slice(m[0].length).trim();
        if (!remainder) break;

        // If the token is a credential label (like "user" or "login") and the remainder
        // has NO separator (no colon or pipe), then "user" or "username" was the username,
        // not a prefix label (e.g. "username:pass word", "user:pass123").
        if (CREDENTIAL_LABELS.has(token)) {
            const hasSep = remainder.includes(":") || remainder.includes("|");
            if (!hasSep) {
                break;
            }
        }

        s = remainder;
        lastStripped = token;
    }

    return { line: s, strippedLabel: lastStripped };
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
        out.push({ login: match[1], password: stripTrailingMetadata(password) });
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

    // Ultra-fast path: standard email:password or phone:password lines with no URL, pipe, or labels
    const fastSep = line.indexOf(":");
    if (fastSep > 0 && !line.includes("|") && line.charCodeAt(fastSep + 1) !== 47 /* '/' */) {
        const atIdx = line.indexOf("@");
        if (atIdx > 0 && atIdx < fastSep && !line.includes(" ")) {
            const user = line.slice(0, fastSep);
            const pass = line.slice(fastSep + 1);
            if (pass.length > 0 && EMAIL_RE.test(user)) {
                return keepUrl ? line : `${user}:${stripTrailingMetadata(pass)}`;
            }
        }
    }

    // Fast check for single-line key-value pairs (e.g. "USER: admin PASS: secret")
    const kv = extractFromKeyValueLabels(line, options);
    if (kv !== null) return kv;

    // Check for "user: login pass" or "user:login pass"
    const userSpaceMatch = line.match(
        /^(?:user(?:name|_name|_login)?|login(?:_id)?|account|acc|usr)\s*[:=|]\s*([^\s:|]+)\s+([^\s]+)$/i,
    );
    if (userSpaceMatch) {
        const first = userSpaceMatch[1].trim();
        const second = stripTrailingMetadata(userSpaceMatch[2].trim());
        const firstLower = first.toLowerCase();
        if (
            firstLower !== "pass" &&
            firstLower !== "password" &&
            firstLower !== "pwd" &&
            firstLower !== "secret" &&
            !PURE_FIELD_LABELS.has(firstLower) &&
            !SCHEMES.has(firstLower)
        ) {
            return `${first}:${second}`;
        }
    }

    // Pass 0: card dumps like `number|mm|yy|cvv|...extras`
    const cc = cleanCcLine(line);
    if (cc !== null) return cc;

    // Check for leading label prefixes (e.g. "action:user:pass" -> "user:pass", "user:login:pass" -> "login:pass")
    const { line: strippedLine, strippedLabel } = stripLabelPrefixes(line);
    const hasColon = strippedLine.includes(":");
    const hasPipe = strippedLine.includes("|");

    // Check for space-separated pair (e.g. "user:login pass" -> "login:pass", "user: admin 123456" -> "admin:123456")
    if (!hasColon && !hasPipe) {
        const spaceIdx = strippedLine.search(/\s+/);
        if (spaceIdx > 0) {
            const first = strippedLine.slice(0, spaceIdx).trim();
            const second = stripTrailingMetadata(strippedLine.slice(spaceIdx).trim());
            const isUserLabel =
                strippedLabel &&
                (strippedLabel === "user" ||
                    strippedLabel === "username" ||
                    strippedLabel === "login" ||
                    strippedLabel === "account" ||
                    strippedLabel === "usr");
            if (first && second && !second.includes(" ")) {
                if (
                    isEmail(first) ||
                    isPhone(first) ||
                    (isUserLabel && (isUsername(first, second) || /^[A-Za-z0-9._-]+$/.test(first)))
                ) {
                    return `${first}:${second}`;
                }
            }
        }
        return null;
    }

    // Fast path: standard email:password or phone:password lines with no URL/pipe
    if (!hasPipe) {
        const firstSep = strippedLine.indexOf(":");
        if (firstSep > 0) {
            const firstToken = strippedLine.slice(0, firstSep).trim();
            const rest = stripTrailingMetadata(strippedLine.slice(firstSep + 1).trim());
            if (rest && !rest.startsWith("//")) {
                if (firstToken.includes("@") && isEmail(firstToken)) {
                    return keepUrl ? strippedLine : `${firstToken}:${rest}`;
                }
                if (isPhone(firstToken)) {
                    return keepUrl ? strippedLine : `${firstToken}:${rest}`;
                }
            }
        }
    }

    const candidates = extractCandidates(strippedLine);

    // Pass 1: prefer an email or number login anywhere on the line. Scanning the
    // whole line (not just the first token) is what lets us skip URL/domain
    // prefixes and grab the real credential in "url:login:pass" dumps.
    for (const { login, password } of candidates) {
        if (!password) continue;
        if (isEmail(login) || isPhone(login)) {
            return keepUrl ? strippedLine : `${login}:${password}`;
        }
    }

    // Pass 2: fall back to a plain username login (only if no email/number was
    // found), skipping URL schemes, domain tokens, and pure field labels.
    for (const { login, password } of candidates) {
        if (!password) continue;
        if (isUsername(login, password)) {
            return keepUrl ? strippedLine : `${login}:${password}`;
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
                !PURE_FIELD_LABELS.has(login.toLowerCase()) &&
                !isUrlOrDomain(login) &&
                !password.startsWith("//") &&
                login.length >= 1
            ) {
                return strippedLine;
            }
        }
    }

    return null;
}

/**
 * Clean an array of lines, with support for multi-line stealer record blocks
 * (e.g. URL:\nUsername:\nPassword:).
 *
 * @param {string[]} rawLines
 * @param {{ dedupe?: boolean, keepUrl?: boolean }} [options]
 * @returns {{ lines: string[], stats: { total: number, kept: number, dropped: number, duplicates: number } }}
 */
function cleanLinesArray(rawLines, options = {}) {
    const keepUrl = Boolean(options && options.keepUrl);
    const dedupe = options && options.dedupe !== false;
    const seen = dedupe ? new Set() : null;
    const cleaned = [];
    let kept = 0;
    let dropped = 0;
    let duplicates = 0;

    const len = rawLines.length;
    let i = 0;

    while (i < len) {
        const raw = rawLines[i];
        const trimmed = normalizeLine(raw);

        // Multi-line stealer record detection (blocks of URL / User / Pass)
        if (
            trimmed &&
            /^(?:url|uri|host|site|website|link|page|action|form_action|application|app|browser|soft|software|client|username|user|login|account|usr)\s*[:=]/i.test(
                trimmed,
            )
        ) {
            let recordUser = null;
            let recordPass = null;
            let recordUrl = null;
            let j = i;
            let foundRecord = false;
            let blockConsumed = 0;

            for (; j < Math.min(i + 8, len); j++) {
                const lineJ = normalizeLine(rawLines[j]);
                if (!lineJ || /^[-=_*#]{3,}$/.test(lineJ)) {
                    if (recordUser && recordPass) {
                        foundRecord = true;
                        break;
                    }
                    continue;
                }

                // If line already contains a full combo without field labels, stop multi-line block
                const isFieldLabelLine =
                    /^(?:url|uri|host|site|website|application|app|browser|soft|software|username|user|login|pass|password|pwd|secret|action)\s*[:=]/i.test(
                        lineJ,
                    );
                if (!isFieldLabelLine && (lineJ.includes(":") || lineJ.includes("|"))) {
                    break;
                }

                const uMatch = lineJ.match(
                    /^(?:user(?:name|_name|_login)?|login(?:_id)?|account|acc|usr|email|mail)\s*[:=]\s*(.+)$/i,
                );
                const pMatch = lineJ.match(/^(?:pass(?:word|wd|w)?|pwd|secret)\s*[:=]\s*(.+)$/i);
                const urlMatch = lineJ.match(
                    /^(?:url|uri|host|site|website|link|page|action|form_action)\s*[:=]\s*(.+)$/i,
                );

                if (uMatch) {
                    recordUser = uMatch[1].trim();
                } else if (pMatch) {
                    recordPass = stripTrailingMetadata(pMatch[1].trim());
                } else if (urlMatch) {
                    recordUrl = urlMatch[1].trim();
                }

                if (recordUser && recordPass) {
                    foundRecord = true;
                    blockConsumed = j - i + 1;
                    break;
                }
            }

            if (foundRecord && recordUser && recordPass) {
                let res;
                if (keepUrl && recordUrl && isUrlOrDomain(recordUrl)) {
                    res = `${recordUrl}:${recordUser}:${recordPass}`;
                } else {
                    res = `${recordUser}:${recordPass}`;
                }

                if (seen) {
                    if (seen.has(res)) {
                        duplicates++;
                    } else {
                        seen.add(res);
                        cleaned.push(res);
                        kept++;
                    }
                } else {
                    cleaned.push(res);
                    kept++;
                }
                dropped += Math.max(0, blockConsumed - 1);
                i += blockConsumed;
                continue;
            }
        }

        // Standard single-line processing
        const res = cleanLine(raw, options);
        if (res === null) {
            if (trimmed !== "") dropped++;
            i++;
            continue;
        }

        if (seen) {
            if (seen.has(res)) {
                duplicates++;
                i++;
                continue;
            }
            seen.add(res);
        }
        cleaned.push(res);
        kept++;
        i++;
    }

    return {
        lines: cleaned,
        stats: {
            total: rawLines.length,
            kept,
            dropped,
            duplicates,
        },
    };
}

/**
 * Clean a whole text blob.
 *
 * @param {string} text
 * @param {{ dedupe?: boolean, keepUrl?: boolean }} [options]
 * @returns {{ lines: string[], stats: { total: number, kept: number, dropped: number, duplicates: number } }}
 */
function cleanText(text, options = {}) {
    const rawLines = String(text || "").split(/\r?\n/);
    return cleanLinesArray(rawLines, options);
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
    cleanLinesArray,
    stripTrailingMetadata,
    stripLabelPrefixes,
    extractFromKeyValueLabels,
    PURE_FIELD_LABELS,
    CREDENTIAL_LABELS,
    isUrlOrDomain,
    isEmail,
    isPhone,
    normalizeLine,
};