"use strict";

const { Markup } = require("telegraf");

// Real HTML tags, built from char codes so no editor auto-formatter can
// mangle them. These must be actual "<" / ">" for Telegram to render bold,
// italic and monospace — escaped entities would display as literal "<b>".
const LT = String.fromCharCode(60); // <
const GT = String.fromCharCode(62); // >
const B = (s) => `${LT}b${GT}${s}${LT}/b${GT}`;
const I = (s) => `${LT}i${GT}${s}${LT}/i${GT}`;
const U = (s) => `${LT}u${GT}${s}${LT}/u${GT}`;
const CODE = (s) => `${LT}code${GT}${s}${LT}/code${GT}`;

// Escape entities (for escaping user text), built from the ampersand char code.
const AMP = String.fromCharCode(38); // &

/**
 * Escape user-controlled text for Telegram HTML parse mode.
 * @param {string} s
 */
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, `${AMP}amp;`)
        .replace(/</g, `${AMP}lt;`)
        .replace(/>/g, `${AMP}gt;`);
}

/**
 * @param {number|undefined} n
 */
function num(n) {
    return Number(n || 0).toLocaleString("en-US");
}

/**
 * Compact human number: 999 -> "999", 1234 -> "1.2K", 2100000 -> "2.1M".
 * @param {number|undefined} n
 */
function compact(n) {
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
 * Decorative rule line.
 */
const RULE = "\u2501".repeat(22); // ━━━━━━━━━━━━━━━━━━━━━━

/**
 * Reusable inline keyboards.
 */
function mainKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback("\uD83D\uDCE6 Get combined file", "combine"),
            Markup.button.callback("\uD83D\uDCCA Stats", "stats"),
        ],
        [
            Markup.button.callback("\uD83D\uDCE1 Sites", "sites"),
            Markup.button.callback("\uD83D\uDC41 Preview", "preview"),
        ],
        [
            Markup.button.callback("\uD83E\uDDF9 Clear batch", "clear:ask"),
            Markup.button.callback("\u2753 Help", "help"),
        ],
    ]);
}

/**
 * Keyboard shown under the combined file.
 */
function afterCombineKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback("\uD83D\uDCE5 Send again", "combine"),
            Markup.button.callback("\uD83D\uDCCA Stats", "stats"),
        ],
        [Markup.button.callback("\uD83E\uDDF9 Clear batch", "clear:ask")],
    ]);
}

/**
 * Keyboard when the batch is empty.
 */
function emptyBatchKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback("\u2753 How do I use this?", "help")],
        [Markup.button.callback("\uD83D\uDCCA Stats", "stats")],
    ]);
}

/**
 * Two-step clear confirmation.
 */
function confirmClearKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback("\u26A0\uFE0F Yes, wipe it", "clear:yes"),
            Markup.button.callback("\u274C Keep it", "clear:no"),
        ],
    ]);
}

/**
 * The /start and /help message — full branded welcome.
 * @param {string} [botUsername]
 * @param {{ size: number, files: number }|null} [batch] existing batch summary
 */
function renderHelp(botUsername, batch = null) {
    const mention = botUsername ? `@${escapeHtml(botUsername)}` : "this bot";
    const lines = [
        `\uD83E\uDDFC  ${B("COMBO CLEANER")}`,
        `\u2728  ${I("Drop messy dumps in. Get one clean file out.")}`,
        RULE,
        "",
        `\uD83C\uDFAF  ${B("Why you'll love it")}`,
        `  \u26A1 \uFE0FInstant cleaning \u2014 no waiting around`,
        `  \uD83E\uDDF9 Dedupes everything, automatically`,
        `  \uD83C\uDF10 Smarts out the ${B("site")} from the dump`,
        `  \uD83D\uDCE6 One tidy file, named for you`,
        "",
        `\uD83D\uDCE5  ${B("How it works")}`,
        `  1\uFE0F\u20E3 Send a ${B(".zip")} or ${B(".txt")} (forwarded is fine!)`,
        `  2\uFE0F\u20E3 I keep emails, cards & numbers \u2014 drop URLs \u274C`,
        `  3\uFE0F\u20E3 Everything piles into your batch, deduped`,
        `  4\uFE0F\u20E3 Tap ${B("\uD83D\uDCE6 Get combined file")} when ready`,
        "",
        `\u26A1  ${B("Commands")}`,
        `  /combine \u2014 \uD83D\uDCE6 download the combined file`,
        `  /stats \u2014 \uD83D\uDCCA batch dashboard`,
        `  /sites \u2014 \uD83D\uDCE1 per-site breakdown`,
        `  /preview \u2014 \uD83D\uDC41 peek at sample lines`,
        `  /clear \u2014 \uD83E\uDDF9 fresh batch`,
        `  /ping \u2014 \uD83C\uDFD3 latency & uptime`,
        `  /help \u2014 \u2753 this message`,
        "",
    ];

    if (batch && batch.size > 0) {
        lines.push(
            `\uD83D\uDCE3  ${B("Welcome back!")} You have ${B(num(batch.size))}` +
                ` unique line${batch.size === 1 ? "" : "s"} waiting \uD83C\uDF81`,
            "",
        );
    }

    lines.push(RULE, `\uD83D\uDD17 ${mention}`);
    return lines.join("\n");
}

/**
 * Welcome-back line returned to /start when a batch exists.
 * @param {{ size: number, files: number }|null} batch
 */
function renderWelcomeBack(batch) {
    if (!batch || batch.size === 0) return null;
    return (
        `\uD83D\uDCE3 ${B("Welcome back!")} Your batch is holding ` +
        `${B(num(batch.size))} unique line${batch.size === 1 ? "" : "s"} ` +
        `from ${num(batch.files)} file${batch.files === 1 ? "" : "s"} \uD83C\uDF81`
    );
}

/**
 * /stats reply — dashboard style with a capacity gauge.
 * @param {{ size: number, files: number, totalKept: number, sites?: number }|null} stats
 */
function renderStats(stats) {
    if (!stats || stats.size === 0) {
        return [
            `\uD83D\uDCCA  ${B("BATCH DASHBOARD")}`,
            RULE,
            "\uD83D\uDCED Empty batch \u2014 nothing stored yet.",
            "",
            `${I("Send me a .zip or .txt and watch it fill up \uD83C\uDF31")}`,
        ].join("\n");
    }
    const cap = 2_000_000; // store.MAX_LINES_PER_CHAT, mirrored for the gauge
    const pct = Math.min(100, Math.round((stats.size / cap) * 100));
    return [
        `\uD83D\uDCCA  ${B("BATCH DASHBOARD")}`,
        RULE,
        `\uD83D\uDD10  ${B("Unique credentials")}   ${B(compact(stats.size))}`,
        `\uD83D\uDCC2  Files processed         ${num(stats.files)}`,
        `\uD83E\uDDFE  Lines accepted          ${num(stats.totalKept)}`,
        stats.sites ? `\uD83C\uDF10  Sites detected          ${B(num(stats.sites))}` : null,
        "",
        `\uD83D\uDCE6  Capacity  ${bar(stats.size, cap, 14)}  ${pct}%`,
        RULE,
        `${I("Tap \uD83D\uDCE6 below to grab the combined file \u2B07\uFE0F")}`,
    ]
        .filter((l) => l !== null)
        .join("\n");
}

/**
 * /sites reply — per-site breakdown with bars.
 * @param {Array<{ site: string, count: number }>|null} siteCounts
 */
function renderSites(siteCounts) {
    if (!siteCounts || siteCounts.length === 0) {
        return [
            `\uD83D\uDCE1  ${B("SITES")}`,
            RULE,
            "\uD83C\uDFED No sites yet \u2014 send a file first \uD83D\uDCE4",
        ].join("\n");
    }
    const max = Math.max(...siteCounts.map((s) => s.count));
    const lines = [
        `\uD83D\uDCE1  ${B("SITES")} \u00B7 ${B(num(siteCounts.length))} detected`,
        RULE,
    ];
    for (const { site, count } of siteCounts) {
        const emoji = siteEmoji(site);
        lines.push(
            `${emoji} ${B(escapeHtml(site))}`,
            `   ${bar(count, max, 14)} ${B(compact(count))}`,
        );
    }
    lines.push("", RULE, `${I("Batch total \u00B7 tap \uD83D\uDCE6 to download \u2B07\uFE0F")}`);
    return lines.join("\n");
}

/**
 * /ping reply.
 * @param {{ latencyMs: number, uptimeSec: number }} info
 */
function renderPing(info) {
    const up = info.uptimeSec;
    const h = Math.floor(up / 3600);
    const m = Math.floor((up % 3600) / 60);
    const s = Math.floor(up % 60);
    const uptime = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
    const speed =
        info.latencyMs < 100 ? "\uD83D\uDE80 Blazing" : info.latencyMs < 300 ? "\u2705 Good" : "\uD83D\uDC27 Slow-ish";
    return [
        `\uD83C\uDFD3  ${B("PONG")}`,
        RULE,
        `\uD83D\uDCE1  Telegram latency   ${B(`${info.latencyMs} ms`)}  ${speed}`,
        `\u23F1\uFE0F  Uptime             ${B(uptime)}`,
        `\uD83D\uDFE2  Status             ${B("Online & polling")}`,
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
function renderFileReport(name, stats, added, chatStats, site) {
    const ratio = stats.total > 0 ? Math.round((stats.kept / stats.total) * 100) : 0;
    const siteEmojiOut = site ? siteEmoji(site) : "\uD83C\uDF10";
    const lines = [
        `\u2705  ${B("CLEAN REPORT")}`,
        RULE,
        `\uD83D\uDCC4  ${escapeHtml(name)}`,
    ];
    if (site) {
        lines.push(`${siteEmojiOut}  Site detected       ${B(escapeHtml(site))}`);
    }
    lines.push(
        RULE,
        `\uD83D\uDCE6  Files read          ${num(stats.files)}`,
        `\uD83E\uDDFE  Lines seen          ${num(stats.total)}`,
        `\u2705  Kept                ${B(num(stats.kept))}  ${bar(stats.kept, stats.total)} ${ratio}%`,
        `\uD83D\uDDD1\uFE0F  Dropped             ${num(stats.dropped)}`,
        `\u267B\uFE0F  Duplicates          ${num(stats.duplicates)}`,
        RULE,
        `\u2795  Added to batch      ${B(num(added.added))}`,
        `\u21A9\uFE0F  Already had         ${num(added.duplicates)}`,
    );

    if (chatStats) {
        lines.push(
            "",
            `\uD83D\uDCE6  ${B("Batch total")} \u00B7 ${B(compact(chatStats.size))} unique from ${num(chatStats.files)} file(s)`,
        );
    }

    if (stats.truncated) {
        lines.push(
            "",
            `\u26A0\uFE0F  ${B("Truncated")} \u2014 huge archive; stopped early to stay safe.`,
        );
    }
    if (stats.skippedLarge) {
        lines.push(
            `\u26A0\uFE0F  Skipped ${num(stats.skippedLarge)} oversized entr${stats.skippedLarge === 1 ? "y" : "ies"}.`,
        );
    }
    if (added.capped) {
        lines.push(
            "",
            `\u26A0\uFE0F  ${B("Storage cap reached")} \u2014 grab the file, then \uD83E\uDDF9 /clear.`,
        );
    }

    lines.push(
        "",
        `\uD83C\uDF81 Added to your batch \u2014 tap \uD83D\uDCE6 below to download it all.`,
    );
    return lines.join("\n");
}

/**
 * /preview reply — a small sample of stored lines.
 * @param {string[]} sample
 * @param {number} total
 */
function renderPreview(sample, total) {
    if (total === 0) {
        return [
            `\uD83D\uDC41  ${B("PREVIEW")}`,
            RULE,
            "\uD83D\uDCED Batch is empty \u2014 nothing to preview.",
            "",
            `${I("Send a .zip or .txt first \uD83D\uDCE4")}`,
        ].join("\n");
    }
    return [
        `\uD83D\uDC41  ${B("PREVIEW")} \u00B7 first ${num(sample.length)} of ${B(compact(total))}`,
        RULE,
        ...sample.map((line) => `${CODE(escapeHtml(line))}`),
        "",
        `${I("Credentials are sensitive \u2014 delete this message when done \uD83D\uDDD1\uFE0F")}`,
    ].join("\n");
}

module.exports = {
    renderHelp,
    renderStats,
    renderSites,
    renderFileReport,
    renderPing,
    renderPreview,
    renderWelcomeBack,
    escapeHtml,
    mainKeyboard,
    confirmClearKeyboard,
    afterCombineKeyboard,
    emptyBatchKeyboard,
    B,
    I,
    U,
    CODE,
    bar,
    num,
    compact,
    siteEmoji,
};








