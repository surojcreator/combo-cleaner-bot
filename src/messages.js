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
            Markup.button.callback("📦 Get combined file", "combine"),
            Markup.button.callback("📊 Stats", "stats"),
        ],
        [
            Markup.button.callback("📡 Sites", "sites"),
            Markup.button.callback("👁 Preview", "preview"),
        ],
        [
            Markup.button.callback("📂 Server files", "server_files"),
            Markup.button.callback("🧹 Clear batch", "clear:ask"),
        ],
        [
            Markup.button.callback("❓ Help", "help"),
        ],
    ]);
}

/**
 * Keyboard shown under the combined file.
 */
function afterCombineKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback("📦 Send again", "combine"),
            Markup.button.callback("📊 Stats", "stats"),
        ],
        [
            Markup.button.callback("📂 Server files", "server_files"),
            Markup.button.callback("🧹 Clear batch", "clear:ask"),
        ],
    ]);
}

/**
 * Keyboard shown under the server files vault.
 */
function serverFilesKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback("🔄 Refresh files", "files:refresh"),
            Markup.button.callback("📊 Stats", "stats"),
        ],
        [
            Markup.button.callback("📦 Get combined file", "combine"),
            Markup.button.callback("❓ Help", "help"),
        ],
    ]);
}

/**
 * Keyboard when the batch is empty.
 */
function emptyBatchKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback("❓ How do I use this?", "help")],
        [Markup.button.callback("📂 Server files", "server_files"), Markup.button.callback("📊 Stats", "stats")],
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
 * /start and /help message — full branded welcome.
 * @param {string} [botUsername]
 * @param {{ size: number, files: number }|null} [batch] existing batch summary
 * @param {string|null} [searcherBot] configured ULP searcher bot username
 */
function renderHelp(botUsername, batch = null, searcherBot = null) {
    const mention = botUsername ? `@${escapeHtml(botUsername)}` : "this bot";
    const lines = [
        `⚡️  ${B("COMBO CLEANER PRO")}  ⚡️`,
        `🚀  ${I("Raw Dumps In • Crystal Clean Batches Out • Ultra-Fast")}`,
        RULE,
        "",
        `💎  ${B("Core Superpowers")}`,
        `  ⚡️ ${B("Instant RAM Pipeline")} \u2014 zero wait streaming`,
        `  🧹 ${B("Auto-Deduplication")} \u2014 drops duplicates on the fly`,
        `  🌐 ${B("Smart Site Detection")} \u2014 identifies domain source`,
        `  📦 ${B("Tidy Auto-Named Outputs")} \u2014 ready to use`,
        "",
        `🛠  ${B("Command Arsenal")}`,
        `  🚀 /ulp \u2014 Auto-relay dump search (@${escapeHtml(searcherBot || "DumpNews14Bot")})`,
        `  📂 /files \u2014 Browse & search server files & dumps`,
        `  📦 /combine \u2014 Download your deduped combined batch`,
        `  📊 /stats \u2014 Real-time batch metrics & capacity gauge`,
        `  📡 /sites \u2014 Site distribution reconnaissance`,
        `  👁 /preview \u2014 Peek at sample cleaned lines`,
        `  🔎 /search \u2014 Query your active RAM batch`,
        `  ⚡ /lsearch \u2014 Fast-scan huge disk output files`,
        `  📥 /save \u2014 Save replied group document directly to disk`,
        `  🛠 /process \u2014 Stream-clean large local file from disk`,
        `  🧹 /clear \u2014 Wipe current batch for a fresh run`,
        `  🏓 /ping \u2014 Latency and system uptime check`,
        `  ❓ /help \u2014 Show this manual`,
        "",
    ];

    if (batch && batch.size > 0) {
        lines.push(
            `💎  ${B("Active Batch:")} ${B(num(batch.size))}` +
                ` unique line${batch.size === 1 ? "" : "s"} waiting 🎁`,
            "",
        );
    }

    if (searcherBot) {
        lines.push(
            `🤖  ${B("ULP Search Relay")}`,
            `  ${CODE(escapeHtml("/ulp <query> [start_date]"))}`,
            `  ↳ Auto-detects latest batch date & steps down day-by-day`,
            `  ↳ Relays & ingests dumps with automatic pacing ⏳`,
            "",
        );
    }

    lines.push(RULE, `🛡️ ${mention} \u00B7 Pro Edition`);
    return lines.join("\n");
}

/**
 * Welcome-back line returned to /start when a batch exists.
 * @param {{ size: number, files: number }|null} batch
 */
function renderWelcomeBack(batch) {
    if (!batch || batch.size === 0) return null;
    return (
        `💎 ${B("Welcome back!")} Your batch holds ` +
        `${B(num(batch.size))} unique line${batch.size === 1 ? "" : "s"} ` +
        `from ${num(batch.files)} file${batch.files === 1 ? "" : "s"} 🎁`
    );
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
    out.push("", I("Credentials are sensitive \u2014 delete this message when done \uD83D\uDDD1\uFE0F"));
    return out.join("\n");
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
function renderServerFiles(info) {
    const { rawFiles = [], processedFiles = [], rawRoot, processedRoot, humanSize } = info;
    const lines = [
        `📂  ${B("SERVER FILES VAULT")}  ⚡️`,
        RULE,
    ];

    lines.push(`📥  ${B("Raw Incoming Dumps")} \u00B7 ${CODE(escapeHtml(rawRoot))}`);
    if (rawFiles.length === 0) {
        lines.push(`  ${I("No raw files found on disk \u2014 forward a file and reply with /save")}`);
    } else {
        for (const f of rawFiles.slice(0, 10)) {
            const isZip = f.name.toLowerCase().endsWith(".zip");
            const icon = isZip ? "📦" : "📄";
            lines.push(`  ${icon} ${B(escapeHtml(f.name))} \u00B7 ${CODE(humanSize(f.size))}`);
        }
        if (rawFiles.length > 10) {
            lines.push(`  ${I(`…and ${rawFiles.length - 10} more raw file(s)`)}`);
        }
    }

    lines.push("");
    lines.push(`💎  ${B("Cleaned Output Files")} \u00B7 ${CODE(escapeHtml(processedRoot))}`);
    if (processedFiles.length === 0) {
        lines.push(`  ${I("No processed outputs yet \u2014 clean a dump with /process")}`);
    } else {
        for (const f of processedFiles.slice(0, 10)) {
            lines.push(`  ⚡ ${B(escapeHtml(f.name))} \u00B7 ${CODE(humanSize(f.size))}`);
        }
        if (processedFiles.length > 10) {
            lines.push(`  ${I(`…and ${processedFiles.length - 10} more output(s)`)}`);
        }
    }

    lines.push(
        "",
        RULE,
        `💡 ${I("Clean any raw file:")} ${CODE("/process /var/data/filename.zip")}`,
        `🔍 ${I("Fast-search cleaned output:")} ${CODE(escapeHtml("/lsearch <query>"))}`,
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

module.exports = {
    renderHelp,
    renderStats,
    renderSites,
    renderFileReport,
    renderPing,
    renderPreview,
    renderSearch,
    renderWelcomeBack,
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
    serverFilesKeyboard,
    escapeHtml,
    mainKeyboard,
    confirmClearKeyboard,
    afterCombineKeyboard,
    emptyBatchKeyboard,
    ulpKeyboard,
    ulpResultKeyboard,
    B,
    I,
    U,
    CODE,
    RULE,
    bar,
    num,
    compact,
    siteEmoji,
};








