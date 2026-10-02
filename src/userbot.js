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
    // Folder "Back" / home controls are NOT page-prev (see isBackButton).
    if (
        text.includes("🔙") ||
        /^(🔙\s*)?(back|home|menu|меню)$/i.test(text) ||
        /^(back|home|main|menu|menu:root|menu:main|\/start)$/i.test(dataStr) ||
        /^back[=:_-]/i.test(dataStr)
    ) {
        return false;
    }
    if (
        text === "←" || text === "⇐" || text === "⬅" || text === "⬅️" || text === "◀️" ||
        text === "◀" || text === "◁" || text === "‹" || text === "«" || text === "<<" ||
        text === "<" || text === "≪" || text === "↤" || text === "↩"
    ) {
        return true;
    }
    if (/^(prev|назад|пред)$/i.test(text) || /prev|назад|пред/i.test(text)) return true;
    // data "back" alone is folder-back, not page-prev; page markers only
    if (/prev|page[_-]?(down|left|dec|-)/i.test(dataStr)) return true;
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
    if (isPageIndicatorButton(btn)) return false;
    return (
        dataStr === "back" ||
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
            // Never treat hist/download buttons as date folders — their callback
            // often embeds the date (hist:02.10.2026:0) which used to fool return-to-list.
            if (isHistButton(btn)) continue;
            const dataBuf = buttonDataBuffer(btn);
            const dataStr = dataBuf ? dataBuf.toString("utf8") : "";
            const textStr = String(btn.text || "");
            if (/^hist:|^dump:|^download:|^dl:|^file:/i.test(dataStr)) continue;
            // Prefer full DD.MM.YYYY (DUMP // Base 34 calendar rows)
            // Require the date to appear on a folder-ish control (text label or folder: data),
            // not buried only inside unrelated payloads.
            const dmyFromText = textStr.match(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/);
            const dmyFromData = dataStr.match(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/);
            const dmy = dmyFromText || dmyFromData;
            if (!dmy) continue;
            // If date only came from data, require folder/date-like callback prefix
            if (!dmyFromText && dmyFromData) {
                if (!/folder|date|day|batch|dump.?date/i.test(dataStr) && !/^\d{1,2}[.\/-]/.test(dataStr)) {
                    continue;
                }
            }
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
            if (!client) return false;
            try {
                if (typeof client.connected === "boolean" && client.connected === false) {
                    // Live disconnect — clear sticky ready so ensureUserbot reconnects
                    if (ready) ready = false;
                    return false;
                }
            } catch (_) {}
            if (ready) return true;
            try {
                if (typeof client.connected === "boolean") return Boolean(client.connected);
                if (client._sender && client._sender._connection) return true;
            } catch (_) {}
            return false;
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
            // Only listen to the searcher bot dialog — never all channels/chats.
            const newMessageFilter = { incoming: true, fromUsers: searcherId ? [searcherId] : undefined };
            client.addEventHandler(async (event) => {
                const msg = event.message;
                if (!msg) return;
                // Hard reject channel / broadcast peers
                try {
                    const peer = msg.peerId;
                    const cls = peer && (peer.className || peer.constructor && peer.constructor.name) || "";
                    if (/Channel|Chat/i.test(cls) && !/User/i.test(cls)) {
                        // Allow only if it's clearly the searcher user bot, not a channel
                        if (cls.includes("Channel")) return;
                    }
                } catch (_) {}
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
                // Must come from the configured searcher bot only
                if (!searcherId || !sender || sender !== searcherId) return;
                if (markHandledResultId(msg.id)) return;
                try {
                    await resultSink(msg);
                } catch (err) {
                    log.error("userbot result sink failed:", err && err.message ? err.message : err);
                }
            }, new libs.NewMessage(newMessageFilter));

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
                stepDelayMs = 10000,
                shouldStop = () => false,
                onStatus = () => {},
                sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
            } = options || {};

            const totalDays = Math.max(1, Math.min(90, Number(daysCount) || 5));
            const searchTarget = searcherEntity || cfg.searcher;
            // Pacing on the dump bot: default 10s between actions (override via SEARCH_STEP_DELAY_MS).
            const clickGapMs = Math.max(800, Number(stepDelayMs) || 10000);
            const seenResultIds = new Set();
            /** Only messages strictly newer than this id may be forwarded (anti re-forward of old dumps). */
            let resultWatermarkId = 0;
            let domainSent = false;
            let daysProcessed = 0;
            let resultsFound = 0;
            let lastDumpActionAt = 0;

            /**
             * Snapshot current searcher chat: mark existing docs/combos as already seen
             * and raise watermark so we never forward leftovers from previous runs/days.
             */
            const seedSeenFromHistory = async () => {
                try {
                    const latest = await client.getMessages(searchTarget, { limit: 40 });
                    if (!Array.isArray(latest)) return;
                    let maxId = resultWatermarkId;
                    for (const m of latest) {
                        if (!m || m.out) continue;
                        const mid = Number(m.id) || 0;
                        if (mid > maxId) maxId = mid;
                        const isDoc = Boolean(
                            m.document ||
                            (m.media && (m.media.document || m.media.className === "MessageMediaDocument"))
                        );
                        const rawText = String(m.message || m.text || "");
                        const hasCombos = rawText && containsComboCredentials(rawText);
                        if (isDoc || hasCombos) {
                            if (mid) {
                                seenResultIds.add(mid);
                                markHandledResultId(mid);
                            }
                        }
                    }
                    if (maxId > resultWatermarkId) resultWatermarkId = maxId;
                    log.log(`userbot result watermark seeded at msg id ${resultWatermarkId} (ignore older dumps)`);
                } catch (e) {
                    log.error("userbot seedSeenFromHistory error:", e && e.message ? e.message : e);
                }
            };

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

                // clickGapMs between every click on the dump bot.
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

            const openRootMenu = async (reason = "open menu") => {
                let sentStart = null;
                for (let startAttempt = 0; startAttempt < 3; startAttempt++) {
                    if (shouldStop()) return null;
                    try {
                        onStatus({
                            day: "init",
                            attempt: Math.max(1, daysProcessed + 1),
                            totalDays,
                            step: startAttempt === 0
                                ? `Sending /start (${reason})…`
                                : `Retrying /start (attempt ${startAttempt + 1})…`,
                        });
                        // /start counts as a dump-bot action — keep the pace gap
                        await paceDumpBot("/start");
                        if (shouldStop()) return null;
                        sentStart = await withTimeout(
                            client.sendMessage(searchTarget, { message: "/start" }),
                            timeoutMs,
                            "userbot send /start",
                        );
                        markDumpAction();
                        // Fresh menu = dump bot may have lost domain context
                        domainSent = false;
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

            /** DUMP // Base 34 style: middle button text "1/5". */
            const readPageIndicator = (menuMsg) => {
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

            const pageLabelOf = (menuMsg, fallback = "?") => {
                const ind = readPageIndicator(menuMsg);
                return ind ? `${ind.page}/${ind.total}` : String(fallback);
            };

            /** Log non-date buttons (arrows, Language, …) for pager debugging. */
            const logNonDateButtons = (menuMsg, tag = "menu") => {
                try {
                    const labels = [];
                    for (const row of (menuMsg && menuMsg.replyMarkup && menuMsg.replyMarkup.rows) || []) {
                        for (const btn of (row && row.buttons) || []) {
                            if (!btn) continue;
                            const t = String(btn.text || "");
                            if (/\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4}/.test(t)) continue;
                            const d = buttonDataString(btn).slice(0, 48);
                            labels.push(`${JSON.stringify(t)}→${JSON.stringify(d)}`);
                        }
                    }
                    log.log(`userbot ${tag} non-date buttons: ${labels.join(" | ") || "(none)"}`);
                } catch (_) {}
            };

            /**
             * Find a LIVE folder button for dateStr on the CURRENT page only.
             * Does not flip pages — caller owns pagination.
             */
            const findDateButtonOnPage = (menuMsg, targetDate, dateStr) => {
                if (!menuMsg || !menuMsg.replyMarkup) return null;
                const rows = menuMsg.replyMarkup.rows || [];
                for (const row of rows) {
                    if (!row || !Array.isArray(row.buttons)) continue;
                    for (const btn of row.buttons) {
                        if (!btn || isUtilityButton(btn)) continue;
                        const data = extractLiveData(btn);
                        if (!data || !data.length) continue;
                        const dataStr = data.toString("utf8");
                        const textStr = String(btn.text || "");
                        if (
                            buttonMatchesDate(btn, targetDate) ||
                            dataStr.includes(dateStr) ||
                            textStr.includes(dateStr) ||
                            (dateStr.length >= 5 && textStr.includes(dateStr.slice(0, 5)))
                        ) {
                            return { menuMsg, data, text: textStr };
                        }
                    }
                }
                return null;
            };

            /** Click → and wait until page indicator / dates change. */
            const goNextPage = async (menuMsg) => {
                if (!menuMsg) return null;
                const beforeInd = readPageIndicator(menuMsg);
                const beforeKeys = extractFolderDatesFromMessage(menuMsg).map((f) => f.dateStr).join("|");
                const next = findNavButton(menuMsg, "next");
                if (!next || !next.data) {
                    log.log(`userbot goNextPage: no → button on page ${pageLabelOf(menuMsg)}`);
                    logNonDateButtons(menuMsg, "goNextPage");
                    return null;
                }
                if (beforeInd && beforeInd.page >= beforeInd.total) {
                    log.log(`userbot goNextPage: already on last page ${beforeInd.text}`);
                    return null;
                }
                try {
                    // Re-read LIVE next bytes right before click (markup may have been edited)
                    const liveMenu = (await refreshMsg(menuMsg.id)) || menuMsg;
                    const liveNext = findNavButton(liveMenu, "next") || next;
                    if (!liveNext || !liveNext.data) return null;
                    await clickLive(liveMenu.id, liveNext.data, "nextPage");
                } catch (e) {
                    log.error("userbot nextPage error:", e && e.message ? e.message : e);
                    return null;
                }
                await sleep(1000);
                let refreshed = null;
                for (let pWait = 0; pWait < 12; pWait++) {
                    refreshed = await refreshMsg(menuMsg.id);
                    if (refreshed && refreshed.replyMarkup) {
                        const ind2 = readPageIndicator(refreshed);
                        const afterKeys = extractFolderDatesFromMessage(refreshed).map((f) => f.dateStr).join("|");
                        if (beforeInd && ind2 && ind2.page !== beforeInd.page) break;
                        if (afterKeys && afterKeys !== beforeKeys) break;
                        if (!beforeInd && pWait >= 3) break;
                    }
                    const maybe = await findMenu(0);
                    if (maybe && maybe.id !== menuMsg.id) {
                        refreshed = maybe;
                        break;
                    }
                    await sleep(400);
                }
                if (!refreshed) return null;
                const afterInd = readPageIndicator(refreshed);
                const afterKeys = extractFolderDatesFromMessage(refreshed).map((f) => f.dateStr).join("|");
                if (
                    beforeInd && afterInd && afterInd.page === beforeInd.page &&
                    afterKeys === beforeKeys
                ) {
                    log.log(`userbot goNextPage: page did not advance (still ${afterInd.text})`);
                    return null;
                }
                if (!afterInd && afterKeys && afterKeys === beforeKeys) {
                    log.log("userbot goNextPage: content unchanged after →");
                    return null;
                }
                log.log(
                    `userbot flipped ${pageLabelOf(menuMsg, "?")} → ${pageLabelOf(refreshed, "?")} ` +
                    `[${extractFolderDatesFromMessage(refreshed).map((f) => f.dateStr).join(", ")}]`
                );
                return refreshed;
            };

            /**
             * Fast path: click Back on the live folder markup to return to the date list
             * on the same page. Returns menu msg or null if Back is missing / failed.
             */
            const tryReturnViaBack = async (targetPage = 1) => {
                try {
                    const latest = await client.getMessages(searchTarget, { limit: 10 });
                    if (!Array.isArray(latest)) return null;
                    for (const m of latest) {
                        if (!m || m.out || !m.replyMarkup || !m.replyMarkup.rows) continue;
                        // Already back on a date list?
                        if (extractFolderDatesFromMessage(m).length > 0) {
                            const ind = readPageIndicator(m);
                            if (!targetPage || !ind || ind.page === targetPage) return m;
                            return m;
                        }
                        const back = findNavButton(m, "back");
                        if (!back || !back.data) continue;
                        try {
                            await clickLive(m.id, back.data, "back");
                        } catch (e) {
                            log.error("userbot back click error:", e && e.message ? e.message : e);
                            continue;
                        }
                        await sleep(600);
                        const after = (await refreshMsg(m.id)) || (await findMenu(0));
                        if (after && extractFolderDatesFromMessage(after).length > 0) {
                            log.log(`userbot Back restored page ${pageLabelOf(after)}`);
                            return after;
                        }
                    }
                } catch (e) {
                    log.error("userbot tryReturnViaBack error:", e && e.message ? e.message : e);
                }
                return null;
            };

            /**
             * Hard reset: ALWAYS send /start for a clean menu, then hop → to targetPage.
             * Used when Back fails or markup is lost.
             */
            const restartMenuAtPage = async (targetPage = 1, reason = "after day results") => {
                let menu = await openRootMenu(reason);
                if (!menu) return null;
                const want = Math.max(1, Number(targetPage) || 1);
                if (want <= 1) return menu;

                for (let hop = 1; hop < want && hop < 40; hop++) {
                    if (shouldStop()) return menu;
                    const ind = readPageIndicator(menu);
                    if (ind && ind.page >= want) break;
                    if (ind && ind.page >= ind.total) break;
                    const next = findNavButton(menu, "next");
                    if (!next || !next.data) {
                        log.log(`userbot restartMenuAtPage: no → while seeking page ${want} (at ${pageLabelOf(menu)})`);
                        logNonDateButtons(menu, "restart-seek");
                        break;
                    }
                    const advanced = await goNextPage(menu);
                    if (!advanced) break;
                    menu = advanced;
                }
                log.log(`userbot restarted menu at page ${pageLabelOf(menu)} (wanted ${want})`);
                return menu;
            };

            /**
             * From current menu (usually page 1 after /start), walk → until a page
             * still has unprocessed date folders. Returns { menuMsg, folders } or null.
             */
            const seekNextUnprocessedPage = async (menuMsg, processed, startTsFilter) => {
                let current = menuMsg;
                let hops = 0;
                while (current && hops < 40) {
                    if (shouldStop()) return null;
                    const ind = readPageIndicator(current);
                    const raw = extractFolderDatesFromMessage(current);
                    let folders = raw.slice();
                    if (startTsFilter != null) {
                        folders = folders.filter((f) => f.date && f.date.getTime() <= startTsFilter);
                    }
                    folders = folders.filter((f) => f.dateStr && !processed.has(f.dateStr));
                    if (folders.length > 0) {
                        return { menuMsg: current, folders, pageLabel: pageLabelOf(current, hops + 1) };
                    }
                    if (ind && ind.page >= ind.total) {
                        log.log(`userbot seek: last page ${ind.text} with no remaining dates`);
                        return null;
                    }
                    const next = await goNextPage(current);
                    if (!next) return null;
                    current = next;
                    hops += 1;
                }
                return null;
            };

            const ensureDomainQuery = async () => {
                if (domainSent || !query) return;
                onStatus({
                    day: "init",
                    attempt: Math.max(1, daysProcessed + 1),
                    totalDays,
                    step: `Setting domain query "${query}" (after /start)`,
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

            const isDumpLikeMessage = (m) => {
                if (!m || m.out) return false;
                const isDoc = Boolean(
                    m.document ||
                    (m.media && (m.media.document || m.media.className === "MessageMediaDocument"))
                );
                const rawText = String(m.message || m.text || "");
                const hasCombos = rawText && containsComboCredentials(rawText);
                return { isDoc, hasCombos, ok: isDoc || hasCombos };
            };

            /** Only NEW dumps after hist — never re-forward previous days' results still in chat. */
            const ingestIncoming = async (dateStr, dayIdx) => {
                let foundDoc = false;
                let foundAny = false;
                try {
                    const latest = await client.getMessages(searchTarget, { limit: 15 });
                    if (!Array.isArray(latest)) return { foundDoc, foundAny };
                    // Process oldest→newest so order is natural; skip anything ≤ watermark
                    const ordered = latest.slice().sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
                    for (const m of ordered) {
                        const mid = Number(m.id) || 0;
                        if (!mid || mid <= resultWatermarkId) continue;
                        if (seenResultIds.has(mid)) continue;
                        const kind = isDumpLikeMessage(m);
                        if (!kind.ok) continue;

                        seenResultIds.add(mid);
                        markHandledResultId(mid);
                        // Raise watermark so concurrent scans don't re-pick this id
                        if (mid > resultWatermarkId) resultWatermarkId = mid;
                        foundAny = true;
                        resultsFound += 1;
                        if (kind.isDoc) {
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
                        // When onResult is provided by beginUlpRun it already cleans;
                        // still forward into the operator chat once for this NEW id only.
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

            /**
             * Process one REAL dump day that is already visible on the current page.
             * After hist + results: ALWAYS /start again (clean menu), then restore page.
             * Returns { ok, menuMsg, page } with a fresh root-or-restored date list.
             */
            const processOneDayOnPage = async (menuMsg, targetDate, dateStr, dayIdx, pageLabel, onPageIdx, onPageTotal) => {
                const progressPrefix = `Page ${pageLabel} · day ${dateStr} (${onPageIdx}/${onPageTotal} on page)`;
                const startInd = readPageIndicator(menuMsg);
                const stayPage = startInd ? startInd.page : 1;

                onStatus({
                    day: dateStr,
                    attempt: dayIdx + 1,
                    totalDays,
                    step: `${progressPrefix} — selecting folder…`,
                });

                let current = menuMsg;
                let clicked = false;
                for (let clickTry = 0; clickTry < 3; clickTry++) {
                    try {
                        current = (await refreshMsg(current.id)) || current;
                        const hit = findDateButtonOnPage(current, targetDate, dateStr);
                        if (!hit || !hit.data) throw new Error("live folder button missing on page");
                        await clickLive(hit.menuMsg.id, hit.data, "click folder");
                        clicked = true;
                        break;
                    } catch (clickErr) {
                        log.error(
                            `userbot click folder error (attempt ${clickTry + 1}) ${dateStr}:`,
                            clickErr && clickErr.message ? clickErr.message : clickErr
                        );
                        await sleep(1200);
                        // Folder disappeared / markup stale — fresh /start and restore page, then retry
                        current = await restartMenuAtPage(stayPage, `retry folder ${dateStr}`) || current;
                    }
                }
                if (!clicked) {
                    log.log(`userbot could not click date folder ${dateStr} on page ${pageLabel}`);
                    const menu = await restartMenuAtPage(stayPage, `after failed ${dateStr}`).catch(() => null);
                    return { ok: false, menuMsg: menu || current, page: stayPage };
                }
                await sleep(700);
                if (shouldStop()) {
                    const menu = await restartMenuAtPage(1, "stopped").catch(() => null);
                    return { ok: false, menuMsg: menu || current, page: stayPage };
                }

                // Domain after folder open (reset after every /start so each day gets context)
                await ensureDomainQuery();
                if (shouldStop()) {
                    return { ok: false, menuMsg: current, page: stayPage };
                }

                // Hist / download — scan for hist button only (do NOT forward old dumps here)
                let histHit = null;
                for (let histScan = 0; histScan < 12; histScan++) {
                    if (shouldStop()) break;
                    try {
                        const folderMsgs = await withTimeout(
                            client.getMessages(searchTarget, { limit: 12 }),
                            timeoutMs,
                            "userbot getMessages folder",
                        );
                        if (Array.isArray(folderMsgs)) {
                            // Mark pre-hist dumps as seen so we never treat chat leftovers as this day's result
                            for (const m of folderMsgs) {
                                if (!m || m.out) continue;
                                const mid = Number(m.id) || 0;
                                const kind = isDumpLikeMessage(m);
                                if (kind.ok && mid) {
                                    seenResultIds.add(mid);
                                    markHandledResultId(mid);
                                    if (mid > resultWatermarkId) resultWatermarkId = mid;
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
                        totalDays,
                        step: `${progressPrefix} — requesting dump…`,
                    });
                    // Raise watermark to "now" right before hist so only brand-new replies count
                    try {
                        const snap = await client.getMessages(searchTarget, { limit: 5 });
                        if (Array.isArray(snap)) {
                            for (const m of snap) {
                                const mid = Number(m && m.id) || 0;
                                if (mid > resultWatermarkId) resultWatermarkId = mid;
                            }
                        }
                    } catch (_) {}

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
                            log.error(
                                `userbot click hist error (attempt ${histClickTry + 1}):`,
                                clickErr && clickErr.message ? clickErr.message : clickErr
                            );
                            await sleep(900);
                        }
                    }
                    daysProcessed += 1;

                    let foundDoc = false;
                    // Fast poll for dump results — bail as soon as file/combos land
                    for (let waitAttempt = 0; waitAttempt < 6; waitAttempt++) {
                        if (shouldStop()) break;
                        await sleep(waitAttempt === 0 ? 900 : 700);
                        const got = await ingestIncoming(dateStr, dayIdx);
                        if (got.foundDoc) { foundDoc = true; break; }
                        if (got.foundAny && waitAttempt >= 2) break;
                    }
                    if (!foundDoc) {
                        await sleep(400);
                        await ingestIncoming(dateStr, dayIdx);
                    }
                } else {
                    log.log(`userbot could not find hist button in folder for ${dateStr}`);
                    await ingestIncoming(dateStr, dayIdx);
                    daysProcessed += 1;
                }

                // Prefer Back to the same page (fast). Only /start if Back fails.
                onStatus({
                    day: dateStr,
                    attempt: daysProcessed,
                    totalDays,
                    step: `${progressPrefix} — results in; return to date list…`,
                });
                log.log(`userbot day ${dateStr} done — return to list (page ${stayPage})`);
                let restored = await tryReturnViaBack(stayPage);
                if (!restored || extractFolderDatesFromMessage(restored).length === 0) {
                    log.log(`userbot Back failed after ${dateStr} — /start + hop to page ${stayPage}`);
                    restored = await restartMenuAtPage(stayPage, `after ${dateStr} results`);
                }
                return {
                    ok: true,
                    menuMsg: restored || current || menuMsg,
                    page: stayPage,
                };
            };

            try {
                /*
                 * Page-first, day-by-day (DUMP // Base 34):
                 *   /start → page 1
                 *   for each real date top→bottom on current page:
                 *     click date → domain → hist → wait results (NEW dumps only)
                 *     return via Back (or /start) and continue
                 *   when page exhausted → → next page
                 * Never invent missing calendar days. Never re-forward old dumps.
                 */
                await seedSeenFromHistory();
                let menuMsg = await openRootMenu("open menu");
                if (!menuMsg) {
                    return { status: "error", error: "Could not open searcher menu (/start).", daysProcessed: 0 };
                }
                // Seed again after /start menu messages land so they don't count as dumps
                await seedSeenFromHistory();

                const datesTried = [];
                const processedSet = new Set();
                let pagesWalked = 0;
                const maxPages = 40;
                const startTs = startDate ? startDate.getTime() + 12 * 3600 * 1000 : null;

                onStatus({
                    day: "init",
                    attempt: 1,
                    totalDays,
                    step: `Page ${pageLabelOf(menuMsg, "1")} — day-by-day, /start after each result…`,
                });
                log.log(`userbot page-first run: need ${totalDays} real day(s), starting page ${pageLabelOf(menuMsg, "1")}`);
                logNonDateButtons(menuMsg, "page1");

                // Empty first open → one /start retry
                if (extractFolderDatesFromMessage(menuMsg).length === 0) {
                    log.log("userbot page 1 has no date folders — retrying /start");
                    menuMsg = await openRootMenu("retry empty menu");
                    if (!menuMsg || extractFolderDatesFromMessage(menuMsg).length === 0) {
                        logNonDateButtons(menuMsg, "empty-page1");
                        if (!menuMsg || !findNavButton(menuMsg, "next")) {
                            return { status: "error", error: "No dump date folders found in searcher menu.", daysProcessed: 0 };
                        }
                    }
                }

                while (daysProcessed < totalDays && pagesWalked < maxPages) {
                    if (shouldStop()) {
                        return { status: "stopped", daysProcessed, resultsFound, datesTried, foldersScanned: datesTried.length };
                    }

                    // After each /start the menu may be on page 1 — walk → to next unprocessed page
                    const sought = await seekNextUnprocessedPage(menuMsg, processedSet, startTs);
                    if (!sought) {
                        log.log(`userbot no more unprocessed dump dates (done ${daysProcessed}/${totalDays})`);
                        break;
                    }
                    menuMsg = sought.menuMsg;
                    const pageFolders = sought.folders;
                    const pageLabel = sought.pageLabel;
                    const ind = readPageIndicator(menuMsg);

                    log.log(
                        `userbot page ${pageLabel}: ${pageFolders.length} date(s) remaining ` +
                        `[${pageFolders.map((f) => f.dateStr).join(", ")}] ` +
                        `(done ${daysProcessed}/${totalDays})`
                    );

                    // Process ONE day, then /start is forced inside processOneDayOnPage
                    const folder = pageFolders[0];
                    const dateStr = folder.dateStr;
                    if (!dateStr || processedSet.has(dateStr)) {
                        processedSet.add(dateStr);
                        continue;
                    }

                    // Live rebind right before click
                    menuMsg = (await refreshMsg(menuMsg.id)) || menuMsg;
                    if (!menuMsg || extractFolderDatesFromMessage(menuMsg).length === 0) {
                        menuMsg = await restartMenuAtPage(ind ? ind.page : 1, "menu lost before day") || menuMsg;
                    }
                    if (!menuMsg) break;

                    onStatus({
                        day: dateStr,
                        attempt: daysProcessed + 1,
                        totalDays,
                        step: `Page ${pageLabel} · ${dateStr} (1/${pageFolders.length} remaining on page)`,
                    });

                    const dayIdx = datesTried.length;
                    const result = await processOneDayOnPage(
                        menuMsg,
                        folder.date,
                        dateStr,
                        dayIdx,
                        pageLabel,
                        1,
                        pageFolders.length,
                    );
                    // processOneDayOnPage always ends with /start + page restore
                    menuMsg = result.menuMsg || menuMsg;
                    processedSet.add(dateStr);
                    datesTried.push(dateStr);

                    if (!result.ok) {
                        log.log(`userbot day ${dateStr} on page ${pageLabel} failed — /start'd and continuing`);
                    }

                    if (daysProcessed >= totalDays) break;

                    // Count page passes loosely (seek may hop multiple)
                    const nowInd = readPageIndicator(menuMsg);
                    if (nowInd && ind && nowInd.page !== ind.page) pagesWalked += 1;
                    else if (!pageFolders.slice(1).some((f) => f.dateStr && !processedSet.has(f.dateStr))) {
                        // This page exhausted after the day — next loop seek will flip →
                        pagesWalked += 1;
                    }

                    onStatus({
                        day: dateStr,
                        attempt: daysProcessed,
                        totalDays,
                        step: `Next dump day after /start (~${Math.round(clickGapMs / 1000)}s pace)…`,
                    });
                }

                log.log(
                    `userbot page-first done: ${daysProcessed} day(s), ${resultsFound} result(s), ` +
                    `dates=[${datesTried.join(", ")}], pages≈${Math.max(1, pagesWalked)}`
                );

                return {
                    status: "done",
                    daysProcessed,
                    resultsFound,
                    foldersScanned: datesTried.length,
                    datesTried,
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
