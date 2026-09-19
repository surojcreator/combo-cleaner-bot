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
 * A proportional bar, e.g. ████████░░ (10 chars wide).
 * @param {number} value
 * @param {number} total
 * @param {number} [width]
 */
function bar(value, total, width = 10) {
    const filled = total > 0 ? Math.round((value / total) * width) : 0;
    return "█".repeat(Math.max(0, Math.min(width, filled))) +
        "░".repeat(Math.max(0, width - Math.max(0, Math.min(width, filled))));
}

/**
 * Reusable inline keyboard.
 */
function mainKeyboard() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback("📦 Get combined file", "combine"),
            Markup.button.callback("📊 Stats", "stats"),
        ],
        [Markup.button.callback("🧹 Clear batch", "clear")],
    ]);
}

/**
 * The /start and /help message.
 * @param {string} [botUsername]
 */
function renderHelp(botUsername) {
    const mention = botUsername ? `@${escapeHtml(botUsername)}` : "this bot";
    return [
        `🧼  ${B("COMBO CLEANER")}`,
        `━━━━━━━━━━━━━━━━━━━━━━`,
        `${I("Drop messy dumps in. Get one clean file out.")}`,
        "",
        `📤  ${B("How it works")}`,
        `  1. Send me a ${B(".zip")} or ${B(".txt")}`,
        `  2. I clean it: emails ${I("or")} numbers only, URLs gone`,
        `  3. Lines pile up in your batch, deduped`,
        `  4. Tap ${B("📦 Get combined file")} when you're ready`,
        "",
        `🧠  ${B("Messy lines? Handled.")}`,
        `  ${CODE("https://site.com/x/:027223395:pass")}`,
        `  ➜ ${CODE("027223395:pass")}`,
        "",
        `✅ ${B("Kept")}`,
        `  ${CODE("user@mail.com:pass")}  ·  ${CODE("15551234567:pass")}`,
        `❌ ${B("Dropped")}`,
        `  ${CODE("https://site.com:443")}  ·  ${CODE("site.com:8080")}`,
        "",
        `📁 ${B("Output naming")}`,
        `  ${CODE("netflix.com_combined_2026-09-19.txt")}`,
        `  ${I("(falls back to combolist_… for mixed batches)")}`,
        "",
        `⌨️  ${B("Commands")}`,
        `  /combine — download the combined file`,
        `  /stats — batch statistics`,
        `  /clear — start a fresh batch`,
        `  /help — this message`,
        "",
        `━━━━━━━━━━━━━━━━━━━━━━`,
        `🔗 ${mention}`,
    ].join("\n");
}

/**
 * /stats reply.
 * @param {{ size: number, files: number, totalKept: number }|null} stats
 */
function renderStats(stats) {
    if (!stats || stats.size === 0) {
        return [
            `📊  ${B("BATCH")}`,
            `━━━━━━━━━━━━━━━━━━━━━━`,
            `📭 Nothing in the batch yet.`,
            "",
            `${I("Send a .zip or .txt and it will show up here.")}`,
        ].join("\n");
    }
    const siteLine = stats.sites
        ? `🌐 Sites                ${B(num(stats.sites))}`
        : null;
    return [
        `📊  ${B("BATCH")}`,
        `━━━━━━━━━━━━━━━━━━━━━━`,
        `🔐 Unique credentials   ${B(num(stats.size))}`,
        `📂 Files processed      ${num(stats.files)}`,
        `🧾 Lines accepted       ${num(stats.totalKept)}`,
        siteLine ? siteLine : null,
        `━━━━━━━━━━━━━━━━━━━━━━`,
        `${I("Tap 📦 below to download the combined file.")}`,
    ]
        .filter((l) => l !== null)
        .join("\n");
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
    const lines = [
        `🧼 ${B("CLEAN REPORT")}`,
        `━━━━━━━━━━━━━━━━━━━━━━`,
        `📄 ${escapeHtml(name)}`,
    ];
    if (site) {
        lines.push(`🌐 Detected site       ${B(escapeHtml(site))}`);
    }
    lines.push(
        `━━━━━━━━━━━━━━━━━━━━━━`,
        `📂 Files read          ${num(stats.files)}`,
        `🧾 Lines seen          ${num(stats.total)}`,
        `✅ Kept                ${B(num(stats.kept))}  ${bar(stats.kept, stats.total)} ${ratio}%`,
        `🗑 Dropped             ${num(stats.dropped)}`,
        `♻️ Duplicates          ${num(stats.duplicates)}`,
        `━━━━━━━━━━━━━━━━━━━━━━`,
        `➕ Added to batch      ${B(num(added.added))}`,
        `↩️ Already had         ${num(added.duplicates)}`,
    );

    if (chatStats) {
        lines.push(
            "",
            `📦 ${B("Batch total")} · ${B(num(chatStats.size))} unique from ${num(chatStats.files)} file(s)`,
        );
    }

    if (stats.truncated) {
        lines.push(
            "",
            `⚠️ ${B("Truncated")} — archive was huge, I stopped early to stay in memory limits.`,
        );
    }
    if (stats.skippedLarge) {
        lines.push(
            `⚠️ Skipped ${num(stats.skippedLarge)} oversized entr${stats.skippedLarge === 1 ? "y" : "ies"}.`,
        );
    }
    if (added.capped) {
        lines.push(
            "",
            `⚠️ ${B("Storage cap reached")} for this chat — download the file, then /clear to free space.`,
        );
    }

    lines.push(
        "",
        `${I("Added to your batch — tap 📦 below to download it all together.")}`,
    );
    return lines.join("\n");
}

module.exports = {
    renderHelp,
    renderStats,
    renderFileReport,
    escapeHtml,
    mainKeyboard,
    B,
    I,
    CODE,
    bar,
};