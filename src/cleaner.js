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

// A candidate token followed by a ':', '|', or ';' separator. The lookbehind ensures
// the token starts at a boundary (start of line or whitespace or separator) WITHOUT
// consuming that boundary. We do NOT allow '/' in the lookbehind because URL paths
// like /LogLogonHandler:user:pass must not treat path segments as candidate usernames.
const CANDIDATE_RE =
    /(?<=^|[\s:|;])([A-Za-z0-9._%+@+-]+)[ \t]*[:|;]+[ \t]*/g;


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

// Labels that represent metadata / form headers / handlers and are NEVER valid usernames.
const PURE_FIELD_LABELS = new Set([
    "menu", "search", "searching", "query", "history",
    "url", "uri", "link", "href", "host", "site", "website", "page", "target", "domain", "server", "address",
    "action", "form_action", "form", "submit", "submit_url", "post_url", "login_url", "auth_url",
    "soft", "software", "browser", "app", "application", "client",
    "hwid", "ip", "country", "time", "date", "token", "cookie", "cookies", "profile", "path", "port",
    "id", "category", "data", "info", "note", "notes", "type", "stat", "status",
    "loglogonhandler", "logonhandler", "loginhandler", "authhandler", "submithandler", "requesthandler",
    "apihandler", "ajaxhandler", "formhandler", "handler", "handlers"
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

// Fast check for special whitespace/BOM/invisible characters
const SPECIAL_WS_RE = /[\u200B-\u200F\u2028\u2029\uFEFF\u00A0]/;

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
            .replace(/[\u200B-\u200F\u2028\u2029\uFEFF]/g, "")
            .replace(/\u00A0/g, " ");
    }
    return s.trim();
}

/**
 * Safely unquote a token if wrapped in matching quotes.
 * @param {string} s
 * @returns {string}
 */
function unquote(s) {
    if (!s || typeof s !== "string") return "";
    const len = s.length;
    if (len < 2) return s.trim();
    const c0 = s.charCodeAt(0);
    if (c0 === 34 /* '"' */ || c0 === 39 /* "'" */ || c0 === 96 /* '`' */) {
        if (s.charCodeAt(len - 1) === c0) {
            return s.slice(1, -1).trim();
        }
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
// Matches PAN with 12-19 digits (with optional spaces/dashes)
const CC_DIGITS_RE = /\d[\d\s-]{10,}\d/;

function cleanCcLine(line) {
    if (!line || !CC_DIGITS_RE.test(line) || !/[|:;,]/.test(line)) {
        return null;
    }
    // Split on any of the common separators, keeping the fields in order.
    const fields = String(line).split(/[|;:,]/).map((f) => unquote(f.trim()));
    if (fields.length < 3) return null;

    // Check for 3-field format where expiry is combined as MM/YY: pan | mm/yy | cvv
    for (let i = 0; i + 2 < fields.length; i++) {
        const rawPan = fields[i];
        const rawExpiry = fields[i + 1];
        const rawCvv = fields[i + 2];

        if (rawExpiry && /[/\-.]/.test(rawExpiry)) {
            const pan = rawPan.replace(/[\s-]/g, "");
            if (/^\d{12,19}$/.test(pan)) {
                const parts = rawExpiry.split(/[/\-.]/);
                const mmDigits = (parts[0] || "").replace(/\D/g, "");
                const mmNum = parseInt(mmDigits, 10) || 0;
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
        const mmNum = parseInt(mmDigits, 10) || 0;
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
    if (typeof left !== "string") return false;
    const value = left.trim();
    if (!value || (!value.includes(".") && !value.includes("/"))) return false;
    if (value.includes("@")) return false;
    if (SCHEME_URL_RE.test(value)) return true;
    if (IPV4_RE.test(value)) return true;
    if (DOMAIN_RE.test(value)) return true;
    const hostPart = value.split(/[\/?#:]/)[0];
    if (hostPart && (DOMAIN_RE.test(hostPart) || IPV4_RE.test(hostPart))) return true;
    return false;
}

/**
 * Checks whether a line already has a URL or domain prefix.
 * @param {string} line
 * @returns {boolean}
 */
function hasUrlPrefix(line) {
    if (!line || typeof line !== "string") return false;
    const trimmed = line.trim();
    if (SCHEME_URL_RE.test(trimmed)) return true;
    const firstSep = trimmed.indexOf(":");
    if (firstSep > 0) {
        const firstToken = trimmed.slice(0, firstSep).trim();
        if (isUrlOrDomain(firstToken)) return true;
    }
    const firstSpace = trimmed.search(/\s+/);
    if (firstSpace > 0) {
        const firstToken = trimmed.slice(0, firstSpace).trim();
        if (isUrlOrDomain(firstToken)) return true;
    }
    return false;
}

/**
 * @param {string} left
 * @returns {boolean}
 */
function isEmail(left) {
    if (typeof left !== "string") return false;
    return EMAIL_RE.test(left.trim());
}

/**
 * @param {string} left
 * @returns {boolean}
 */
function isPhone(left) {
    if (typeof left !== "string") return false;
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
    let p = typeof password === "string" ? password.trim() : String(password).trim();
    if (!/[\s;|,[()\]]/.test(p)) {
        return unquote(p);
    }
    p = p.replace(
        /(?:\s*[|;,]\s*|\s+)(?:ip|hwid|country|soft|software|browser|date|time|token|cookie|cookies|profile|status|note|os|pc|user|username|location|city|zip|url|uri|host|site|website|link|page|app|application|client|action)\s*[:=].*$/i,
        "",
    );
    p = p.replace(
        /(?:\s*[|;,]\s*|\s*)(?:(?:\[|\()(?:google\s+)?(?:chrome|firefox|edge|opera|brave|safari|chromium|yandex|vivaldi|windows)[\w\s.-]*(?:\]|\))|(?:[|;,]\s*)(?:google\s+)?(?:chrome|firefox|edge|opera|brave|safari|chromium|yandex|vivaldi|windows)[\w\s.-]*).*$/i,
        "",
    );
    if (p.includes("[")) {
        p = p.replace(/\s+\[.*?\]/g, "");
    }
    if (p.includes("(")) {
        p = p.replace(/\s+\(.*?\)/g, "");
    }
    if (p.includes("-")) {
        p = p.replace(/(?:\s*[|;,]\s*|\s+)\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}:\d{2})?.*$/, "");
    }
    if (p.includes("|") || p.includes(";") || p.includes(",")) {
        p = p.replace(/\s+[|;,]+.*$/, "");
        p = p.replace(/[|;,]+$/, "").trim();
    }
    if (p.includes(" ")) {
        p = p.split(/\s+/)[0];
    }
    return unquote(p);
}

/**
 * Checks if a string is a useless placeholder (null, undefined, unknown, empty, etc.)
 * @param {string} val
 * @returns {boolean}
 */
function isPlaceholder(val) {
    if (!val || typeof val !== "string") return true;
    const s = val.trim().toLowerCase();
    return (
        s === "(empty)" ||
        s === "<empty>" ||
        s === "[empty]" ||
        s === "none" ||
        s === "n/a" ||
        s === "anonymous"
    );
}

/**
 * Checks if a user:pass pair is a useless placeholder/junk pair
 * (e.g. null:null, undefined:undefined, unknown:unknown, user:(empty)).
 * Allows legitimate credentials like '031555014:NULL' in dumps where NULL is the password string.
 * @param {string} user
 * @param {string} pass
 * @returns {boolean}
 */
function isJunkPair(user, pass) {
    if (!user || !pass) return true;
    const uLen = typeof user === "string" ? user.length : String(user).length;
    const pLen = typeof pass === "string" ? pass.length : String(pass).length;
    if (uLen === 0 || pLen === 0) return true;

    // Fast check: credentials > 9 chars cannot match any of the short placeholders
    // (longest placeholder is "anonymous" which is 9 chars) unless starting with punctuation
    if (uLen > 9 && pLen > 9) {
        const u0 = user.charCodeAt(0);
        const p0 = pass.charCodeAt(0);
        if (u0 !== 40 && u0 !== 60 && u0 !== 91 && p0 !== 40 && p0 !== 60 && p0 !== 91) {
            return false;
        }
    }

    const u = String(user).trim().toLowerCase();
    const p = String(pass).trim().toLowerCase();
    if (!u || !p) return true;
    if (isPlaceholder(u) || isPlaceholder(p)) return true;
    if (
        (u === "null" || u === "undefined" || u === "unknown") &&
        (p === "null" || p === "undefined" || p === "unknown")
    ) {
        return true;
    }
    if ((p === "null" || p === "undefined" || p === "(empty)" || p === "<empty>") && u.includes("@")) {
        return true;
    }
    return false;
}

/**
 * Normalize ULP lines replacing non-standard separators with standard colons.
 * @param {string} line
 * @returns {string}
 */
function normalizeUlpOutput(line) {
    if (!line) return "";
    return line.replace(/[;\t]+/g, ":");
}

/**
 * Decide whether a token is a usable plain-username login.
 * Rejects pure metadata field labels, scheme words, handlers/endpoints, passwords, and URLs.
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
    if (isPlaceholder(lower)) return false;
    if (password && isJunkPair(lower, password)) return false;
    if (
        (lower === "user" ||
            lower === "username" ||
            lower === "login" ||
            lower === "account" ||
            lower === "acc" ||
            lower === "usr") &&
        password &&
        (isEmail(password) || isUrlOrDomain(password))
    ) {
        return false;
    }
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
    if (
        lower.endsWith("handler") ||
        lower.includes("handler") ||
        lower.startsWith("loglogon") ||
        lower.startsWith("logon") ||
        lower.endsWith(".aspx") ||
        lower.endsWith(".ashx") ||
        lower.endsWith(".asmx") ||
        lower.endsWith(".php") ||
        lower.endsWith(".jsp") ||
        lower.endsWith(".action") ||
        lower.endsWith(".do") ||
        lower.endsWith(".cgi") ||
        lower.endsWith(".html") ||
        lower.endsWith(".htm")
    ) {
        return false;
    }
    if (login.includes(".") && isUrlOrDomain(login)) return false;
    // A password in a combo line cannot be a URL scheme, full URL, or bare domain
    if (password && (password.startsWith("//") || SCHEME_URL_RE.test(password) || isUrlOrDomain(password))) return false;
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
    if (!line || !/(?:pass(?:word|wd|w)?|pwd|secret)["']?\s*[:=]/i.test(line)) {
        return null;
    }
    const keepUrl = Boolean(options && options.keepUrl);

    const userMatch = line.match(
        /(?:^|[\s|;,:"'{])["']?(?:user(?:name|_name|_login)?|login(?:_id)?|account|acc|usr|email|mail)["']?\s*[:=]\s*(?:["']([^"'\r\n]+)["']|([^\s|;,:"']+))/i,
    );
    const passMatch = line.match(
        /(?:^|[\s|;,:"'{])["']?(?:pass(?:word|wd|w)?|pwd|secret)["']?\s*[:=]\s*(?:["']([^"'\r\n]+)["']|(.+))$/i,
    );

    if (userMatch && passMatch) {
        const rawUser = userMatch[1] !== undefined ? userMatch[1] : userMatch[2];
        const rawPass = passMatch[1] !== undefined ? passMatch[1] : passMatch[2];
        const user = unquote(rawUser || "");
        let pass = user === (rawPass || "").trim() ? "" : (rawPass || "").trim();
        pass = stripTrailingMetadata(unquote(pass));

        const nextLabelMatch = pass.match(
            /\s+(?:ip|hwid|date|time|browser|soft|country|token|cookie|profile|url|host)\s*[:=]/i,
        );
        if (nextLabelMatch) {
            pass = pass.slice(0, nextLabelMatch.index).trim();
        }

        if (user && pass && !isPlaceholder(user) && !isPlaceholder(pass)) {
            const userLower = user.toLowerCase();
            if (!PURE_FIELD_LABELS.has(userLower) && userLower !== "http" && userLower !== "https") {
                if (keepUrl) {
                    const fallbackUrl = (options && (options.fallbackUrl || options.defaultUrl || options.url))
                        ? String(options.fallbackUrl || options.defaultUrl || options.url).trim()
                        : null;
                    const urlMatch = line.match(
                        /(?:^|[\s|;,:"'{])["']?(?:url|uri|host|site|website|link|action|form_action)["']?\s*[:=]\s*(?:["']([^"'\r\n]+)["']|([^\s|;,]+))/i,
                    );
                    const rawUrl = urlMatch ? (urlMatch[1] !== undefined ? urlMatch[1] : urlMatch[2]) : "";
                    const url = unquote(rawUrl || "");
                    if (url && isUrlOrDomain(url)) {
                        return `${url}:${user}:${pass}`;
                    }
                    if (fallbackUrl) {
                        return `${fallbackUrl}:${user}:${pass}`;
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
    if (typeof line !== "string") return { line: "", strippedLabel: null };
    const LEADING_LABEL_RE =
        /^(?:action|form_action|form|submit|submit_url|post_url|login_url|url|uri|host|site|website|page|target|domain|user|username|login|account|acc|usr|user_name|user_login|email|mail|soft|software|browser|app|application|client|[a-z0-9_.-]*handler|[a-z0-9_.-]*logon)\s*[:=;|]\s*/i;

    let s = line;
    let lastStripped = null;

    while (true) {
        const m = s.match(LEADING_LABEL_RE);
        if (!m) break;

        const token = m[0].split(/[:=;|]/)[0].trim().toLowerCase();
        if (SCHEMES.has(token)) break;

        const remainder = s.slice(m[0].length).trim();
        if (!remainder) break;

        // If the token is a credential label (like "user" or "login") and the remainder
        // has NO separator (no colon or pipe or semicolon), then "user" or "username" was the username,
        // not a prefix label (e.g. "username:pass word", "user:pass123").
        if (CREDENTIAL_LABELS.has(token)) {
            const hasSep = remainder.includes(":") || remainder.includes("|") || remainder.includes(";");
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
        let password = line.slice(match.index + match[0].length).trim();
        if (password.startsWith(":") || password.startsWith("|") || password.startsWith(";")) {
            password = password.replace(/^[:|;]+/, "").trim();
        }
        out.push({ login: match[1], password: stripTrailingMetadata(password) });
    }
    return out;
}

/**
 * Parse a CSV line into fields respecting single and double quotes.
 * @param {string} line
 * @returns {string[]}
 */
function splitCsvLine(line) {
    const fields = [];
    let current = "";
    let inQuotes = false;
    let quoteChar = "";

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (inQuotes) {
            if (char === quoteChar) {
                if (i + 1 < line.length && line[i + 1] === quoteChar) {
                    current += char;
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                current += char;
            }
        } else {
            if (char === '"' || char === "'") {
                inQuotes = true;
                quoteChar = char;
            } else if (char === ",") {
                fields.push(current.trim());
                current = "";
            } else {
                current += char;
            }
        }
    }
    fields.push(current.trim());
    return fields;
}

/**
 * Extract credentials from an array of delimited fields (CSV, TSV, SQL).
 * @param {string[]} fields
 * @param {{ keepUrl?: boolean }} [options]
 * @returns {string|null}
 */
function extractFromFields(fields, options = {}) {
    if (!Array.isArray(fields) || fields.length < 2) return null;
    const keepUrl = Boolean(options && options.keepUrl);

    // Pass 1: look for email or phone
    for (let i = 0; i < fields.length - 1; i++) {
        const candidate = unquote(fields[i]);
        if (isEmail(candidate) || isPhone(candidate)) {
            const rawPass = fields[i + 1];
            if (rawPass && rawPass.trim().toUpperCase() === "NULL" && !rawPass.startsWith("'") && !rawPass.startsWith('"')) {
                continue;
            }
            const pass = stripTrailingMetadata(unquote(rawPass));
            if (pass && !isJunkPair(candidate, pass)) {
                if (keepUrl && i > 0 && isUrlOrDomain(unquote(fields[i - 1]))) {
                    return `${unquote(fields[i - 1])}:${candidate}:${pass}`;
                }
                return `${candidate}:${pass}`;
            }
        }
    }

    // Pass 2: look for username
    for (let i = 0; i < fields.length - 1; i++) {
        const candidate = unquote(fields[i]);
        const rawPass = fields[i + 1];
        if (rawPass && rawPass.trim().toUpperCase() === "NULL" && !rawPass.startsWith("'") && !rawPass.startsWith('"')) {
            continue;
        }
        const pass = stripTrailingMetadata(unquote(rawPass));
        if (isUsername(candidate, pass)) {
            if (pass && !isJunkPair(candidate, pass)) {
                if (i > 0 && isUrlOrDomain(unquote(fields[i - 1]))) {
                    if (keepUrl) {
                        return `${unquote(fields[i - 1])}:${candidate}:${pass}`;
                    }
                    return `${candidate}:${pass}`;
                }
                if (fields.length === 2 || (i === 1 && /^\d+$/.test(unquote(fields[0])))) {
                    return `${candidate}:${pass}`;
                }
                if (i === 0 || (i === 1 && (isUrlOrDomain(unquote(fields[0])) || /^\d+$/.test(unquote(fields[0]))))) {
                    return `${candidate}:${pass}`;
                }
            }
        }
    }

    return null;
}

/**
 * Extract a `login:password` credential from a messy line.
 *
 * @param {string} rawLine
 * @returns {string|null} normalized `login:password`, or null to drop the line.
 */
function cleanLine(rawLine, options = {}) {
    const keepUrl = Boolean(options && options.keepUrl);
    const fallbackUrl = (options && (options.fallbackUrl || options.defaultUrl || options.url))
        ? String(options.fallbackUrl || options.defaultUrl || options.url).trim()
        : null;
    let line = typeof rawLine === "string" && !SPECIAL_WS_RE.test(rawLine) ? rawLine.trim() : normalizeLine(rawLine);
    if (!line) return null;

    // Strip trailing semicolons or commas from SQL / CSV / JSON lines
    if (line.endsWith(";") || line.endsWith(",")) {
        const strippedTrailing = line.replace(/[,;]+$/, "").trim();
        if (
            (strippedTrailing.startsWith("(") && strippedTrailing.endsWith(")")) ||
            (strippedTrailing.startsWith("{") && strippedTrailing.endsWith("}")) ||
            strippedTrailing.includes(":") ||
            strippedTrailing.includes("|") ||
            strippedTrailing.includes(",") ||
            strippedTrailing.includes(";") ||
            strippedTrailing.includes("\t")
        ) {
            line = strippedTrailing;
        }
    }

    const len = line.length;
    const c0 = line.charCodeAt(0);

    // Check for JSON object line (e.g. NDJSON database dumps or stealer logs)
    if (c0 === 123 /* '{' */ && line.charCodeAt(len - 1) === 125 /* '}' */) {
        try {
            const obj = JSON.parse(line);
            if (obj && typeof obj === "object") {
                const user =
                    obj.email ||
                    obj.user ||
                    obj.username ||
                    obj.login ||
                    obj.account ||
                    obj.acc ||
                    obj.mail ||
                    obj.user_name ||
                    obj.user_login ||
                    obj.login_id ||
                    obj.phone ||
                    obj.mobile;
                const pass =
                    obj.password ||
                    obj.pass ||
                    obj.pwd ||
                    obj.secret ||
                    obj.passwd ||
                    obj.passw;
                const url =
                    obj.url ||
                    obj.uri ||
                    obj.host ||
                    obj.site ||
                    obj.website ||
                    obj.link ||
                    obj.page ||
                    obj.action;
                if (user != null && pass != null) {
                    const u = unquote(String(user));
                    const p = stripTrailingMetadata(unquote(String(pass)));
                    if (u && p && !isPlaceholder(u) && !isPlaceholder(p)) {
                        if (keepUrl) {
                            if (url && isUrlOrDomain(String(url))) {
                                return `${String(url).trim()}:${u}:${p}`;
                            }
                            if (fallbackUrl) {
                                return `${fallbackUrl}:${u}:${p}`;
                            }
                        }
                        return `${u}:${p}`;
                    }
                }
                return null;
            }
        } catch (_) {}
    }


    // Strip SQL INSERT / VALUES prefix only if line starts with i/I/v/V
    const lowerC0 = c0 | 32;
    if (lowerC0 === 105 /* i */ || lowerC0 === 118 /* v */) {
        if (/^(?:INSERT\s+INTO\s+.*?\s+VALUES\s*|VALUES\s*)/i.test(line)) {
            line = line.replace(/^(?:INSERT\s+INTO\s+.*?\s+VALUES\s*|VALUES\s*)/i, "").trim();
        }
    }

    // Normalize SQL tuple parentheses: ('user', 'pass') -> 'user', 'pass'
    if (line.charCodeAt(0) === 40 /* '(' */ && line.charCodeAt(line.length - 1) === 41 /* ')' */) {
        line = line.slice(1, -1).trim();
    }

    // Normalize wrapping quotes or quoted delimiter lines (e.g. "user:pass", "user":"pass", "user","pass")
    if (line.charCodeAt(0) === 34 /* '"' */ || line.charCodeAt(0) === 39 /* "'" */) {
        const curLen = line.length;
        const quoteChar = line[0];
        if (line.charCodeAt(curLen - 1) === line.charCodeAt(0) && line.indexOf(quoteChar, 1) === curLen - 1) {
            line = line.slice(1, -1).trim();
        } else if (curLen >= 5 && /^"[^"]+"\s*[:|,]\s*"[^"]+"$/.test(line)) {
            line = line.slice(1, -1).replace(/"\s*[:|,]\s*"/, ":").trim();
        } else if (curLen >= 5 && /^'[^']+'\s*[:|,]\s*'[^']+'$/.test(line)) {
            line = line.slice(1, -1).replace(/'\s*[:|,]\s*'/, ":").trim();
        }
    }

    // Ultra-fast path: standard email:password, phone:password, or username:password lines with no URL or conflicting colons
    const fastSep = line.indexOf(":");
    if (
        fastSep > 0 &&
        line.charCodeAt(fastSep + 1) !== 47 /* '/' */ &&
        line.charCodeAt(fastSep + 1) !== 58 /* ':' */
    ) {
        const nextSep = line.indexOf(":", fastSep + 1);
        if (nextSep === -1) {
            // Exactly ONE colon on the entire line
            if (!/[|;,\t ()\[\]]/.test(line)) {
                // Zero spaces, zero delimiters, zero brackets: pristine combo
                const user = line.slice(0, fastSep);
                const userLower = user.toLowerCase();
                if (!CREDENTIAL_LABELS.has(userLower) && !PURE_FIELD_LABELS.has(userLower)) {
                    const pass = line.slice(fastSep + 1);
                    if (pass.length > 0 && !isJunkPair(user, pass)) {
                        if (user.includes("@")) {
                            if (EMAIL_RE.test(user)) {
                                return keepUrl && fallbackUrl ? `${fallbackUrl}:${line}` : line;
                            }
                        } else if (isPhone(user)) {
                            return keepUrl && fallbackUrl ? `${fallbackUrl}:${line}` : line;
                        } else if (isUsername(user, pass)) {
                            return keepUrl && fallbackUrl ? `${fallbackUrl}:${line}` : line;
                        }
                    }
                }
            } else if (!line.includes("\t") && !line.includes(",")) {
                // Has spaces or bracket/pipe metadata (e.g. "user:pass | IP: 1.2.3.4" or "user:pass [Chrome]")
                const user = line.slice(0, fastSep).trim();
                const userLower = user.toLowerCase();
                if (!user.includes(" ") && !user.includes("|") && !user.includes(";") && !CREDENTIAL_LABELS.has(userLower) && !PURE_FIELD_LABELS.has(userLower)) {
                    const rawPass = line.slice(fastSep + 1);
                    const cleanPass = stripTrailingMetadata(rawPass);
                    if (cleanPass.length > 0 && !isJunkPair(user, cleanPass)) {
                        if (user.includes("@")) {
                            if (EMAIL_RE.test(user)) {
                                return keepUrl && fallbackUrl ? `${fallbackUrl}:${user}:${cleanPass}` : `${user}:${cleanPass}`;
                            }
                        } else if (isPhone(user)) {
                            return keepUrl && fallbackUrl ? `${fallbackUrl}:${user}:${cleanPass}` : `${user}:${cleanPass}`;
                        } else if (isUsername(user, cleanPass)) {
                            return keepUrl && fallbackUrl ? `${fallbackUrl}:${user}:${cleanPass}` : `${user}:${cleanPass}`;
                        }
                    }
                }
            }
        } else {
            const thirdSep = line.indexOf(":", nextSep + 1);
            if (thirdSep === -1 && !line.includes("\t") && !line.includes(",")) {
                // Exactly TWO colons on the line, e.g. "site.com:user:pass"
                const domainToken = line.slice(0, fastSep).trim();
                if (isUrlOrDomain(domainToken)) {
                    const userToken = line.slice(fastSep + 1, nextSep).trim();
                    const userLower = userToken.toLowerCase();
                    if (!CREDENTIAL_LABELS.has(userLower) && !PURE_FIELD_LABELS.has(userLower)) {
                        const rawPass = line.slice(nextSep + 1);
                        const cleanPass = stripTrailingMetadata(rawPass);
                        if (cleanPass.length > 0 && !isJunkPair(userToken, cleanPass)) {
                            if (userToken.includes("@") ? EMAIL_RE.test(userToken) : (isPhone(userToken) || isUsername(userToken, cleanPass))) {
                                return keepUrl ? (userToken === line.slice(fastSep + 1, nextSep) && cleanPass === rawPass ? line : `${domainToken}:${userToken}:${cleanPass}`) : `${userToken}:${cleanPass}`;
                            }
                        }
                    }
                }
            }
        }
    } else if (fastSep === 4 || fastSep === 5) {
        // Fast path for URL-prefixed combos: "https://site.com/path:user@mail.com:pass"
        if (line.charCodeAt(fastSep + 1) === 47 && line.charCodeAt(fastSep + 2) === 47) {
            const afterScheme = fastSep + 3;
            const urlSep1 = line.indexOf(":", afterScheme);
            if (urlSep1 > 0) {
                const urlSep2 = line.indexOf(":", urlSep1 + 1);
                if (urlSep2 > 0 && line.indexOf(":", urlSep2 + 1) === -1 && !line.includes("\t") && !line.includes(",")) {
                    const userToken = line.slice(urlSep1 + 1, urlSep2).trim();
                    const userLower = userToken.toLowerCase();
                    if (!CREDENTIAL_LABELS.has(userLower) && !PURE_FIELD_LABELS.has(userLower)) {
                        const rawPass = line.slice(urlSep2 + 1);
                        const cleanPass = stripTrailingMetadata(rawPass);
                        if (cleanPass.length > 0 && !isJunkPair(userToken, cleanPass)) {
                            if (userToken.includes("@") ? EMAIL_RE.test(userToken) : (isPhone(userToken) || isUsername(userToken, cleanPass))) {
                                return keepUrl ? (userToken === line.slice(urlSep1 + 1, urlSep2) && cleanPass === rawPass ? line : `${line.slice(0, urlSep1).trim()}:${userToken}:${cleanPass}`) : `${userToken}:${cleanPass}`;
                            }
                        }
                    }
                }
            }
        }
    }

    // Fast check for single-line key-value pairs (e.g. "USER: admin PASS: secret")
    const kv = extractFromKeyValueLabels(line, options);
    if (kv !== null) return kv;

    // Check for "user: login pass" or "user:login pass"
    if (line.includes(" ")) {
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
                !SCHEMES.has(firstLower) &&
                !isPlaceholder(firstLower) &&
                !isPlaceholder(second)
            ) {
                return `${first}:${second}`;
            }
        }
    }

    // Pass 0: card dumps like `number|mm|yy|cvv|...extras`
    const cc = cleanCcLine(line);
    if (cc !== null) return cc;

    // Check for TSV format (tab-separated)
    if (line.includes("\t")) {
        const tsvFields = line.split(/\t+/).map((f) => unquote(f.trim())).filter((f) => f !== "");
        const tsvRes = extractFromFields(tsvFields, options);
        if (tsvRes !== null) {
            return keepUrl && fallbackUrl && !hasUrlPrefix(tsvRes) ? `${fallbackUrl}:${tsvRes}` : tsvRes;
        }
    }

    // Check for CSV format (comma-separated, respecting quotes)
    if (line.includes(",")) {
        const csvFields = splitCsvLine(line).map((f) => unquote(f.trim())).filter((f) => f !== "");
        const csvRes = extractFromFields(csvFields, options);
        if (csvRes !== null) {
            return keepUrl && fallbackUrl && !hasUrlPrefix(csvRes) ? `${fallbackUrl}:${csvRes}` : csvRes;
        }
    }

    // Check for leading label prefixes (e.g. "action:user:pass" -> "user:pass", "user:login:pass" -> "login:pass")
    const { line: strippedLine, strippedLabel } = stripLabelPrefixes(line);
    const hasColon = strippedLine.includes(":");
    const hasPipe = strippedLine.includes("|");
    const hasSemicolon = strippedLine.includes(";");

    // Check for space-separated pair (e.g. "user:login pass" -> "login:pass", "user: admin 123456" -> "admin:123456")
    if (!hasColon && !hasPipe && !hasSemicolon) {
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
            if (first && second && !second.includes(" ") && !isPlaceholder(first) && !isPlaceholder(second)) {
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

    // Fast path: standard email:password or phone:password lines with no URL/pipe/semicolon
    if (!hasPipe && !hasSemicolon) {
        const firstSep = strippedLine.indexOf(":");
        if (firstSep > 0) {
            const rawRest = strippedLine.slice(firstSep + 1).trim();
            if (rawRest && !rawRest.startsWith("//") && !rawRest.startsWith(":")) {
                const firstToken = strippedLine.slice(0, firstSep).trim();
                const rest = stripTrailingMetadata(rawRest);
                if (rest && !isJunkPair(firstToken, rest)) {
                    if (firstToken.includes("@") && isEmail(firstToken)) {
                        const pair = `${firstToken}:${rest}`;
                        return keepUrl && fallbackUrl ? `${fallbackUrl}:${pair}` : pair;
                    }
                    if (isPhone(firstToken)) {
                        const pair = `${firstToken}:${rest}`;
                        return keepUrl && fallbackUrl ? `${fallbackUrl}:${pair}` : pair;
                    }
                    if (isUsername(firstToken, rest)) {
                        const pair = `${firstToken}:${rest}`;
                        return keepUrl && fallbackUrl ? `${fallbackUrl}:${pair}` : pair;
                    }
                }
            }
        }
    }

    const candidates = extractCandidates(strippedLine);

    // Pass 1: prefer an email or number login anywhere on the line. Scanning the
    // whole line (not just the first token) is what lets us skip URL/domain
    // prefixes and grab the real credential in "url:login:pass" dumps.
    for (const { login, password } of candidates) {
        if (!password || isJunkPair(login, password)) continue;
        if (isEmail(login) || isPhone(login)) {
            if (keepUrl) {
                const norm = normalizeUlpOutput(strippedLine);
                return fallbackUrl && !hasUrlPrefix(norm) ? `${fallbackUrl}:${norm}` : norm;
            }
            return `${login}:${password}`;
        }
    }

    // Pass 2: fall back to a plain username login (only if no email/number was
    // found), skipping URL schemes, domain tokens, and pure field labels.
    // If a candidate's password contains another ':' and a later candidate is also
    // a valid username/email (e.g. "prefix:user:pass"), prefer the actual credential pair.
    let bestUsernameCandidate = null;
    for (const cand of candidates) {
        const { login, password } = cand;
        if (!password || isJunkPair(login, password)) continue;
        if (isUsername(login, password)) {
            if (password.includes(":")) {
                if (!bestUsernameCandidate) bestUsernameCandidate = cand;
                continue;
            }
            bestUsernameCandidate = cand;
            break;
        }
    }
    if (bestUsernameCandidate) {
        if (keepUrl) {
            const norm = normalizeUlpOutput(strippedLine);
            return fallbackUrl && !hasUrlPrefix(norm) ? `${fallbackUrl}:${norm}` : norm;
        }
        return `${bestUsernameCandidate.login}:${bestUsernameCandidate.password}`;
    }

    // Pass 3: when keepUrl is enabled, also support shorter or non-standard
    // usernames (1-3 chars) preceded by a URL or domain, so ULP dumps like
    // "https://site.com:sam:pass" or "site.com:bob:pass" are kept intact.
    if (keepUrl) {
        for (const { login, password } of candidates) {
            if (!password || isJunkPair(login, password)) continue;
            if (
                !SCHEMES.has(login.toLowerCase()) &&
                !PURE_FIELD_LABELS.has(login.toLowerCase()) &&
                !CREDENTIAL_LABELS.has(login.toLowerCase()) &&
                !isUrlOrDomain(login) &&
                !password.startsWith("//") &&
                login.length >= 1
            ) {
                const norm = normalizeUlpOutput(strippedLine);
                return fallbackUrl && !hasUrlPrefix(norm) ? `${fallbackUrl}:${norm}` : norm;
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
// Pre-compiled regex for stealer block header detection
const STEALER_LABEL_RE =
    /^(?:url|uri|host|hostname|site|website|web[\s_-]*site|link|page|action|form[\s_-]*action|application|app|browser|soft|software|client|username|user|user[\s_-]*name|user[\s_-]*login|login|login[\s_-]*id|account|acc|usr|email|mail)\s*[:=|]/i;

function cleanLinesArray(rawLines, options = {}) {
    if (!Array.isArray(rawLines)) {
        rawLines = rawLines ? [rawLines] : [];
    }
    const keepUrl = Boolean(options && options.keepUrl);
    const fallbackUrl = (options && (options.fallbackUrl || options.defaultUrl || options.url))
        ? String(options.fallbackUrl || options.defaultUrl || options.url).trim()
        : null;
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
        let isStealerCandidate = false;
        if (trimmed && trimmed.length >= 4) {
            let sepIdx = trimmed.indexOf(":");
            const eqIdx = trimmed.indexOf("=");
            const pipeIdx = trimmed.indexOf("|");
            if (sepIdx === -1 || (eqIdx !== -1 && eqIdx < sepIdx)) sepIdx = eqIdx;
            if (sepIdx === -1 || (pipeIdx !== -1 && pipeIdx < sepIdx)) sepIdx = pipeIdx;
            if (sepIdx >= 1 && sepIdx <= 25) {
                const firstChar = trimmed.charCodeAt(0) | 32;
                if (
                    firstChar === 117 || // u
                    firstChar === 104 || // h
                    firstChar === 115 || // s
                    firstChar === 119 || // w
                    firstChar === 108 || // l
                    firstChar === 112 || // p
                    firstChar === 97  || // a
                    firstChar === 102 || // f
                    firstChar === 98  || // b
                    firstChar === 99     // c
                ) {
                    isStealerCandidate = STEALER_LABEL_RE.test(trimmed);
                }
            }
        }
        if (isStealerCandidate) {
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
                        blockConsumed = Math.max(1, j - i);
                        break;
                    }
                    continue;
                }

                // If line already contains a full combo without field labels, stop multi-line block
                const isFieldLabelLine =
                    /^(?:url|uri|host|site|website|application|app|browser|soft|software|username|user|login|pass|password|pwd|secret|action)\s*[:=|]/i.test(
                        lineJ,
                    );
                if (!isFieldLabelLine && (lineJ.includes(":") || lineJ.includes("|"))) {
                    break;
                }

                const uMatch = lineJ.match(
                    /^(?:user(?:name|_name|_login)?|login(?:_id)?|account|acc|usr|email|mail)\s*[:=|]\s*(.+)$/i,
                );
                const pMatch = lineJ.match(/^(?:pass(?:word|wd|w)?|pwd|secret)\s*[:=|]\s*(.+)$/i);
                const urlMatch = lineJ.match(
                    /^(?:url|uri|host|site|website|link|page|action|form_action)\s*[:=|]\s*(.+)$/i,
                );

                if (uMatch) {
                    const u = unquote(uMatch[1].trim());
                    if (u && !isPlaceholder(u)) {
                        recordUser = u;
                    } else {
                        blockConsumed = j - i + 1;
                        break;
                    }
                } else if (pMatch) {
                    const p = stripTrailingMetadata(unquote(pMatch[1].trim()));
                    if (
                        p &&
                        !/^(?:unknown|null|undefined|\(empty\)|<empty>|\[empty\]|none|n\/a)$/i.test(p)
                    ) {
                        recordPass = p;
                    } else {
                        blockConsumed = j - i + 1;
                        break;
                    }
                } else if (urlMatch) {
                    recordUrl = unquote(urlMatch[1].trim());
                }

                if (recordUser && recordPass) {
                    if (keepUrl && !recordUrl && j + 1 < Math.min(i + 8, len)) {
                        const nextLine = normalizeLine(rawLines[j + 1]);
                        const nextUrlMatch = nextLine.match(
                            /^(?:url|uri|host|site|website|link|page|action|form_action)\s*[:=|]\s*(.+)$/i,
                        );
                        if (nextUrlMatch) {
                            recordUrl = nextUrlMatch[1].trim();
                            j++;
                        }
                    }
                    foundRecord = true;
                    blockConsumed = j - i + 1;
                    break;
                }
            }

            if (foundRecord && recordUser && recordPass) {
                let res;
                if (keepUrl && recordUrl && isUrlOrDomain(recordUrl)) {
                    res = `${recordUrl}:${recordUser}:${recordPass}`;
                } else if (keepUrl && fallbackUrl) {
                    res = `${fallbackUrl}:${recordUser}:${recordPass}`;
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
                const advance = Math.max(1, blockConsumed);
                dropped += Math.max(0, advance - 1);
                i += advance;
                continue;
            }

            if (!foundRecord && blockConsumed > 0) {
                dropped += blockConsumed;
                i += blockConsumed;
                continue;
            }
        }

        // Standard single-line processing
        const res = cleanLine(trimmed, options);
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

/**
 * Extract ONLY the cleaned `user:password` or `email:password` from any credential line,
 * completely stripping any URL, scheme, or domain prefix.
 *
 * @param {string} rawLine
 * @returns {string|null}
 */
function cleanUserPassOnly(rawLine) {
    if (!rawLine || typeof rawLine !== "string") return null;
    const trimmed = rawLine.trim();
    if (!trimmed) return null;

    // Standard path: cleanLine with keepUrl: false strips all domain/URL prefixes
    const cleaned = cleanLine(trimmed, { keepUrl: false });
    if (cleaned) return cleaned;

    // Fallback if cleanLine returned null:
    // Check if line starts with URL scheme (e.g. https://site.com/path:user:pass)
    const schemeIdx = trimmed.indexOf("://");
    if (schemeIdx > 0) {
        const nextColon = trimmed.indexOf(":", schemeIdx + 3);
        if (nextColon > 0) {
            const remainder = trimmed.slice(nextColon + 1).trim();
            const subClean = cleanLine(remainder, { keepUrl: false });
            if (subClean) return subClean;
            if (remainder.includes(":")) return remainder;
        }
    }

    // Check if line starts with domain prefix (e.g. domain.com:user:pass)
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0) {
        const prefix = trimmed.slice(0, colonIdx).trim().toLowerCase();
        if ((prefix.includes(".") || prefix.includes("/")) && trimmed.indexOf(":", colonIdx + 1) > 0) {
            const remainder = trimmed.slice(colonIdx + 1).trim();
            const subClean = cleanLine(remainder, { keepUrl: false });
            if (subClean) return subClean;
            if (remainder.includes(":")) return remainder;
        }
    }

    return trimmed;
}

/**
 * Extract clean hostname/domain from a query if it contains a URL or domain with protocol/path/port.
 * E.g. "https://netflix.com/login" -> "netflix.com", "www.netflix.com" -> "netflix.com"
 *
 * @param {string} rawQuery
 * @returns {string|null}
 */
function extractSearchDomain(rawQuery) {
    if (!rawQuery || typeof rawQuery !== "string") return null;
    let s = rawQuery.trim();
    if (/^https?:\/\//i.test(s)) {
        try {
            const parsed = new URL(s);
            s = parsed.hostname;
        } catch {
            s = s.replace(/^https?:\/\//i, "").split(/[/?#:]/)[0];
        }
    } else if (s.includes("/") && !s.includes(" ")) {
        s = s.split(/[/?#:]/)[0];
    }
    s = s.replace(/^www\./i, "").replace(/:\d+$/, "").trim();
    if (s.includes(".") && !s.includes("@") && s.length >= 3) {
        return s.toLowerCase();
    }
    return null;
}

/**
 * Safely decodes a buffer to text with automatic encoding detection (UTF-8, UTF-16LE, UTF-16BE, UTF-8 BOM).
 * Handles stealer dumps and Windows password files that use wide UTF-16 characters.
 *
 * @param {Buffer} buf
 * @returns {string}
 */
function decodeBufferToText(buf) {
    if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) return "";

    // UTF-16LE BOM: FF FE
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        return buf.subarray(2).toString("utf16le");
    }
    // UTF-16BE BOM: FE FF
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        const swapped = Buffer.allocUnsafe(buf.length - 2);
        for (let i = 2; i < buf.length - 1; i += 2) {
            swapped[i - 2] = buf[i + 1];
            swapped[i - 1] = buf[i];
        }
        return swapped.toString("utf16le");
    }
    // UTF-8 BOM: EF BB BF
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        return buf.subarray(3).toString("utf8");
    }

    // Detect UTF-16LE without BOM: ASCII characters alternate with 0x00 null bytes
    const checkLen = Math.min(buf.length, 256);
    if (checkLen >= 4) {
        let nullOdds = 0;
        let nullEvens = 0;
        for (let i = 0; i < checkLen; i++) {
            if (buf[i] === 0) {
                if (i % 2 === 1) nullOdds++;
                else nullEvens++;
            }
        }
        if (nullOdds > checkLen / 4 && nullEvens === 0) {
            return buf.toString("utf16le");
        }
        if (nullEvens > checkLen / 4 && nullOdds === 0) {
            const swapped = Buffer.allocUnsafe(buf.length);
            for (let i = 0; i < buf.length - 1; i += 2) {
                swapped[i] = buf[i + 1];
                swapped[i + 1] = buf[i];
            }
            return swapped.toString("utf16le");
        }
    }

    return buf.toString("utf8");
}

/**
 * Reconstruct a complete credential combo [url:]user:pass from lines surrounding a stealer label match.
 *
 * @param {string[]} lines
 * @param {number} matchIdx
 * @returns {string|null}
 */
function resolveStealerRecordFromLines(lines, matchIdx) {
    if (!Array.isArray(lines) || matchIdx < 0 || matchIdx >= lines.length) return null;
    const matchLine = lines[matchIdx].trim();
    const isLabel = /^(?:url|uri|host|site|website|hostname|application|app|browser|soft|software|username|user|login|pass|password|pwd|secret|action)\s*[:=|]/i.test(matchLine);
    if (!isLabel) return null;

    // Constrain search within the current block boundaries
    let start = matchIdx;
    while (start > 0 && matchIdx - start < 10) {
        const prev = lines[start - 1].trim();
        if (!prev || /^[-=_*#~]{3,}$/.test(prev)) break;
        // Stop if preceding line is another URL and we are on or past a URL
        if (/^(?:url|uri|host|site|website|hostname)\s*[:=|]/i.test(prev) && /^(?:url|uri|host|site|website|hostname)\s*[:=|]/i.test(matchLine)) break;
        start--;
    }

    let end = matchIdx;
    while (end < lines.length - 1 && end - matchIdx < 10) {
        const next = lines[end + 1].trim();
        if (!next || /^[-=_*#~]{3,}$/.test(next)) break;
        // Stop if following line starts a new record (new URL)
        if (/^(?:url|uri|host|site|website|hostname)\s*[:=|]/i.test(next)) break;
        end++;
    }

    let u = null;
    let p = null;
    let url = null;

    for (let i = start; i <= end; i++) {
        const l = lines[i].trim();
        const uM = l.match(/^(?:user(?:[\s_-]*name|[\s_-]*login)?|login(?:[\s_-]*id)?|account|acc|usr|email|mail)\s*[:=|]\s*(.+)$/i);
        const pM = l.match(/^(?:pass(?:[\s_-]*word|wd|w)?|pwd|secret)\s*[:=|]\s*(.+)$/i);
        const urlM = l.match(/^(?:url|uri|host|site|website|link|page|hostname|action|form[\s_-]*action)\s*[:=|]\s*(.+)$/i);
        if (uM && !u) u = uM[1].trim();
        else if (pM && !p) p = pM[1].trim();
        else if (urlM && !url) url = urlM[1].trim();
    }

    if (u && p) {
        return url ? `${url}:${u}:${p}` : `${u}:${p}`;
    }
    return null;
}

/**
 * Fast case-insensitive string matcher without per-line string allocations.
 * Precompiles a case-insensitive RegExp from an escaped query string.
 * Supports matching both literal query and normalized domain/host (e.g. "https://site.com" -> "site.com").
 *
 * @param {string} query
 * @returns {((line: string) => boolean)|null}
 */
function createSearchMatcher(query) {
    const q = String(query || "").trim();
    if (!q) return null;
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "i");

    const qLower = q.toLowerCase();
    const qUpper = q.toUpperCase();
    const qTitle = q.length > 1 ? q[0].toUpperCase() + q.slice(1).toLowerCase() : qUpper;
    const hasCaseDiff = qLower !== qUpper;
    const hasTitleDiff = qTitle !== qLower && qTitle !== qUpper;

    const domain = extractSearchDomain(q);
    if (domain && domain.toLowerCase() !== qLower) {
        const domainEscaped = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const domainRegex = new RegExp(domainEscaped, "i");
        const dLower = domain.toLowerCase();
        const dUpper = domain.toUpperCase();
        const dTitle = domain.length > 1 ? domain[0].toUpperCase() + domain.slice(1).toLowerCase() : dUpper;
        const dHasCaseDiff = dLower !== dUpper;
        const dHasTitleDiff = dTitle !== dLower && dTitle !== dUpper;

        return (line) => {
            if (typeof line !== "string") return false;
            // Lightning fast native C++ substring checks
            if (line.includes(qLower)) return true;
            if (hasTitleDiff && line.includes(qTitle)) return true;
            if (hasCaseDiff && line.includes(qUpper)) return true;
            if (line.includes(dLower)) return true;
            if (dHasTitleDiff && line.includes(dTitle)) return true;
            if (dHasCaseDiff && line.includes(dUpper)) return true;
            // Case-insensitive regex fallback for mixed-case variations
            return regex.test(line) || domainRegex.test(line);
        };
    }

    return (line) => {
        if (typeof line !== "string") return false;
        // Lightning fast native C++ substring checks
        if (line.includes(qLower)) return true;
        if (hasTitleDiff && line.includes(qTitle)) return true;
        if (hasCaseDiff && line.includes(qUpper)) return true;
        // Case-insensitive regex fallback for mixed-case variations
        return regex.test(line);
    };
}

/**
 * Fast case-insensitive search across a Buffer without splitting lines or allocating strings for non-matches.
 * Automatically decodes UTF-16LE / BOM buffers.
 * Uses Boyer-Moore-Horspool for ASCII queries and RegExp for non-ASCII queries.
 * Reconstructs multi-line stealer records and normalizes URL queries into matching domains.
 *
 * @param {Buffer} buf
 * @param {string} query
 * @param {number} [limit=20]
 * @returns {{ total: number, matches: string[] }}
 */
function searchBufferCI(buf, query, limit = 20) {
    const rawQ = String(query || "").trim();
    if (!rawQ || !buf || buf.length === 0) return { total: 0, matches: [] };

    // Check if buffer is UTF-16LE or has BOM
    const isUtf16 = (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) ||
        (buf.length >= 4 && buf[1] === 0x00 && buf[3] === 0x00);
    if (isUtf16) {
        const text = decodeBufferToText(buf);
        const matcher = createSearchMatcher(rawQ);
        const lines = text.split(/\r?\n/);
        const matches = [];
        let total = 0;
        const maxMatches = typeof limit === "number" && limit > 0 ? limit : 20;
        for (let j = 0; j < lines.length; j++) {
            let line = lines[j];
            if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
            if (matcher && matcher(line)) {
                total++;
                if (matches.length < maxMatches) {
                    let matchResult = line;
                    const trimmedLine = line.trim();
                    if (STEALER_LABEL_RE && STEALER_LABEL_RE.test(trimmedLine)) {
                        const stealerRec = resolveStealerRecordFromLines(lines, j);
                        if (stealerRec) matchResult = stealerRec;
                    }
                    if (matches.length === 0 || matches[matches.length - 1] !== matchResult) {
                        matches.push(matchResult);
                    }
                }
            }
        }
        return { total, matches };
    }

    const domain = extractSearchDomain(rawQ);
    const q = (domain && domain.length >= 3 && domain.length < rawQ.length) ? domain : rawQ;

    const matches = [];
    let total = 0;
    const len = buf.length;
    const maxMatches = typeof limit === "number" && limit > 0 ? limit : 20;

    const isAscii = !/[^\x00-\x7F]/.test(q);

    if (isAscii && q.length <= 256) {
        const m = q.length;
        const qLower = q.toLowerCase();
        const table = new Uint8Array(256);
        table.fill(m);
        for (let i = 0; i < m - 1; i++) {
            const c = qLower.charCodeAt(i);
            table[c] = m - 1 - i;
            if (c >= 97 && c <= 122) table[c - 32] = m - 1 - i;
        }

        let i = m - 1;
        while (i < len) {
            let k = 0;
            while (k < m) {
                let b = buf[i - k];
                if (b >= 65 && b <= 90) b += 32;
                if (b !== qLower.charCodeAt(m - 1 - k)) break;
                k++;
            }
            if (k === m) {
                const hit = i - m + 1;
                let lineEnd = buf.indexOf(0x0a, hit);
                if (lineEnd === -1) lineEnd = len;

                total++;
                if (matches.length < maxMatches) {
                    let lineStart = buf.lastIndexOf(0x0a, hit);
                    lineStart = lineStart === -1 ? 0 : lineStart + 1;

                    let line = buf.subarray(lineStart, lineEnd).toString("utf8");
                    if (line.endsWith("\r")) line = line.slice(0, -1);
                    if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);

                    let matchResult = line;
                    const trimmedLine = line.trim();
                    if (STEALER_LABEL_RE && STEALER_LABEL_RE.test(trimmedLine)) {
                        // Snap window to line boundaries
                        let winStart = Math.max(0, lineStart - 1000);
                        if (winStart > 0) {
                            const nl = buf.indexOf(0x0a, winStart);
                            if (nl !== -1 && nl < lineStart) winStart = nl + 1;
                        }
                        let winEnd = Math.min(len, lineEnd + 1000);
                        if (winEnd < len) {
                            const nl = buf.indexOf(0x0a, winEnd);
                            if (nl !== -1) winEnd = nl;
                        }

                        // Exact target index by counting newlines before lineStart
                        let targetIdx = 0;
                        for (let p = winStart; p < lineStart; p++) {
                            if (buf[p] === 0x0a) targetIdx++;
                        }

                        const winText = buf.subarray(winStart, winEnd).toString("utf8");
                        const winLines = winText.split(/\r?\n/);
                        if (targetIdx >= 0 && targetIdx < winLines.length) {
                            const stealerRec = resolveStealerRecordFromLines(winLines, targetIdx);
                            if (stealerRec) matchResult = stealerRec;
                        }
                    }
                    if (matches.length === 0 || matches[matches.length - 1] !== matchResult) {
                        matches.push(matchResult);
                    }
                }

                i = lineEnd + m;
            } else {
                i += table[buf[i]];
            }
        }
        return { total, matches };
    }

    const text = buf.toString("utf8");
    const matcher = createSearchMatcher(rawQ);
    const lines = text.split(/\r?\n/);
    for (let j = 0; j < lines.length; j++) {
        let line = lines[j];
        if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
        if (matcher && matcher(line)) {
            total++;
            if (matches.length < maxMatches) {
                let matchResult = line;
                const trimmedLine = line.trim();
                if (STEALER_LABEL_RE && STEALER_LABEL_RE.test(trimmedLine)) {
                    const stealerRec = resolveStealerRecordFromLines(lines, j);
                    if (stealerRec) matchResult = stealerRec;
                }
                if (matches.length === 0 || matches[matches.length - 1] !== matchResult) {
                    matches.push(matchResult);
                }
            }
        }
    }
    return { total, matches };
}

module.exports = {
    cleanLine,
    cleanUserPassOnly,
    createSearchMatcher,
    searchBufferCI,
    extractSearchDomain,
    resolveStealerRecordFromLines,
    decodeBufferToText,
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
    splitCsvLine,
    isPlaceholder,
};
