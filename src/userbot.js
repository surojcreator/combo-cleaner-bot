"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { cleanLine, isEmail, isPhone, isCcLine, PURE_FIELD_LABELS, CREDENTIAL_LABELS } = require("./cleaner");

/**
 * MTProto "userbot" transport — the bypass for sealed search bots.
 *
 * Bot-to-bot private chats require the *other* bot's owner to enable
 * "Bot-to-Bot Communication" in @BotFather. When that is impossible, this
 * transport instead talks to the searcher bot from a **user account**: exactly
 * what the operator would do by hand, only paced and relayed automatically.
 *
 *   /ulp htzone.co.il  ->  userbot sends "htzone.co.il", then "hist:full:day"
 *                          (7s apart, capped retries)
 *                       ->  every answer from the searcher bot is forwarded into
 *                          the chat that asked, so it can be cleaned into the batch
 *
 * Requires TELEGRAM_API_ID, TELEGRAM_API_HASH and TELEGRAM_SESSION
 * (`npm run userbot:login` prints the session string).
 *
 * The library is loaded lazily so the bot still boots without it installed.
 */

/** Marker put in front of copied (non-forwardable) results. */
const ULP_MARKER = "#ulp";

/** Default timeout for a single MTProto call. */
const CALL_TIMEOUT_MS = 25000;

/**
 * Read userbot settings from the environment.
 * @param {NodeJS.ProcessEnv} [env]
 */
function loadConfig(env = process.env) {
    env = env || process.env || {};
    const apiId = Number(env.TELEGRAM_API_ID || 0);
    return {
        apiId: Number.isFinite(apiId) ? apiId : 0,
        apiHash: String(env.TELEGRAM_API_HASH || "").trim(),
        session: String(env.TELEGRAM_SESSION || "").trim(),
        searcher: String(env.SEARCH_BOT_USERNAME || "DumpNews14Bot").replace(/^@+/, ""),
        transport: String(env.SEARCH_TRANSPORT || "auto").trim().toLowerCase(),
        botUsername: String(env.BOT_USERNAME || "").replace(/^@+/, ""),
    };
}

/**
 * Is the userbot fully configured?
 * @param {ReturnType<typeof loadConfig>} cfg
 */
function isConfigured(cfg) {
    return Boolean(cfg && cfg.apiId > 0 && cfg.apiHash && cfg.session);
}

/**
 * Map an MTProto error to the relay's error kinds.
 * @param {any} err
 * @returns {"userbot_auth"|"not_found"|"flood_wait"|"blocked"|"other"}
 */
function classifyUserbotError(err) {
    const text = String((err && (err.errorMessage || err.message)) || "");
    if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|SESSION_PASSWORD_NEEDED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED|AUTH_KEY_INVALID|SESSION_INVALID|USERBOT_NOT_READY|API_ID_INVALID/i.test(text)) {
        return "userbot_auth";
    }
    if (/USERNAME_NOT_OCCUPIED|USERNAME_INVALID|PEER_ID_INVALID|USER_NOT_FOUND|CHANNEL_INVALID/i.test(text)) {
        return "not_found";
    }
    if (/FLOOD_WAIT|SLOW_MODE_WAIT|FROZEN_METHOD_INVALID/i.test(text)) {
        return "flood_wait";
    }
    if (/PRIVACY_RESTRICTED|YOU_BLOCKED_USER|CHAT_WRITE_FORBIDDEN|USER_IS_BLOCKED/i.test(text)) {
        return "blocked";
    }
    return "other";
}

/**
 * Load the MTProto library lazily.
 */
function loadLibs() {
    // eslint-disable-next-line global-require
    const { TelegramClient, Api } = require("teleproto");
    // eslint-disable-next-line global-require
    const { StringSession } = require("teleproto/sessions");
    // eslint-disable-next-line global-require
    const { NewMessage } = require("teleproto/events");
    // eslint-disable-next-line global-require
    const { getPeerId } = require("teleproto/Utils");
    return { TelegramClient, Api, StringSession, NewMessage, getPeerId };
}

/**
 * Reject after `ms` so a stuck MTProto call can't block a run forever.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, label) {
    let timer;
    const guard = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        if (timer && typeof timer.unref === "function") timer.unref();
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * Turn a Telegram document name into a safe local filename.
 * @param {string} raw
 */
function safeDownloadName(raw) {
    if (!raw || raw === "undefined" || raw === "null" || raw === "file" || raw === "telegram-undefined.bin") {
        return "telegram-file.bin";
    }
    const normalized = String(raw || "telegram-file.bin")
        .replace(/\\/g, "/")
        .replace(/\0/g, "");
    const base = path.posix.basename(normalized);
    let safe = base
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
        .replace(/\s+/g, " ")
        .replace(/^\.+/, "")
        .replace(/[. ]+$/, "")
        .slice(0, 180);
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) {
        safe = `_${safe}`;
    }
    return safe || "telegram-file.bin";
}

function isUnnamedName(val) {
    if (!val || typeof val !== "string") return true;
    const s = val.trim().toLowerCase();
    if (!s) return true;
    const baseWithoutExt = s.replace(/\.[a-z0-9_]+$/i, "");
    return (
        s === "file" ||
        s === "undefined" ||
        s === "null" ||
        s === "unknown" ||
        s === "unnamed" ||
        s === "telegram-file.bin" ||
        s === "ulp-result.bin" ||
        s.startsWith("telegram-undefined") ||
        s.startsWith("ulp-result-") ||
        baseWithoutExt === "unnamed" ||
        baseWithoutExt === "file" ||
        baseWithoutExt === "undefined" ||
        baseWithoutExt === "null" ||
        baseWithoutExt === "unknown" ||
        baseWithoutExt.startsWith("unnamed_") ||
        baseWithoutExt.startsWith("unnamed-")
    );
}

/**
 * Bulletproof filename resolution helper:
 * Extracts filename from GramJS message attributes, Telegraf document objects,
 * or inspects MIME types before falling back to a structured timestamped name.
 *
 * @param {any} doc
 * @param {string} [defaultBase]
 * @param {string} [ext]
 * @returns {string}
 */
function resolveSafeFileName(doc, defaultBase = "combolist", ext = ".txt") {
    let name = "";
    if (typeof doc === "string" && doc.trim()) {
        name = doc.trim();
    } else if (doc && typeof doc === "object") {
        name = doc.file_name || doc.fileName || doc.filename || "";

        if (!name && doc.media && doc.media.document && Array.isArray(doc.media.document.attributes)) {
            const attr = doc.media.document.attributes.find((a) => a && (a.fileName || a.file_name));
            if (attr) name = attr.fileName || attr.file_name || "";
        }

        if (!name && doc.document && Array.isArray(doc.document.attributes)) {
            const attr = doc.document.attributes.find((a) => a && (a.fileName || a.file_name));
            if (attr) name = attr.fileName || attr.file_name || "";
        }

        const mime = doc.mime_type || doc.mimeType ||
            (doc.media && doc.media.document && doc.media.document.mimeType) ||
            (doc.document && (doc.document.mime_type || doc.document.mimeType)) || "";
        if (mime) {
            if (mime.includes("zip")) ext = ".zip";
            else if (mime.includes("csv")) ext = ".csv";
            else if (mime.includes("json")) ext = ".json";
            else if (mime.includes("text") || mime.includes("plain")) ext = ".txt";
        }
    }

    if (isUnnamedName(name)) {
        name = "";
    }

    if (!name) {
        const stamp = new Date().toISOString().slice(0, 10);
        const safeBase = (defaultBase && typeof defaultBase === "string" && defaultBase.trim() && !isUnnamedName(defaultBase))
            ? defaultBase.trim()
            : "combolist";
        name = `${safeBase}_${stamp}${ext}`;
    }

    return safeDownloadName(name);
}

/** Build a collision-resistant destination path under the configured root. */
function downloadPath(root, rawName, messageId) {
    const safeRoot = typeof root === "string" && root ? root : ".";
    const name = safeDownloadName(rawName);
    const ext = path.extname(name).slice(0, 16);
    const stem = path.basename(name, ext).slice(0, 140) || "telegram-file";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return path.join(path.resolve(safeRoot), `${stem}_${messageId || Date.now()}_${stamp}${ext}`);
}

/** Normalize Telegram's marked peer ids (including -100... supergroups). */
function markedPeerId(value) {
    return String(value == null ? "" : value).trim();
}

/**
 * Format a Date object to "DD.MM.YYYY" (e.g. "20.09.2026").
 * @param {Date} [date]
 * @returns {string}
 */
function formatDateDmy(date = new Date()) {
    const dObj = (date instanceof Date && !Number.isNaN(date.getTime())) ? date : new Date();
    const d = String(dObj.getDate()).padStart(2, "0");
    const m = String(dObj.getMonth() + 1).padStart(2, "0");
    const y = String(dObj.getFullYear());
    return `${d}.${m}.${y}`;
}

/**
 * Return a new Date representing the previous day.
 * @param {Date} date
 * @returns {Date}
 */
function previousDate(date) {
    const dObj = (date instanceof Date && !Number.isNaN(date.getTime())) ? date : new Date();
    const prev = new Date(dObj.getTime());
    prev.setDate(prev.getDate() - 1);
    return prev;
}

/**
 * Parse "DD.MM.YYYY" or "DD/MM/YYYY" to Date.
 * @param {string} str
 * @returns {Date|null}
 */
function parseDmyDate(str) {
    const m = String(str || "").trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (!m) return null;
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10) - 1;
    const year = parseInt(m[3], 10);
    if (month < 0 || month > 11 || day < 1 || day > 31) return null;
    const d = new Date(year, month, day);
    if (Number.isNaN(d.getTime())) return null;
    if (d.getFullYear() !== year || d.getMonth() !== month || d.getDate() !== day) return null;
    return d;
}

/**
 * Parse any date string format (DD.MM.YYYY, DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD, YYYY.MM.DD).
 * @param {string} str
 * @returns {Date|null}
 */
function parseAnyDate(str) {
    if (!str) return null;
    const s = String(str).trim();
    const dmy = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (dmy) {
        return parseDmyDate(`${dmy[1]}.${dmy[2]}.${dmy[3]}`);
    }
    const ymd = s.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
    if (ymd) {
        return parseDmyDate(`${ymd[3]}.${ymd[2]}.${ymd[1]}`);
    }
    return null;
}

/**
 * Check if a button matches target date in any representation.
 * @param {any} btn
 * @param {Date} targetDate
 * @returns {boolean}
 */
function buttonMatchesDate(btn, targetDate) {
    if (!btn || !targetDate || Number.isNaN(targetDate.getTime())) return false;
    let dataStr = "";
    try {
        dataStr = btn.type && btn.type.data ? btn.type.data.toString() : (Buffer.isBuffer(btn.data) ? btn.data.toString("utf8") : String(btn.data || ""));
    } catch {
        dataStr = "";
    }
    const textStr = String(btn.text || "");

    const d = targetDate.getDate();
    const dPad = String(d).padStart(2, "0");
    const m = targetDate.getMonth() + 1;
    const mPad = String(m).padStart(2, "0");
    const y = targetDate.getFullYear();
    const y2 = String(y).slice(-2);

    const variants = [
        `${dPad}.${mPad}.${y}`,
        `${d}.${m}.${y}`,
        `${dPad}-${mPad}-${y}`,
        `${d}-${m}-${y}`,
        `${y}-${mPad}-${dPad}`,
        `${y}.${mPad}.${dPad}`,
        `${dPad}/${mPad}/${y}`,
        `${d}/${m}/${y}`,
        `${dPad}.${mPad}.${y2}`,
        `${d}.${m}.${y2}`,
        `${dPad}/${mPad}/${y2}`,
        `${d}/${m}/${y2}`,
        `${dPad}-${mPad}-${y2}`,
        `${d}-${m}-${y2}`,
        `${dPad}.${mPad}`,
        `${dPad}/${mPad}`,
        `${dPad}-${mPad}`,
        `${d}.${m}`,
        `${dPad}_${mPad}_${y}`,
        `${y}_${mPad}_${dPad}`,
    ];

    for (const v of variants) {
        if (
            dataStr.startsWith(`folder:${v}:`) ||
            dataStr === `folder:${v}` ||
            dataStr.includes(v) ||
            textStr.includes(v)
        ) {
            return true;
        }
    }
    return false;
}

/**
 * Check if message contains date folder or menu pagination buttons.
 * @param {any} m
 * @returns {boolean}
 */
/**
 * Raw callback payload bytes from a GramJS/teleproto keyboard button.
 * MUST stay binary — Telegram rejects re-encoded UTF-8 with
 * "Encrypted data invalid" on messages.GetBotCallbackAnswer.
 * @param {any} btn
 * @returns {Buffer|null}
 */
function buttonDataBuffer(btn) {
    if (!btn) return null;
    try {
        const raw =
            (btn.type && btn.type.data != null ? btn.type.data : null) ??
            (btn.data != null ? btn.data : null);
        if (raw == null) return null;
        if (Buffer.isBuffer(raw)) return raw;
        if (raw instanceof Uint8Array) return Buffer.from(raw);
        if (typeof raw === "string") return Buffer.from(raw, "utf8");
        if (Array.isArray(raw)) return Buffer.from(raw);
        // BigInt / number-like — uncommon, stringify as utf8 last resort
        if (typeof raw === "object" && raw.buffer && ArrayBuffer.isView(raw)) {
            return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
        }
        return Buffer.from(String(raw), "utf8");
    } catch {
        return null;
    }
}

function buttonDataString(btn) {
    const buf = buttonDataBuffer(btn);
    if (!buf) return "";
    try {
        return buf.toString("utf8");
    } catch {
        return "";
    }
}

/** Page indicator like "1/5" in DUMP // Base 34 style menus — not a date, not a nav click target. */
function isPageIndicatorButton(btn) {
    if (!btn) return false;
    const text = String(btn.text || "").replace(/\s+/g, "").trim();
    if (/^\d+\/\d+$/.test(text)) return true;
    const dataStr = buttonDataString(btn);
    if (/page.?info|pages|pager|counter/i.test(dataStr)) return true;
    return false;
}

function isNextPageButton(btn) {
    if (!btn) return false;
    if (isPageIndicatorButton(btn)) return false;
    const dataStr = buttonDataString(btn);
    const text = String(btn.text || "").trim();
    // Explicit prev → never next
    if (
        text.includes("⬅️") || text.includes("◀") || text.includes("◁") || text.includes("‹") ||
        text.includes("◀️") || text.includes("<<") || text.includes("←") || text.includes("⇦") ||
        /^(prev|back|назад|пред)$/i.test(text) || /prev|назад|пред/i.test(text)
    ) {
        return false;
    }
    // Bare arrows used by DUMP // Base 34 style UIs
    if (
        text === "→" || text === "⇒" || text === "➡" || text === "➡️" || text === "▶️" ||
        text === "▶" || text === "▷" || text === "›" || text === "»" || text === ">>" ||
        text === ">" || text === "≫" || text === "↦" || text === "↪"
    ) {
        return true;
    }
    if (/next|след|далее|forward/i.test(text)) return true;
    // Callback data heuristics
    if (/next|forward|page[_-]?(up|right|\+|inc)/i.test(dataStr)) return true;
    const pageMatch = dataStr.match(/(?:menu:)?page[=:_-]?(\d+)/i);
    if (pageMatch) {
        const n = Number(pageMatch[1]);
        // page 0 is usually home/first; higher index = next
        return Number.isFinite(n) && n > 0;
    }
    // row position fallback handled in findNavButton when text is empty icon button
    return false;
}

function isPrevPageButton(btn) {
    if (!btn) return false;
    if (isPageIndicatorButton(btn)) return false;
    const dataStr = buttonDataString(btn);
    const text = String(btn.text || "").trim();
    if (
        text === "←" || text === "⇐" || text === "⬅" || text === "⬅️" || text === "◀️" ||
        text === "◀" || text === "◁" || text === "‹" || text === "«" || text === "<<" ||
        text === "<" || text === "≪" || text === "↤" || text === "↩"
    ) {
        return true;
    }
    if (/^(prev|back|назад|пред)$/i.test(text) || /prev|назад|пред/i.test(text)) return true;
    if (/prev|back|page[_-]?(down|left|dec|-)/i.test(dataStr)) return true;
    if (dataStr === "menu:page:0" || /(?:menu:)?page[=:_-]?0\b/i.test(dataStr)) return true;
    return false;
}

function isBackButton(btn) {
    if (!btn) return false;
    // Never treat pagination as "back" — menu:page:N is Next/Prev, not root.
    if (isNextPageButton(btn) || isPrevPageButton(btn)) return false;
    const dataStr = buttonDataString(btn).toLowerCase();
    const text = String(btn.text || "").toLowerCase();
    if (/^menu:page:/i.test(dataStr)) return false;
    return (
        dataStr.includes("back") ||
        dataStr === "home" ||
        dataStr === "main" ||
        dataStr === "/start" ||
        dataStr === "menu" ||
        dataStr === "menu:root" ||
        dataStr === "menu:main" ||
        text.includes("back") ||
        text.includes("назад") ||
        text.includes("меню") ||
        text.includes("home") ||
        text.includes("↩") ||
        text.includes("🔙")
    );
}

function isUtilityButton(btn) {
    if (!btn) return false;
    if (isPageIndicatorButton(btn) || isNextPageButton(btn) || isPrevPageButton(btn) || isBackButton(btn)) return true;
    const text = String(btn.text || "").toLowerCase();
    const dataStr = buttonDataString(btn).toLowerCase();
    // DUMP // Base 34 style: Language / Info footers
    if (/language|язык|info|about|help|start|settings|настройки/.test(text)) return true;
    if (/lang|language|info|about|help|settings/.test(dataStr)) return true;
    return false;
}

function extractFolderDatesFromMessage(menuMsg) {
    const out = [];
    if (!menuMsg || !menuMsg.replyMarkup || !Array.isArray(menuMsg.replyMarkup.rows)) return out;
    for (const row of menuMsg.replyMarkup.rows) {
        if (!row || !Array.isArray(row.buttons)) continue;
        for (const btn of row.buttons) {
            if (!btn) continue;
            if (isUtilityButton(btn)) continue;
            const dataBuf = buttonDataBuffer(btn);
            const dataStr = dataBuf ? dataBuf.toString("utf8") : "";
            const textStr = String(btn.text || "");
            // Prefer full DD.MM.YYYY (DUMP // Base 34 calendar rows)
            const dmy =
                dataStr.match(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/) ||
                textStr.match(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/);
            if (!dmy) continue;
            const parsed = parseDmyDate(`${dmy[1]}.${dmy[2]}.${dmy[3]}`);
            if (!parsed) continue;
            out.push({
                date: parsed,
                dateStr: formatDateDmy(parsed),
                text: textStr,
                // Keep RAW bytes for GetBotCallbackAnswer — never re-encode.
                data: dataBuf || Buffer.from(dataStr, "utf8"),
                dataStr,
                messageId: Number(menuMsg.id) || 0,
            });
        }
    }
    return out;
}

function findNavButton(menuMsg, kind = "next") {
    if (!menuMsg || !menuMsg.replyMarkup || !Array.isArray(menuMsg.replyMarkup.rows)) return null;

    // Pass 1: semantic match (text / data)
    for (const row of menuMsg.replyMarkup.rows) {
        if (!row || !Array.isArray(row.buttons)) continue;
        for (const btn of row.buttons) {
            if (!btn) continue;
            if (isPageIndicatorButton(btn)) continue;
            const data = buttonDataBuffer(btn);
            if (kind === "next" && isNextPageButton(btn)) {
                return { text: String(btn.text || ""), data };
            }
            if (kind === "prev" && isPrevPageButton(btn)) {
                return { text: String(btn.text || ""), data };
            }
            if (kind === "back" && isBackButton(btn)) {
                return { text: String(btn.text || ""), data };
            }
        }
    }

    // Pass 2: DUMP // Base 34 style pager row: [ ← ] [ 1/5 ] [ → ]
    // Identify by a 3-button row whose middle is a page indicator.
    if (kind === "next" || kind === "prev") {
        for (const row of menuMsg.replyMarkup.rows) {
            if (!row || !Array.isArray(row.buttons) || row.buttons.length < 2) continue;
            const btns = row.buttons.filter(Boolean);
            if (btns.length < 2) continue;
            const mid = btns.length === 3 ? btns[1] : null;
            const hasIndicator = mid ? isPageIndicatorButton(mid) : btns.some(isPageIndicatorButton);
            if (!hasIndicator && btns.length !== 3) continue;

            if (kind === "prev") {
                const left = btns[0];
                if (left && !isPageIndicatorButton(left) && !isUtilityButton(left)) {
                    // Prefer left if it's clearly prev OR unknown icon in pager row
                    if (isPrevPageButton(left) || (!isNextPageButton(left) && hasIndicator)) {
                        return { text: String(left.text || ""), data: buttonDataBuffer(left) };
                    }
                }
            }
            if (kind === "next") {
                const right = btns[btns.length - 1];
                if (right && !isPageIndicatorButton(right) && !isUtilityButton(right)) {
                    if (isNextPageButton(right) || (!isPrevPageButton(right) && hasIndicator)) {
                        return { text: String(right.text || ""), data: buttonDataBuffer(right) };
                    }
                }
            }
        }
    }
    return null;
}

function isMenuMessage(m) {
    if (!m || !m.replyMarkup || !Array.isArray(m.replyMarkup.rows)) return false;
    let dateLike = 0;
    for (const row of m.replyMarkup.rows) {
        if (!row || !Array.isArray(row.buttons)) continue;
        for (const btn of row.buttons) {
            if (!btn) continue;
            const dataStr = buttonDataString(btn);
            const textStr = String(btn.text || "");
            if (isPageIndicatorButton(btn)) return true; // DUMP // Base 34 pager
            if (
                dataStr.includes("folder:") ||
                dataStr.includes("menu:page:") ||
                /\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}/.test(textStr) ||
                /\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}/.test(dataStr) ||
                isNextPageButton(btn) ||
                isPrevPageButton(btn)
            ) {
                return true;
            }
            // Count bare calendar labels "02.10.2026"
            if (/\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4}/.test(textStr)) dateLike += 1;
        }
    }
    // A grid of date buttons alone is a menu even without pager text
    return dateLike >= 2;
}

/**
 * Check if button is a download/history dump button.
 * @param {any} btn
 * @returns {boolean}
 */
function isHistButton(btn) {
    if (!btn) return false;
    const dataStr = (btn.type && btn.type.data ? btn.type.data.toString() : (Buffer.isBuffer(btn.data) ? btn.data.toString("utf8") : String(btn.data || ""))).toLowerCase();
    const textStr = String(btn.text || "").toLowerCase();
    if (
        dataStr.startsWith("hist:") ||
        dataStr.includes("hist") ||
        dataStr.includes("dump") ||
        dataStr.includes("download") ||
        dataStr.includes("file:") ||
        dataStr.includes("dl:")
    ) {
        return true;
    }
    if (
        textStr.includes("hist") ||
        textStr.includes("history") ||
        textStr.includes("full") ||
        textStr.includes("dump") ||
        textStr.includes("дамп") ||
        textStr.includes("скачать") ||
        textStr.includes("выгрузить") ||
        textStr.includes("получить") ||
        textStr.includes("download") ||
        textStr.includes("база") ||
        textStr.includes("архив") ||
        textStr.includes("логи") ||
        textStr.includes("комбо") ||
        textStr.includes("файл") ||
        textStr.includes("export") ||
        textStr.includes("get file") ||
        textStr.includes("get dump")
    ) {
        return true;
    }
    return false;
}

/**
 * Extract the newest batch date from the DumpNews14Bot menu message.
 * Inspects all buttons and returns the newest date.
 * @param {any} menuMsg
 * @returns {Date|null}
 */
function detectLatestBatchDate(menuMsg) {
    if (!menuMsg || !menuMsg.replyMarkup || !Array.isArray(menuMsg.replyMarkup.rows)) {
        return null;
    }
    const foundDates = [];
    try {
        for (const row of menuMsg.replyMarkup.rows) {
            if (!row || !Array.isArray(row.buttons)) continue;
            for (const btn of row.buttons) {
                if (!btn) continue;
                let dataStr = "";
                try {
                    dataStr = btn.type && btn.type.data ? btn.type.data.toString() : (Buffer.isBuffer(btn.data) ? btn.data.toString("utf8") : String(btn.data || ""));
                } catch {
                    dataStr = "";
                }
                const textStr = String(btn.text || "");
                // Match DD.MM.YYYY, DD-MM-YYYY, DD/MM/YYYY
                const dmy = dataStr.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/) || textStr.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
                if (dmy) {
                    const parsed = parseDmyDate(`${dmy[1]}.${dmy[2]}.${dmy[3]}`);
                    if (parsed) foundDates.push(parsed);
                }
                // Match YYYY-MM-DD, YYYY.MM.DD
                const ymd = dataStr.match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})/) || textStr.match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
                if (ymd) {
                    const parsed = parseDmyDate(`${ymd[3]}.${ymd[2]}.${ymd[1]}`);
                    if (parsed) foundDates.push(parsed);
                }
            }
        }
    } catch {
        return null;
    }
    if (foundDates.length === 0) return null;
    foundDates.sort((a, b) => b.getTime() - a.getTime());
    return foundDates[0];
}

async function syncCustomEmojis(peer) {
    if (!peer) return 0;
    if (typeof peer.syncCustomEmojis === "function") {
        const res = await peer.syncCustomEmojis();
        return (res && typeof res.synced === "number") ? res.synced : (typeof res === "number" ? res : 0);
    }
    if (typeof peer.getInstalledEmojiPacks === "function") {
        const data = await peer.getInstalledEmojiPacks();
        const { registerCustomEmojis } = require("./messages");
        let count = 0;
        if (data && data.emojiMap) {
            registerCustomEmojis(data.emojiMap);
            count += Object.keys(data.emojiMap).length;
        }
        if (data && Array.isArray(data.packs)) {
            for (const pack of data.packs) {
                if (pack && Array.isArray(pack.documents)) {
                    const mapped = {};
                    for (const doc of pack.documents) {
                        if (doc && doc.id && doc.alt) {
                            mapped[doc.alt] = String(doc.id);
                        }
                    }
                    registerCustomEmojis(mapped);
                    count += Object.keys(mapped).length;
                }
            }
        }
        return count;
    }
    return 0;
}

/**
 * Extract source chat and message id from a Telegram forwarded message.
 * Supports Telegram Bot API 7.0+ (forward_origin) and legacy forward_from_chat.
 *
 * @param {any} msg
 * @returns {{ peer: string|number, messageId: number, title?: string }|null}
 */
function extractForwardOrigin(msg) {
    if (!msg) return null;

    // Telegram Bot API 7.0+ MessageOrigin
    if (msg.forward_origin) {
        const o = msg.forward_origin;
        if (o.type === "channel" && o.chat) {
            const peer = o.chat.username ? `@${o.chat.username.replace(/^@+/, "")}` : o.chat.id;
            return { peer, messageId: o.message_id, title: o.chat.title || o.chat.username || "" };
        }
        if (o.type === "chat" && o.sender_chat) {
            const peer = o.sender_chat.username ? `@${o.sender_chat.username.replace(/^@+/, "")}` : o.sender_chat.id;
            return { peer, messageId: o.message_id, title: o.sender_chat.title || o.sender_chat.username || "" };
        }
    }

    // Legacy Telegram Bot API fields
    if (msg.forward_from_chat) {
        const peer = msg.forward_from_chat.username
            ? `@${msg.forward_from_chat.username.replace(/^@+/, "")}`
            : msg.forward_from_chat.id;
        return {
            peer,
            messageId: msg.forward_from_message_id,
            title: msg.forward_from_chat.title || msg.forward_from_chat.username || "",
        };
    }

    return null;
}

/**
 * Parse channel username and message id from standard channel dump filenames,
 * e.g. "@moonulp - 213.txt", "@channel_123.txt", "moonulp - 213.txt".
 *
 * @param {string} fileName
 * @returns {{ peer: string, messageId: number }|null}
 */
function parseChannelFilename(fileName) {
    if (!fileName || typeof fileName !== "string") return null;
    const m = fileName.trim().match(/^@([a-zA-Z0-9_]{3,32})\s*[-_]\s*(\d+)/);
    if (m) {
        const peer = `@${m[1]}`;
        const messageId = parseInt(m[2], 10);
        if (Number.isSafeInteger(messageId) && messageId > 0) {
            return { peer, messageId };
        }
    }
    return null;
}

const BOT_MESSAGE_LABELS = new Set([
    "menu", "search", "searching", "result", "results", "history", "hist",
    "date", "folder", "page", "attempt", "step", "error", "warning",
    "info", "notice", "status", "query", "url", "link", "domain", "site",
    "bot", "help", "download", "dump", "select", "enter", "choose", "file", "no"
]);

/**
 * Check if raw text actually contains valid combo credentials (user:pass).
 * @param {string} text
 * @returns {boolean}
 */
function containsComboCredentials(text) {
    if (!text || typeof text !== "string") return false;
    const lines = text.split(/[\r\n]+/);
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("/")) continue;
        if (typeof isCcLine === "function" && isCcLine(trimmed)) return true;

        // Detect multi-line stealer blocks (URL: ... Username: ... Password: ...)
        if (
            /^(?:user(?:name|_name|_login)?|login(?:_id)?|account|acc|usr|email|mail)\s*[:=|]/i.test(trimmed) ||
            /^(?:pass(?:word|wd|w)?|pwd|secret)\s*[:=|]/i.test(trimmed) ||
            /^(?:url|uri|host|site|website)\s*[:=|]/i.test(trimmed)
        ) {
            const start = Math.max(0, i - 4);
            const end = Math.min(lines.length, i + 5);
            let hasU = false;
            let hasP = false;
            for (let j = start; j < end; j++) {
                const lj = lines[j].trim();
                if (/^(?:user(?:name|_name|_login)?|login(?:_id)?|account|acc|usr|email|mail)\s*[:=|]/i.test(lj)) hasU = true;
                if (/^(?:pass(?:word|wd|w)?|pwd|secret)\s*[:=|]/i.test(lj)) hasP = true;
            }
            if (hasU && hasP) return true;
        }

        const cleaned = cleanLine(trimmed);
        if (!cleaned) continue;
        const [u, p] = cleaned.split(":");
        if (!u || !p) continue;
        const uLower = u.toLowerCase();
        if (
            BOT_MESSAGE_LABELS.has(uLower) ||
            (PURE_FIELD_LABELS && PURE_FIELD_LABELS.has(uLower)) ||
            (CREDENTIAL_LABELS && CREDENTIAL_LABELS.has(uLower))
        ) {
            continue;
        }
        if (typeof isEmail === "function" && isEmail(u)) return true;
        if (typeof isPhone === "function" && isPhone(u)) return true;
        // For plain username:password, if original line contains multiple English words, it is prose
        const words = trimmed.split(/\s+/);
        if (words.length > 2 && (!isEmail || !isEmail(u))) continue;
        return true;
    }
    return false;
}

module.exports = {
    ULP_MARKER,
    CALL_TIMEOUT_MS,
    loadConfig,
    isConfigured,
    classifyUserbotError,
    loadLibs,
    withTimeout,
    safeDownloadName,
    resolveSafeFileName,
    downloadPath,
    markedPeerId,
    formatDateDmy,
    previousDate,
    parseDmyDate,
    parseAnyDate,
    buttonMatchesDate,
    buttonDataBuffer,
    buttonDataString,
    isPageIndicatorButton,
    isNextPageButton,
    isPrevPageButton,
    isBackButton,
    isUtilityButton,
    extractFolderDatesFromMessage,
    findNavButton,
    isMenuMessage,
    isHistButton,
    detectLatestBatchDate,
    containsComboCredentials,
    createUserbot,
    syncCustomEmojis,
    extractForwardOrigin,
    parseChannelFilename,
};

/**
 * Create the userbot transport.
 *
 * @param {ReturnType<typeof loadConfig>} cfg
 * @param {{ log?: Console, timeoutMs?: number }} [opts]
 */
function createUserbot(cfg = loadConfig(), opts = {}) {
    const log = opts.log || console;
    const timeoutMs = opts.timeoutMs || CALL_TIMEOUT_MS;
    const { TelegramClient, Api, StringSession, getPeerId } = loadLibs();

    /** @type {any} */
    let client = opts.client || null;
    /** @type {any} */
    let searcherEntity = opts.searcherEntity || null;
    let searcherId = opts.searcherId || null;
    let botUsername = cfg.botUsername || (opts && opts.botUsername) || "";
    let ready = Boolean(opts.client || opts.ready);

    /**
     * Whoever cares whether a searcher message should be relayed.
     * @type {((msg: any) => Promise<void>|void)|null}
     */
    let resultSink = null;

    const peerCache = new Map();
    const forwardedMsgKeys = new Set();
    const handledResultIds = new Set();

    function markHandledResultId(id) {
        if (!id) return false;
        if (handledResultIds.has(id)) return true;
        handledResultIds.add(id);
        if (handledResultIds.size > 5000) {
            const first = handledResultIds.values().next().value;
            handledResultIds.delete(first);
        }
        return false;
    }

    function setPeerCache(key, value) {
        if (!key) return;
        if (peerCache.size >= 500) {
            const first = peerCache.keys().next().value;
            peerCache.delete(first);
        }
        peerCache.set(key, value);
    }

    /**
     * Resolve a Bot API chat id to the account-specific InputPeer/access hash.
     * Numeric -100... ids often aren't resolvable until dialogs warm the cache.
     * @param {number|string} chatId
     */
    async function resolveChatPeer(chatId) {
        const wanted = markedPeerId(chatId);
        if (peerCache.has(wanted)) {
            return peerCache.get(wanted);
        }
        try {
            const ent = await client.getInputEntity(chatId);
            setPeerCache(wanted, ent);
            return ent;
        } catch (firstError) {
            log.log(`userbot peer cache miss for ${wanted}; loading dialogs`);
            const dialogs = await withTimeout(
                client.getDialogs({ limit: 40 }),
                Math.max(timeoutMs, 30_000),
                "userbot getDialogs",
            );
            for (const dialog of dialogs) {
                let candidate = "";
                try {
                    candidate = markedPeerId(getPeerId(dialog.inputEntity, true));
                } catch {
                    candidate = dialog.id ? markedPeerId(dialog.id) : "";
                }
                if (candidate === wanted || (dialog.id && markedPeerId(dialog.id) === wanted)) {
                    setPeerCache(wanted, dialog.inputEntity);
                    return dialog.inputEntity;
                }
            }
            const err = new Error(`ACCOUNT_CANNOT_SEE_CHAT:${wanted}`);
            err.cause = firstError;
            throw err;
        }
    }

    async function forwardResult(toChatId, msg, forwardOpts = {}) {
        if (!ready || !client) return "skipped";
        if (!msg || !msg.id) return "skipped";

        const isDoc = Boolean(msg.media || msg.document || msg.file);
        const text = String(msg.message || msg.text || "");
        const hasCombos = !isDoc && text && containsComboCredentials(text);

        // Never forward prompts, menus, status updates, or echoes of the search URL
        if (!isDoc && !hasCombos) {
            return "skipped";
        }

        const fwdKey = `${String(toChatId)}:${msg.id}`;
        if (forwardedMsgKeys.has(fwdKey)) {
            return "already_forwarded";
        }
        forwardedMsgKeys.add(fwdKey);
        if (forwardedMsgKeys.size > 2000) {
            const first = forwardedMsgKeys.values().next().value;
            forwardedMsgKeys.delete(first);
        }

        const targetBot = (forwardOpts && forwardOpts.botUsername) || botUsername || cfg.botUsername;
        const isPrivateChat = Number(toChatId) > 0;
        let targetPeer = toChatId;

        // In private 1-on-1 chats with the bot, forward/copy to the bot so it arrives in the bot conversation
        if (isPrivateChat && targetBot) {
            try {
                targetPeer = await client.getInputEntity(targetBot.replace(/^@+/, ""));
            } catch {
                targetPeer = `@${targetBot.replace(/^@+/, "")}`;
            }
        } else {
            try {
                targetPeer = await resolveChatPeer(toChatId);
            } catch (err) {
                log.log(`userbot resolveChatPeer fallback for ${toChatId}: ${err && err.message ? err.message : err}`);
            }
        }

        // teleproto/gramJS need integer message ids (BigInt → Number) and a
        // resolvable fromPeer. MESSAGE_ID_INVALID is almost always a type/peer
        // mismatch here — never fail the search just because the optional
        // forward into the bot conversation couldn't be done.
        const msgId = Number(msg.id);
        const fromPeer = searcherEntity || cfg.searcher || searcherId;
        let forwarded = false;
        if (Number.isFinite(msgId) && msgId > 0) {
            const forwardAttempts = [
                { messages: [msg], fromPeer },
                { messages: [msgId], fromPeer },
                { messages: [msgId], fromPeer: cfg.searcher },
            ];
            for (const attempt of forwardAttempts) {
                try {
                    await withTimeout(
                        client.forwardMessages(targetPeer, attempt),
                        timeoutMs,
                        "userbot forwardMessages",
                    );
                    forwarded = true;
                    break;
                } catch (err) {
                    log.log(`forward attempt failed (${err && err.message ? err.message : err})`);
                }
            }
        }
        if (forwarded) return "forward";
        log.log("forward blocked - copying media/text instead");

        const media = msg.media;
        if (media) {
            const buffer = await withTimeout(client.downloadMedia(msg, {}), timeoutMs, "userbot downloadMedia").catch(() => null);
            if (buffer) {
                const candidateName = (msg.file && (msg.file.name || msg.file.fileName)) ||
                    resolveSafeFileName(msg, "ulp_result", ".txt");
                const safeName = resolveSafeFileName(candidateName, "ulp_result", ".txt");
                buffer.name = safeName;
                const sendPayload = {
                    file: buffer,
                    caption: `${ULP_MARKER} ${safeName}`,
                    forceDocument: true,
                };
                if (Api && typeof Api.DocumentAttributeFilename === "function") {
                    sendPayload.attributes = [
                        new Api.DocumentAttributeFilename({ fileName: safeName }),
                    ];
                }
                await withTimeout(
                    client.sendFile(targetPeer, sendPayload),
                    timeoutMs,
                    "userbot sendFile",
                );
                return "copy";
            }
        }
        if (text && hasCombos) {
            await withTimeout(
                client.sendMessage(targetPeer, { message: `${ULP_MARKER} ${text}` }),
                timeoutMs,
                "userbot copy",
            );
            return "copy";
        }
        return "skipped";
    }

    return {
        kind: "userbot",
        get searcherId() {
            return searcherId;
        },
        get botUsername() {
            return botUsername;
        },
        setBotUsername(name) {
            botUsername = String(name || "").replace(/^@+/, "");
        },
        /** @param {(msg: any) => Promise<void>|void} sink */
        onResult(sink) {
            resultSink = sink;
        },
        isReady() {
            // ready flag is set after successful start(); also treat a connected client as ready
            // so a dropped internal flag doesn't strand ULP behind ACCOUNT BYPASS OFFLINE.
            if (ready && client) return true;
            try {
                if (client && typeof client.connected === "boolean") return Boolean(client.connected);
                if (client && client._sender && client._sender._connection) return true;
            } catch (_) {}
            return Boolean(ready);
        },
        classify: classifyUserbotError,

        async start() {
            if (ready) return { id: searcherId, username: cfg.searcher };
            client = new TelegramClient(new StringSession(cfg.session), cfg.apiId, cfg.apiHash, {
                connectionRetries: 5,
                autoReconnect: true,
                maxSessions: 8,
                sessions: 4,
                download: {
                    maxSessions: 8,
                    startSessions: 4,
                },
            });

            const noInput = () => {
                throw new Error("SESSION_INVALID: run `npm run userbot:login` and update TELEGRAM_SESSION");
            };
            await withTimeout(
                client.start({
                    phoneNumber: noInput,
                    password: noInput,
                    phoneCode: noInput,
                    emailAddress: noInput,
                    emailVerification: noInput,
                    onError: (err) => log.error("userbot auth error:", err && err.message ? err.message : err),
                }),
                timeoutMs,
                "userbot start",
            );

            searcherEntity = await withTimeout(client.getEntity(cfg.searcher), timeoutMs, "userbot getEntity");
            searcherId = Number(searcherEntity && searcherEntity.id) || null;
            ready = true;
            log.log(`Userbot connected · searcher @${cfg.searcher} (id ${searcherId})`);

            // Pre-warm active dialogs in background so resolveChatPeer is instant for /save
            void client.getDialogs({ limit: 40 }).then((dialogs) => {
                for (const d of dialogs || []) {
                    try {
                        const pid = markedPeerId(getPeerId(d.inputEntity, true));
                        if (pid) setPeerCache(pid, d.inputEntity);
                        if (d.id) setPeerCache(markedPeerId(d.id), d.inputEntity);
                    } catch {}
                }
            }).catch(() => {});

            const libs = loadLibs();
            client.addEventHandler(async (event) => {
                const msg = event.message;
                if (!msg) return;
                if (msg.peerId) {
                    try {
                        const mid = markedPeerId(getPeerId(msg.peerId, true));
                        if (mid && !peerCache.has(mid)) {
                            setPeerCache(mid, msg.inputPeer || msg.peerId);
                        }
                    } catch {}
                }
                if (!resultSink) return;
                const sender = Number(msg.senderId || (msg.peerId && msg.peerId.userId) || 0);
                if (searcherId && sender && sender !== searcherId) return;
                if (markHandledResultId(msg.id)) return;
                try {
                    await resultSink(msg);
                } catch (err) {
                    log.error("userbot result sink failed:", err && err.message ? err.message : err);
                }
            }, new libs.NewMessage({}));

            return { id: searcherId, username: cfg.searcher };
        },

        async stop() {
            ready = false;
            if (client) {
                try {
                    await client.disconnect();
                } catch {
                    // ignore
                }
            }
        },

        async send(text) {
            if (!ready || !client) throw new Error("USERBOT_NOT_READY");
            const message = (text && typeof text === "object" && text.text) ? text.text : String(text || "");
            const sent = await withTimeout(
                client.sendMessage(searcherEntity || cfg.searcher, { message }),
                timeoutMs,
                "userbot sendMessage",
            );
            return { message_id: Number(sent && sent.id) || 0, chat: { id: searcherId } };
        },

        /**
         * Fetch a message visible to the account and stream its media to disk.
         * The account must be a member of the source group/chat.
         *
         * @param {number|string} chatId
         * @param {number} messageId
         * @param {{ root: string, fileName?: string, onProgress?: (done: number, total: number) => void }} options
         */
        async downloadMessageToDisk(chatId, messageId, options) {
            if (!ready || !client) throw new Error("USERBOT_NOT_READY");
            const root = path.resolve(options.root);
            fs.mkdirSync(root, { recursive: true });

            let message = (options && options.message && options.message.media) ? options.message : null;
            if (!message) {
                const inputPeer = await resolveChatPeer(chatId);
                const messages = await withTimeout(
                    client.getMessages(inputPeer, { ids: Number(messageId) }),
                    timeoutMs,
                    "userbot getMessages",
                );
                message = messages && messages[0];
            }
            if (!message) {
                throw new Error(`MESSAGE_NOT_VISIBLE:${messageId}`);
            }
            if (!message.media) {
                throw new Error(`REPLIED_MESSAGE_HAS_NO_MEDIA:${messageId}`);
            }

            const actualName = resolveSafeFileName(
                message,
                options.fileName || `dump_${messageId}`,
            );
            const finalPath = downloadPath(root, actualName, messageId);
            const partialPath = `${finalPath}.partial`;

            try {
                const result = await client.downloadMedia(message, {
                    outputFile: partialPath,
                    partSizeKb: 1024,
                    progressCallback: (done, total) => {
                        if (options.onProgress) options.onProgress(Number(done), Number(total));
                    },
                    requestTimeout: 180_000,
                });
                if (!result || !fs.existsSync(partialPath)) {
                    throw new Error("TELEGRAM_MEDIA_DOWNLOAD_FAILED");
                }
                fs.renameSync(partialPath, finalPath);
                const stat = fs.statSync(finalPath);
                return {
                    path: finalPath,
                    name: path.basename(finalPath),
                    originalName: safeDownloadName(actualName),
                    size: stat.size,
                };
            } catch (err) {
                fs.rmSync(partialPath, { force: true });
                throw err;
            }
        },

        /**
         * Download media directly from an MTProto message without writing to disk.
         * @param {any} msg
         * @param {any} [options]
         * @returns {Promise<Buffer|null>}
         */
        async downloadMedia(msg, options = {}) {
            if (!ready || !client) throw new Error("USERBOT_NOT_READY");
            const downloadTimeoutMs = options.timeoutMs || 120000;
            return await withTimeout(
                client.downloadMedia(msg, options),
                downloadTimeoutMs,
                "userbot downloadMedia",
            );
        },

        forwardResult,

        /**
         * Find a document from the replied message or the most recent message in the chat.
         * Resolves the Telegram Privacy Mode issue where Bot API strips reply_to_message.
         *
         * @param {number|string} chatId
         * @param {number} commandMessageId
         * @param {number} [preferredReplyId]
         * @returns {Promise<{ messageId: number, fileName: string, size: number, document: any } | null>}
         */
        async findRepliedOrRecentDocument(chatId, commandMessageId, preferredReplyId) {
            if (!ready || !client) throw new Error("USERBOT_NOT_READY");
            const inputPeer = await resolveChatPeer(chatId);

            let targetReplyId = preferredReplyId ? Number(preferredReplyId) : null;

            if (!targetReplyId && commandMessageId) {
                try {
                    const messages = await withTimeout(
                        client.getMessages(inputPeer, { ids: Number(commandMessageId) }),
                        timeoutMs,
                        "userbot getMessages cmd",
                    );
                    const cmdMsg = messages && messages[0];
                    if (cmdMsg && cmdMsg.replyTo && cmdMsg.replyTo.replyToMsgId) {
                        targetReplyId = cmdMsg.replyTo.replyToMsgId;
                    }
                } catch (err) {
                    log.error("userbot failed to fetch command message:", err && err.message ? err.message : err);
                }
            }

            if (targetReplyId) {
                try {
                    const messages = await withTimeout(
                        client.getMessages(inputPeer, { ids: targetReplyId }),
                        timeoutMs,
                        "userbot getMessages reply",
                    );
                    const msg = messages && messages[0];
                    if (msg && msg.media) {
                        const fileName = resolveSafeFileName(msg, `dump_${targetReplyId}`);
                        const size = Number((msg.file && msg.file.size) || (msg.media.document && msg.media.document.size) || 0);
                        return {
                            messageId: targetReplyId,
                            fileName,
                            size,
                            document: msg.media.document || msg.file,
                            message: msg,
                        };
                    }
                } catch (err) {
                    log.error("userbot failed to fetch replied message:", err && err.message ? err.message : err);
                }
            }

            // Fallback: Scan recent messages in chat for the newest document
            try {
                const recent = await withTimeout(
                    client.getMessages(inputPeer, { limit: 15 }),
                    timeoutMs,
                    "userbot getRecentMessages",
                );
                for (const msg of recent || []) {
                    if (msg.id === Number(commandMessageId)) continue;
                    if (msg.media && (msg.media.document || msg.file)) {
                        const fileName = resolveSafeFileName(msg, `dump_${msg.id}`);
                        const size = Number((msg.file && msg.file.size) || (msg.media.document && msg.media.document.size) || 0);
                        return {
                            messageId: msg.id,
                            fileName,
                            size,
                            document: msg.media.document || msg.file,
                            message: msg,
                        };
                    }
                }
            } catch (err) {
                log.error("userbot failed to scan recent messages:", err && err.message ? err.message : err);
            }

            return null;
        },

        /**
         * Find multiple recent documents in a chat for batch saving.
         *
         * @param {number|string} chatId
         * @param {number} [limit] max documents to return (default 10)
         * @param {number} [commandMessageId] optional command message id to exclude
         * @returns {Promise<Array<{ messageId: number, fileName: string, size: number, document: any }>>}
         */
        async findRecentDocuments(chatId, limit = 10, commandMessageId = null) {
            if (!ready || !client) return [];
            let inputPeer = chatId;
            try {
                inputPeer = await resolveChatPeer(chatId);
            } catch {
                inputPeer = chatId;
            }
            try {
                const recent = await withTimeout(
                    client.getMessages(inputPeer, { limit: 80 }),
                    timeoutMs,
                    "userbot getRecentMessagesBatch",
                );
                const found = [];
                for (const msg of recent || []) {
                    if (commandMessageId && msg.id === Number(commandMessageId)) continue;
                    if (found.length >= limit) break;
                    if (msg.media && (msg.media.document || msg.file)) {
                        const fileName = resolveSafeFileName(msg, `dump_${msg.id}`);
                        const size = Number((msg.file && msg.file.size) || (msg.media.document && msg.media.document.size) || 0);
                        found.push({
                            messageId: msg.id,
                            fileName,
                            size,
                            document: msg.media.document || msg.file,
                            message: msg,
                        });
                    }
                }
                // Return in chronological order so files process sequentially (e.g. part 1, part 2...)
                return found.reverse();
            } catch (err) {
                log.error("userbot failed to scan recent batch documents:", err && err.message ? err.message : err);
                return [];
            }
        },

        /**
         * Query all installed custom emoji sticker sets and animated emojis on the user account.
         * @returns {Promise<{ packs: Array<{ title: string, shortName: string, id: string, count: number, sample: string[] }>, totalEmojis: number }>}
         */
        async getInstalledEmojiPacks() {
            if (!ready || !client) {
                return { packs: [], totalEmojis: 0, error: "USERBOT_NOT_READY" };
            }
            try {
                const res = await withTimeout(
                    client.invoke(new Api.messages.GetEmojiStickers({ hash: BigInt(0) })),
                    timeoutMs,
                    "userbot GetEmojiStickers",
                );
                const packs = [];
                const emojiMap = {};
                let totalEmojis = 0;
                for (const s of (res && res.sets) || []) {
                    try {
                        const full = await withTimeout(
                            client.invoke(new Api.messages.GetStickerSet({
                                stickerset: new Api.InputStickerSetID({ id: s.id, accessHash: s.accessHash }),
                                hash: 0,
                            })),
                            timeoutMs,
                            `userbot GetStickerSet ${s.shortName}`,
                        );
                        const sample = (full.packs || []).slice(0, 10).map((p) => p.emoticon);
                        const count = full.documents ? full.documents.length : (s.count || 0);
                        totalEmojis += count;

                        // Prefer pack.emoticon → first document (matches SearchCustomEmoji).
                        // Attribute.alt alone misses many glyphs and FE0F variants.
                        if (Array.isArray(full.packs)) {
                            for (const pack of full.packs) {
                                const emo = pack && pack.emoticon;
                                const docs = pack && pack.documents;
                                if (!emo || !docs || !docs.length) continue;
                                const rawId = docs[0] && (docs[0].value != null ? docs[0].value : docs[0]);
                                const id = rawId != null ? String(rawId) : "";
                                if (!id) continue;
                                if (!emojiMap[emo]) emojiMap[emo] = id;
                                const stripped = String(emo).replace(/\uFE0F/g, "");
                                if (stripped && stripped !== emo && !emojiMap[stripped]) emojiMap[stripped] = id;
                            }
                        }
                        if (Array.isArray(full.documents)) {
                            for (const doc of full.documents) {
                                let alt = "";
                                if (doc.attributes) {
                                    for (const a of doc.attributes) {
                                        if (a && a.alt) {
                                            alt = a.alt;
                                            break;
                                        }
                                    }
                                }
                                if (alt && doc.id) {
                                    const id = doc.id.toString();
                                    if (!emojiMap[alt]) emojiMap[alt] = id;
                                    const stripped = String(alt).replace(/\uFE0F/g, "");
                                    if (stripped && stripped !== alt && !emojiMap[stripped]) emojiMap[stripped] = id;
                                }
                            }
                        }

                        packs.push({
                            title: s.title || s.shortName,
                            shortName: s.shortName,
                            id: s.id.toString(),
                            count,
                            sample,
                        });
                    } catch (e) {
                        packs.push({
                            title: s.title || s.shortName,
                            shortName: s.shortName,
                            id: s.id.toString(),
                            count: s.count || 0,
                            sample: [],
                        });
                        totalEmojis += s.count || 0;
                    }
                }
                return { packs, totalEmojis, emojiMap };
            } catch (err) {
                log.error("userbot getInstalledEmojiPacks error:", err && err.message ? err.message : err);
                return { packs: [], totalEmojis: 0, emojiMap: {}, error: err.message };
            }
        },

        /**
         * Sync account installed custom animated emojis directly into messages.js registry.
         */
        async syncCustomEmojis() {
            if (!ready || !client) return { synced: 0, error: "USERBOT_NOT_READY" };
            const { emojiMap, totalEmojis } = await this.getInstalledEmojiPacks();
            const map = { ...(emojiMap || {}) };
            // Fill common UI glyphs via SearchCustomEmoji when packs don't cover them.
            try {
                const { EMOJI_KEY_MAP } = require("./messages");
                const wanted = new Set(Object.keys(EMOJI_KEY_MAP || {}));
                for (const sym of wanted) {
                    if (!sym || map[sym] || map[String(sym).replace(/\uFE0F/g, "")]) continue;
                    try {
                        const r = await withTimeout(
                            client.invoke(new Api.messages.SearchCustomEmoji({
                                emoticon: sym,
                                hash: BigInt(0),
                            })),
                            Math.min(timeoutMs, 8000),
                            "userbot SearchCustomEmoji",
                        );
                        const ids = (r && r.documentId) || [];
                        if (ids.length) {
                            const raw = ids[0] && (ids[0].value != null ? ids[0].value : ids[0]);
                            if (raw != null) {
                                map[sym] = String(raw);
                                const stripped = String(sym).replace(/\uFE0F/g, "");
                                if (stripped && !map[stripped]) map[stripped] = String(raw);
                            }
                        }
                    } catch (_) {}
                }
            } catch (_) {}
            const { registerCustomEmojis, saveEmojiRegistryFile } = require("./messages");
            if (typeof registerCustomEmojis === "function") {
                registerCustomEmojis(map);
            }
            if (typeof saveEmojiRegistryFile === "function") {
                saveEmojiRegistryFile(process.env.EMOJI_REGISTRY_PATH || "/var/data/emoji-registry.json");
            }
            return { synced: Object.keys(map).length, totalEmojis };
        },

        /**
         * Click an inline callback button on a message from the searcher bot.
         * @param {number} messageId
         * @param {string|Buffer} callbackData
         */
        async clickButton(messageId, callbackData) {
            if (!ready || !client) throw new Error("USERBOT_NOT_READY");
            let dataBuf;
            if (Buffer.isBuffer(callbackData)) dataBuf = callbackData;
            else if (callbackData instanceof Uint8Array) dataBuf = Buffer.from(callbackData);
            else if (typeof callbackData === "string") dataBuf = Buffer.from(callbackData, "binary");
            else dataBuf = Buffer.from(String(callbackData || ""), "utf8");
            return await withTimeout(
                client.invoke(new Api.messages.GetBotCallbackAnswer({
                    peer: searcherEntity || cfg.searcher,
                    msgId: Number(messageId),
                    data: dataBuf,
                })),
                timeoutMs,
                "userbot clickButton",
            );
        },

        /**
         * Perform automated day-by-day search on @DumpNews14Bot via inline buttons.
         * Starts with startDate (formatted as DD.MM.YYYY, e.g. 20.09.2026) and steps backward.
         * Clicks folder:DD.MM.YYYY:P then hist:DD.MM.YYYY.
         *
         * @param {{
         *   query: string,
         *   daysCount?: number,
         *   startDate?: Date,
         *   chatId?: number|string,
         *   stepDelayMs?: number,
         *   shouldStop?: () => boolean,
         *   onStatus?: (status: { day: string, attempt: number, totalDays: number, step: string }) => void,
         *   sleep?: (ms: number) => Promise<void>,
         * }} options
         */
        async searchDayByDay(options) {
            if (!ready || !client) throw new Error("USERBOT_NOT_READY");
            const {
                query,
                daysCount = 5,
                startDate = null,
                chatId = null,
                stepDelayMs = 15000,
                shouldStop = () => false,
                onStatus = () => {},
                sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
            } = options || {};

            const totalDays = Math.max(1, Math.min(90, Number(daysCount) || 5));
            const searchTarget = searcherEntity || cfg.searcher;
            // Hard pacing on the dump bot: default 15s between actions (override via SEARCH_STEP_DELAY_MS).
            const clickGapMs = Math.max(1000, Number(stepDelayMs) || 15000);
            const seenResultIds = new Set();
            let domainSent = false;
            let daysProcessed = 0;
            let resultsFound = 0;
            let lastDumpActionAt = 0;

            /** Wait until clickGapMs has elapsed since the last dump-bot action. */
            const paceDumpBot = async (label = "action") => {
                const now = Date.now();
                const elapsed = now - lastDumpActionAt;
                if (lastDumpActionAt > 0 && elapsed < clickGapMs) {
                    const wait = clickGapMs - elapsed;
                    onStatus({
                        day: "pace",
                        attempt: daysProcessed + 1,
                        totalDays,
                        step: `Waiting ${(wait / 1000).toFixed(0)}s before next dump-bot ${label}…`,
                    });
                    await sleep(wait);
                }
            };

            const markDumpAction = () => {
                lastDumpActionAt = Date.now();
            };

            const clickLive = async (msgId, data, label = "click") => {
                // CRITICAL: pass the exact bytes Telegram attached to the button on
                // THIS message id. Re-encoded / stale buffers → "Encrypted data invalid".
                let dataBuf = null;
                if (Buffer.isBuffer(data)) dataBuf = data;
                else if (data instanceof Uint8Array) dataBuf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
                else if (data && data.buffer && ArrayBuffer.isView(data)) {
                    dataBuf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
                } else if (typeof data === "string") {
                    dataBuf = Buffer.from(data, "utf8");
                }
                if (!dataBuf || !dataBuf.length) throw new Error(`userbot ${label}: empty callback data`);

                // 15s (clickGapMs) between every click on the dump bot.
                await paceDumpBot(label);
                if (shouldStop()) throw new Error("stopped");

                const res = await withTimeout(
                    client.invoke(new Api.messages.GetBotCallbackAnswer({
                        peer: searchTarget,
                        msgId: Number(msgId),
                        data: dataBuf,
                    })),
                    timeoutMs,
                    `userbot ${label}`,
                );
                markDumpAction();
                return res;
            };

            const extractLiveData = (btn) => {
                // Prefer nested teleproto type.data (exact bytes)
                try {
                    if (btn && btn.type && btn.type.data != null) {
                        const d = btn.type.data;
                        if (Buffer.isBuffer(d)) return d;
                        if (d instanceof Uint8Array) return Buffer.from(d.buffer, d.byteOffset, d.byteLength);
                        if (d.buffer && ArrayBuffer.isView(d)) return Buffer.from(d.buffer, d.byteOffset, d.byteLength);
                        if (typeof d === "string") return Buffer.from(d, "utf8");
                    }
                } catch {}
                return buttonDataBuffer(btn);
            };

            const refreshMsg = async (msgId) => {
                try {
                    const updated = await client.getMessages(searchTarget, { ids: [Number(msgId)] });
                    if (updated && updated[0]) return updated[0];
                } catch {}
                return null;
            };

            const findMenu = async (afterId = 0) => {
                for (let pollTry = 0; pollTry < 10; pollTry++) {
                    if (shouldStop()) return null;
                    try {
                        const recents = await withTimeout(
                            client.getMessages(searchTarget, { limit: 12 }),
                            timeoutMs,
                            "userbot getMessages menu",
                        );
                        if (Array.isArray(recents)) {
                            const menu =
                                recents.find((m) => !m.out && afterId && m.id > afterId && isMenuMessage(m)) ||
                                recents.find((m) => !m.out && isMenuMessage(m)) ||
                                recents.find((m) => !m.out && m.replyMarkup && m.replyMarkup.rows && m.replyMarkup.rows.length > 0);
                            if (menu) return menu;
                        }
                    } catch (fetchErr) {
                        log.error("userbot poll menu error:", fetchErr && fetchErr.message ? fetchErr.message : fetchErr);
                    }
                    await sleep(700);
                }
                return null;
            };

            const openRootMenu = async () => {
                let sentStart = null;
                for (let startAttempt = 0; startAttempt < 3; startAttempt++) {
                    if (shouldStop()) return null;
                    try {
                        onStatus({
                            day: "init",
                            attempt: 1,
                            totalDays,
                            step: startAttempt === 0 ? "Sending /start to open menu…" : `Retrying /start (attempt ${startAttempt + 1})…`,
                        });
                        sentStart = await withTimeout(
                            client.sendMessage(searchTarget, { message: "/start" }),
                            timeoutMs,
                            "userbot send /start",
                        );
                        if (sentStart) break;
                    } catch (startErr) {
                        log.error(`userbot send /start attempt ${startAttempt + 1} failed:`, startErr && startErr.message ? startErr.message : startErr);
                        await sleep(1200);
                    }
                }
                await sleep(1200);
                return await findMenu(sentStart && sentStart.id ? sentStart.id : 0);
            };

            /** Always prefer a fresh /start root menu — DumpNews edits markup in place. */
            const ensureRootMenu = async () => {
                // Try back on the newest markup first (cheap).
                try {
                    const latest = await client.getMessages(searchTarget, { limit: 8 });
                    const withBtns = Array.isArray(latest)
                        ? latest.find((m) => !m.out && m.replyMarkup && m.replyMarkup.rows)
                        : null;
                    if (withBtns && extractFolderDatesFromMessage(withBtns).length > 0) {
                        return withBtns;
                    }
                    if (withBtns) {
                        const back = findNavButton(withBtns, "back");
                        if (back && back.data) {
                            await clickLive(withBtns.id, back.data, "back").catch(() => {});
                            await sleep(1000);
                            const after = await refreshMsg(withBtns.id);
                            if (after && extractFolderDatesFromMessage(after).length > 0) return after;
                        }
                    }
                } catch (_) {}
                return await openRootMenu();
            };

            /**
             * Walk every menu page and collect REAL dump-date folders.
             * Returns newest-first list of { date, dateStr }.
             * Does NOT cache callback bytes — those go stale after page changes.
             */
            const readPageIndicator = (menuMsg) => {
                // DUMP // Base 34 style: middle button text "1/5"
                if (!menuMsg || !menuMsg.replyMarkup || !Array.isArray(menuMsg.replyMarkup.rows)) return null;
                for (const row of menuMsg.replyMarkup.rows) {
                    if (!row || !Array.isArray(row.buttons)) continue;
                    for (const btn of row.buttons) {
                        if (!btn) continue;
                        const text = String(btn.text || "").replace(/\s+/g, "").trim();
                        const m = text.match(/^(\d+)\/(\d+)$/);
                        if (m) return { page: Number(m[1]), total: Number(m[2]), text };
                    }
                }
                return null;
            };

            const inventoryAllDates = async (menuMsg) => {
                const byKey = new Map(); // dateStr -> Date
                let current = menuMsg;
                let pages = 0;
                const maxPages = 40;
                let stableRepeats = 0;
                let lastIndicator = readPageIndicator(current);

                while (current && pages < maxPages) {
                    if (shouldStop()) break;
                    const indicator = readPageIndicator(current) || lastIndicator;
                    if (indicator) lastIndicator = indicator;
                    const pageLabel = indicator ? `${indicator.page}/${indicator.total}` : String(pages + 1);
                    onStatus({
                        day: "scan",
                        attempt: pages + 1,
                        totalDays,
                        step: `Scanning menu page ${pageLabel} for dump dates…`,
                    });

                    const beforeSize = byKey.size;
                    const pageDates = extractFolderDatesFromMessage(current).map((f) => f.dateStr);
                    for (const f of extractFolderDatesFromMessage(current)) {
                        if (f.dateStr && !byKey.has(f.dateStr)) {
                            byKey.set(f.dateStr, f.date);
                        }
                    }
                    log.log(`userbot inventory page ${pageLabel}: +${byKey.size - beforeSize} dates [${pageDates.join(", ")}] total=${byKey.size}`);

                    // Stop if indicator says we're on the last page
                    if (indicator && indicator.page >= indicator.total) {
                        log.log(`userbot inventory reached last page ${indicator.text}`);
                        break;
                    }

                    const next = findNavButton(current, "next");
                    if (!next || !next.data) {
                        log.log(`userbot inventory: no next-page button on page ${pageLabel} (dates so far=${byKey.size})`);
                        // Debug: list non-date button labels so we can learn unknown nav glyphs
                        try {
                            const labels = [];
                            for (const row of current.replyMarkup.rows || []) {
                                for (const btn of (row && row.buttons) || []) {
                                    if (!btn) continue;
                                    const t = String(btn.text || "");
                                    const d = buttonDataString(btn).slice(0, 40);
                                    if (!/\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4}/.test(t)) labels.push(`${JSON.stringify(t)}→${JSON.stringify(d)}`);
                                }
                            }
                            log.log(`userbot inventory non-date buttons: ${labels.join(" | ")}`);
                        } catch (_) {}
                        break;
                    }

                    try {
                        await clickLive(current.id, next.data, "nextPage");
                    } catch (e) {
                        log.error("userbot nextPage error:", e && e.message ? e.message : e);
                        break;
                    }
                    await sleep(1000);

                    let refreshed = null;
                    for (let pWait = 0; pWait < 10; pWait++) {
                        refreshed = await refreshMsg(current.id);
                        if (refreshed && refreshed.replyMarkup) {
                            // Prefer when page indicator advanced
                            const ind2 = readPageIndicator(refreshed);
                            if (!indicator || !ind2 || ind2.page !== indicator.page || pWait >= 3) break;
                        }
                        const maybe = await findMenu(0);
                        if (maybe && maybe.id !== current.id) { refreshed = maybe; break; }
                        await sleep(400);
                    }
                    if (!refreshed) break;

                    const beforeKeys = extractFolderDatesFromMessage(current).map((f) => f.dateStr).sort().join("|");
                    const afterKeys = extractFolderDatesFromMessage(refreshed).map((f) => f.dateStr).sort().join("|");
                    const indAfter = readPageIndicator(refreshed);
                    current = refreshed;
                    pages += 1;

                    if (indicator && indAfter && indAfter.page === indicator.page && beforeKeys === afterKeys) {
                        stableRepeats += 1;
                        if (stableRepeats >= 2) {
                            log.log("userbot menu pagination stuck (same page indicator + same dates twice)");
                            break;
                        }
                    } else if (beforeKeys && afterKeys && beforeKeys === afterKeys && !indAfter) {
                        stableRepeats += 1;
                        if (stableRepeats >= 2) {
                            log.log("userbot menu pagination stopped (page content unchanged twice)");
                            break;
                        }
                    } else {
                        stableRepeats = 0;
                    }
                }

                // Rewind toward first page so later searches start clean
                try {
                    for (let i = 0; i < 3; i++) {
                        const prev = findNavButton(current, "prev");
                        if (!prev || !prev.data) break;
                        await clickLive(current.id, prev.data, "prevPage").catch(() => {});
                        await sleep(700);
                        current = (await refreshMsg(current.id)) || current;
                    }
                } catch (_) {}

                const list = Array.from(byKey.entries())
                    .map(([dateStr, date]) => ({ dateStr, date }))
                    .sort((a, b) => b.date.getTime() - a.date.getTime());
                log.log(`userbot inventory: ${list.length} real dump date(s) across ${pages + 1} page pass(es)` +
                    (list[0] ? ` (newest ${list[0].dateStr})` : ""));
                return { menuMsg: current, dates: list };
            };

            /**
             * Find a LIVE folder button for dateStr by paging from the current menu.
             * Returns { menuMsg, data, text } with fresh bytes.
             */
            const findDateButtonLive = async (menuMsg, targetDate, dateStr) => {
                let current = menuMsg;
                let sawAnyFolders = false;
                for (let pageTry = 0; pageTry < 40; pageTry++) {
                    if (shouldStop()) return null;
                    if (!current) current = await findMenu(0);
                    if (!current) return null;

                    const rows = (current.replyMarkup && current.replyMarkup.rows) || [];
                    for (const row of rows) {
                        if (!row || !Array.isArray(row.buttons)) continue;
                        for (const btn of row.buttons) {
                            if (!btn || isNextPageButton(btn) || isPrevPageButton(btn)) continue;
                            const data = extractLiveData(btn);
                            if (!data || !data.length) continue;
                            const dataStr = data.toString("utf8");
                            const textStr = String(btn.text || "");
                            const foldersHere = extractFolderDatesFromMessage(current);
                            if (foldersHere.length) sawAnyFolders = true;
                            if (
                                buttonMatchesDate(btn, targetDate) ||
                                dataStr.includes(dateStr) ||
                                textStr.includes(dateStr) ||
                                // looser: DD.MM without year on very short labels
                                (dateStr.length >= 5 && textStr.includes(dateStr.slice(0, 5)))
                            ) {
                                return { menuMsg: current, data, text: textStr };
                            }
                        }
                    }

                    const next = findNavButton(current, "next");
                    if (!next || !next.data) {
                        // try prev pages if we started mid-menu
                        const prev = findNavButton(current, "prev");
                        if (!prev || !prev.data || pageTry > 5) break;
                        try {
                            await clickLive(current.id, prev.data, "prevPage-find");
                        } catch (_) { break; }
                        await sleep(800);
                        current = (await refreshMsg(current.id)) || (await findMenu(0));
                        continue;
                    }
                    try {
                        await clickLive(current.id, next.data, "nextPage-find");
                    } catch (e) {
                        log.error("userbot nextPage-find error:", e && e.message ? e.message : e);
                        break;
                    }
                    await sleep(800);
                    const refreshed = await refreshMsg(current.id) || await findMenu(0);
                    if (!refreshed) break;
                    const before = extractFolderDatesFromMessage(current).map((f) => f.dateStr).join("|");
                    const after = extractFolderDatesFromMessage(refreshed).map((f) => f.dateStr).join("|");
                    current = refreshed;
                    if (before && after && before === after) {
                        // One more attempt after tiny wait, then give up this direction
                        await sleep(500);
                        const again = await refreshMsg(current.id);
                        if (again) current = again;
                        const after2 = extractFolderDatesFromMessage(current).map((f) => f.dateStr).join("|");
                        if (before === after2) break;
                    }
                }
                if (!sawAnyFolders) log.log(`userbot findDateButtonLive: no folders visible while seeking ${dateStr}`);
                return null;
            };

            const ensureDomainQuery = async () => {
                if (domainSent || !query) return;
                onStatus({
                    day: "init",
                    attempt: 1,
                    totalDays,
                    step: `Setting domain query "${query}" (once for whole run)`,
                });
                for (let qTry = 0; qTry < 3; qTry++) {
                    if (shouldStop()) return;
                    try {
                        await paceDumpBot("domain query");
                        if (shouldStop()) return;
                        await withTimeout(
                            client.sendMessage(searchTarget, { message: query }),
                            timeoutMs,
                            "userbot send query",
                        );
                        markDumpAction();
                        domainSent = true;
                        break;
                    } catch (qErr) {
                        log.error(`userbot send query error (attempt ${qTry + 1}):`, qErr && qErr.message ? qErr.message : qErr);
                        await sleep(1200);
                    }
                }
            };

            const ingestIncoming = async (dateStr, dayIdx) => {
                let foundDoc = false;
                let foundAny = false;
                try {
                    const latest = await client.getMessages(searchTarget, { limit: 15 });
                    if (!Array.isArray(latest)) return { foundDoc, foundAny };
                    for (const m of latest) {
                        const isDoc = Boolean(
                            m.document ||
                            (m.media && (m.media.document || m.media.className === "MessageMediaDocument"))
                        );
                        const rawText = String(m.message || m.text || "");
                        const hasCombos = rawText && containsComboCredentials(rawText);
                        if (m.out || seenResultIds.has(m.id) || (!isDoc && !hasCombos)) continue;
                        seenResultIds.add(m.id);
                        markHandledResultId(m.id);
                        foundAny = true;
                        resultsFound += 1;
                        if (isDoc) {
                            foundDoc = true;
                            onStatus({
                                day: dateStr,
                                attempt: dayIdx + 1,
                                totalDays,
                                step: `Received dump file for ${dateStr} — auto-cleaning…`,
                            });
                        } else {
                            onStatus({
                                day: dateStr,
                                attempt: dayIdx + 1,
                                totalDays,
                                step: `Received credentials for ${dateStr} — auto-cleaning…`,
                            });
                        }
                        if (options.onResult) {
                            try { await Promise.resolve(options.onResult(m)); } catch (_) {}
                        } else if (resultSink) {
                            try { await Promise.resolve(resultSink(m)); } catch (_) {}
                        }
                        if (chatId && typeof forwardResult === "function") {
                            await forwardResult(chatId, m, {
                                botUsername: options.botUsername || botUsername || cfg.botUsername,
                            }).catch((err) => {
                                log.log(`userbot forwardResult error: ${err && err.message ? err.message : err}`);
                            });
                        }
                    }
                } catch (err) {
                    log.log(`userbot post-hist message fetch error: ${err && err.message ? err.message : err}`);
                }
                return { foundDoc, foundAny };
            };

            const processOneDay = async (targetDate, dateStr, dayIdx, plannedTotal) => {
                onStatus({
                    day: dateStr,
                    attempt: dayIdx + 1,
                    totalDays: plannedTotal,
                    step: `Opening menu for ${dateStr}…`,
                });

                // Fresh root every day so pagination state is known
                let menuMsg = await openRootMenu();
                if (!menuMsg) {
                    log.log(`userbot no menu for ${dateStr}`);
                    return false;
                }

                const live = await findDateButtonLive(menuMsg, targetDate, dateStr);
                if (!live || !live.data) {
                    log.log(`userbot could not find date folder for ${dateStr}`);
                    return false;
                }

                onStatus({
                    day: dateStr,
                    attempt: dayIdx + 1,
                    totalDays: plannedTotal,
                    step: `Selecting date folder: ${dateStr}`,
                });

                let clicked = false;
                for (let clickTry = 0; clickTry < 3; clickTry++) {
                    try {
                        // Re-find live button immediately before click (bytes bound to current markup)
                        let msg = await refreshMsg(live.menuMsg.id) || live.menuMsg;
                        let hit = await findDateButtonLive(msg, targetDate, dateStr);
                        if (!hit || !hit.data) throw new Error("live folder button missing");
                        await clickLive(hit.menuMsg.id, hit.data, "click folder");
                        clicked = true;
                        break;
                    } catch (clickErr) {
                        log.error(`userbot click folder error (attempt ${clickTry + 1}):`, clickErr && clickErr.message ? clickErr.message : clickErr);
                        await sleep(1200);
                        menuMsg = await openRootMenu();
                        if (!menuMsg) break;
                    }
                }
                if (!clicked) return false;
                await sleep(1500);
                if (shouldStop()) return false;

                // Domain once after first successful folder (DumpNews context)
                await ensureDomainQuery();
                if (shouldStop()) return false;

                // Hist / download
                let histHit = null;
                for (let histScan = 0; histScan < 12; histScan++) {
                    if (shouldStop()) return false;
                    try {
                        const folderMsgs = await withTimeout(
                            client.getMessages(searchTarget, { limit: 12 }),
                            timeoutMs,
                            "userbot getMessages folder",
                        );
                        if (Array.isArray(folderMsgs)) {
                            for (const m of folderMsgs) {
                                const isDoc = Boolean(m.document || (m.media && (m.media.document || m.media.className === "MessageMediaDocument")));
                                const rawText = String(m.message || m.text || "");
                                const hasCombos = rawText && containsComboCredentials(rawText);
                                if (!m.out && !seenResultIds.has(m.id) && (isDoc || hasCombos)) {
                                    seenResultIds.add(m.id);
                                    markHandledResultId(m.id);
                                    resultsFound += 1;
                                    if (options.onResult) {
                                        try { await Promise.resolve(options.onResult(m)); } catch (_) {}
                                    } else if (resultSink) {
                                        try { await Promise.resolve(resultSink(m)); } catch (_) {}
                                    }
                                    if (chatId && typeof forwardResult === "function") {
                                        await forwardResult(chatId, m, {
                                            botUsername: options.botUsername || botUsername || cfg.botUsername,
                                        }).catch(() => {});
                                    }
                                }
                            }
                            for (const m of folderMsgs) {
                                if (m.out || !m.replyMarkup || !Array.isArray(m.replyMarkup.rows)) continue;
                                for (const row of m.replyMarkup.rows) {
                                    if (!row || !Array.isArray(row.buttons)) continue;
                                    for (const btn of row.buttons) {
                                        if (!btn) continue;
                                        const data = extractLiveData(btn);
                                        if (!data || !data.length) continue;
                                        const dataStr = data.toString("utf8");
                                        const textStr = String(btn.text || "");
                                        if (
                                            isHistButton(btn) ||
                                            dataStr.startsWith(`hist:${dateStr}`) ||
                                            dataStr.includes("hist:") ||
                                            /hist|full|history|dump|скачать|download/i.test(textStr)
                                        ) {
                                            histHit = { msg: m, data, text: textStr };
                                            break;
                                        }
                                    }
                                    if (histHit) break;
                                }
                                if (histHit) break;
                            }
                        }
                    } catch (fErr) {
                        log.error("userbot getMessages folder error:", fErr && fErr.message ? fErr.message : fErr);
                    }
                    if (histHit) break;
                    await sleep(700);
                }

                if (histHit && histHit.data) {
                    onStatus({
                        day: dateStr,
                        attempt: dayIdx + 1,
                        totalDays: plannedTotal,
                        step: `Requesting dump: ${histHit.text || dateStr}`,
                    });
                    for (let histClickTry = 0; histClickTry < 3; histClickTry++) {
                        try {
                            const fresh = await refreshMsg(histHit.msg.id) || histHit.msg;
                            let data = histHit.data;
                            const rows = (fresh.replyMarkup && fresh.replyMarkup.rows) || [];
                            for (const row of rows) {
                                if (!row || !Array.isArray(row.buttons)) continue;
                                for (const btn of row.buttons) {
                                    if (isHistButton(btn)) {
                                        const liveData = extractLiveData(btn);
                                        if (liveData && liveData.length) data = liveData;
                                        break;
                                    }
                                }
                            }
                            await clickLive(fresh.id, data, "click hist");
                            break;
                        } catch (clickErr) {
                            log.error(`userbot click hist error (attempt ${histClickTry + 1}):`, clickErr && clickErr.message ? clickErr.message : clickErr);
                            await sleep(900);
                        }
                    }
                    daysProcessed += 1;

                    let foundDoc = false;
                    for (let waitAttempt = 0; waitAttempt < 8; waitAttempt++) {
                        if (shouldStop()) return true;
                        await sleep(waitAttempt === 0 ? 1800 : 1200);
                        const got = await ingestIncoming(dateStr, dayIdx);
                        if (got.foundDoc) { foundDoc = true; await sleep(400); break; }
                        if (got.foundAny && waitAttempt >= 3) break;
                    }
                    if (!foundDoc) {
                        await sleep(800);
                        await ingestIncoming(dateStr, dayIdx);
                    }
                } else {
                    log.log(`userbot could not find hist button in folder for ${dateStr}`);
                    await ingestIncoming(dateStr, dayIdx);
                    // Still count as processed attempt if folder opened
                    daysProcessed += 1;
                }

                return true;
            };

            try {
                let menuMsg = await openRootMenu();
                if (!menuMsg) {
                    return { status: "error", error: "Could not open searcher menu (/start).", daysProcessed: 0 };
                }

                // Inventory REAL dump folders across pages (not synthetic calendar days)
                onStatus({ day: "scan", attempt: 1, totalDays, step: "Building inventory of dump dates…" });
                const inv = await inventoryAllDates(menuMsg);
                menuMsg = inv.menuMsg || menuMsg;
                let dates = inv.dates || [];

                if (startDate) {
                    const startTs = startDate.getTime() + 12 * 3600 * 1000;
                    dates = dates.filter((f) => f.date.getTime() <= startTs);
                }

                if (dates.length === 0) {
                    // Last resort: single detected latest date only (don't invent missing calendar days)
                    const latest = detectLatestBatchDate(menuMsg) || (startDate ? new Date(startDate.getTime()) : null);
                    if (latest) {
                        dates = [{ date: latest, dateStr: formatDateDmy(latest) }];
                        log.log(`userbot inventory empty — using single detected date ${dates[0].dateStr}`);
                    } else {
                        return { status: "error", error: "No dump date folders found in searcher menu.", daysProcessed: 0 };
                    }
                }

                const planned = dates.slice(0, totalDays);
                log.log(`userbot will process ${planned.length} REAL dump day(s) (requested ${totalDays}): ${planned.map((p) => p.dateStr).join(", ")}`);

                for (let dayIdx = 0; dayIdx < planned.length; dayIdx++) {
                    if (shouldStop()) return { status: "stopped", daysProcessed, resultsFound };
                    const item = planned[dayIdx];
                    const ok = await processOneDay(item.date, item.dateStr, dayIdx, planned.length);
                    if (!ok) {
                        log.log(`userbot day ${item.dateStr} failed — continuing to next real date`);
                    }
                    if (dayIdx < planned.length - 1) {
                        onStatus({
                            day: item.dateStr,
                            attempt: dayIdx + 1,
                            totalDays: planned.length,
                            step: `Next dump day in ~${Math.round(clickGapMs / 1000)}s…`,
                        });
                        await paceDumpBot("next day");
                    }
                }

                return {
                    status: "done",
                    daysProcessed,
                    resultsFound,
                    foldersScanned: planned.length,
                    datesTried: planned.map((p) => p.dateStr),
                };
            } catch (fatalErr) {
                log.error("userbot searchDayByDay fatal error:", fatalErr && fatalErr.message ? fatalErr.message : fatalErr);
                return {
                    status: "error",
                    error: fatalErr && fatalErr.message ? fatalErr.message : String(fatalErr),
                    daysProcessed,
                    resultsFound,
                };
            }
        },

    };
}
