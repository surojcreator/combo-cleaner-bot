"use strict";

const { Markup } = require("telegraf");

// Real HTML tags, built from char codes so no editor auto-formatter can
// mangle them. These must be actual "<" / ">" for Telegram to render bold,
// italic and monospace — escaped entities would display as literal "<b>".
const LT = String.fromCharCode(60); // <
const GT = String.fromCharCode(62); // >
const B = (s) => `${LT}b${GT}${s}${LT}/b${GT}`;
const I = (s) => `${LT}i${GT}${s}${LT}/i${GT}`;
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
            Markup.button.callback("🚀 Run ULP Search", "ulp:menu"),
            Markup.button.callback("📂 Server Vault", "server_files"),
        ],
        [
            Markup.button.callback("📦 Get Combined File", "combine"),
            Markup.button.callback("📊 System Stats", "stats"),
        ],
        [
            Markup.button.callback("🔎 Search Batch", "batch:search:prompt"),
            Markup.button.callback("👁 Line Preview", "preview"),
        ],
        [
            Markup.button.callback("🌐 Detected Sites", "sites"),
            Markup.button.callback("🧹 Wipe Batch", "clear:ask"),
        ],
        [
            Markup.button.callback("⚡️ Fast /save Guide", "help:save"),
            Markup.button.callback("💎 Bot Features", "emojis:view"),
        ],
        [
            Markup.button.callback("🔄 Refresh Menu", "help"),
        ],
    ]);
}

/**
 * Keyboard shown under the combined file.
 */
function afterCombineKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback("📦 Send Again", "combine"),
            Markup.button.callback("📊 Stats", "stats"),
        ],
        [
            Markup.button.callback("📂 Server Vault", "server_files"),
            Markup.button.callback("🧹 Wipe Batch", "clear:ask"),
        ],
        [
            Markup.button.callback("🔙 Main Menu", "help"),
        ],
    ]);
}

/**
 * Keyboard shown under the server files vault.
 * Supports file cleaning, downloading, searching, individual deletion, and bulk wipe.
 * @param {Array} [rawFiles]
 * @param {Array} [processedFiles]
 * @param {{ page?: number, pageSize?: number }} [options]
 */
function serverFilesKeyboard(rawFiles = [], processedFiles = [], options = {}) {
    const rows = [];
    const pageSize = options.pageSize || 3;
    const page = options.page || 0;

    const rawStart = page * pageSize;
    const rawSlice = Array.isArray(rawFiles) ? rawFiles.slice(rawStart, rawStart + pageSize) : [];
    const totalRawPages = Math.ceil((rawFiles ? rawFiles.length : 0) / pageSize) || 1;

    const procStart = page * pageSize;
    const procSlice = Array.isArray(processedFiles) ? processedFiles.slice(procStart, procStart + pageSize) : [];
    const totalProcPages = Math.ceil((processedFiles ? processedFiles.length : 0) / pageSize) || 1;
    const maxPages = Math.max(totalRawPages, totalProcPages);

    // 1. Raw Files Actions (Clean, Search, Delete)
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

    // 2. Processed Outputs Actions (Download, Search, Delete)
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

    // 3. Pagination Controls (if more than pageSize items exist)
    if (maxPages > 1) {
        const navRow = [];
        if (page > 0) {
            navRow.push(Markup.button.callback("◀️ Prev Page", `files:page:${page - 1}`));
        }
        navRow.push(Markup.button.callback(`📄 ${page + 1}/${maxPages}`, "files:refresh"));
        if (page + 1 < maxPages) {
            navRow.push(Markup.button.callback("Next Page ▶️", `files:page:${page + 1}`));
        }
        rows.push(navRow);
    }

    // 4. Batch & Bulk Operations
    const bulkRow = [];
    if (Array.isArray(rawFiles) && rawFiles.length > 1) {
        bulkRow.push(Markup.button.callback(`⚡️ Clean All Raw (${rawFiles.length})`, "files:clean:all"));
    }
    if (Array.isArray(rawFiles) && rawFiles.length > 0) {
        bulkRow.push(Markup.button.callback(`🧹 Wipe All Raw`, "files:wipe:raw:ask"));
    }
    if (Array.isArray(processedFiles) && processedFiles.length > 0) {
        bulkRow.push(Markup.button.callback(`🧹 Wipe All Outputs`, "files:wipe:proc:ask"));
    }
    if (bulkRow.length > 0) {
        rows.push(bulkRow);
    }

    // 5. Global Actions
    rows.push([
        Markup.button.callback("🔄 Refresh Vault", "files:refresh"),
        Markup.button.callback("📊 System Stats", "stats"),
        Markup.button.callback("💥 Purge All", "files:wipe:all:ask"),
    ]);
    rows.push([
        Markup.button.callback("📦 Get Combined File", "combine"),
        Markup.button.callback("🔙 Main Menu", "help"),
    ]);
    return Markup.inlineKeyboard(rows);
}

/**
 * Confirmation dialog keyboard for deleting individual files or bulk storage.
 */
function confirmFileDeleteKeyboard(actionType, targetId, fileName = "") {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback("⚠️ Yes, permanently delete", `file:del:confirm:${actionType}:${targetId}`),
            Markup.button.callback("❌ Cancel", "server_files"),
        ],
    ]);
}

/**
 * Keyboard for ULP preset searches.
 */
function ulpMenuKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback("🎬 Netflix", "ulp:quick:netflix.com"),
            Markup.button.callback("🎵 Spotify", "ulp:quick:spotify.com"),
        ],
        [
            Markup.button.callback("📧 Gmail", "ulp:quick:gmail.com"),
            Markup.button.callback("🎮 Steam", "ulp:quick:store.steampowered.com"),
        ],
        [
            Markup.button.callback("🛍 Amazon", "ulp:quick:amazon.com"),
            Markup.button.callback("🕹 Roblox", "ulp:quick:roblox.com"),
        ],
        [
            Markup.button.callback("💳 PayPal", "ulp:quick:paypal.com"),
            Markup.button.callback("🪙 Crypto", "ulp:quick:binance.com"),
        ],
        [
            Markup.button.callback("🔙 Main Menu", "help"),
        ],
    ]);
}

/**
 * Keyboard for /save instructions.
 */
function saveGuideKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback("📂 Open Server Vault", "server_files"),
            Markup.button.callback("🔙 Main Menu", "help"),
        ],
    ]);
}

/**
 * Keyboard for quick batch search.
 */
function searchPromptKeyboard() {
    return Markup.inlineKeyboard([
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
 * Keyboard when the batch is empty.
 */
function emptyBatchKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback("🚀 Run ULP Search", "ulp:menu")],
        [Markup.button.callback("📂 Server Vault", "server_files"), Markup.button.callback("📊 Stats", "stats")],
        [Markup.button.callback("❓ Help Manual", "help")],
    ]);
}

/**
 * Two-step clear confirmation.
 */
function confirmClearKeyboard() {
    return Markup.inlineKeyboard([
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
    const cpus = require("os").cpus().length || 8;

    return [
        `🔥  ${B("COMBO CLEANER ULTIMATE")}  🔥`,
        `⚡️  ${I("Multi-Core Turbo Cleaning & ULP Relay Engine")}  ⚡️`,
        RULE,
        `💎  ${B("SYSTEM ENGINE STATUS")}`,
        `  ⚡️ ${B("Multi-Core Workers:")} ${CODE(`${cpus}x Parallel CPU Cores Active`)}`,
        `  📦 ${B("Active Batch Vault:")} ${B(num(batchSize))} unique lines (${num(batchFiles)} files)`,
        `  🤖 ${B("Connected ULP Searcher:")} ${CODE(`@${escapeHtml(searcherBot || "DumpNews14Bot")}`)}`,
        `  🚀 ${B("Engine Mode:")} ${B("TURBO 100% CPU SATURATION")}`,
        RULE,
        "",
        `✨  ${B("INTERACTIVE ACTION DASHBOARD")}`,
        `👇 ${I("Tap any button below to execute instantly without typing commands:")}`,
        "",
        `🛡️ ${mention} · Ultimate Pro Edition`,
    ].join("\n");
}

/**
 * /stats reply — dashboard style with a capacity gauge.
 * @param {{ size: number, files: number, totalKept: number, sites?: number }|null} stats
 */
function renderStats(stats) {
    if (!stats || stats.size === 0) {
        return [
            `📊  ${B("BATCH METRICS DASHBOARD")}  ⚡️`,
            RULE,
            "📭 Empty batch \u2014 nothing stored yet.",
            "",
            `${I("Send me a .zip or .txt dump to get started 🚀")}`,
        ].join("\n");
    }
    const cap = 2_000_000;
    const pct = Math.min(100, Math.round((stats.size / cap) * 100));
    return [
        `📊  ${B("BATCH METRICS DASHBOARD")}  ⚡️`,
        RULE,
        `💎  ${B("Unique Credentials")}   ${B(compact(stats.size))}`,
        `📂  Files Processed         ${num(stats.files)}`,
        `✂️  Lines Accepted          ${num(stats.totalKept)}`,
        stats.sites ? `🌐  Sites Detected          ${B(num(stats.sites))}` : null,
        "",
        `📦  Capacity  ${bar(stats.size, cap, 14)}  ${pct}%`,
        RULE,
        `${I("Tap 📦 Get combined file below to download ⬇️")}`,
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
            `📡  ${B("SITE RECONNAISSANCE")}  ⚡️`,
            RULE,
            "🌐 No sites detected yet \u2014 send a dump file first 📤",
        ].join("\n");
    }
    const max = Math.max(...siteCounts.map((s) => s.count));
    const lines = [
        `📡  ${B("SITE RECONNAISSANCE")} \u00B7 ${B(num(siteCounts.length))} detected 🌐`,
        RULE,
    ];
    for (const { site, count } of siteCounts) {
        const emoji = siteEmoji(site);
        lines.push(
            `${emoji} ${B(escapeHtml(site))}`,
            `   ${bar(count, max, 14)} ${B(compact(count))}`,
        );
    }
    lines.push("", RULE, `${I("Tap 📦 Get combined file below to download ⬇️")}`);
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
        info.latencyMs < 100 ? "🚀 Blazing Fast" : info.latencyMs < 300 ? "⚡ Optimal" : "⏳ Normal";
    return [
        `🏓  ${B("SYSTEM STATUS: PONG")}  ⚡️`,
        RULE,
        `📡  Telegram Latency   ${B(`${info.latencyMs} ms`)} \u00B7 ${speed}`,
        `⏱  Uptime             ${B(uptime)}`,
        `🟢  Core Engine        ${B("Online & Polling")}`,
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
    const siteEmojiOut = site ? siteEmoji(site) : "🌐";
    const lines = [
        `✨  ${B("CLEAN REPORT")}  ⚡️`,
        RULE,
        `📄  ${escapeHtml(name)}`,
    ];
    if (site) {
        lines.push(`${siteEmojiOut}  Site Detected       ${B(escapeHtml(site))}`);
    }
    lines.push(
        RULE,
        `📂  Files Read          ${num(stats.files)}`,
        `📑  Lines Seen          ${num(stats.total)}`,
        `💎  Kept                ${B(num(stats.kept))}  ${bar(stats.kept, stats.total)} ${ratio}%`,
        `🗑  Dropped             ${num(stats.dropped)}`,
        `🔄  Duplicates          ${num(stats.duplicates)}`,
        RULE,
        `➕  Added to batch      ${B(num(added.added))}`,
        `↩️  Already Had         ${num(added.duplicates)}`,
    );

    if (chatStats) {
        lines.push(
            "",
            `📦  ${B("Batch Total")} \u00B7 ${B(compact(chatStats.size))} unique from ${num(chatStats.files)} file(s)`,
        );
    }

    if (stats.truncated) {
        lines.push(
            "",
            `⚠️  ${B("Truncated")} \u2014 huge archive; stopped early to stay safe.`,
        );
    }
    if (stats.skippedLarge) {
        lines.push(
            `⚠️  Skipped ${num(stats.skippedLarge)} oversized entr${stats.skippedLarge === 1 ? "y" : "ies"}.`,
        );
    }
    if (added.capped) {
        lines.push(
            "",
            `⚠️  ${B("Storage cap reached")} \u2014 grab the file, then 🧹 /clear.`,
        );
    }

    lines.push(
        "",
        `🎉 Successfully ingested \u2014 tap 📦 below to download it all!`,
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
            `👁  ${B("PREVIEW")}  ⚡️`,
            RULE,
            "📭 Batch is empty \u2014 nothing to preview.",
            "",
            `${I("Send a .zip or .txt first 📤")}`,
        ].join("\n");
    }
    return [
        `👁  ${B("PREVIEW")} \u00B7 first ${num(sample.length)} of ${B(compact(total))}  💎`,
        RULE,
        ...sample.map((line) => `${CODE(escapeHtml(line))}`),
        "",
        `${I("Credentials are sensitive \u2014 delete this message when done 🗑")}`,
    ].join("\n");
}


/**
 * /search reply - matching lines from the batch, capped for Telegram limits.
 * Shows at most 20 hits inline; if there are more, use /combine + search locally.
 */
function renderSearch(query, result) {
    const shown = result.matches.length;
    if (result.total === 0) {
        return [
            `🔎  ${B("SEARCH RESULTS")}  ⚡️`,
            RULE,
            "No matches for " + CODE(escapeHtml(query)) + " \u2014 try another term \uD83D\uDD0D",
        ].join("\n");
    }
    const out = [
        `🔎  ${B("SEARCH RESULTS")} \u00B7 ${B(num(result.total))} hit${result.total === 1 ? "" : "s"} for ${CODE(escapeHtml(query))}`,
        RULE,
    ];
    for (const line of result.matches) out.push(CODE(escapeHtml(line)));
    if (result.total > shown) {
        out.push("", I("Showing first " + shown + " of " + num(result.total) + " \u2014 /combine for the full file \uD83D\uDCE6"));
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
            Markup.button.callback(`📥 Download "${shortQ}" (${num(total)})`, `search:dl:${cleanQ}`),
        ]);
    }
    rows.push([
        Markup.button.callback("📦 Get Combined File", "combine"),
        Markup.button.callback("📊 System Stats", "stats"),
    ]);
    rows.push([
        Markup.button.callback("🔙 Main Menu", "help"),
    ]);
    return Markup.inlineKeyboard(rows);
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
        return Markup.inlineKeyboard([
            [Markup.button.callback("🔁 Run again", "ulp:again")],
        ]);
    }
    return Markup.inlineKeyboard([
        [Markup.button.callback("🛑 Stop", "ulp:stop")],
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
    return Markup.inlineKeyboard(rows);
}

/**
 * /ulp usage card.
 * @param {{ searcherBot: string, stepDelayMs: number, maxTries: number }} info
 */
function renderUlpHint(info) {
    return [
        `🚀  ${B("ULP SEARCH RELAY")}  ⚡️`,
        RULE,
        `${I("Usage:")} ${CODE(escapeHtml("/ulp <query> [start_date]"))}`,
        "",
        `  1️⃣ ${B("Target")} \u2014 Sent to ${B(mentionOf(info.searcherBot))}`,
        `  2️⃣ ${B("Smart Batch")} \u2014 Auto-detects latest batch date & steps down day-by-day`,
        `  3️⃣ ${B("Live Forward")} \u2014 All dump results are forwarded & auto-cleaned into batch`,
        `  4️⃣ ${B("Auto-Delivery")} \u2014 Delivers combined file and resets batch when finished 💎`,
    ].join("\n");
}

/**
 * /ulp launch card: the exact sequence that will be sent to the searcher bot.
 * @param {{ query: string, scope: string, searcherBot: string, steps: Array<{ id: string, text: string }>, stepDelayMs: number, maxTries: number, transport?: string }} info
 */
function renderUlpStart(info) {
    const whoRow =
        info.transport === "userbot"
            ? [
                `👤  Sender    ${B("your account")} ${I("(MTProto bypass)")} ⚡️`,
                `🤖  Searcher  ${B(mentionOf(info.searcherBot))}`,
            ]
            : [`🤖  Searcher  ${B(mentionOf(info.searcherBot))}`];
    return [
        `🚀  ${B("ULP SEARCH INITIALIZED")}  ⚡️`,
        RULE,
        `🎯  Query     ${B(escapeHtml(info.query))}`,
        `📅  Mode      ${B("Day-by-Day (Auto-detecting latest batch)")}`,
        ...whoRow,
        `⏳  Pacing    ${B(pacingLabel(info.stepDelayMs))} anti-flood delay`,
        "",
        `${I("Incoming dump files will be auto-downloaded & cleaned into batch ⬇️")}`,
        `${I("When done or stopped, the combined file is delivered automatically ✨")}`,
    ].join("\n");
}

/**
 * Progress card after each paced send.
 * @param {{ searcherBot: string, attempt: number, maxTries: number, sends: number, stepDelayMs: number }} info
 */
function renderUlpProgress(info) {
    return [
        `📡  ${B("SEARCH IN PROGRESS")} \u00B7 ${B(`${info.attempt}/${info.maxTries}`)}  ⏳`,
        RULE,
        `🤖  ${B(mentionOf(info.searcherBot))} \u00B7 ${num(info.sends)} step(s) sent`,
        `⏳  ${I(`Pacing ${pacingLabel(info.stepDelayMs)} for safe anti-flood execution…`)}`,
    ].join("\n");
}

/**
 * Header posted once, right before results are forwarded.
 * @param {{ searcherBot: string, query: string, scope: string, count: number }} info
 */
function renderUlpResults(info) {
    return [
        `📥  ${B("RESULTS INCOMING")}  ⚡️`,
        RULE,
        `🤖  ${B(mentionOf(info.searcherBot))} answered \u2014 forwarding ${B(num(info.count))} message${info.count === 1 ? "" : "s"} ⬇️`,
        `🎯  ${CODE(escapeHtml(info.query))} \u00B7 ${CODE(escapeHtml(`hist:full:${info.scope}`))}`,
        "",
        `${I("Documents are automatically ingested and deduped into your batch 💎")}`,
    ].join("\n");
}

/**
 * Nothing came back after all paced tries.
 * @param {{ searcherBot: string, query: string, scope: string, attempts: number, stepDelayMs: number }} info
 */
function renderUlpEmpty(info) {
    return [
        `🕳  ${B("NO RESULTS")}  🕳`,
        RULE,
        `Tried ${B(`${info.attempts}×`)} with ${B(pacingLabel(info.stepDelayMs))} pacing \u2014 ${B(mentionOf(info.searcherBot))} returned no dumps.`,
        `🎯  ${CODE(escapeHtml(info.query))} \u00B7 ${CODE(escapeHtml(`hist:full:${info.scope}`))}`,
        "",
        `${I(`Try another query with ${CODE(escapeHtml("/ulp <query>"))} 🔄`)}`,
    ].join("\n");
}

/**
 * Run completed successfully.
 * @param {{ query: string, scope?: string, count: number }} info
 */
function renderUlpDone(info) {
    return [
        `✨  ${B("ULP SEARCH COMPLETED")}  🚀`,
        RULE,
        `🎯  Target      ${B(escapeHtml(info.query))}`,
        `📊  Relayed     ${B(num(info.count))} message${info.count === 1 ? "" : "s"}`,
        `📦  Status      ${B("Combined file generated & batch reset")} 💎`,
        "",
        `${I("Start another one anytime with /ulp ⚡️")}`,
    ].join("\n");
}

/**
 * Run stopped by the user (or the result window expired).
 * @param {{ query: string, scope: string, count: number }} info
 */
function renderUlpStopped(info) {
    return [
        `🛑  ${B("SEARCH HALTED")}  🛑`,
        RULE,
        `🎯  ${CODE(escapeHtml(info.query))} \u00B7 ${CODE(escapeHtml(`hist:full:${info.scope}`))}`,
        `📊  ${num(info.count)} result message${info.count === 1 ? "" : "s"} captured this run`,
        "",
        `${I("Ready for your next search with /ulp 🚀")}`,
    ].join("\n");
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
function renderServerFiles(info) {
    const { rawFiles = [], processedFiles = [], rawRoot, processedRoot, humanSize, diskStats = null, batchStats = null } = info;
    const totalRawBytes = rawFiles.reduce((acc, f) => acc + (Number(f.size) || 0), 0);
    const totalProcBytes = processedFiles.reduce((acc, f) => acc + (Number(f.size) || 0), 0);

    const lines = [
        `💾  ${B("SERVER STORAGE & FILES VAULT")}  ⚡️`,
        RULE,
    ];

    if (diskStats && Number.isFinite(diskStats.total) && diskStats.total > 0) {
        const pctUsed = Math.min(100, Math.max(0, Math.round((diskStats.used / diskStats.total) * 100)));
        const filled = Math.round(pctUsed / 10);
        const gauge = "█".repeat(filled) + "░".repeat(10 - filled);
        lines.push(
            `💽  ${B("Server Disk Storage:")}`,
            `     ${CODE(`[${gauge}]`)} ${B(`${pctUsed}%`)} (${humanSize(diskStats.used)} / ${humanSize(diskStats.total)})`,
            `     └ 🟢 Free Space: ${B(humanSize(diskStats.free))}`,
            "",
        );
    }

    lines.push(
        `📊  ${B("Vault Breakdown:")}`,
        `  📥  ${B("Raw Incoming:")} ${num(rawFiles.length)} file${rawFiles.length === 1 ? "" : "s"} (${humanSize(totalRawBytes)})`,
        `  💎  ${B("Cleaned Outputs:")} ${num(processedFiles.length)} file${processedFiles.length === 1 ? "" : "s"} (${humanSize(totalProcBytes)})`,
    );

    if (batchStats) {
        lines.push(`  📦  ${B("Active In-Memory Batch:")} ${num(batchStats.size || 0)} credentials`);
    }
    lines.push(RULE);

    lines.push(`📥  ${B("Raw Incoming Dumps")} · ${CODE(escapeHtml(rawRoot))}`);
    if (rawFiles.length === 0) {
        lines.push(`  ${I("No raw files on disk — reply to any file with /save")}`);
    } else {
        for (let i = 0; i < Math.min(rawFiles.length, 10); i++) {
            const f = rawFiles[i];
            const isZip = f.name.toLowerCase().endsWith(".zip");
            const icon = isZip ? "📦" : "📄";
            lines.push(
                `  ${B(`[${i + 1}]`)} ${icon} ${B(escapeHtml(f.name))}`,
                `       └ 📁 ${CODE(humanSize(f.size))} · 📅 ${CODE(formatFileDate(f.mtime))}`,
            );
        }
        if (rawFiles.length > 10) {
            lines.push(`  ${I(`…and ${rawFiles.length - 10} more raw file(s)`)}`);
        }
    }

    lines.push("");
    lines.push(`💎  ${B("Cleaned Output Files")} · ${CODE(escapeHtml(processedRoot))}`);
    if (processedFiles.length === 0) {
        lines.push(`  ${I("No processed outputs yet — tap a Clean button below")}`);
    } else {
        for (let i = 0; i < Math.min(processedFiles.length, 10); i++) {
            const f = processedFiles[i];
            lines.push(
                `  ${B(`[${i + 1}]`)} ⚡️ ${B(escapeHtml(f.name))}`,
                `       └ 📁 ${CODE(humanSize(f.size))} · 📅 ${CODE(formatFileDate(f.mtime))}`,
            );
        }
        if (processedFiles.length > 10) {
            lines.push(`  ${I(`…and ${processedFiles.length - 10} more output(s)`)}`);
        }
    }

    lines.push(
        "",
        RULE,
        `👇 ${I("Tap any button below to Clean, Search, or Download files directly (or Delete as you wish):")}`,
    );
    return lines.join("\n");
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
function renderUlpBlocked(info) {
    const transport = info.transport === "userbot" ? "userbot" : "bot";
    const header = ulpErrorHeader(info.kind, transport);
    const own = info.ownBot ? mentionOf(info.ownBot) : "this bot";
    const lines = [
        `${header.emoji}  ${B(header.title)}`,
        RULE,
        header.detail,
    ];
    if (info.reason) lines.push(`${I(escapeHtml(info.reason))}`);
    if (transport === "userbot") {
        lines.push(
            "",
            `\uD83D\uDD27  ${B("Fix the account transport")}`,
            `  1\uFE0F\u20E3 run ${B(CODE("npm run userbot:login"))} and follow the prompts`,
            `  2\uFE0F\u20E3 copy the printed ${B("TELEGRAM_SESSION")} into your env`,
            `  3\uFE0F\u20E3 restart the bot, then tap \uD83D\uDD01 Run again`,
        );
        if (info.kind !== "userbot_auth" && info.kind !== "userbot_not_ready") {
            lines.push(
                "",
                `\uD83D\uDC64  ${B("Remember")}: results only land here once ${B(own)} can use your login`,
            );
        }
    } else {
        lines.push(
            "",
            `\uD83D\uDD27  ${B("Unlock bot-to-bot messaging")}`,
            `  1\uFE0F\u20E3 ${B("@BotFather")} \u2192 ${B("/mybots")} \u2192 ${B(own)}`,
            `  2\uFE0F\u20E3 ${B("Bot Settings")} \u2192 ${B("Bot-to-Bot Communication")} \u2192 ${B("Enable")}`,
            `  3\uFE0F\u20E3 the owner of ${B(mentionOf(info.searcherBot))} must enable it too`,
            `  4\uFE0F\u20E3 tap \uD83D\uDD01 Run again \u2014 Telegram allows bot \u2194 bot chats only when both agree`,
            "",
            `\uD83E\uDD16  ${B("Better bypass")}: log in with your own account (${B(CODE("SEARCH_TRANSPORT=userbot"))}),`,
            `  so the relay talks to ${B(mentionOf(info.searcherBot))} as a user \u2014 no owner needed.`,
        );
    }
    lines.push(
        "",
        `\uD83D\uDEE0\uFE0F  ${B("By hand, right now")}`,
        ...info.steps.map((step, i) => `  ${i + 1}\uFE0F\u20E3 ${CODE(escapeHtml(step.text))}`),
        `  \u21B3 send these to ${B(mentionOf(info.searcherBot))} yourself, ${B(pacingLabel(info.stepDelayMs))} apart`,
        `  \u21B3 forward its answers here \u2014 files get cleaned \uD83E\uDDFC`,
    );
    return lines.join("\n");
}

/**
 * Card posted on a result that the userbot shared into this chat (already
 * there as a forward or a marked copy — this just adds the tools).
 * Applies to documents (with a clean button) and to everything else.
 * @param {{ searcherBot: string, query: string, scope: string, count: number, hasDocument: boolean }} info
 */
function renderUlpSharedResult(info) {
    return [
        `📥  ${B("RESULT IN")} \u00B7 ${B(mentionOf(info.searcherBot))}  💎`,
        RULE,
        `🎯  ${CODE(escapeHtml(info.query))} \u00B7 ${CODE(escapeHtml(`hist:full:${info.scope}`))}`,
        `📦  ${num(info.count)} message${info.count === 1 ? "" : "s"} relayed in this run ⬇️`,
        "",
        info.hasDocument
            ? `${I("⚡ Auto-processing dump file into batch now…")}`
            : `${I("📄 Text dump relayed \u2014 send files for deep cleaning")}`,
    ].join("\n");
}

function humanSize(bytes) {
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
    const lines = [
        `💎  ${B("BOT NATIVE EMOJI DASHBOARD")}  ✨`,
        RULE,
        `🎨  ${B("Direct Native Unicode Icons & Visual Palette")}`,
        "",
        `  🚀  ${B("ULP Search Relay:")} Automated day-by-day searches & URL-stripped outputs`,
        `  🧼  ${B("Credential Sanitizer:")} Email, User, Phone & CC normalizer`,
        `  📦  ${B("Storage & Vault:")} Combined files, disk raw dumps & bulk wiping`,
        `  📊  ${B("Live Metrics:")} Real-time capacity gauges & duplicate counters`,
        `  🌐  ${B("Site Recon:")} Automated domain detection & per-site stats`,
        `  🔎  ${B("Deep Search:")} Rapid indexed keyword lookup in batch`,
        `  ⚡️  ${B("Multi-Core Turbo:")} Parallel CPU processing across all cores`,
        `  🛡️  ${B("Anti-Flood Shield:")} Paced message queues & safety limits`,
    ];

    if (packs.length > 0) {
        lines.push(
            "",
            RULE,
            `📂  ${B("Custom Packs:")} ${packs.length}  ·  🎨  ${B("Total Emojis:")} ${num(totalEmojis)}`,
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
        I("All visual icons and emojis are rendered natively directly on this bot! ⚡️"),
    );

    return lines.join("\n");
}

/**
 * Render batch save progress.
 */
function renderBatchSaveProgress({ current, total, currentName, linesAdded, totalLines }) {
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    return [
        `📦  ${B("BATCH SAVE & PROCESS")}  ⏳`,
        RULE,
        `📊  ${B("Progress:")} ${bar(current, total, 10)} ${pct}% (${current}/${total} files)`,
        `📄  ${B("Current:")} ${CODE(escapeHtml(currentName))}`,
        `✨  ${B("Lines added so far:")} ${num(totalLines)} (+${num(linesAdded)})`,
        "",
        I("Streaming via MTProto bypass directly into /var/data and cleaning… 🧼"),
    ].join("\n");
}

/**
 * Render batch save completion.
 */
function renderBatchSaveComplete({ totalFiles, totalLines, files = [], durationMs = 0 }) {
    const s = (durationMs / 1000).toFixed(1);
    const out = [
        `✅  ${B("BATCH SAVE COMPLETE")}  💎`,
        RULE,
        `📦  ${B("Files Processed:")} ${num(totalFiles)} in ${s}s`,
        `🧼  ${B("Total Credentials in Batch:")} ${num(totalLines)}`,
        "",
        `${B("Processed Documents:")}`,
    ];
    files.slice(0, 8).forEach((f, i) => {
        out.push(` ${i + 1}. ${CODE(escapeHtml(f.name))} ↳ +${num(f.lines)} lines (${humanSize(f.size)})`);
    });
    if (files.length > 8) {
        out.push(` …and ${files.length - 8} more files.`);
    }
    out.push(
        "",
        RULE,
        I("Tap 📦 Get Combined File below to download all deduped credentials! ⬇️"),
    );
    return out.join("\n");
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
    serverFilesKeyboard,
    confirmFileDeleteKeyboard,
    formatFileDate,
    ulpMenuKeyboard,
    saveGuideKeyboard,
    searchPromptKeyboard,
    escapeHtml,
    mainKeyboard,
    confirmClearKeyboard,
    afterCombineKeyboard,
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
};








