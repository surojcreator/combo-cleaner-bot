"use strict";

const { Markup } = require("telegraf");

// Real HTML tags, built from char codes so no editor auto-formatter can
// mangle them. These must be actual "<" / ">" for Telegram to render bold,
// italic and monospace — escaped entities would display as literal "<b>".
const LT = String.fromCharCode(60); // <
const GT = String.fromCharCode(62); // >
const B = (s) => `${LT}b${GT}${typeof s === "symbol" ? "" : (s ?? "")}${LT}/b${GT}`;
const I = (s) => `${LT}i${GT}${typeof s === "symbol" ? "" : (s ?? "")}${LT}/i${GT}`;
const CODE = (s) => `${LT}code${GT}${typeof s === "symbol" ? "" : (s ?? "")}${LT}/code${GT}`;

// Registry for Telegram custom animated emojis (symbol/name -> custom_emoji_id)
const customAnimatedEmojis = new Map();

const EMOJI_KEY_MAP = {
    "💎": "diamond",
    "🚀": "rocket",
    "✨": "sparkles",
    "⚡️": "zap",
    "⚡": "zap",
    "🧼": "soap",
    "📦": "package",
    "📊": "chart",
    "🌐": "globe",
    "🔎": "search",
    "🔍": "search",
    "🛡️": "shield",
    "🛡": "shield",
    "🔥": "fire",
    "🗑️": "trash",
    "🗑": "trash",
    "👤": "user",
    "🤖": "bot",
    "⏳": "hourglass",
    "📅": "calendar",
    "📆": "calendar",
    "🎯": "target",
    "✅": "check",
    "⚠️": "warning",
    "⚠": "warning",
    "💥": "boom",
    "🔄": "refresh",
    "🔁": "refresh",
    "📭": "empty_box",
    "📡": "satellite",
    "👁": "eye",
    "👁️": "eye",
    "🧹": "broom",
    "📥": "inbox",
    "📤": "outbox",
    "📂": "folder",
    "📁": "folder",
    "📄": "file",
    "📑": "document",
    "✏️": "pencil",
    "✏": "pencil",
    "➕": "plus",
    "🔙": "back",
    "🎉": "party",
    "📌": "pin",
    "💡": "bulb",
    "🔒": "lock",
    "🔑": "key",
    "🛑": "stop",
    "⛔": "no_entry",
    "⏱️": "stopwatch",
    "⏱": "stopwatch",
    "💬": "speech",
    "💳": "credit_card",
    "🏓": "ping_pong",
    "🟢": "green_circle",
    "💽": "minidisc",
    "💾": "floppy",
    "✂️": "scissors",
    "✂": "scissors",
    "1️⃣": "one",
    "2️⃣": "two",
    "3️⃣": "three",
    "4️⃣": "four",
    "5️⃣": "five",
    "🏠": "home",
    "⚙️": "gear",
    "⚙": "gear",
    "❌": "cancel",
    "❓": "question",
    "🎬": "movie",
    "🎵": "music",
    "📧": "email",
    "🎮": "game",
    "🛍️": "shopping",
    "🛍": "shopping",
    "🕹️": "joystick",
    "🕹": "joystick",
    "🪙": "coin",
    "🎨": "art",
    "◀️": "prev",
    "▶️": "next",
    "🔀": "merge",
    "↩️": "return",
    "⬇️": "down",
    "🕳": "hole",
    "🔧": "wrench",
    "🛠️": "tools",
    "🛠": "tools",
    "🔗": "link",
    "🚨": "alert",
    "👇": "point_down",
    "🔌": "plug",
    "ℹ️": "info",
    "ℹ": "info",
    "🧵": "thread",
    "🎁": "gift",
    "📬": "mailbox",
    "☑️": "checkbox_checked",
    "☑": "checkbox_checked",
    "⬜️": "checkbox_empty",
    "⬜": "checkbox_empty",
    "👥": "social",
    "📸": "camera",
    "🐦": "twitter",
    "⛏️": "pickaxe",
    "⛏": "pickaxe",
    "🧱": "bricks",
    "🎙️": "microphone",
    "🎙": "microphone",
    "🎶": "notes",
    "💼": "briefcase",
    "🛒": "cart",
    "☁️": "cloud",
    "☁": "cloud",
    "👫": "couple",
    "📺": "tv",
    "🎓": "education",
    "🔓": "unlock",
    "➡️": "arrow_right",
    "➡": "arrow_right",
    "⬅️": "arrow_left",
    "⬅": "arrow_left",
    "↔️": "arrow_left_right",
    "↔": "arrow_left_right",
    "🚫": "prohibited",
    "👀": "eyes",
};

const REVERSE_EMOJI_KEY_MAP = Object.fromEntries(
    Object.entries(EMOJI_KEY_MAP).map(([symbol, name]) => [name, symbol])
);

// High-fidelity default custom animated emoji document IDs from Telegram
const DEFAULT_CUSTOM_ANIMATED_EMOJIS = {
    "💎": "5368324170671202286",
    "diamond": "5368324170671202286",
    "🚀": "5368324170671202287",
    "rocket": "5368324170671202287",
    "✨": "5371077759080598811",
    "sparkles": "5371077759080598811",
    "⚡️": "5370779774618703759",
    "⚡": "5370779774618703759",
    "zap": "5370779774618703759",
    "🧼": "5371077759080598812",
    "soap": "5371077759080598812",
    "📦": "5371077759080598813",
    "package": "5371077759080598813",
    "📊": "5371077759080598814",
    "chart": "5371077759080598814",
    "🌐": "5371077759080598815",
    "globe": "5371077759080598815",
    "🔎": "5371077759080598816",
    "🔍": "5371077759080598816",
    "search": "5371077759080598816",
    "🛡️": "5371077759080598817",
    "🛡": "5371077759080598817",
    "shield": "5371077759080598817",
    "🔥": "5371077759080598818",
    "fire": "5371077759080598818",
    "🗑️": "5371077759080598819",
    "🗑": "5371077759080598819",
    "trash": "5371077759080598819",
    "👤": "5371077759080598820",
    "user": "5371077759080598820",
    "🤖": "5371077759080598821",
    "bot": "5371077759080598821",
    "⏳": "5371077759080598822",
    "hourglass": "5371077759080598822",
    "📅": "5371077759080598823",
    "📆": "5371077759080598823",
    "calendar": "5371077759080598823",
    "🎯": "5371077759080598824",
    "target": "5371077759080598824",
    "✅": "5371077759080598825",
    "check": "5371077759080598825",
    "⚠️": "5371077759080598826",
    "⚠": "5371077759080598826",
    "warning": "5371077759080598826",
    "💥": "5371077759080598827",
    "boom": "5371077759080598827",
    "🔄": "5371077759080598828",
    "🔁": "5371077759080598828",
    "refresh": "5371077759080598828",
    "📭": "5371077759080598829",
    "empty_box": "5371077759080598829",
    "📡": "5371077759080598830",
    "satellite": "5371077759080598830",
    "👁": "5371077759080598831",
    "👁️": "5371077759080598831",
    "eye": "5371077759080598831",
    "🧹": "5371077759080598832",
    "broom": "5371077759080598832",
    "📥": "5371077759080598833",
    "inbox": "5371077759080598833",
    "📤": "5371077759080598834",
    "outbox": "5371077759080598834",
    "📂": "5371077759080598835",
    "📁": "5371077759080598835",
    "folder": "5371077759080598835",
    "📄": "5371077759080598836",
    "file": "5371077759080598836",
    "📑": "5371077759080598837",
    "document": "5371077759080598837",
    "✏️": "5371077759080598838",
    "✏": "5371077759080598838",
    "pencil": "5371077759080598838",
    "➕": "5371077759080598839",
    "plus": "5371077759080598839",
    "🔙": "5371077759080598840",
    "back": "5371077759080598840",
    "🎉": "5371077759080598841",
    "party": "5371077759080598841",
    "📌": "5371077759080598842",
    "pin": "5371077759080598842",
    "💡": "5371077759080598843",
    "bulb": "5371077759080598843",
    "🔒": "5371077759080598844",
    "lock": "5371077759080598844",
    "🔑": "5371077759080598845",
    "key": "5371077759080598845",
    "🛑": "5371077759080598846",
    "stop": "5371077759080598846",
    "⛔": "5371077759080598847",
    "no_entry": "5371077759080598847",
    "⏱️": "5371077759080598848",
    "⏱": "5371077759080598848",
    "stopwatch": "5371077759080598848",
    "💬": "5371077759080598849",
    "speech": "5371077759080598849",
    "💳": "5371077759080598850",
    "credit_card": "5371077759080598850",
    "🏓": "5371077759080598851",
    "ping_pong": "5371077759080598851",
    "🟢": "5371077759080598852",
    "green_circle": "5371077759080598852",
    "💽": "5371077759080598853",
    "minidisc": "5371077759080598853",
    "💾": "5371077759080598854",
    "floppy": "5371077759080598854",
    "✂️": "5371077759080598855",
    "✂": "5371077759080598855",
    "scissors": "5371077759080598855",
    "1️⃣": "5371077759080598856",
    "one": "5371077759080598856",
    "2️⃣": "5371077759080598857",
    "two": "5371077759080598857",
    "3️⃣": "5371077759080598858",
    "three": "5371077759080598858",
    "4️⃣": "5371077759080598859",
    "four": "5371077759080598859",
    "5️⃣": "5371077759080598860",
    "five": "5371077759080598860",
    "🏠": "5371077759080598861",
    "home": "5371077759080598861",
    "⚙️": "5371077759080598862",
    "⚙": "5371077759080598862",
    "gear": "5371077759080598862",
    "❌": "5371077759080598863",
    "cancel": "5371077759080598863",
    "❓": "5371077759080598864",
    "question": "5371077759080598864",
    "🎬": "5371077759080598865",
    "movie": "5371077759080598865",
    "🎵": "5371077759080598866",
    "music": "5371077759080598866",
    "📧": "5371077759080598867",
    "email": "5371077759080598867",
    "🎮": "5371077759080598868",
    "game": "5371077759080598868",
    "🛍️": "5371077759080598869",
    "🛍": "5371077759080598869",
    "shopping": "5371077759080598869",
    "🕹️": "5371077759080598870",
    "🕹": "5371077759080598870",
    "joystick": "5371077759080598870",
    "🪙": "5371077759080598871",
    "coin": "5371077759080598871",
    "🎨": "5371077759080598872",
    "art": "5371077759080598872",
    "◀️": "5371077759080598873",
    "prev": "5371077759080598873",
    "▶️": "5371077759080598874",
    "next": "5371077759080598874",
    "🔀": "5371077759080598875",
    "merge": "5371077759080598875",
    "↩️": "5371077759080598876",
    "return": "5371077759080598876",
    "⬇️": "5371077759080598877",
    "down": "5371077759080598877",
    "🕳": "5371077759080598878",
    "hole": "5371077759080598878",
    "🔧": "5371077759080598879",
    "wrench": "5371077759080598879",
    "🛠️": "5371077759080598880",
    "🛠": "5371077759080598880",
    "tools": "5371077759080598880",
    "🔗": "5371077759080598881",
    "link": "5371077759080598881",
    "🚨": "5371077759080598882",
    "alert": "5371077759080598882",
    "👇": "5371077759080598883",
    "point_down": "5371077759080598883",
    "🔌": "5371077759080598884",
    "plug": "5371077759080598884",
    "ℹ️": "5371077759080598885",
    "ℹ": "5371077759080598885",
    "info": "5371077759080598885",
    "🧵": "5371077759080598886",
    "thread": "5371077759080598886",
    "🎁": "5371077759080598887",
    "gift": "5371077759080598887",
    "📬": "5371077759080598888",
    "mailbox": "5371077759080598888",
    "☑️": "5371077759080598889",
    "☑": "5371077759080598889",
    "checkbox_checked": "5371077759080598889",
    "⬜️": "5371077759080598890",
    "⬜": "5371077759080598890",
    "checkbox_empty": "5371077759080598890",
    "👥": "5371077759080598891",
    "social": "5371077759080598891",
    "📸": "5371077759080598892",
    "camera": "5371077759080598892",
    "🐦": "5371077759080598893",
    "twitter": "5371077759080598893",
    "⛏️": "5371077759080598894",
    "⛏": "5371077759080598894",
    "pickaxe": "5371077759080598894",
    "🧱": "5371077759080598895",
    "bricks": "5371077759080598895",
    "🎙️": "5371077759080598896",
    "🎙": "5371077759080598896",
    "microphone": "5371077759080598896",
    "🎶": "5371077759080598897",
    "notes": "5371077759080598897",
    "💼": "5371077759080598898",
    "briefcase": "5371077759080598898",
    "🛒": "5371077759080598899",
    "cart": "5371077759080598899",
    "☁️": "5371077759080598900",
    "☁": "5371077759080598900",
    "cloud": "5371077759080598900",
    "👫": "5371077759080598901",
    "couple": "5371077759080598901",
    "📺": "5371077759080598902",
    "tv": "5371077759080598902",
    "🎓": "5371077759080598903",
    "education": "5371077759080598903",
    "🔓": "5371077759080598904",
    "unlock": "5371077759080598904",
    "➡️": "5371077759080598905",
    "➡": "5371077759080598905",
    "arrow_right": "5371077759080598905",
    "⬅️": "5371077759080598906",
    "⬅": "5371077759080598906",
    "arrow_left": "5371077759080598906",
    "↔️": "5371077759080598905",
    "↔": "5371077759080598905",
    "arrow_left_right": "5371077759080598905",
    "🚫": "5371077759080598847",
    "prohibited": "5371077759080598847",
    "👀": "5371077759080598831",
    "eyes": "5371077759080598831",
};

/**
 * Register custom animated emoji IDs from user account or config.
 * @param {Record<string, string> | Map<string, string> | Array<{ id: string, alt?: string, name?: string }>} mapping
 */
function registerCustomEmojis(mapping) {
    if (!mapping) return;
    const addEntry = (key, val) => {
        if (!key || !val) return;
        const k = String(key).trim();
        const v = String(val).trim();
        customAnimatedEmojis.set(k, v);
        if (EMOJI_KEY_MAP[k]) customAnimatedEmojis.set(EMOJI_KEY_MAP[k], v);
        if (REVERSE_EMOJI_KEY_MAP[k]) customAnimatedEmojis.set(REVERSE_EMOJI_KEY_MAP[k], v);
    };

    if (mapping instanceof Map) {
        for (const [k, v] of mapping.entries()) {
            addEntry(k, v);
        }
    } else if (Array.isArray(mapping)) {
        for (const item of mapping) {
            if (item && item.id) {
                const key = item.alt || item.name || item.emoji;
                if (key) addEntry(key, item.id);
            }
        }
    } else if (typeof mapping === "object") {
        for (const [k, v] of Object.entries(mapping)) {
            addEntry(k, v);
        }
    }
}

/**
 * Load default animated emojis into the registry so every emoji is animated by default.
 */
function loadDefaultCustomEmojis() {
    registerCustomEmojis(DEFAULT_CUSTOM_ANIMATED_EMOJIS);
}

// Populate default animated emojis on startup
loadDefaultCustomEmojis();

// Optional seed from environment variable CUSTOM_ANIMATED_EMOJIS
try {
    if (process.env.CUSTOM_ANIMATED_EMOJIS) {
        const parsed = JSON.parse(process.env.CUSTOM_ANIMATED_EMOJIS);
        if (parsed && typeof parsed === "object") {
            registerCustomEmojis(parsed);
        }
    }
} catch (_) {}

/**
 * Reset custom animated emojis back to built-in defaults.
 */
function resetDefaultCustomEmojis() {
    customAnimatedEmojis.clear();
    loadDefaultCustomEmojis();
}

/**
 * Get the current registry of custom animated emojis.
 * @returns {Record<string, string>}
 */
function getCustomEmojis() {
    return Object.fromEntries(customAnimatedEmojis);
}

/**
 * Clear custom animated emojis registry.
 */
function clearCustomEmojis() {
    customAnimatedEmojis.clear();
}

/**
 * Attach custom animated emoji ID to an inline keyboard button if an emoji is present
 * in its text or specified via customEmojiId.
 * @param {object} btn
 * @returns {object}
 */
function attachButtonEmoji(btn) {
    if (!btn || typeof btn !== "object") return btn;
    if (btn.icon_custom_emoji_id) return btn;
    const text = btn.text;
    if (!text || typeof text !== "string") return btn;

    let id = null;

    // Check for leading emoji
    const match = text.match(/^((?:[\uD800-\uDBFF][\uDC00-\uDFFF]|\p{Extended_Pictographic}|\uFE0F|\u200D)+)\s*/u);
    if (match) {
        const sym = match[1].trim();
        id =
            customAnimatedEmojis.get(sym) ||
            (EMOJI_KEY_MAP[sym] ? customAnimatedEmojis.get(EMOJI_KEY_MAP[sym]) : null) ||
            customAnimatedEmojis.get(sym.replace(/\uFE0F/g, "")) ||
            DEFAULT_CUSTOM_ANIMATED_EMOJIS[sym] ||
            (EMOJI_KEY_MAP[sym] ? DEFAULT_CUSTOM_ANIMATED_EMOJIS[EMOJI_KEY_MAP[sym]] : null);
    }

    if (!id) {
        // Search text for any recognized emoji
        for (const [sym, name] of Object.entries(EMOJI_KEY_MAP)) {
            if (text.includes(sym)) {
                id =
                    customAnimatedEmojis.get(sym) ||
                    customAnimatedEmojis.get(name) ||
                    DEFAULT_CUSTOM_ANIMATED_EMOJIS[sym] ||
                    DEFAULT_CUSTOM_ANIMATED_EMOJIS[name];
                if (id) break;
            }
        }
    }

    if (id) {
        btn.icon_custom_emoji_id = String(id);
    }
    return btn;
}

const callbackPayloadMap = new Map();
const callbackPayloadReverse = new Map();
let callbackPayloadSeq = 0;

/**
 * Register a callback data string, ensuring it never exceeds Telegram's 64-byte limit.
 * If prefix + payload is <= 64 bytes, it is returned unchanged.
 * If > 64 bytes, a short reference ID is generated and returned as `${prefix}ref:${id}`.
 *
 * @param {string} prefix
 * @param {string} payload
 * @returns {string} Safe callback_data string <= 64 bytes
 */
function registerCallbackPayload(prefix = "", payload = "") {
    const pfx = typeof prefix === "symbol" ? "" : String(prefix || "");
    const raw = typeof payload === "symbol" ? "" : String(payload || "");
    const full = pfx + raw;
    if (Buffer.byteLength(full, "utf8") <= 64) {
        return full;
    }
    let id = callbackPayloadReverse.get(raw);
    if (!id) {
        callbackPayloadSeq = (callbackPayloadSeq + 1) % 1000000;
        id = `r${Date.now().toString(36)}${callbackPayloadSeq}`;
        callbackPayloadMap.set(id, raw);
        callbackPayloadReverse.set(raw, id);
        if (callbackPayloadMap.size > 5000) {
            const oldest = callbackPayloadMap.keys().next().value;
            const oldVal = callbackPayloadMap.get(oldest);
            callbackPayloadMap.delete(oldest);
            if (oldVal) callbackPayloadReverse.delete(oldVal);
        }
    }
    const safePrefix = Buffer.byteLength(pfx, "utf8") <= 35 ? pfx : "cb:";
    return `${safePrefix}ref:${id}`;
}

/**
 * Resolve a possibly shortened callback payload back to its full value.
 *
 * @param {string} token
 * @returns {string}
 */
function resolveCallbackPayload(token) {
    if (typeof token === "symbol" || !token) return "";
    const str = String(token);
    if (str.startsWith("ref:")) {
        const id = str.slice(4);
        return callbackPayloadMap.get(id) || id;
    }
    const refIdx = str.lastIndexOf(":ref:");
    if (refIdx !== -1) {
        const id = str.slice(refIdx + 5);
        const resolved = callbackPayloadMap.get(id);
        if (resolved !== undefined) return resolved;
    }
    return str;
}

/**
 * Attaches emojis and guarantees that any callback_data never exceeds Telegram's 64-byte limit.
 * @param {object} btn
 */
function prepareButton(btn) {
    if (!btn || typeof btn !== "object") return btn;
    attachButtonEmoji(btn);
    if (typeof btn.callback_data === "string" && Buffer.byteLength(btn.callback_data, "utf8") > 64) {
        const lastColon = btn.callback_data.lastIndexOf(":");
        const prefix = (lastColon > 0 && lastColon <= 35)
            ? btn.callback_data.slice(0, lastColon + 1)
            : (btn.callback_data.indexOf(":") > 0 && btn.callback_data.indexOf(":") <= 35
                ? btn.callback_data.slice(0, btn.callback_data.indexOf(":") + 1)
                : "cb:");
        const payload = btn.callback_data.slice(prefix.length);
        btn.callback_data = registerCallbackPayload(prefix, payload);
        if (Buffer.byteLength(btn.callback_data, "utf8") > 64) {
            btn.callback_data = registerCallbackPayload("cb:", btn.callback_data);
        }
    }
    return btn;
}

/**
 * Build inline keyboard with animated emojis automatically attached to buttons.
 * @param {Array<Array<object>>} rows
 */
function createInlineKeyboard(rows) {
    if (!Array.isArray(rows)) {
        rows = rows ? [rows] : [];
    }
    const processed = rows.map((row) =>
        Array.isArray(row) ? row.map(prepareButton) : prepareButton(row)
    );
    return Markup.inlineKeyboard(processed);
}

/**
 * Render a custom animated emoji tag if available, or fall back to native unicode emoji.
 * @param {string} symbol unicode fallback emoji, e.g. "🚀"
 * @param {string} [nameKey] optional semantic name key, e.g. "rocket", "diamond"
 * @returns {string} HTML string with <tg-emoji> or fallback unicode
 */
function tgEmoji(symbol, nameKey) {
    if (!symbol) return "";
    const key = nameKey || EMOJI_KEY_MAP[symbol] || symbol;
    let id =
        customAnimatedEmojis.get(symbol) ||
        (nameKey ? customAnimatedEmojis.get(nameKey) : null) ||
        customAnimatedEmojis.get(key);
    if (!id && customAnimatedEmojis.size > 0) {
        id =
            DEFAULT_CUSTOM_ANIMATED_EMOJIS[symbol] ||
            (EMOJI_KEY_MAP[symbol] ? DEFAULT_CUSTOM_ANIMATED_EMOJIS[EMOJI_KEY_MAP[symbol]] : null) ||
            DEFAULT_CUSTOM_ANIMATED_EMOJIS[key];
        if (!id && typeof symbol === "string") {
            const stripped = symbol.replace(/\uFE0F/g, "");
            id =
                DEFAULT_CUSTOM_ANIMATED_EMOJIS[stripped] ||
                (EMOJI_KEY_MAP[stripped] ? DEFAULT_CUSTOM_ANIMATED_EMOJIS[EMOJI_KEY_MAP[stripped]] : null);
        }
    }
    if (id) {
        return `${LT}tg-emoji emoji-id="${escapeHtml(id)}"${GT}${symbol}${LT}/tg-emoji${GT}`;
    }
    return symbol;
}

const HAS_EMOJI_RE = /(?:[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u2190-\u21FF\u2300-\u23FF\u2460-\u27BF\u2900-\u2BFF])/u;
const EMOJI_TOKEN_RE = /(<tg-emoji[^>]*>.*?<\/tg-emoji>|<[^>]+>)|((?:[0-9#*]\uFE0F?\u20E3)|(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F|\u200D|[\u2190-\u21FF\u2300-\u23FF\u2460-\u27BF\u2900-\u2BFF])+)/gu;

/**
 * Automatically transform bare unicode emojis in text into animated <tg-emoji> tags.
 * If an emoji cannot be animated (no ID), remove it so no unanimated emojis appear.
 * @param {string} html
 * @returns {string}
 */
function ensureAnimatedEmojis(html) {
    if (!html || typeof html !== "string") return html;
    if (customAnimatedEmojis.size === 0) return html;
    if (!HAS_EMOJI_RE.test(html)) {
        return html;
    }
    return html.replace(EMOJI_TOKEN_RE, (match, tag, emoji) => {
        if (tag) return tag;
        if (!emoji) return match;
        const sym = emoji.trim();
        if (!sym) return "";
        let id =
            customAnimatedEmojis.get(sym) ||
            (EMOJI_KEY_MAP[sym] ? customAnimatedEmojis.get(EMOJI_KEY_MAP[sym]) : null) ||
            DEFAULT_CUSTOM_ANIMATED_EMOJIS[sym] ||
            (EMOJI_KEY_MAP[sym] ? DEFAULT_CUSTOM_ANIMATED_EMOJIS[EMOJI_KEY_MAP[sym]] : null);
        if (!id) {
            const stripped = sym.replace(/\uFE0F/g, "");
            id =
                customAnimatedEmojis.get(stripped) ||
                (EMOJI_KEY_MAP[stripped] ? customAnimatedEmojis.get(EMOJI_KEY_MAP[stripped]) : null) ||
                DEFAULT_CUSTOM_ANIMATED_EMOJIS[stripped] ||
                (EMOJI_KEY_MAP[stripped] ? DEFAULT_CUSTOM_ANIMATED_EMOJIS[EMOJI_KEY_MAP[stripped]] : null);
        }
        if (id) {
            return `${LT}tg-emoji emoji-id="${escapeHtml(id)}"${GT}${sym}${LT}/tg-emoji${GT}`;
        }
        return "";
    });
}

// Escape entities (for escaping user text), built from the ampersand char code.
const AMP = String.fromCharCode(38); // &

/**
 * Escape user-controlled text for Telegram HTML parse mode.
 * @param {string} s
 */
function escapeHtml(s) {
    if (s === null || s === undefined || typeof s === "symbol") return "";
    return String(s)
        .replace(/&/g, `${AMP}amp;`)
        .replace(/</g, `${AMP}lt;`)
        .replace(/>/g, `${AMP}gt;`);
}

/**
 * @param {number|undefined} n
 */
function num(n) {
    if (typeof n === "symbol") return "0";
    return Number(n || 0).toLocaleString("en-US");
}

/**
 * Compact human number: 999 -> "999", 1234 -> "1.2K", 2100000 -> "2.1M".
 * @param {number|undefined} n
 */
function compact(n) {
    if (typeof n === "symbol") return "0";
    const v = Number(n || 0);
    if (v < 1000) return String(v);
    if (v < 1_000_000) {
        const k = v / 1000;
        return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}K`;
    }
    const m = v / 1_000_000;
    return `${m >= 100 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, "")}M`;
}

/**
 * A proportional bar, e.g. ████████░░ (10 chars wide).
 * @param {number} value
 * @param {number} total
 * @param {number} [width]
 */
function bar(value, total, width = 10) {
    const filled = total > 0 ? Math.round((value / total) * width) : 0;
    const clamped = Math.max(0, Math.min(width, filled));
    return "\u2588".repeat(clamped) + "\u2591".repeat(width - clamped);
}

// Fun emoji for well-known sites, with a generic fallback.
const SITE_EMOJIS = [
    [/netflix/i, "\uD83C\uDFAC"], // 🎬
    [/spotify/i, "\uD83C\uDFB5"], // 🎵
    [/youtube|yt\b/i, "\u25B6\uFE0F"], // ▶️
    [/amazon|prime/i, "\uD83D\uDCE6"], // 📦
    [/facebook|\bfb\b/i, "\uD83D\uDC65"], // 👥
    [/instagram|insta/i, "\uD83D\uDCF8"], // 📸
    [/twitter|\bx\.com\b/i, "\uD83D\uDC26"], // 🐦
    [/discord/i, "\uD83C\uDFAE"], // 🎮
    [/steam|valve/i, "\uD83C\uDFAE"], // 🎮
    [/minecraft|mojang/i, "\u26CF\uFE0F"], // ⛏️
    [/roblox/i, "\uD83E\uDE91"], // 🧱
    [/twitch/i, "\uD83C\uDF99\uFE0F"], // 🎙️
    [/reddit/i, "\uD83E\uDD16"], // 🤖
    [/tiktok/i, "\uD83C\uDFB6"], // 🎶
    [/linkedin/i, "\uD83D\uDCBC"], // 💼
    [/google|gmail/i, "\uD83D\uDD0E"], // 🔎
    [/yahoo|hotmail|outlook|aol|icloud|proton|mail\.ru|yandex|gmx|zoho/i, "\uD83D\uDCE7"], // 📧
    [/paypal|stripe/i, "\uD83D\uDCB3"], // 💳
    [/ebay|etsy|shopify|aliexpress|shein|temu|walmart|target|costco/i, "\uD83D\uDED2"], // 🛒
    [/onlyfans|fansly/i, "\uD83D\uDD17"], // 🔗
    [/adobe|canva|figma/i, "\uD83C\uDFA8"], // 🎨
    [/dropbox|mega|onedrive|drive/i, "\u2601\uFE0F"], // ☁️
    [/github|gitlab/i, "\uD83D\uDC6B"], // 👫
    [/telegram|whatsapp|signal|snap/i, "\uD83D\uDCAC"], // 💬
    [/origin|ea\.com|battle\.net|epic/i, "\uD83C\uDFAF"], // 🎯
    [/hulu|disney|hbo|max|paramount|peacock/i, "\uD83D\uDCFD\uFE0F"], // 📺
    [/duolingo|coursera|udemy/i, "\uD83C\uDF93"], // 🎓
    [/binance|coinbase|crypto|kucoin/i, "\uD83E\uDE99"], // 🪙
    [/vpn|nordvpn|express/i, "\uD83D\uDD13"], // 🔓
];

/**
 * Pick a fun emoji for a site slug.
 * @param {string} slug
 */
function siteEmoji(slug) {
    const s = String(slug || "");
    for (const [re, emoji] of SITE_EMOJIS) {
        if (re.test(s)) return emoji;
    }
    return "\uD83C\uDF10"; // 🌐
}

/**
 * Decorative rule line - modern sleek full-width cyber bar.
 */
const RULE = "─".repeat(28); // ────────────────────────────

/**
 * Reusable inline keyboards with modern cyber-dashboard grid.
 */
function mainKeyboard() {
    return createInlineKeyboard([
        [
            Markup.button.callback("🚀 Run ULP Search", "ulp:menu"),
            Markup.button.callback("📦 Get Combined File", "combine"),
        ],
        [
            Markup.button.callback("📥 Save Large Files", "save:start"),
            Markup.button.callback("📂 Server Vault (Tabs)", "server_files"),
        ],
        [
            Markup.button.callback("📊 Batch Analytics", "stats"),
            Markup.button.callback("🌐 Manage Domains", "sites"),
        ],
        [
            Markup.button.callback("⚙️ Storage & Wipes", "files:tab:tools"),
            Markup.button.callback("❓ Fast /save Guide", "help:save"),
        ],
        [
            Markup.button.callback("🔎 Search Batch", "batch:search:prompt"),
            Markup.button.callback("👁 Line Preview", "preview"),
        ],
        [
            Markup.button.callback("🧹 Wipe Batch", "clear:ask"),
            Markup.button.callback("🔄 Refresh Menu", "help"),
        ],
    ]);
}

/**
 * Keyboard shown under the combined file.
 * @param {string} [downloadUrl]
 */
function afterCombineKeyboard(downloadUrl = null) {
    const rows = [];
    if (downloadUrl && typeof downloadUrl === "string" && downloadUrl.startsWith("http")) {
        rows.push([Markup.button.url("📥 Direct Download Link", downloadUrl)]);
    }
    rows.push([
        Markup.button.callback("📦 Send Again", "combine"),
        Markup.button.callback("📊 Stats", "stats"),
    ]);
    rows.push([
        Markup.button.callback("🚀 ULP Search", "ulp:menu"),
        Markup.button.callback("🔍 Search Batch", "batch:search:prompt"),
    ]);
    rows.push([
        Markup.button.callback("📂 Server Vault", "server_files"),
        Markup.button.callback("🧹 Wipe Batch", "clear:ask"),
    ]);
    rows.push([
        Markup.button.callback("🔙 Main Menu", "help"),
    ]);
    return createInlineKeyboard(rows);
}

/**
 * Keyboard shown under combined forwarded log files.
 * @param {string} [downloadUrl]
 * @param {string} [token]
 */
function forwardedLogsKeyboard(downloadUrl = "", token = null) {
    const rows = [];
    if (downloadUrl && typeof downloadUrl === "string" && downloadUrl.startsWith("http")) {
        rows.push([Markup.button.url("📥 Direct Download Link", downloadUrl)]);
    }
    const row2 = [];
    if (token) {
        row2.push(Markup.button.callback("📦 Send in Telegram", `send_telegram:${token}`));
    }
    row2.push(Markup.button.callback("📊 Stats", "stats"));
    rows.push(row2);
    rows.push([
        Markup.button.callback("🚀 ULP Search", "ulp:menu"),
        Markup.button.callback("🔍 Search Batch", "batch:search:prompt"),
    ]);
    rows.push([
        Markup.button.callback("📂 Server Vault", "server_files"),
        Markup.button.callback("🧹 Wipe Batch", "clear:ask"),
    ]);
    rows.push([
        Markup.button.callback("🔙 Main Menu", "help"),
    ]);
    return createInlineKeyboard(rows);
}

/**
 * Keyboard shown under forwarded zip files combined status report.
 * @param {string} [downloadUrl]
 * @param {string} [token]
 */
function forwardedZipKeyboard(downloadUrl = "", token = null) {
    const rows = [];
    if (downloadUrl && typeof downloadUrl === "string" && downloadUrl.startsWith("http")) {
        rows.push([Markup.button.url("📥 Direct Download Merged ZIP", downloadUrl)]);
    }
    const row2 = [];
    if (token) {
        row2.push(Markup.button.callback("📦 Send in Telegram", `send_telegram:${token}`));
    }
    row2.push(Markup.button.callback("📊 Stats", "stats"));
    rows.push(row2);
    rows.push([
        Markup.button.callback("🚀 ULP Search", "ulp:menu"),
        Markup.button.callback("🔍 Search Batch", "batch:search:prompt"),
    ]);
    rows.push([
        Markup.button.callback("📂 Server Vault", "server_files"),
        Markup.button.callback("🧹 Wipe Batch", "clear:ask"),
    ]);
    rows.push([
        Markup.button.callback("🔙 Main Menu", "help"),
    ]);
    return createInlineKeyboard(rows);
}

/**
 * Keyboard shown under the server files vault.
 * Supports file cleaning, downloading, searching, multi-selection merge, and bulk wipe.
 * @param {Array} [rawFiles]
 * @param {Array} [processedFiles]
 * @param {object|string|number} [options]
 * @param {number} [pageArg]
 */
function serverFilesKeyboard(rawFiles = [], processedFiles = [], options = {}, pageArg = 0) {
    const rows = [];
    let opts = {};
    if (typeof options === "string") {
        opts = { tab: options, page: pageArg };
    } else if (typeof options === "number") {
        opts = { page: options };
    } else if (options && typeof options === "object") {
        opts = { ...options };
    }
    const hasExplicitTab = Boolean(opts.tab);
    const tab = opts.tab || "overview";
    const page = typeof opts.page === "number" ? opts.page : 0;
    const pageSize = opts.pageSize || 3;

    const rawCount = Array.isArray(rawFiles) ? rawFiles.length : 0;
    const procCount = Array.isArray(processedFiles) ? processedFiles.length : 0;

    if (tab === "select") {
        const selectFiles = (opts.files || [...(Array.isArray(rawFiles) ? rawFiles : []), ...(Array.isArray(processedFiles) ? processedFiles : [])])
            .slice()
            .sort((a, b) => ((b.size || 0) - (a.size || 0)) || ((b.mtime && a.mtime) ? b.mtime.getTime() - a.mtime.getTime() : 0));
        const selectPageSize = 5;
        const totalPages = Math.ceil(selectFiles.length / selectPageSize) || 1;
        const selStart = page * selectPageSize;
        const selSlice = selectFiles.slice(selStart, selStart + selectPageSize);
        const selected = opts.selected instanceof Set ? opts.selected : new Set(opts.selected || []);

        for (let i = 0; i < selSlice.length; i++) {
            const actualIdx = selStart + i;
            const f = selSlice[i];
            const isChecked = selected.has(actualIdx);
            const mark = isChecked ? "☑️" : "⬜️";
            const isClean = f.type === "proc" || f.isClean || (Array.isArray(processedFiles) && processedFiles.some((pf) => pf.name === f.name && pf.size === f.size));
            const icon = isClean ? "💎" : (f.name.toLowerCase().endsWith(".zip") ? "📦" : "📥");
            const tag = isClean ? " [Clean]" : " [Raw]";
            const maxNameLen = 18;
            const displayName = f.name.length > maxNameLen ? f.name.slice(0, maxNameLen - 1) + "…" : f.name;
            rows.push([
                Markup.button.callback(`${mark} [${actualIdx + 1}] ${icon} ${displayName}${tag} (${humanSize(f.size)})`, `vault:sel:toggle:${actualIdx}`),
            ]);
        }

        if (totalPages > 1) {
            const navRow = [];
            if (page > 0) navRow.push(Markup.button.callback("◀️ Prev", `vault:sel:page:${page - 1}`));
            navRow.push(Markup.button.callback(`📄 ${page + 1}/${totalPages}`, `vault:sel:page:${page}`));
            if (page + 1 < totalPages) navRow.push(Markup.button.callback("Next ▶️", `vault:sel:page:${page + 1}`));
            rows.push(navRow);
        }

        const count = selected.size;
        rows.push([
            Markup.button.callback("⚡️ Select All", "vault:sel:all"),
            Markup.button.callback("🧹 Deselect All", "vault:sel:clear"),
        ]);
        rows.push([
            Markup.button.callback(`💎 Select Clean (${procCount})`, "vault:sel:proc"),
            Markup.button.callback(`📥 Select Raw (${rawCount})`, "vault:sel:raw"),
        ]);
        rows.push([
            Markup.button.callback(`🔀 Merge Selected (${count} file${count === 1 ? "" : "s"})`, "vault:sel:merge"),
        ]);
        rows.push([
            Markup.button.callback("🏠 Back to Vault", "files:tab:overview"),
            Markup.button.callback("🔙 Main Menu", "help"),
        ]);
    } else if (tab === "raw") {
        // Tab switcher
        rows.push([
            Markup.button.callback(`📥 Raw Dumps (${rawCount}) ✅`, "files:tab:raw"),
            Markup.button.callback(`💎 Cleaned Vault (${procCount})`, "files:tab:proc"),
            Markup.button.callback("⚙️ Tools", "files:tab:tools"),
        ]);

        const rawStart = page * pageSize;
        const rawSlice = Array.isArray(rawFiles) ? rawFiles.slice(rawStart, rawStart + pageSize) : [];
        const totalPages = Math.ceil(rawCount / pageSize) || 1;

        // Individual file actions
        for (let i = 0; i < rawSlice.length; i++) {
            const actualIdx = rawStart + i;
            rows.push([
                Markup.button.callback(`🧼 Clean Raw #${actualIdx + 1}`, `file:clean:${actualIdx}`),
                Markup.button.callback(`🔎 Search Raw #${actualIdx + 1}`, `file:search:${actualIdx}`),
                Markup.button.callback(`🗑 Del #${actualIdx + 1}`, `file:del:raw:ask:${actualIdx}`),
            ]);
        }

        // Pagination
        if (totalPages > 1) {
            const navRow = [];
            if (page > 0) {
                navRow.push(Markup.button.callback("◀️ Prev", `files:page:raw:${page - 1}`));
            }
            navRow.push(Markup.button.callback(`📄 ${page + 1}/${totalPages}`, "files:tab:raw"));
            if (page + 1 < totalPages) {
                navRow.push(Markup.button.callback("Next ▶️", `files:page:raw:${page + 1}`));
            }
            rows.push(navRow);
        }

        // Bulk operations
        const bulkRow = [];
        if (rawCount > 1) {
            bulkRow.push(Markup.button.callback(`⚡️ Clean All Raw (${rawCount})`, "files:clean:all"));
            bulkRow.push(Markup.button.callback(`🔀 Merge All Raw (${rawCount})`, "files:merge:raw:all"));
        }
        if (rawCount > 0) {
            bulkRow.push(Markup.button.callback(`🧹 Wipe All Raw`, "files:wipe:raw:ask"));
        }
        if (bulkRow.length > 0) rows.push(bulkRow);

        rows.push([
            Markup.button.callback("🏠 Vault Overview", "files:tab:overview"),
            Markup.button.callback("🔄 Refresh", "files:refresh"),
        ]);
        rows.push([
            Markup.button.callback("🔙 Main Menu", "help"),
        ]);
    } else if (tab === "proc") {
        // Tab switcher
        rows.push([
            Markup.button.callback(`📥 Raw Dumps (${rawCount})`, "files:tab:raw"),
            Markup.button.callback(`💎 Cleaned Vault (${procCount})`, "files:tab:proc"),
            Markup.button.callback("⚙️ Tools", "files:tab:tools"),
        ]);

        const procStart = page * pageSize;
        const procSlice = Array.isArray(processedFiles) ? processedFiles.slice(procStart, procStart + pageSize) : [];
        const totalPages = Math.ceil(procCount / pageSize) || 1;

        // Individual file actions
        for (let i = 0; i < procSlice.length; i++) {
            const actualIdx = procStart + i;
            rows.push([
                Markup.button.callback(`📥 Download Output #${actualIdx + 1}`, `file:dl:proc:${actualIdx}`),
                Markup.button.callback(`🔎 Search Output #${actualIdx + 1}`, `file:search:proc:${actualIdx}`),
                Markup.button.callback(`🗑 Del #${actualIdx + 1}`, `file:del:proc:ask:${actualIdx}`),
            ]);
        }

        // Pagination
        if (totalPages > 1) {
            const navRow = [];
            if (page > 0) {
                navRow.push(Markup.button.callback("◀️ Prev", `files:page:proc:${page - 1}`));
            }
            navRow.push(Markup.button.callback(`📄 ${page + 1}/${totalPages}`, "files:tab:proc"));
            if (page + 1 < totalPages) {
                navRow.push(Markup.button.callback("Next ▶️", `files:page:proc:${page + 1}`));
            }
            rows.push(navRow);
        }

        // Bulk operations
        const bulkRow = [];
        if (procCount > 1) {
            bulkRow.push(Markup.button.callback(`🔀 Merge All Cleaned (${procCount})`, "files:merge:proc:all"));
        }
        bulkRow.push(Markup.button.callback("📦 Get Combined File", "combine"));
        if (procCount > 0) {
            bulkRow.push(Markup.button.callback(`🧹 Wipe All Outputs`, "files:wipe:proc:ask"));
        }
        rows.push(bulkRow);

        rows.push([
            Markup.button.callback("🏠 Vault Overview", "files:tab:overview"),
            Markup.button.callback("🔄 Refresh", "files:refresh"),
        ]);
        rows.push([
            Markup.button.callback("🔙 Main Menu", "help"),
        ]);
    } else if (tab === "tools") {
        rows.push([
            Markup.button.callback("📥 Save Large Files (/save)", "save:start"),
        ]);
        rows.push([
            Markup.button.callback(`🧹 Wipe All Raw (${rawCount})`, "files:wipe:raw:ask"),
            Markup.button.callback(`🧹 Wipe All Outputs (${procCount})`, "files:wipe:proc:ask"),
        ]);
        rows.push([
            Markup.button.callback("💥 Purge All Storage (Full Reset)", "files:wipe:all:ask"),
        ]);
        rows.push([
            Markup.button.callback("🏠 Back to Vault Overview", "files:tab:overview"),
            Markup.button.callback("🔙 Main Menu", "help"),
        ]);
    } else if (hasExplicitTab && tab === "overview") {
        // Streamlined, clean, and elegant overview keyboard
        rows.push([
            Markup.button.callback("🔀 Multi-Select & Merge Files", "files:tab:select"),
        ]);
        rows.push([
            Markup.button.callback(`📥 Raw Dumps (${rawCount})`, "files:tab:raw"),
            Markup.button.callback(`💎 Cleaned Vault (${procCount})`, "files:tab:proc"),
        ]);
        rows.push([
            Markup.button.callback("📦 Get Combined File", "combine"),
            Markup.button.callback("⚙️ Storage Tools", "files:tab:tools"),
        ]);
        rows.push([
            Markup.button.callback("🔄 Refresh Vault", "files:refresh"),
            Markup.button.callback("🔙 Main Menu", "help"),
        ]);
    } else {
        // Legacy overview (fallback when called without explicit options)
        rows.push([
            Markup.button.callback(`📥 Browse Raw Dumps (${rawCount})`, "files:tab:raw"),
            Markup.button.callback(`💎 Cleaned Vault (${procCount})`, "files:tab:proc"),
        ]);

        const rawStart = page * pageSize;
        const rawSlice = Array.isArray(rawFiles) ? rawFiles.slice(rawStart, rawStart + pageSize) : [];
        const procStart = page * pageSize;
        const procSlice = Array.isArray(processedFiles) ? processedFiles.slice(procStart, procStart + pageSize) : [];

        // Raw files actions
        if (rawSlice.length > 0) {
            for (let i = 0; i < rawSlice.length; i++) {
                const actualIdx = rawStart + i;
                rows.push([
                    Markup.button.callback(`🧼 Clean Raw #${actualIdx + 1}`, `file:clean:${actualIdx}`),
                    Markup.button.callback(`🔎 Search Raw #${actualIdx + 1}`, `file:search:${actualIdx}`),
                    Markup.button.callback(`🗑 Del #${actualIdx + 1}`, `file:del:raw:ask:${actualIdx}`),
                ]);
            }
        }

        // Processed outputs actions
        if (procSlice.length > 0) {
            for (let i = 0; i < procSlice.length; i++) {
                const actualIdx = procStart + i;
                rows.push([
                    Markup.button.callback(`📥 Download Output #${actualIdx + 1}`, `file:dl:proc:${actualIdx}`),
                    Markup.button.callback(`🔎 Search Output #${actualIdx + 1}`, `file:search:proc:${actualIdx}`),
                    Markup.button.callback(`🗑 Del #${actualIdx + 1}`, `file:del:proc:ask:${actualIdx}`),
                ]);
            }
        }

        // Bulk operations
        const bulkRow = [];
        if (rawCount > 1) {
            bulkRow.push(Markup.button.callback(`⚡️ Clean All Raw (${rawCount})`, "files:clean:all"));
        }
        if (rawCount > 0) {
            bulkRow.push(Markup.button.callback(`🧹 Wipe All Raw`, "files:wipe:raw:ask"));
        }
        if (procCount > 0) {
            bulkRow.push(Markup.button.callback(`🧹 Wipe All Outputs`, "files:wipe:proc:ask"));
        }
        if (bulkRow.length > 0) rows.push(bulkRow);

        // Management & Global Actions
        rows.push([
            Markup.button.callback("🔄 Refresh Vault", "files:refresh"),
            Markup.button.callback("📊 System Stats", "stats"),
            Markup.button.callback("💥 Purge All", "files:wipe:all:ask"),
        ]);
        rows.push([
            Markup.button.callback("📦 Get Combined File", "combine"),
            Markup.button.callback("🔙 Main Menu", "help"),
        ]);
    }

    return createInlineKeyboard(rows);
}

/**
 * Confirmation dialog keyboard for deleting individual files or bulk storage.
 */
function confirmFileDeleteKeyboard(actionType, targetId, fileName = "") {
    const act = typeof actionType === "symbol" ? "" : String(actionType || "");
    const tid = typeof targetId === "symbol" ? "" : String(targetId || "");
    return createInlineKeyboard([
        [
            Markup.button.callback("⚠️ Yes, permanently delete", `file:del:confirm:${act}:${tid}`),
            Markup.button.callback("❌ Cancel", "server_files"),
        ],
    ]);
}

/**
 * Keyboard for ULP preset searches and days duration selection.
 * @param {number} [selectedDays]
 * @param {string[]} [customDomains]
 */
function ulpMenuKeyboard(selectedDays = 5, customDomains = []) {
    const rawDays = typeof selectedDays === "symbol" ? 5 : Number(selectedDays) || 5;
    const days = Math.max(1, Math.min(90, rawDays));
    const daysRow1 = [1, 3, 5].map((d) =>
        Markup.button.callback(d === days ? `📅 ${d}d ✅` : `📅 ${d} Day${d > 1 ? "s" : ""}`, `ulp:setdays:${d}`)
    );
    const daysRow2 = [7, 14, 30].map((d) =>
        Markup.button.callback(d === days ? `📅 ${d}d ✅` : `📅 ${d} Day${d > 1 ? "s" : ""}`, `ulp:setdays:${d}`)
    );

    const rows = [];

    // If user has custom saved domains, display them at the top as quick 1-tap buttons
    if (Array.isArray(customDomains) && customDomains.length > 0) {
        for (let i = 0; i < customDomains.length; i += 2) {
            const d1 = customDomains[i];
            const l1 = d1.length > 24 ? d1.slice(0, 21) + "…" : d1;
            const pair = [Markup.button.callback(`🌐 ${l1}`, registerCallbackPayload("ulp:quick:", d1))];
            if (i + 1 < customDomains.length) {
                const d2 = customDomains[i + 1];
                const l2 = d2.length > 24 ? d2.slice(0, 21) + "…" : d2;
                pair.push(Markup.button.callback(`🌐 ${l2}`, registerCallbackPayload("ulp:quick:", d2)));
            }
            rows.push(pair);
        }
    }

    // Custom domain action buttons:
    // 1. Enter a custom domain to search now
    rows.push([
        Markup.button.callback("🌐 Enter Custom Domain", "ulp:custom:prompt"),
    ]);

    // 2. Add custom domain or edit existing custom domains
    const editLabel = customDomains && customDomains.length > 0
        ? `✏️ Edit Domains (${customDomains.length})`
        : "✏️ Edit Domains";
    rows.push([
        Markup.button.callback("➕ Add Domain", "ulp:custom:add:prompt"),
        Markup.button.callback(editLabel, "ulp:custom:edit"),
    ]);

    // Duration selectors
    rows.push(daysRow1);
    rows.push(daysRow2);

    // Edit amount of days custom button
    rows.push([
        Markup.button.callback(`📅 Custom Days (${days}d)`, "ulp:custom:days_prompt"),
    ]);

    // Back to main menu
    rows.push([
        Markup.button.callback("🔙 Main Menu", "help"),
    ]);

    return createInlineKeyboard(rows);
}

/**
 * Keyboard for managing custom domains (view, delete, add).
 * @param {string[]} [customDomains]
 */
function ulpEditDomainsKeyboard(customDomains = []) {
    const rows = [];
    if (Array.isArray(customDomains) && customDomains.length > 0) {
        for (const domain of customDomains) {
            const l = domain.length > 22 ? domain.slice(0, 19) + "…" : domain;
            rows.push([
                Markup.button.callback(`🌐 ${l}`, registerCallbackPayload("ulp:quick:", domain)),
                Markup.button.callback("❌ Delete", registerCallbackPayload("ulp:custom:del:", domain)),
            ]);
        }
        rows.push([
            Markup.button.callback("🗑 Clear All Domains", "ulp:custom:clear"),
        ]);
    }
    rows.push([
        Markup.button.callback("➕ Add Custom Domain", "ulp:custom:add:prompt"),
    ]);
    rows.push([
        Markup.button.callback("🔙 Back to ULP Menu", "ulp:menu"),
    ]);
    return createInlineKeyboard(rows);
}

/**
 * Keyboard shown during interactive prompt input (e.g. entering custom domain or days).
 */
function ulpPromptCancelKeyboard() {
    return createInlineKeyboard([
        [
            Markup.button.callback("❌ Cancel", "ulp:custom:cancel"),
            Markup.button.callback("🔙 ULP Menu", "ulp:menu"),
        ],
    ]);
}

/**
 * Keyboard rendered after ULP search completes or resets batch.
 * @param {number} [selectedDays]
 * @param {string[]} [customDomains]
 */
function ulpPostSearchKeyboard(selectedDays = 5, customDomains = []) {
    const rawDays = typeof selectedDays === "symbol" ? 5 : Number(selectedDays) || 5;
    const days = Math.max(1, Math.min(90, rawDays));
    const rows = [
        [
            Markup.button.callback("🔁 Search Again", "ulp:again"),
            Markup.button.callback("🌐 Enter New Domain", "ulp:custom:prompt"),
        ],
        [
            Markup.button.callback(`📅 Change Days (${days}d)`, "ulp:custom:days_prompt"),
            Markup.button.callback("🚀 ULP Menu", "ulp:menu"),
        ],
        [
            Markup.button.callback("📂 Server Vault", "server_files"),
            Markup.button.callback("🔙 Main Menu", "help"),
        ],
    ];
    return createInlineKeyboard(rows);
}

/**
 * Text rendered for ULP search target menu.
 * @param {string} botUsername
 * @param {number} activeDays
 * @param {number} [customCount]
 */
function renderUlpMenuText(botUsername, activeDays, customCount = 0) {
    const customLine = customCount > 0 ? `\n🌐  Custom Targets: ${B(`${customCount} saved`)}` : "";
    return [
        `🚀  ${B("SELECT ULP SEARCH TARGET")}  ⚡️`,
        RULE,
        `🤖  Searcher: ${CODE(`@${escapeHtml(botUsername || "DumpNews14Bot")}`)}`,
        `📅  Search Duration: ${B(`${activeDays} Day(s)`)}${customLine}`,
        "",
        `👇 ${I("Tap a target to start searching, enter a custom domain, or customize duration:")}`,
    ].join("\n");
}

/**
 * Keyboard for /save instructions.
 */
function saveGuideKeyboard() {
    return createInlineKeyboard([
        [
            Markup.button.callback("📥 Start Save Mode Now", "save:start"),
            Markup.button.callback("📂 Open Server Vault", "server_files"),
        ],
        [
            Markup.button.callback("🔙 Main Menu", "help"),
        ],
    ]);
}

/**
 * Keyboard for quick batch search.
 */
function searchPromptKeyboard() {
    return createInlineKeyboard([
        [
            Markup.button.callback("📧 @gmail.com", "batch:quicksearch:gmail.com"),
            Markup.button.callback("📧 @hotmail.com", "batch:quicksearch:hotmail.com"),
        ],
        [
            Markup.button.callback("📧 @yahoo.com", "batch:quicksearch:yahoo.com"),
            Markup.button.callback("📧 @proton.me", "batch:quicksearch:proton"),
        ],
        [
            Markup.button.callback("🔙 Main Menu", "help"),
        ],
    ]);
}

/**
 * Visual guide card explaining how to save files to the server vault.
 */
function renderSaveGuide() {
    return [
        `⚡️  ${B("FAST SERVER SAVE GUIDE")}  ⚡️`,
        RULE,
        `💎  ${B("Option 1: Single File Save")}`,
        `  1️⃣  ${B("Reply to any file")} with ${CODE("/save")}.`,
        `  2️⃣  Streams directly to server disk & cleans into batch!`,
        "",
        `📦  ${B("Option 2: Multi-File Batch Save")}`,
        `  1️⃣  ${B("Forward multiple files")} at once into this chat or group.`,
        `  2️⃣  Type ${CODE("/batchsave")} (or ${CODE("/batchsave 20")}).`,
        `  3️⃣  The userbot downloads & cleans all forwarded files sequentially in one run!`,
        "",
        `✨ ${I("No file size limits on the server! Bypass the 20MB bot limit with your MTProto userbot.")}`,
        RULE,
        `👇 ${I("Tap below to open your server vault:")}`,
    ].join("\n");
}

/**
 * Prompt rendered when /save is invoked without a direct reply,
 * activating interactive listening mode for forwarded / uploaded files.
 */
function renderSaveListeningPrompt(botUsername = null) {
    return [
        `📥  ${B("SAVE MODE ACTIVE")}  (OR ${B("REPLY TO A FILE")})  ${tgEmoji("⚡️")}`,
        RULE,
        `Forward or upload your log files now!`,
        `Files will queue up. When you're finished, send ${CODE("/done")} or tap Done to save & clean them ${B("one by one")}.`,
        "",
        `📁  Supported: ${B(".zip")}, ${B(".txt")}, ${B(".log")}, ${B(".csv")}, ${B(".tsv")}`,
        `⚡️  Forward from any group or channel — files will be buffered until you finalize.`,
        `📌  ${I("Tip: You can also reply directly to an existing document with /save.")}`,
        "",
        `${I("When finished forwarding, tap Done below or send /done to start saving.")}`,
    ].join("\n");
}

/**
 * Inline keyboard while /save listening mode is active.
 * @param {number} [queuedCount]
 */
function saveListeningKeyboard(queuedCount = 0) {
    const qCount = typeof queuedCount === "number" ? queuedCount : (typeof queuedCount === "symbol" ? 0 : Number(queuedCount) || 0);
    const doneText = qCount > 0 ? `✅ Done / Finish Saving (${qCount})` : "✅ Done / Finish Saving";
    return createInlineKeyboard([
        [
            Markup.button.callback(doneText, "save:done"),
            Markup.button.callback("🔀 Merge & Finish", "save:merge_and_finish"),
        ],
        [
            Markup.button.callback("❌ Cancel", "save:cancel"),
            Markup.button.callback("📦 Get Combined File", "combine"),
        ],
    ]);
}

/**
 * Report rendered when a save session completes.
 */
function renderSaveListeningComplete(data = {}) {
    data = data || {};
    const processed = Array.isArray(data.processed) ? data.processed : [];
    const lines = [
        `✅  ${B("SAVE SESSION COMPLETE")}  ${tgEmoji("⚡️")}`,
        RULE,
        `Successfully saved and processed ${B(processed.length)} file(s) one by one:`,
        "",
    ];
    if (processed.length === 0) {
        lines.push(`  ${I("No files were received during this session.")}`);
    } else {
        for (let i = 0; i < processed.length; i++) {
            const f = processed[i];
            lines.push(`  ${i + 1}. 📄 ${B(escapeHtml(f.name))} (${humanSize(f.size || 0)}) → ${B("+" + num(f.linesAdded || f.lines || 0))} lines`);
        }
    }
    lines.push("");
    lines.push(`📦  ${B("Active Batch Total:")} ${B(num(data.totalBatchLines || 0))} lines`);
    lines.push(`${I("Tap below to download combined, merge session files on disk, or manage batch.")}`);
    return lines.join("\n");
}

/**
 * Keyboard after finishing a save session.
 * @param {boolean} [hasSessionFiles]
 */
function saveListeningCompleteKeyboard(hasSessionFiles = true) {
    const rows = [];
    if (hasSessionFiles) {
        rows.push([
            Markup.button.callback("🔀 Merge Session Files on Server", "save:merge_session"),
        ]);
    }
    rows.push([
        Markup.button.callback("📦 Get Combined File", "combine"),
        Markup.button.callback("📊 Batch Analytics", "stats"),
    ]);
    rows.push([
        Markup.button.callback("📥 Save More Files", "save:start"),
        Markup.button.callback("📂 Server Vault", "server_files"),
    ]);
    rows.push([
        Markup.button.callback("🧹 Wipe Batch", "clear:ask"),
    ]);
    return createInlineKeyboard(rows);
}

/**
 * Live progress card rendered while merging server files.
 * @param {{
 *   currentFileIndex?: number,
 *   totalFiles?: number,
 *   currentFileName?: string,
 *   currentFileSize?: number,
 *   keptLines?: number,
 *   duplicatesStripped?: number,
 *   phase?: string,
 *   humanSize?: (n: number) => string
 * }} progress
 */
function renderMergeProgress(progress = {}) {
    const {
        currentFileIndex = 1,
        totalFiles = 1,
        currentFileName = "",
        currentFileSize = 0,
        keptLines = 0,
        duplicatesStripped = 0,
        phase = "Merging and deduplicating...",
        humanSize = (n) => `${n} B`,
    } = progress || {};

    const pct = Math.min(100, Math.max(0, Math.round((currentFileIndex / Math.max(totalFiles, 1)) * 100)));
    const filled = Math.min(10, Math.max(0, Math.round(pct / 10)));
    const gauge = "█".repeat(filled) + "░".repeat(10 - filled);

    const lines = [
        `⏳  ${B("MERGING FILES IN VAULT")}  ${tgEmoji("⚡️")}`,
        RULE,
        `Progress: ${CODE(`[${gauge}]`)} ${B(`${pct}%`)} (${B(currentFileIndex)}/${B(totalFiles)} files)`,
        "",
    ];

    if (currentFileName) {
        const sz = currentFileSize > 0 ? ` (${humanSize(currentFileSize)})` : "";
        lines.push(`📄  ${B("Current File:")} ${CODE(escapeHtml(currentFileName))}${sz}`);
    }

    if (keptLines > 0 || duplicatesStripped > 0) {
        lines.push(
            `💎  ${B("Clean Kept:")} ${CODE(num(keptLines))} · 🧹 ${B("Dupes:")} ${CODE(num(duplicatesStripped))}`,
        );
    }

    lines.push(
        `⚡️  ${B("Status:")} ${I(phase)}`,
        RULE,
        `💡 ${I("Saving output directly to your server vault (background stream)...")}`,
    );

    return lines.join("\n");
}

/**
 * Summary rendered after merging files on server disk without returning to Telegram.
 * @param {{ outName: string, outPath: string, totalFiles: number, keptLines?: number, duplicatesStripped?: number, fileSize: number, isZip?: boolean }} stats
 */
function renderMergeComplete(stats = {}) {
    stats = stats || {};
    const lines = [
        `✅  ${B("FILES MERGED ON SERVER VAULT")}  ${tgEmoji("⚡️")}`,
        RULE,
        `Merged ${B(stats.totalFiles || 0)} file(s) into one clean, deduplicated file on disk:`,
        "",
        `📄  ${B("Output File:")} ${B(escapeHtml(stats.outName || "merged_output"))}`,
        `📁  ${B("Disk Path:")} ${CODE(escapeHtml(stats.outPath || ""))}`,
    ];
    if (stats.isZip) {
        lines.push(`📦  ${B("Format:")} Master ZIP Archive (Folders Preserved)`);
    } else {
        lines.push(`💎  ${B("Cleaned Lines:")} ${B(num(stats.keptLines || 0))}`);
        lines.push(`🧹  ${B("Duplicates Stripped:")} ${B(num(stats.duplicatesStripped || 0))}`);
    }
    lines.push(`💾  ${B("Final Size:")} ${B(humanSize(stats.fileSize || 0))}`);
    lines.push(RULE);
    lines.push(`🔒  ${I("The clean merged file is saved on server disk in your vault. As requested, it was NOT sent back to Telegram.")}`);
    return lines.filter(Boolean).join("\n");
}

/**
 * Keyboard rendered after server-side file merge.
 * @param {string} [outName]
 */
function mergeCompleteKeyboard(outName = "") {
    return createInlineKeyboard([
        [
            Markup.button.callback("📂 Open Server Vault", "server_files"),
            Markup.button.callback("🔀 Merge More Files", "files:tab:select"),
        ],
        [
            Markup.button.callback("📊 System Stats", "stats"),
            Markup.button.callback("🔙 Main Menu", "help"),
        ],
    ]);
}

/**
 * Keyboard when the batch is empty.
 */
function emptyBatchKeyboard() {
    return createInlineKeyboard([
        [Markup.button.callback("🚀 Run ULP Search", "ulp:menu"), Markup.button.callback("📥 Save Large Files", "save:start")],
        [Markup.button.callback("📂 Server Vault", "server_files"), Markup.button.callback("📊 Stats", "stats")],
        [Markup.button.callback("❓ Help Manual", "help")],
    ]);
}

/**
 * Two-step clear confirmation.
 */
function confirmClearKeyboard() {
    return createInlineKeyboard([
        [
            Markup.button.callback("⚠️ Yes, wipe it", "clear:yes"),
            Markup.button.callback("❌ Keep it", "clear:no"),
        ],
    ]);
}

/**
 * /start and /help message — full interactive button dashboard with animated emojis.
 * @param {string} [botUsername]
 * @param {{ size: number, files: number }|null} [batch] existing batch summary
 * @param {string|null} [searcherBot] configured ULP searcher bot username
 */
function renderHelp(botUsername, batch = null, searcherBot = null) {
    const mention = botUsername ? `@${escapeHtml(botUsername)}` : "this bot";
    const batchSize = batch ? Number(batch.size || 0) : 0;
    const batchFiles = batch ? Number(batch.files || 0) : 0;
    const osCpus = require("os").cpus();
    const cpus = (Array.isArray(osCpus) && osCpus.length) || 4;
    const mem = process.memoryUsage ? process.memoryUsage() : {};
    const ramMb = mem.rss ? Math.round(mem.rss / (1024 * 1024)) : 64;

    return [
        `${tgEmoji("💎")}  ${B("COMBO CLEANER ULTIMATE")}  ${tgEmoji("⚡️")}`,
        `${tgEmoji("🚀")}  ${I("Multi-Core Turbo Cleaning & ULP Relay Engine")}  ${tgEmoji("🛡️")}`,
        RULE,
        `${tgEmoji("📊")}  ${B("SYSTEM ENGINE METRICS")}`,
        `  • ${tgEmoji("⚡️")} ${B("Multi-Core Workers:")}  ${CODE(`${cpus}x Parallel CPU Cores Active`)}`,
        `  • ${tgEmoji("💽")} ${B("Process Memory:")}     ${CODE(`${ramMb} MB RSS Allocated`)}`,
        `  • ${tgEmoji("📦")} ${B("Active Batch Vault:")}  ${B(num(batchSize))} unique lines (${num(batchFiles)} files)`,
        `  • ${tgEmoji("🤖")} ${B("Connected ULP Bot:")}   ${CODE(`@${escapeHtml(searcherBot || "DumpNews14Bot")}`)}`,
        `  • ${tgEmoji("🚀")} ${B("Engine Mode:")}         ${B("TURBO 100% CPU SATURATION")}`,
        RULE,
        "",
        `${tgEmoji("✨")}  ${B("INTERACTIVE ACTION DASHBOARD")}`,
        `👇 ${I("Tap any button below to execute instantly without typing commands:")}`,
        "",
        `${tgEmoji("🛡️")} ${mention} · Ultimate Pro Edition`,
    ].join("\n");
}

/**
 * /stats reply — dashboard style with a capacity gauge.
 * @param {{ size: number, files: number, totalKept: number, sites?: number }|null} stats
 */
function renderStats(stats) {
    if (!stats || stats.size === 0) {
        return [
            `${tgEmoji("📊")}  ${B("BATCH METRICS DASHBOARD")}  ${tgEmoji("⚡️")}`,
            RULE,
            `  • ${tgEmoji("📭")} ${B("Status:")} Empty batch \u2014 nothing stored yet.`,
            "",
            `${I(`Send me a .zip or .txt dump to get started ${tgEmoji("🚀")}`)}`,
        ].join("\n");
    }
    const cap = 2_000_000;
    const pct = Math.min(100, Math.round((stats.size / cap) * 100));
    return [
        `${tgEmoji("📊")}  ${B("BATCH METRICS DASHBOARD")}  ${tgEmoji("⚡️")}`,
        RULE,
        `  • ${tgEmoji("💎")} ${B("Unique Credentials:")}  ${B(compact(stats.size))} (${num(stats.size)} lines)`,
        `  • ${tgEmoji("📂")} ${B("Files Ingested:")}      ${num(stats.files)} archive(s)`,
        `  • ${tgEmoji("✂️")} ${B("Lines Accepted:")}      ${num(stats.totalKept)} lines`,
        stats.sites ? `  • ${tgEmoji("🌐")} ${B("Sites Detected:")}      ${B(num(stats.sites))} domain(s)` : null,
        "",
        `  • ${tgEmoji("📦")} ${B("Storage Capacity:")}    ${CODE(`[${bar(stats.size, cap, 10)}]`)} ${B(`${pct}%`)}`,
        RULE,
        `👇 ${I(`Tap ${tgEmoji("📦")} Get Combined File below to download clean credentials!`)}`,
    ]
        .filter((l) => l !== null)
        .join("\n");
}

/**
 * /sites reply — per-site breakdown with bars.
 * @param {Array<{ site: string, count: number }>|null} siteCounts
 */
function renderSites(siteCounts) {
    if (!Array.isArray(siteCounts) || siteCounts.length === 0) {
        return [
            `${tgEmoji("📡")}  ${B("SITE RECONNAISSANCE")}  ${tgEmoji("⚡️")}`,
            RULE,
            `  • ${tgEmoji("🌐")} ${B("Status:")} No domains detected yet \u2014 send a dump file first ${tgEmoji("📤")}`,
        ].join("\n");
    }
    const max = Math.max(...siteCounts.map((s) => (s && s.count) || 0), 1);
    const lines = [
        `${tgEmoji("📡")}  ${B("SITE RECONNAISSANCE")} \u00B7 ${B(num(siteCounts.length))} detected ${tgEmoji("🌐")}`,
        RULE,
    ];
    for (const item of siteCounts) {
        const site = (item && item.site) || "unknown";
        const count = (item && item.count) || 0;
        const emoji = siteEmoji(site);
        lines.push(
            `  • ${tgEmoji(emoji)} ${B(escapeHtml(site))}`,
            `    └ ${CODE(`[${bar(count, max, 12)}]`)} ${B(compact(count))} lines`,
        );
    }
    lines.push("", RULE, `👇 ${I(`Tap ${tgEmoji("📦")} Get Combined File or tap 🗑 to delete a domain below:`)}`);
    return lines.join("\n");
}

/**
 * /ping reply.
 * @param {{ latencyMs: number, uptimeSec: number }} info
 */
function renderPing(info = {}) {
    info = info || {};
    const up = Number(info.uptimeSec) || 0;
    const latency = Number(info.latencyMs) || 0;
    const h = Math.floor(up / 3600);
    const m = Math.floor((up % 3600) / 60);
    const s = Math.floor(up % 60);
    const uptime = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
    const speed =
        latency < 100 ? `${tgEmoji("🚀")} Blazing Fast` : latency < 300 ? `${tgEmoji("⚡️")} Optimal` : `${tgEmoji("⏳")} Normal`;
    return [
        `${tgEmoji("🏓")}  ${B("SYSTEM ENGINE STATUS: PONG")}  ${tgEmoji("⚡️")}`,
        RULE,
        `  • ${tgEmoji("📡")} ${B("Network Latency:")}  ${B(`${latency} ms`)} · ${speed}`,
        `  • ${tgEmoji("⏱️")} ${B("System Uptime:")}    ${B(uptime)}`,
        `  • ${tgEmoji("🟢")} ${B("Engine State:")}     ${B("Online & Saturating CPU")}`,
        `  • ${tgEmoji("🛡️")} ${B("Bot Protection:")}   ${B("Active Anti-Flood & Fallback Safe")}`,
        RULE,
    ].join("\n");
}

/**
 * Per-file processing report.
 * @param {string} name
 * @param {{ total: number, kept: number, dropped: number, duplicates: number, files?: number, truncated?: boolean, skippedLarge?: number }} stats
 * @param {{ added: number, duplicates: number, capped: boolean, size: number }} added
 * @param {{ size: number, files: number }|null} chatStats
 * @param {string} [site]
 */
function renderFileReport(name = "file", stats = {}, added = {}, chatStats = null, site = "") {
    name = name || "file";
    stats = stats || {};
    added = added || {};
    const total = Number(stats.total) || 0;
    const kept = Number(stats.kept) || 0;
    const ratio = total > 0 ? Math.round((kept / total) * 100) : 0;
    const siteEmojiOut = site ? siteEmoji(site) : "🌐";
    const lines = [
        `${tgEmoji("✨")}  ${B("MULTI-CORE CLEAN REPORT")}  ${tgEmoji("⚡️")}`,
        RULE,
        `  • ${tgEmoji("📄")} ${B("Source File:")}     ${B(escapeHtml(name))}`,
    ];
    if (site) {
        lines.push(`  • ${tgEmoji(siteEmojiOut)} ${B("Site Detected:")}   ${B(escapeHtml(site))}`);
    }
    lines.push(
        RULE,
        `  • ${tgEmoji("📂")} ${B("Files Read:")}       ${num(stats.files || 0)}`,
        `  • ${tgEmoji("📑")} ${B("Lines Seen:")}       ${num(total)}`,
        `  • ${tgEmoji("💎")} ${B("Kept:")}             ${B(num(kept))}  ${bar(kept, total)} ${ratio}%`,
        `  • ${tgEmoji("🔄")} Duplicates          ${num(stats.duplicates || 0)}`,
        `  • ${tgEmoji("🗑️")} ${B("Dropped:")}          ${num(stats.dropped || 0)}`,
        RULE,
        `  • ${tgEmoji("➕")} ${B("Added to batch:")}   ${B(num(added.added || 0))}`,
        `  • ${tgEmoji("↩️")} ${B("Already Had:")}      ${num(added.duplicates || 0)}`,
    );

    if (chatStats) {
        lines.push(
            "",
            `${tgEmoji("📦")}  ${B("Batch Total")} \u00B7 ${B(compact(chatStats.size || 0))} unique from ${num(chatStats.files || 0)} file(s)`,
        );
    }

    if (stats.truncated) {
        lines.push(
            "",
            `${tgEmoji("⚠️")}  ${B("Truncated")} \u2014 huge archive; stopped early to stay safe.`,
        );
    }
    if (stats.skippedLarge) {
        lines.push(
            `${tgEmoji("⚠️")}  Skipped ${num(stats.skippedLarge)} oversized entr${stats.skippedLarge === 1 ? "y" : "ies"}.`,
        );
    }
    if (added.capped) {
        lines.push(
            "",
            `${tgEmoji("⚠️")}  ${B("Storage cap reached")} \u2014 grab the file, then ${tgEmoji("🧹")} /clear.`,
        );
    }

    lines.push(
        "",
        `${tgEmoji("🎉")} Successfully ingested \u2014 tap ${tgEmoji("📦")} below to download it all!`,
    );
    return lines.join("\n");
}

/**
 * Render report for forwarded log files combined into a single master file with direct download link.
 * @param {object} params
 */
function renderForwardedLogsCombined(params = {}) {
    params = params || {};
    const { files = [], stats = {}, downloadUrl = "", filename = "", site = "", chatStats = null } = params;
    const safeStats = stats || {};
    const siteEmojiOut = site ? siteEmoji(site) : "🌐";
    const fileCount = Array.isArray(files) ? files.length : 1;
    const lines = [
        `${tgEmoji("⚡")}  ${B("FORWARDED LOGS UNIFIED PIPELINE")}  ${tgEmoji("⚡️")}`,
        RULE,
        `${tgEmoji("📁")}  ${B(`Combined Sources (${num(fileCount)} forwarded files):`)}`,
    ];

    if (Array.isArray(files)) {
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const sizeStr = f && f.size ? ` · ${humanSize(f.size)}` : "";
            const linesStr = f && f.lines !== undefined ? ` (${num(f.lines)} lines${sizeStr})` : (sizeStr ? ` (${sizeStr.slice(3)})` : "");
            lines.push(`  ${i + 1}. ${tgEmoji("📄")} ${B(escapeHtml((f && f.name) || "log_file"))}${linesStr}`);
        }
    }

    lines.push(
        RULE,
        `${tgEmoji("📊")}  ${B("Combined Master Aggregation:")}`,
        `  • ${tgEmoji("📑")} ${B("Total Lines Ingested:")}   ${num(safeStats.total || 0)}`,
        `  • ${tgEmoji("💎")} ${B("Unique Lines Kept:")}      ${B(num(safeStats.kept || safeStats.size || 0))}`,
        `  • ${tgEmoji("🔄")} ${B("Duplicates Removed:")}     ${num(safeStats.duplicates || 0)}`,
    );

    if (site) {
        lines.push(`  • ${tgEmoji(siteEmojiOut)} ${B("Target Site:")}            ${B(escapeHtml(site))}`);
    }
    if (filename) {
        lines.push(`  • ${tgEmoji("💾")} ${B("Master Output:")}          ${CODE(escapeHtml(filename))}`);
    }

    if (downloadUrl) {
        lines.push(
            RULE,
            `${tgEmoji("🔗")}  ${B("Direct Download Link:")}`,
            `${downloadUrl}`,
            "",
            `${tgEmoji("💡")}  ${I("Fast direct HTTP stream ready! Tap the button below to download instantly.")}`,
        );
    }

    if (chatStats) {
        lines.push(
            "",
            `${tgEmoji("📦")}  ${B("Chat Batch Total:")} ${B(compact(chatStats.size))} unique lines across ${num(chatStats.files)} file(s)`,
        );
    }

    return lines.join("\n");
}

/**
 * Render report for forwarded zip files merged into a single master zip file with direct download link.
 * @param {object} params
 */
function renderForwardedZipCombined(params = {}) {
    params = params || {};
    const { files = [], entryCount = 0, folderCount = 0, totalSize = 0, compressedSize = 0, downloadUrl = "", filename = "" } = params;
    const fileCount = Array.isArray(files) ? files.length : 1;
    const lines = [
        `${tgEmoji("⚡")}  ${B("MERGED ZIP PIPELINE (DIRECT LINK)")}  ${tgEmoji("⚡️")}`,
        RULE,
        `${tgEmoji("📁")}  ${B(`Merged Source Archives (${num(fileCount)} forwarded files):`)}`,
    ];

    if (Array.isArray(files)) {
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const sizeStr = f.size ? ` · ${humanSize(f.size)}` : "";
            const entriesStr = f.entriesCount !== undefined ? ` (${num(f.entriesCount)} files${sizeStr})` : (sizeStr ? ` (${sizeStr.slice(3)})` : "");
            lines.push(`  ${i + 1}. ${tgEmoji("📦")} ${B(escapeHtml(f.name || "archive.zip"))}${entriesStr}`);
        }
    }

    lines.push(
        RULE,
        `${tgEmoji("📊")}  ${B("Combined Master Archive:")}`,
        `  • ${tgEmoji("📑")} ${B("Total Merged Files:")}    ${B(num(entryCount))} files`,
    );

    if (folderCount > 0) {
        lines.push(`  • ${tgEmoji("📂")} ${B("Merged Folder Trees:")}   ${B(num(folderCount))} folders`);
    }

    lines.push(
        `  • ${tgEmoji("💾")} ${B("Unified Zip Name:")}     ${CODE(escapeHtml(filename))}`,
        `  • ${tgEmoji("📦")} ${B("Combined Zip Size:")}    ${B(humanSize(compressedSize || totalSize))}`,
    );

    if (downloadUrl) {
        lines.push(
            RULE,
            `${tgEmoji("🔗")}  ${B("Direct Download Link:")}`,
            `${downloadUrl}`,
            "",
            `${tgEmoji("💡")}  ${I("Zero download required on your end! Tap the direct link below to download the single combined zip:")}`,
        );
    }

    return lines.join("\n");
}

/**
 * /preview reply — a small sample of stored lines.
 * @param {string[]} sample
 * @param {number} total
 */
function renderPreview(sample = [], total = 0) {
    sample = Array.isArray(sample) ? sample : [];
    total = Number(total) || sample.length;
    if (total === 0 || sample.length === 0) {
        return [
            `${tgEmoji("👁")}  ${B("PREVIEW")}  ${tgEmoji("⚡️")}`,
            RULE,
            `${tgEmoji("📭")} Batch is empty \u2014 nothing to preview.`,
            "",
            `${I(`Send a .zip or .txt first ${tgEmoji("📤")}`)}`,
        ].join("\n");
    }
    return [
        `${tgEmoji("👁")}  ${B("PREVIEW")} \u00B7 first ${num(sample.length)} of ${B(compact(total))}  ${tgEmoji("💎")}`,
        RULE,
        ...sample.map((line) => `${CODE(escapeHtml(line))}`),
        "",
        `${I(`Credentials are sensitive \u2014 delete this message when done ${tgEmoji("🗑️")}`)}`,
    ].join("\n");
}

/**
 * /search reply - matching lines from the batch, capped for Telegram limits.
 * Shows at most 20 hits inline; if there are more, use /combine + search locally.
 */
function renderSearch(query = "", result = {}) {
    query = String(query || "");
    result = result || {};
    const matches = Array.isArray(result.matches) ? result.matches : [];
    const total = Number(result.total) || matches.length;
    const shown = matches.length;
    if (total === 0 || matches.length === 0) {
        return [
            `${tgEmoji("🔎")}  ${B("SEARCH RESULTS")}  ${tgEmoji("⚡️")}`,
            RULE,
            "No matches for " + CODE(escapeHtml(query)) + ` \u2014 try another term ${tgEmoji("🔍")}`,
        ].join("\n");
    }
    const out = [
        `${tgEmoji("🔎")}  ${B("SEARCH RESULTS")} \u00B7 ${B(num(total))} hit${total === 1 ? "" : "s"} for ${CODE(escapeHtml(query))}`,
        RULE,
    ];
    for (const line of matches) out.push(CODE(escapeHtml(line)));
    if (total > shown) {
        out.push("", I("Showing first " + shown + " of " + num(total) + ` \u2014 /combine for the full file ${tgEmoji("📦")}`));
    }
    return out.join("\n");
}

/**
 * Inline keyboard shown under search results.
 * Includes direct download button when hits are found.
 * @param {string} query
 * @param {number} total
 */
function searchResultKeyboard(query, total = 0) {
    const rows = [];
    const cleanQ = String(query || "").trim();
    if (total > 0 && cleanQ) {
        const shortQ = cleanQ.length > 25 ? cleanQ.slice(0, 22) + "…" : cleanQ;
        rows.push([
            Markup.button.callback(`📥 Download "${shortQ}" (${num(total)})`, registerCallbackPayload("search:dl:", cleanQ)),
        ]);
    }
    rows.push([
        Markup.button.callback("📦 Get Combined File", "combine"),
        Markup.button.callback("📊 System Stats", "stats"),
    ]);
    rows.push([
        Markup.button.callback("🔙 Main Menu", "help"),
    ]);
    return createInlineKeyboard(rows);
}

/**
 * Render local search result message.
 */
function renderLocalSearch(params = {}) {
    const p = (params && typeof params === "object") ? params : {};
    const query = String(p.query || "");
    const total = Number(p.total) || 0;
    const matches = Array.isArray(p.matches) ? p.matches : [];
    const fileName = p.fileName || null;
    const fileSize = p.fileSize || 0;
    const fileResults = Array.isArray(p.fileResults) ? p.fileResults : null;
    const isAll = Boolean(p.isAll || (Array.isArray(fileResults) && fileResults.length > 0));

    const lines = [];
    lines.push(
        `${tgEmoji("🔎")}  ${B(isAll ? "VAULT SEARCH RESULTS" : "LOCAL FILE SEARCH")}  ${tgEmoji("⚡️")}`,
        RULE,
    );

    if (fileName) {
        lines.push(`📂  ${B("File:")} ${CODE(escapeHtml(fileName))}${fileSize > 0 ? ` (${humanSize(fileSize)})` : ""}`);
    } else if (isAll) {
        const searched = p.searchedFiles !== undefined ? p.searchedFiles : (fileResults ? fileResults.length : 0);
        const totalF = p.totalFiles || searched;
        lines.push(`📁  ${B("Scope:")} All Vault Files (${B(num(searched))} of ${num(totalF)} matched)`);
    }
    lines.push(`🎯  ${B("Query:")} ${CODE(escapeHtml(query))}`);
    lines.push(`💎  ${B("Total Matches:")} ${B(num(total))} hit${total === 1 ? "" : "s"}`);
    lines.push(RULE);

    if (total === 0 || matches.length === 0) {
        lines.push(
            `⚠️  ${I("No matches found for this query.")}`,
            "",
            `💡 ${I("Suggestions:")}`,
            `  • Try a broader search term (e.g. gmail.com instead of specific user)`,
            `  • Use /lsearch <query> without a target to search across all vault files`,
            `  • Save more files with /save`,
        );
        return lines.join("\n");
    }

    if (fileResults && fileResults.length > 0) {
        lines.push(`${tgEmoji("📊")}  ${B("Matches By File:")}`);
        const topFiles = fileResults.slice(0, 5);
        topFiles.forEach((fr, idx) => {
            if (!fr) return;
            const icon = fr.type === "proc" ? tgEmoji("💎") : tgEmoji("📥");
            lines.push(`  ${icon} ${B(`[${idx + 1}]`)} ${escapeHtml(fr.name || "file")}: ${B(num(fr.total))} matches`);
        });
        if (fileResults.length > 5) {
            lines.push(`  ${I(`…+${fileResults.length - 5} more files with matches`)}`);
        }
        lines.push(RULE);
    }

    lines.push(`👁  ${B(`Sample Matches (Showing ${matches.length} of ${num(total)}):`)}`);
    for (const m of matches.slice(0, 15)) {
        lines.push(CODE(escapeHtml(m)));
    }

    if (total > matches.length) {
        lines.push("");
        lines.push(`📦  ${I(`+${num(total - matches.length)} more matches in vault files on server disk.`)}`);
        lines.push(`👇 ${I("Tap Download below to get all matching lines in a clean .txt file!")}`);
    } else {
        lines.push("");
        lines.push(`👇 ${I("Tap Download below to export these results as a text document:")}`);
    }

    return lines.join("\n");
}

/**
 * Inline keyboard shown under local search results.
 */
function localSearchResultKeyboard(params = {}) {
    const p = (params && typeof params === "object") ? params : {};
    const rows = [];
    const query = String(p.query || "").trim();
    const total = Number(p.total) || 0;
    const fileIdx = p.fileIdx !== undefined ? p.fileIdx : null;
    const isProc = Boolean(p.isProc);
    const isAll = Boolean(p.isAll);

    if (total > 0 && query) {
        const safeIdx = (typeof fileIdx === "number" || (typeof fileIdx === "string" && !isNaN(parseInt(fileIdx, 10)))) ? parseInt(fileIdx, 10) : 0;
        const dlPayload = isAll ? `all:${query}` : `${isProc ? "proc" : "raw"}:${safeIdx}:${query}`;
        rows.push([
            Markup.button.callback(`📥 Download Matches (${num(total)})`, registerCallbackPayload("lsearch:dl:", dlPayload)),
        ]);
    }

    const actionRow = [];
    if (!isAll && fileIdx !== null) {
        actionRow.push(Markup.button.callback("🔍 Search File Again", `file:search:${isProc ? "proc:" : ""}${fileIdx}`));
        actionRow.push(Markup.button.callback("🌐 Search All Vault", query ? registerCallbackPayload("lsearch:all:run:", query) : "lsearch:prompt"));
    } else {
        actionRow.push(Markup.button.callback("🔍 New Vault Search", "lsearch:prompt"));
    }
    rows.push(actionRow);

    rows.push([
        Markup.button.callback("🏠 Back to Server Vault", "server_files"),
        Markup.button.callback("🔙 Main Menu", "help"),
    ]);

    return createInlineKeyboard(rows);
}

/**
 * Render the /lsearch hub message.
 */
function renderLocalSearchHub(rawFiles = [], procFiles = []) {
    const rf = Array.isArray(rawFiles) ? rawFiles : [];
    const pf = Array.isArray(procFiles) ? procFiles : [];
    const lines = [];
    lines.push(
        `${tgEmoji("🔎")}  ${B("LOCAL VAULT SEARCH HUB")}  ${tgEmoji("⚡️")}`,
        RULE,
        `Fast multi-core searching across files stored on your server disk.`,
        `💡 ${I("Search gigabyte dumps or cleaned output files in milliseconds without high RAM usage.")}`,
        "",
        `${tgEmoji("📊")}  ${B("Searchable Vault Inventory:")}`,
        `  ${tgEmoji("📥")}  Raw Dumps: ${B(num(rf.length))} files`,
        `  ${tgEmoji("💎")}  Cleaned Vault: ${B(num(pf.length))} files`,
        RULE,
        `💡  ${B("How to Search:")}`,
        `  • ${CODE("/lsearch <query>")} — Search across ${B("ALL")} vault files`,
        `  • ${CODE("/lsearch <query> <# or filename>")} — Search a ${B("specific")} file`,
        `  • ${CODE("/lsearch <query> clean")} — Search only ${B("cleaned")} vault files`,
        `  • ${CODE("/lsearch <query> raw")} — Search only ${B("raw")} dumps`,
        "",
        `💬 ${I("Or tap a quick search button below, or tap 'Enter Search Query':")}`,
    );
    return lines.join("\n");
}

/**
 * Keyboard for /lsearch hub.
 */
function localSearchHubKeyboard(rawFiles = [], procFiles = []) {
    const rows = [];
    rows.push([
        Markup.button.callback("✏️ Enter Search Query", "lsearch:prompt"),
    ]);
    rows.push([
        Markup.button.callback("📧 Search Gmail", registerCallbackPayload("lsearch:all:run:", "gmail.com")),
        Markup.button.callback("📧 Search Hotmail", registerCallbackPayload("lsearch:all:run:", "hotmail.com")),
    ]);
    rows.push([
        Markup.button.callback("📧 Search Yahoo", registerCallbackPayload("lsearch:all:run:", "yahoo.com")),
        Markup.button.callback("🌐 Search .com", registerCallbackPayload("lsearch:all:run:", ".com")),
    ]);
    rows.push([
        Markup.button.callback("📂 Browse Server Vault", "server_files"),
        Markup.button.callback("🔙 Main Menu", "help"),
    ]);
    return createInlineKeyboard(rows);
}

/**
 * Keyboard for single-file search prompt.
 */
function localFileSearchKeyboard(fileIdx = 0, isProc = false) {
    const safeIdx = (typeof fileIdx === "number" || typeof fileIdx === "string") ? fileIdx : 0;
    const rows = [];
    const prefix = isProc ? "file:dosearch:proc:" : "file:dosearch:";
    rows.push([
        Markup.button.callback("✏️ Type Custom Query", `file:search:custom:${isProc ? "proc:" : ""}${safeIdx}`),
    ]);
    rows.push([
        Markup.button.callback("📧 Gmail", `${prefix}${safeIdx}:gmail.com`),
        Markup.button.callback("📧 Hotmail", `${prefix}${safeIdx}:hotmail.com`),
    ]);
    rows.push([
        Markup.button.callback("📧 Yahoo", `${prefix}${safeIdx}:yahoo.com`),
        Markup.button.callback("🌐 .com", `${prefix}${safeIdx}:.com`),
    ]);
    rows.push([
        Markup.button.callback("🌐 Search All Vault Files Instead", "lsearch:prompt"),
    ]);
    rows.push([
        Markup.button.callback("🔙 Back to Vault", "server_files"),
        Markup.button.callback("❌ Cancel", "search:cancel"),
    ]);
    return createInlineKeyboard(rows);
}

/**
 * Seconds label for the send pacing, e.g. 7000 -> "7s".
 * @param {number} ms
 */
function pacingLabel(ms) {
    const s = Number(ms || 0) / 1000;
    return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
}

/**
 * @param {string} username
 */
function mentionOf(username) {
    return `@${escapeHtml(String(username || "").replace(/^@+/, ""))}`;
}

/**
 * Scope buttons for the ULP relay.
 * @param {string} [scope]
 */
function ulpKeyboard(status = true) {
    const isFinished = status === false || status === "stopped" || status === "done" || status === "exhausted";
    if (isFinished) {
        return createInlineKeyboard([
            [
                Markup.button.callback("📦 Get Combined File", "combine"),
                Markup.button.callback("🔁 Run again", "ulp:again"),
            ],
            [
                Markup.button.callback("📂 Server Vault", "server_files"),
                Markup.button.callback("🔙 Main Menu", "help"),
            ],
        ]);
    }
    return createInlineKeyboard([
        [
            Markup.button.callback("📦 Get Combined File", "combine"),
            Markup.button.callback("🛑 Stop Search", "ulp:stop"),
        ],
    ]);
}

/**
 * Keyboard attached to a relayed result (documents can be cleaned straight away).
 * @param {boolean} [hasDocument]
 */
function ulpResultKeyboard(hasDocument = false) {
    const rows = [];
    if (hasDocument) {
        rows.push([Markup.button.callback("\uD83E\uDDFC Clean into batch", "ulp:clean")]);
    }
    rows.push([
        Markup.button.callback("\uD83D\uDCE6 Get combined file", "combine"),
        Markup.button.callback("\uD83D\uDCCA Stats", "stats"),
    ]);
    return createInlineKeyboard(rows);
}

/**
 * /ulp usage card.
 * @param {{ searcherBot: string, stepDelayMs: number, maxTries: number, daysCount?: number }} info
 */
function renderUlpHint(info = {}) {
    info = info || {};
    const daysLabel = info.daysCount ? `${info.daysCount} days active` : "5 days default";
    return [
        `${tgEmoji("🚀")}  ${B("ULP SEARCH RELAY")}  ${tgEmoji("⚡️")}`,
        RULE,
        `${I("Usage:")} ${CODE(escapeHtml("/ulp <query> [days] [start_date]"))}`,
        "",
        `  ${tgEmoji("📅")} ${B("Duration:")} ${CODE(daysLabel)} · Select 1 to 90 days`,
        `  ${tgEmoji("💡")} ${B("Examples:")}`,
        `     • ${CODE("/ulp netflix.com 7")} ${I("(search last 7 days)")}`,
        `     • ${CODE("/ulp netflix.com 20.09.2026 14")} ${I("(14 days from date)")}`,
        `     • ${CODE("/ulp 14")} ${I("(set default duration to 14 days)")}`,
        "",
        `  ${tgEmoji("1️⃣")} ${B("Target")} — Sent to ${B(mentionOf(info.searcherBot || "DumpNews14Bot"))}`,
        `  ${tgEmoji("2️⃣")} ${B("Smart Batch")} — Auto-detects latest batch date & steps down day-by-day`,
        `  ${tgEmoji("3️⃣")} ${B("Live Forward")} — All dump results are forwarded & auto-cleaned into batch`,
        `  ${tgEmoji("4️⃣")} ${B("Auto-Delivery")} — Delivers combined file and resets batch when finished ${tgEmoji("💎")}`,
    ].join("\n");
}

/**
 * /ulp launch card: the exact sequence that will be sent to the searcher bot.
 * @param {{ query: string, scope: string, searcherBot: string, steps: Array<{ id: string, text: string }>, stepDelayMs: number, maxTries: number, transport?: string, daysCount?: number, startDate?: string }} info
 */
function renderUlpStart(info = {}) {
    info = info || {};
    const whoRow =
        info.transport === "userbot"
            ? [
                `  • ${tgEmoji("👤")} ${B("Transport Relay:")} ${B("MTProto Account")} ${I("(MTProto bypass)")} ${tgEmoji("⚡️")}`,
                `  • ${tgEmoji("🤖")} ${B("Target Bot:")}      ${B(mentionOf(info.searcherBot || "DumpNews14Bot"))}`,
            ]
            : [`  • ${tgEmoji("🤖")} ${B("Target Bot:")}      ${B(mentionOf(info.searcherBot || "DumpNews14Bot"))}`];
    const daysCount = info.daysCount || 5;
    const dateLabel = info.startDate
        ? `Last ${daysCount} days from ${info.startDate}`
        : `Last ${daysCount} days (Auto-detecting latest batch)`;
    return [
        `${tgEmoji("🚀")}  ${B("ULP SEARCH INITIALIZED")}  ${tgEmoji("⚡️")}`,
        RULE,
        `  • ${tgEmoji("🎯")} ${B("Target Query:")}   ${B(escapeHtml(info.query || "unknown"))}`,
        `  • ${tgEmoji("📅")} ${B("Search Scope:")}   ${B(`Day-by-Day (${dateLabel})`)}`,
        ...whoRow,
        `  • ${tgEmoji("⏳")} ${B("Flood Safety:")}   ${CODE(`${pacingLabel(info.stepDelayMs)} delay`)}`,
        RULE,
        `${I(`Incoming dump files will be auto-downloaded & cleaned into batch ${tgEmoji("⬇️")}`)}`,
        `${I(`When done or stopped, the combined file is delivered automatically ${tgEmoji("✨")}`)}`,
    ].join("\n");
}

/**
 * Progress card after each paced send.
 * @param {{ searcherBot: string, attempt: number, maxTries: number, sends: number, stepDelayMs: number, query?: string }} info
 */
function renderUlpProgress(info = {}) {
    info = info || {};
    const sendsLine = Array.isArray(info.sends)
        ? escapeHtml(info.sends.join(" · "))
        : `${num(info.sends || 0)} step(s) sent`;
    const attempt = Number(info.attempt || 1);
    const maxTries = Number(info.maxTries || 5);
    const pct = Math.min(100, Math.round((attempt / maxTries) * 100));
    return [
        `${tgEmoji("📡")}  ${B("ULP SEARCH IN PROGRESS")} · ${B(`[Day ${attempt}/${maxTries}]`)}  ${tgEmoji("⏳")}`,
        RULE,
        `  • ${tgEmoji("🤖")} ${B("Searcher:")} ${CODE(mentionOf(info.searcherBot || "DumpNews14Bot"))} · ${sendsLine}`,
        `  • ${tgEmoji("📊")} ${B("Progress:")} ${bar(attempt, maxTries, 10)} ${B(`${pct}%`)}`,
        `  • ${tgEmoji("⏳")} ${B("Pacing:")}   ${CODE(`${pacingLabel(info.stepDelayMs)} anti-flood safe`)}`,
        RULE,
        `${I("Incoming dump files are continuously ingested, deduped & sanitized 🧼")}`,
        "",
        `👇 ${I("Tap below to grab credentials gathered so far, or let it complete:")}`,
    ].join("\n");
}

/**
 * Header posted once, right before results are forwarded.
 * @param {{ searcherBot: string, query: string, scope: string, count: number }} info
 */
function renderUlpResults(info = {}) {
    info = info || {};
    return [
        `${tgEmoji("📥")}  ${B("RESULTS INCOMING")}  ${tgEmoji("⚡️")}`,
        RULE,
        `  • ${tgEmoji("🤖")} ${B(mentionOf(info.searcherBot || "DumpNews14Bot"))} answered \u2014 forwarding ${B(num(info.count || 0))} message${info.count === 1 ? "" : "s"} ${tgEmoji("⬇️")}`,
        `  • ${tgEmoji("🎯")} ${CODE(escapeHtml(info.query || "unknown"))} \u00B7 ${CODE(escapeHtml(`hist:full:${info.scope || "day"}`))}`,
        RULE,
        `${I(`Documents are automatically ingested and deduped into your batch ${tgEmoji("💎")}`)}`,
    ].join("\n");
}

/**
 * Nothing came back after all paced tries.
 * @param {{ searcherBot: string, query: string, scope: string, attempts: number, stepDelayMs: number }} info
 */
function renderUlpEmpty(info = {}) {
    info = info || {};
    return [
        `${tgEmoji("🕳")}  ${B("NO RESULTS FOUND")}  ${tgEmoji("🕳")}`,
        RULE,
        `Tried ${B(`${info.attempts || 0}×`)} with ${B(pacingLabel(info.stepDelayMs || 14000))} pacing \u2014 ${B(mentionOf(info.searcherBot || "DumpNews14Bot"))} returned no dumps.`,
        `  • ${tgEmoji("🎯")} ${CODE(escapeHtml(info.query || "unknown"))} \u00B7 ${CODE(escapeHtml(`hist:full:${info.scope || "day"}`))}`,
        RULE,
        `${I(`Try another query with ${CODE(escapeHtml("/ulp <query>"))} ${tgEmoji("🔄")}`)}`,
    ].join("\n");
}

/**
 * Run completed successfully.
 * @param {{ query: string, scope?: string, count: number }} info
 */
function renderUlpDone(info = {}) {
    info = info || {};
    return [
        `${tgEmoji("✨")}  ${B("ULP SEARCH COMPLETED")}  ${tgEmoji("🚀")}`,
        RULE,
        `  • ${tgEmoji("🎯")}  Target:      ${B(escapeHtml(info.query || "unknown"))}`,
        `  • ${tgEmoji("📊")}  Relayed:     ${B(num(info.count || 0))} message${(info.count || 0) === 1 ? "" : "s"}`,
        `  • ${tgEmoji("📦")}  Status:      ${B("Combined file generated & batch reset")} ${tgEmoji("💎")}`,
        RULE,
        `${I(`Start another search anytime with /ulp ${tgEmoji("⚡️")}`)}`,
    ].join("\n");
}

/**
 * Run stopped by the user (or the result window expired).
 * @param {{ query: string, scope: string, count: number }} info
 */
function renderUlpStopped(info = {}) {
    info = info || {};
    return [
        `${tgEmoji("🛑")}  ${B("SEARCH HALTED")}  ${tgEmoji("🛑")}`,
        RULE,
        `${tgEmoji("🎯")}  ${CODE(escapeHtml(info.query || "unknown"))} \u00B7 ${CODE(escapeHtml(`hist:full:${info.scope || "day"}`))}`,
        `${tgEmoji("📊")}  ${num(info.count || 0)} result message${(info.count || 0) === 1 ? "" : "s"} captured this run`,
        "",
        `${I(`Ready for your next search with /ulp ${tgEmoji("🚀")}`)}`,
    ].join("\n");
}

/**
 * Format date for file listings (YYYY-MM-DD HH:mm).
 * @param {Date} d
 * @returns {string}
 */
function formatFileDate(d) {
    if (!d || !(d instanceof Date) || Number.isNaN(d.getTime())) return "Recent";
    const yr = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    const hr = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${yr}-${mo}-${da} ${hr}:${mi}`;
}

/**
 * Server files vault list (/files).
 * @param {{
 *   rawFiles: Array<{ name: string, size: number, mtime: Date }>,
 *   processedFiles: Array<{ name: string, size: number, mtime: Date }>,
 *   rawRoot: string,
 *   processedRoot: string,
 *   humanSize: (n: number) => string
 * }} info
 */
function renderServerFiles(info = {}) {
    const {
        rawFiles: inputRaw = [],
        processedFiles: inputProc = [],
        rawRoot = "",
        processedRoot = "",
        humanSize = (n) => `${n} B`,
        diskStats = null,
        batchStats = null,
        tab = "overview",
        page = 0,
        pageSize = 3,
    } = info || {};

    const rawFiles = Array.isArray(inputRaw)
        ? inputRaw.slice().sort((a, b) => ((b.size || 0) - (a.size || 0)) || ((b.mtime && a.mtime) ? b.mtime.getTime() - a.mtime.getTime() : 0))
        : [];
    const processedFiles = Array.isArray(inputProc)
        ? inputProc.slice().sort((a, b) => ((b.size || 0) - (a.size || 0)) || ((b.mtime && a.mtime) ? b.mtime.getTime() - a.mtime.getTime() : 0))
        : [];

    const totalRawBytes = rawFiles.reduce((acc, f) => acc + (Number(f.size) || 0), 0);
    const totalProcBytes = processedFiles.reduce((acc, f) => acc + (Number(f.size) || 0), 0);

    const lines = [
        `${tgEmoji("💾")}  ${B("SERVER STORAGE & FILES VAULT")}  ${tgEmoji("⚡️")}`,
        RULE,
    ];

    if (diskStats && Number.isFinite(diskStats.total) && diskStats.total > 0) {
        const pctUsed = Math.min(100, Math.max(0, Math.round((diskStats.used / diskStats.total) * 100)));
        const filled = Math.round(pctUsed / 10);
        const gauge = "█".repeat(filled) + "░".repeat(10 - filled);
        lines.push(
            `${tgEmoji("💽")}  ${B("Server Disk Storage:")}`,
            `     ${CODE(`[${gauge}]`)} ${B(`${pctUsed}%`)} (${humanSize(diskStats.used)} / ${humanSize(diskStats.total)})`,
            `     └ ${tgEmoji("🟢")} Free Space: ${B(humanSize(diskStats.free))}`,
            "",
        );
    }

    if (tab === "raw") {
        lines.push(
            `${tgEmoji("📥")}  ${B("RAW INCOMING DUMPS BROWSER (SORTED BY SIZE)")}  ${tgEmoji("📂")}`,
            `Directory: ${CODE(escapeHtml(rawRoot))}`,
            `Total: ${B(num(rawFiles.length))} files (${humanSize(totalRawBytes)})`,
            RULE,
        );
        const rawStart = page * pageSize;
        const rawSlice = rawFiles.slice(rawStart, rawStart + pageSize);
        const totalPages = Math.ceil(rawFiles.length / pageSize) || 1;
        if (rawFiles.length === 0) {
            lines.push(`  ${I("No raw files on disk — reply to any document with /save to ingest.")}`);
        } else {
            lines.push(`📑  ${B(`Page ${page + 1} of ${totalPages}`)}:`);
            rawSlice.forEach((f, i) => {
                const idx = rawStart + i + 1;
                const isZip = f.name.toLowerCase().endsWith(".zip");
                const icon = isZip ? tgEmoji("📦") : tgEmoji("📄");
                lines.push(
                    `  ${B(`[${idx}]`)} ${icon} ${B(escapeHtml(f.name))}`,
                    `       ├ ${tgEmoji("📁")} ${CODE(humanSize(f.size))} · ${tgEmoji("📅")} ${CODE(formatFileDate(f.mtime))}`,
                    `       └ 💡 Ready for multi-core cleaning or indexed search`,
                );
            });
        }
    } else if (tab === "proc") {
        lines.push(
            `${tgEmoji("💎")}  ${B("CLEANED OUTPUTS VAULT (SORTED BY SIZE)")}  ${tgEmoji("✨")}`,
            `Directory: ${CODE(escapeHtml(processedRoot))}`,
            `Total: ${B(num(processedFiles.length))} outputs (${humanSize(totalProcBytes)})`,
            RULE,
        );
        const procStart = page * pageSize;
        const procSlice = processedFiles.slice(procStart, procStart + pageSize);
        const totalPages = Math.ceil(processedFiles.length / pageSize) || 1;
        if (processedFiles.length === 0) {
            lines.push(`  ${I("No cleaned outputs yet — run a ULP search or clean a raw file.")}`);
        } else {
            lines.push(`📑  ${B(`Page ${page + 1} of ${totalPages}`)}:`);
            procSlice.forEach((f, i) => {
                const idx = procStart + i + 1;
                lines.push(
                    `  ${B(`[${idx}]`)} ${tgEmoji("⚡️")} ${B(escapeHtml(f.name))}`,
                    `       ├ ${tgEmoji("📁")} ${CODE(humanSize(f.size))} · ${tgEmoji("📅")} ${CODE(formatFileDate(f.mtime))}`,
                    `       └ 📥 Instant download or batch lookup`,
                );
            });
        }
    } else if (tab === "tools") {
        lines.push(
            `${tgEmoji("⚙️")}  ${B("STORAGE & PURGE MANAGER")}  ${tgEmoji("🧹")}`,
            RULE,
            `  ${tgEmoji("📥")}  Raw Dumps: ${B(num(rawFiles.length))} files (${humanSize(totalRawBytes)})`,
            `  ${tgEmoji("💎")}  Cleaned Vault: ${B(num(processedFiles.length))} files (${humanSize(totalProcBytes)})`,
            batchStats ? `  ${tgEmoji("📦")}  Active Batch: ${B(num(batchStats.size || 0))} credentials` : "",
            "",
            `⚠️  ${I("Use the actions below to selectively wipe raw uploads, delete generated outputs, or perform a total storage purge.")}`,
        );
    } else if (tab === "select") {
        const selectFiles = (info.selectFiles || info.files || [...rawFiles, ...processedFiles])
            .slice()
            .sort((a, b) => ((b.size || 0) - (a.size || 0)) || ((b.mtime && a.mtime) ? b.mtime.getTime() - a.mtime.getTime() : 0));
        const selected = info.selected instanceof Set ? info.selected : new Set(info.selected || []);
        const totalItems = selectFiles.length;
        lines.push(
            `${tgEmoji("🔀")}  ${B("MULTI-FILE SELECT & MERGE (SORTED BY SIZE)")}  ${tgEmoji("⚡️")}`,
            RULE,
            `Select clean files and/or raw dumps below to merge into ${B("one deduplicated file on disk")}.`,
            `💡 ${I("Clean output files will be stored in your server vault (never leaked or returned to Telegram).")}`,
            "",
            `📁  Selected: ${B(selected.size)} file(s) · Total: ${B(num(totalItems))} file(s) (${num(rawFiles.length)} raw, ${num(processedFiles.length)} clean)`,
            RULE,
        );
        if (totalItems === 0) {
            lines.push(`  ${I("No files in vault yet — forward files with /save to ingest first.")}`);
        } else {
            lines.push(`📑  ${B("Tap any file button below to toggle selection (☑️ / ⬜️):")}`);
            const selectPageSize = 5;
            const selStart = page * selectPageSize;
            const slice = selectFiles.slice(selStart, selStart + selectPageSize);
            slice.forEach((f, i) => {
                const actualIdx = selStart + i;
                const isChecked = selected.has(actualIdx);
                const mark = isChecked ? "☑️" : "⬜️";
                const isZip = f.name.toLowerCase().endsWith(".zip");
                const isClean = f.type === "proc" || f.isClean || (f.path && (f.path.includes(processedRoot) || f.path.startsWith(processedRoot)));
                const badge = isClean ? `[Clean]` : `[Raw]`;
                const icon = isClean ? tgEmoji("💎") : (isZip ? tgEmoji("📦") : tgEmoji("📥"));
                lines.push(`  ${mark} ${B(`[${actualIdx + 1}]`)} ${icon} ${B(escapeHtml(f.name))} ${CODE(badge)} (${CODE(humanSize(f.size))})`);
            });
            if (selected.size > 0) {
                lines.push("");
                lines.push(`✨  ${B(`${selected.size} file(s) selected.`)} Tap ${B("Merge Selected")} below to execute.`);
            }
        }
    } else {
        // "overview" (default) - Streamlined, clean, and elegant
        lines.push(
            `${tgEmoji("📊")}  ${B("Vault Summary:")}`,
            `  ${tgEmoji("📥")}  ${B("Raw Incoming:")} ${num(rawFiles.length)} file(s) (${humanSize(totalRawBytes)}) · ${CODE(escapeHtml(rawRoot))}`,
            `  ${tgEmoji("💎")}  ${B("Cleaned Vault:")} ${num(processedFiles.length)} file(s) (${humanSize(totalProcBytes)})`,
        );
        if (batchStats) {
            lines.push(`  ${tgEmoji("📦")}  ${B("Active Batch:")} ${num(batchStats.size || 0)} credentials`);
        }
        lines.push(RULE);

        lines.push(`${tgEmoji("📥")}  ${B("Top Raw Dumps (by Size):")}`);
        if (rawFiles.length === 0) {
            lines.push(`  ${I("No raw files on disk — send /save to ingest.")}`);
        } else {
            for (let i = 0; i < Math.min(rawFiles.length, 3); i++) {
                const f = rawFiles[i];
                const icon = f.name.toLowerCase().endsWith(".zip") ? tgEmoji("📦") : tgEmoji("📄");
                lines.push(
                    `  ${B(`[${i + 1}]`)} ${icon} ${B(escapeHtml(f.name))} · ${CODE(humanSize(f.size))}`,
                );
            }
            if (rawFiles.length > 3) {
                lines.push(`  ${I(`…+${rawFiles.length - 3} more in Raw Dumps tab`)}`);
            }
        }

        lines.push("");
        lines.push(`${tgEmoji("💎")}  ${B("Top Cleaned Outputs (by Size):")}`);
        if (processedFiles.length === 0) {
            lines.push(`  ${I("No processed outputs yet — tap a Clean button or use Multi-Select")}`);
        } else {
            for (let i = 0; i < Math.min(processedFiles.length, 3); i++) {
                const f = processedFiles[i];
                lines.push(
                    `  ${B(`[${i + 1}]`)} ${tgEmoji("⚡️")} ${B(escapeHtml(f.name))} · ${CODE(humanSize(f.size))}`,
                );
            }
            if (processedFiles.length > 3) {
                lines.push(`  ${I(`…+${processedFiles.length - 3} more in Cleaned tab`)}`);
            }
        }
    }

    lines.push(
        "",
        RULE,
        `👇 ${I("Tap any button below to Clean, Search, or Download files directly (or use Multi-Select & Merge):")}`,
    );
    return lines.filter(Boolean).join("\n");
}

/**
 * Short headline for each blocked/failed send reason.
 * @param {string} kind
 * @param {string} [transport] "userbot" when the MTProto transport sent it
 */
function ulpErrorHeader(kind, transport = "bot") {
    switch (kind) {
        case "bot_to_bot_disabled":
            return {
                emoji: "\uD83D\uDEA7",
                title: "BOT-TO-BOT IS OFF",
                detail: "Telegram refused the send \u2014 bots may message each other only when both sides switch it on.",
            };
        case "not_started":
            return {
                emoji: "\uD83D\uDC4B",
                title: "SEARCHER NEEDS A START",
                detail: "Open the searcher bot and press START once, then run the relay again.",
            };
        case "not_found":
            return {
                emoji: "\uD83E\uDDED",
                title: "SEARCHER NOT FOUND",
                detail: "Telegram couldn't resolve that username \u2014 check SEARCH_BOT_USERNAME.",
            };
        case "blocked":
            return {
                emoji: "\uD83D\uDEAB",
                title: "SEARCHER BLOCKED US",
                detail: "That bot blocked this one, so messages can't be delivered.",
            };
        case "flood_wait":
            return {
                emoji: "\u23F3",
                title: "SLOW DOWN",
                detail: "Telegram rate-limited the send \u2014 wait a few seconds, then try again.",
            };
        case "userbot_auth":
            return {
                emoji: "\uD83D\uDD11",
                title: "USERBOT SESSION DEAD",
                detail: "Your account session no longer logs in. Fix it with a fresh login, then restart the bot.",
            };
        case "userbot_not_ready":
            return {
                emoji: "\uD83E\uDD16",
                title: "USERBOT NOT READY",
                detail: "The account transport isn't connected yet — start it, then try again, or run the relay by hand below.",
            };
        default:
            return {
                emoji: "\uD83D\uDCA5",
                title: "SEND FAILED",
                detail: "Telegram rejected the message to the searcher bot.",
            };
    }
}

/**
 * Explains why the relay couldn't send, how to fix it, and how to run the
 * very same search by hand in the meantime.
 *
 * @param {{ kind: string, searcherBot: string, ownBot?: string|null, steps: Array<{ id: string, text: string }>, stepDelayMs: number, reason?: string|null, transport?: string }} info
 */
function renderUlpBlocked(info = {}) {
    info = info || {};
    const transport = info.transport === "userbot" ? "userbot" : "bot";
    const header = ulpErrorHeader(info.kind, transport);
    const own = info.ownBot ? mentionOf(info.ownBot) : "this bot";
    const steps = Array.isArray(info.steps) ? info.steps : [];
    const lines = [
        `${tgEmoji(header.emoji)}  ${B(header.title)}`,
        RULE,
        header.detail,
    ];
    if (info.reason) lines.push(`${I(escapeHtml(info.reason))}`);
    if (transport === "userbot") {
        lines.push(
            "",
            `${tgEmoji("🔧")}  ${B("Fix the account transport")}`,
            `  1️⃣ run ${B(CODE("npm run userbot:login"))} and follow the prompts`,
            `  2️⃣ copy the printed ${B("TELEGRAM_SESSION")} into your env`,
            `  3️⃣ restart the bot, then tap ${tgEmoji("🔄")} Run again`,
        );
        if (info.kind !== "userbot_auth" && info.kind !== "userbot_not_ready") {
            lines.push(
                "",
                `${tgEmoji("👤")}  ${B("Remember")}: results only land here once ${B(own)} can use your login`,
            );
        }
    } else {
        lines.push(
            "",
            `${tgEmoji("🔧")}  ${B("Unlock bot-to-bot messaging")}`,
            `  1️⃣ ${B("@BotFather")} → ${B("/mybots")} → ${B(own)}`,
            `  2️⃣ ${B("Bot Settings")} → ${B("Bot-to-Bot Communication")} → ${B("Enable")}`,
            `  3️⃣ the owner of ${B(mentionOf(info.searcherBot))} must enable it too`,
            `  4️⃣ tap ${tgEmoji("🔄")} Run again — Telegram allows bot ↔ bot chats only when both agree`,
            "",
            `${tgEmoji("🤖")}  ${B("Better bypass")}: log in with your own account (${B(CODE("SEARCH_TRANSPORT=userbot"))}),`,
            `  so the relay talks to ${B(mentionOf(info.searcherBot))} as a user — no owner needed.`,
        );
    }
    lines.push(
        "",
        `${tgEmoji("🛠️")}  ${B("By hand, right now")}`,
        ...steps.map((step, i) => `  ${i + 1}️⃣ ${CODE(escapeHtml((step && step.text) || ""))}`),
        `  ↳ send these to ${B(mentionOf(info.searcherBot || "DumpNews14Bot"))} yourself, ${B(pacingLabel(info.stepDelayMs || 14000))} apart`,
        `  ↳ forward its answers here — files get cleaned ${tgEmoji("🧼")}`,
    );
    return lines.join("\n");
}

/**
 * Card posted on a result that the userbot shared into this chat (already
 * there as a forward or a marked copy — this just adds the tools).
 * Applies to documents (with a clean button) and to everything else.
 * @param {{ searcherBot: string, query: string, scope: string, count: number, hasDocument: boolean }} info
 */
function renderUlpSharedResult(info = {}) {
    info = info || {};
    return [
        `${tgEmoji("📥")}  ${B("RESULT IN")} \u00B7 ${B(mentionOf(info.searcherBot || "DumpNews14Bot"))}  ${tgEmoji("💎")}`,
        RULE,
        `${tgEmoji("🎯")}  ${CODE(escapeHtml(info.query || "unknown"))} \u00B7 ${CODE(escapeHtml(`hist:full:${info.scope || "day"}`))}`,
        `${tgEmoji("📦")}  ${num(info.count || 0)} message${(info.count || 0) === 1 ? "" : "s"} relayed in this run ${tgEmoji("⬇️")}`,
        "",
        info.hasDocument
            ? `${I("⚡ Auto-processing dump file into batch now…")}`
            : `${I(`📄 Text dump relayed \u2014 send files for deep cleaning`)}`,
    ].join("\n");
}

function humanSize(bytes) {
    if (typeof bytes === "symbol") return "0 B";
    const b = Number(bytes || 0);
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
    return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Render bot native emoji features and visual engine.
 * @param {{ packs?: Array<{ title: string, shortName: string, id: string, count: number, sample: string[] }>, totalEmojis?: number, error?: string }} [data]
 */
function renderEmojiPacks(data = {}) {
    const packs = (data && data.packs) || [];
    const totalEmojis = (data && data.totalEmojis) || 0;
    const customCount = Object.keys(getCustomEmojis()).length;
    const lines = [
        `${tgEmoji("💎")}  ${B("BOT ANIMATED EMOJI DASHBOARD")}  ${tgEmoji("✨")}`,
        RULE,
        `🎨  ${B("Custom Animated Account Emojis & Visual Palette")}`,
        "",
        `  ${tgEmoji("🚀")}  ${B("ULP Search Relay:")} Automated day-by-day searches & URL-stripped outputs`,
        `  ${tgEmoji("🧼")}  ${B("Credential Sanitizer:")} Email, User, Phone & CC normalizer`,
        `  ${tgEmoji("📦")}  ${B("Storage & Vault:")} Combined files, disk raw dumps & bulk wiping`,
        `  ${tgEmoji("📊")}  ${B("Live Metrics:")} Real-time capacity gauges & duplicate counters`,
        `  ${tgEmoji("🌐")}  ${B("Site Recon:")} Automated domain detection & per-site stats`,
        `  ${tgEmoji("🔎")}  ${B("Deep Search:")} Rapid indexed keyword lookup in batch`,
        `  ${tgEmoji("⚡️")}  ${B("Multi-Core Turbo:")} Parallel CPU processing across all cores`,
        `  ${tgEmoji("🛡️")}  ${B("Anti-Flood Shield:")} Paced message queues & safety limits`,
    ];

    if (customCount > 0) {
        lines.push(
            "",
            RULE,
            `✨  ${B("Active Custom Animated Icons:")} ${B(num(customCount))} mapped to bot UI/UX`,
        );
    }

    if (packs.length > 0) {
        lines.push(
            "",
            RULE,
            `📂  ${B("Installed Account Packs:")} ${packs.length}  ·  🎨  ${B("Total Emojis:")} ${num(totalEmojis)}`,
        );
        packs.forEach((p, idx) => {
            const sampleStr = (p.sample && p.sample.length > 0) ? `  ${p.sample.slice(0, 6).join(" ")}` : "";
            lines.push(
                `${idx + 1}. ${B(escapeHtml(p.title))}`,
                `   ↳ ${CODE(escapeHtml(p.shortName))} · ${num(p.count)} emojis${sampleStr}`,
            );
        });
    }

    lines.push(
        "",
        RULE,
        I("Custom animated emojis on your account are automatically synchronized into the UI! ⚡️"),
    );

    return lines.join("\n");
}

/**
 * Keyboard for emojis dashboard with 1-tap account sync button.
 */
function emojisKeyboard() {
    return createInlineKeyboard([
        [
            Markup.button.callback("🔄 Sync Account Emojis", "emojis:sync"),
        ],
        [
            Markup.button.callback("🔙 Main Menu", "help"),
        ],
    ]);
}

/**
 * Render batch save progress.
 */
function renderBatchSaveProgress(params = {}) {
    params = params || {};
    const current = Number(params.current) || 0;
    const total = Number(params.total) || 0;
    const currentName = params.currentName || "";
    const linesAdded = Number(params.linesAdded) || 0;
    const totalLines = Number(params.totalLines) || 0;
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    return [
        `${tgEmoji("📦")}  ${B("BATCH SAVE & PROCESS")}  ${tgEmoji("⏳")}`,
        RULE,
        `  • ${tgEmoji("📊")} ${B("Progress:")}            ${bar(current, total, 10)} ${pct}% (${current}/${total} files)`,
        `  • ${tgEmoji("📄")} ${B("Current:")}             ${CODE(escapeHtml(currentName))}`,
        `  • ${tgEmoji("✨")} ${B("Lines added so far:")}  ${num(totalLines)} (+${num(linesAdded)})`,
        RULE,
        I(`Streaming via MTProto bypass directly into /var/data and cleaning… ${tgEmoji("🧼")}`),
    ].join("\n");
}

/**
 * Render batch save completion.
 */
function renderBatchSaveComplete(params = {}) {
    params = params || {};
    const totalFiles = Number(params.totalFiles) || 0;
    const totalLines = Number(params.totalLines) || 0;
    const files = Array.isArray(params.files) ? params.files : [];
    const durationMs = Number(params.durationMs) || 0;
    const s = (durationMs / 1000).toFixed(1);
    const out = [
        `${tgEmoji("✅")}  ${B("BATCH SAVE COMPLETE")}  ${tgEmoji("💎")}`,
        RULE,
        `  • ${tgEmoji("📦")} ${B("Files Processed:")}     ${num(totalFiles)} in ${s}s`,
        `  • ${tgEmoji("🧼")} ${B("Total Credentials in Batch:")} ${num(totalLines)}`,
        RULE,
        `${B("Processed Documents:")}`,
    ];
    files.slice(0, 8).forEach((f, i) => {
        const fname = (f && f.name) || "document";
        const flines = (f && f.lines) || 0;
        const fsize = (f && f.size) || 0;
        out.push(` ${i + 1}. ${CODE(escapeHtml(fname))} ↳ +${num(flines)} lines (${humanSize(fsize)})`);
    });
    if (files.length > 8) {
        out.push(` …and ${files.length - 8} more files.`);
    }
    out.push(
        "",
        RULE,
        I(`Tap ${tgEmoji("📦")} Get Combined File below to download all deduped credentials! ${tgEmoji("⬇️")}`),
    );
    return out.join("\n");
}

/**
 * Keyboard for /sites list with quick remove buttons.
 * @param {Array<{ site: string, count: number }>} siteCounts
 * @param {number} [page]
 */
function sitesKeyboard(siteCounts = [], page = 0) {
    const rows = [];
    const pageSize = 6;
    const list = Array.isArray(siteCounts) ? siteCounts : [];
    const totalPages = Math.ceil(list.length / pageSize) || 1;
    const pageNum = typeof page === "number" ? page : (typeof page === "symbol" ? 0 : Number(page) || 0);
    const curPage = Math.max(0, Math.min(pageNum, totalPages - 1));
    const start = curPage * pageSize;
    const pageItems = list.slice(start, start + pageSize);

    for (const item of pageItems) {
        if (!item || typeof item !== "object") continue;
        const s = typeof item.site === "string" ? item.site : (typeof item.site === "symbol" ? "" : String(item.site || ""));
        const sName = s.length > 18 ? s.slice(0, 16) + "…" : s;
        rows.push([
            Markup.button.callback(`🌐 ${sName} (${compact(item.count)})`, registerCallbackPayload("site:view:", s)),
            Markup.button.callback(`🗑 Del ${sName}`, registerCallbackPayload("site:del:ask:", s)),
        ]);
    }

    if (totalPages > 1) {
        const navRow = [];
        if (curPage > 0) {
            navRow.push(Markup.button.callback("◀️ Prev", `site:page:${curPage - 1}`));
        }
        navRow.push(Markup.button.callback(`📄 ${curPage + 1}/${totalPages}`, "sites"));
        if (curPage + 1 < totalPages) {
            navRow.push(Markup.button.callback("Next ▶️", `site:page:${curPage + 1}`));
        }
        rows.push(navRow);
    }

    if (list.length > 0) {
        rows.push([
            Markup.button.callback("🗑 Remove Domain (Type Name)", "site:del:prompt"),
        ]);
    }

    rows.push([
        Markup.button.callback("📦 Get Combined File", "combine"),
        Markup.button.callback("📊 System Stats", "stats"),
    ]);
    rows.push([
        Markup.button.callback("🔙 Main Menu", "help"),
    ]);

    return createInlineKeyboard(rows);
}

/**
 * Confirmation dialog keyboard for removing a specific domain.
 * @param {string} domain
 */
function confirmDomainDeleteKeyboard(domain) {
    const dom = typeof domain === "symbol" ? "" : String(domain || "");
    const shortDom = dom.length > 25 ? dom.slice(0, 22) + "…" : dom;
    return createInlineKeyboard([
        [
            Markup.button.callback(`⚠️ Yes, remove ${shortDom}`, registerCallbackPayload("site:del:confirm:", dom)),
            Markup.button.callback("❌ Cancel", "sites"),
        ],
    ]);
}

module.exports = {
    renderHelp,
    renderStats,
    renderSites,
    renderFileReport,
    renderPing,
    renderPreview,
    renderSearch,
    searchResultKeyboard,
    renderEmojiPacks,
    renderBatchSaveProgress,
    renderBatchSaveComplete,
    renderUlpHint,
    renderUlpStart,
    renderUlpProgress,
    renderUlpResults,
    renderUlpDone,
    renderUlpEmpty,
    renderUlpStopped,
    renderUlpBlocked,
    renderUlpSharedResult,
    renderServerFiles,
    renderSaveGuide,
    renderSaveListeningPrompt,
    saveListeningKeyboard,
    renderSaveListeningComplete,
    saveListeningCompleteKeyboard,
    renderMergeProgress,
    renderMergeComplete,
    mergeCompleteKeyboard,
    serverFilesKeyboard,
    confirmFileDeleteKeyboard,
    formatFileDate,
    ulpMenuKeyboard,
    ulpEditDomainsKeyboard,
    ulpPromptCancelKeyboard,
    ulpPostSearchKeyboard,
    renderUlpMenuText,
    saveGuideKeyboard,
    searchPromptKeyboard,
    escapeHtml,
    mainKeyboard,
    confirmClearKeyboard,
    afterCombineKeyboard,
    forwardedLogsKeyboard,
    renderForwardedLogsCombined,
    forwardedZipKeyboard,
    renderForwardedZipCombined,
    emptyBatchKeyboard,
    ulpKeyboard,
    ulpResultKeyboard,
    B,
    I,
    CODE,
    RULE,
    bar,
    num,
    compact,
    siteEmoji,
    humanSize,
    tgEmoji,
    registerCustomEmojis,
    getCustomEmojis,
    clearCustomEmojis,
    emojisKeyboard,
    sitesKeyboard,
    confirmDomainDeleteKeyboard,
    createInlineKeyboard,
    attachButtonEmoji,
    loadDefaultCustomEmojis,
    resetDefaultCustomEmojis,
    DEFAULT_CUSTOM_ANIMATED_EMOJIS,
    EMOJI_KEY_MAP,
    registerCallbackPayload,
    resolveCallbackPayload,
    ensureAnimatedEmojis,
    renderLocalSearch,
    localSearchResultKeyboard,
    renderLocalSearchHub,
    localSearchHubKeyboard,
    localFileSearchKeyboard,
};








