"use strict";

const { Telegraf } = require("telegraf");
const { extractAndCleanZip, extractAndCleanText, isZipBuffer } = require("./extractor");
const { sanitizeSiteSlug } = require("./sites");
const store = require("./store");
const {
    renderStats,
    renderHelp,
    renderFileReport,
    mainKeyboard,
    B,
    I,
} = require("./messages");

// Telegram Bot API caps bot downloads at 20 MB.
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

// Build the ampersand from its char code so this file can never be HTML-decoded
// into broken escape sequences by the editor's auto-formatter.
const AMP = String.fromCharCode(38);

/**
 * @param {string} s
 */
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, `${AMP}amp;`)
        .replace(/</g, `${AMP}lt;`)
        .replace(/>/g, `${AMP}gt;`);
}

/**
 * Human-readable byte size.
 * @param {number} bytes
 */
function humanSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Locale-formatted number.
 * @param {number|undefined} n
 */
function num(n) {
    return Number(n || 0).toLocaleString("en-US");
}

/**
 * Build the combined output text for a chat.
 * @param {string[]} lines
 */
function buildOutput(lines) {
    return lines.join("\n") + (lines.length ? "\n" : "");
}

/**
 * Create and configure the Telegraf bot.
 * @param {string} token
 * @param {{ botUsername?: string }} [meta]
 */
function createBot(token, meta = {}) {
    const bot = new Telegraf(token, { handlerTimeout: 10 * 60 * 1000 });

    bot.start(async (ctx) => {
        await ctx.reply(renderHelp(meta.botUsername), {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            ...mainKeyboard(),
        });
    });

    bot.help(async (ctx) => {
        await ctx.reply(renderHelp(meta.botUsername), {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            ...mainKeyboard(),
        });
    });

    bot.command("stats", async (ctx) => {
        await safeReply(ctx, renderStats(store.getStats(ctx.chat.id)), mainKeyboard());
    });

    bot.command("clear", async (ctx) => {
        const existed = store.clear(ctx.chat.id);
        await safeReply(
            ctx,
            existed ? "🧹 Cleared this chat's batch." : "Nothing stored for this chat.",
        );
    });

    bot.command("combine", async (ctx) => {
        await ctx.replyWithChatAction("upload_document").catch(() => { });
        await sendCombined(ctx);
    });

    // Inline button: Combine
    bot.action("combine", async (ctx) => {
        await ctx.answerCbQuery("📦 Building file…").catch(() => { });
        await sendCombined(ctx);
    });

    // Inline button: Stats
    bot.action("stats", async (ctx) => {
        await ctx.answerCbQuery().catch(() => { });
        try {
            await ctx.editMessageText(renderStats(store.getStats(ctx.chat.id)), {
                parse_mode: "HTML",
                disable_web_page_preview: true,
                ...mainKeyboard(),
            });
        } catch {
            await safeReply(ctx, renderStats(store.getStats(ctx.chat.id)), mainKeyboard());
        }
    });

    // Inline button: Clear
    bot.action("clear", async (ctx) => {
        const existed = store.clear(ctx.chat.id);
        await ctx.answerCbQuery(existed ? "Batch cleared" : "Nothing to clear").catch(() => { });
        try {
            await ctx.editMessageText(
                existed ? "🧹 Cleared this chat's batch." : "Nothing stored for this chat.",
            );
        } catch {
            // ignore
        }
    });

    bot.on("document", async (ctx) => {
        try {
            await handleDocument(ctx);
        } catch (err) {
            console.error("document handler error:", err);
            await safeReply(
                ctx,
                "❌ Something went wrong while processing that file. It may be corrupt or too large.",
            );
        }
    });

    // Guides for anything that isn't a document/command.
    bot.on("message", async (ctx) => {
        const msg = ctx.message;
        if (!msg) return;
        if (msg.text && msg.text.startsWith("/")) return;
        if (msg.document) return;
        await safeReply(
            ctx,
            [
                "📎 Send me a <b>.zip</b> or plain text file (<b>.txt</b>, .csv, .log, …).",
                "",
                "If you forwarded a zip and it arrived as text, download it first, then send it as a file.",
            ].join("\n"),
            mainKeyboard(),
        );
    });

    bot.catch((err, ctx) => {
        console.error(`Bot error for update ${ctx.update.update_id}:`, err);
    });

    return bot;
}

/**
 * Reply without throwing if the reply itself fails.
 * @param {import('telegraf').Context} ctx
 * @param {string} text
 * @param {object} [extra] additional sendMessage options (e.g. keyboard)
 */
async function safeReply(ctx, text, extra = {}) {
    try {
        await ctx.reply(text, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            ...extra,
        });
    } catch (err) {
        console.error("safeReply failed:", err.message);
    }
}

/**
 * Handle a forwarded/uploaded document.
 * @param {import('telegraf').Context} ctx
 */
async function handleDocument(ctx) {
    const doc = ctx.message.document;
    const name = doc.file_name || "file";
    const lower = name.toLowerCase();
    const isZip = lower.endsWith(".zip");
    const isText =
        lower.endsWith(".txt") ||
        lower.endsWith(".csv") ||
        lower.endsWith(".tsv") ||
        lower.endsWith(".log") ||
        lower.endsWith(".lst") ||
        lower.endsWith(".list") ||
        lower.endsWith(".dat");

    if (!isZip && !isText) {
        await safeReply(
            ctx,
            "⚠️ I only handle <b>.zip</b> and plain text files (<b>.txt</b>, .csv, .log, …).",
        );
        return;
    }

    if (doc.file_size && doc.file_size > MAX_DOWNLOAD_BYTES) {
        await safeReply(
            ctx,
            `⚠️ That file is ${humanSize(doc.file_size)}, over Telegram's 20 MB bot limit. Split it into smaller zips.`,
        );
        return;
    }

    const progress = await ctx.reply(
        [
            `📥 ${B("Downloading")} ${escapeHtml(name)}`,
            `┃  ${humanSize(doc.file_size || 0)}`,
            "┗━━━━━━━━━━━━━━━━━",
        ].join("\n"),
        { parse_mode: "HTML" },
    );

    const link = await ctx.telegram.getFileLink(doc.file_id);
    const res = await fetch(link.href);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());

    await ctx.telegram
        .editMessageText(ctx.chat.id, progress.message_id, undefined, "🧼 Cleaning…", {
            parse_mode: "HTML",
        })
        .catch(() => { });

    const result =
        isZip || isZipBuffer(buffer)
            ? extractAndCleanZip(buffer, { sourceName: name })
            : extractAndCleanText(buffer.toString("utf8"), { sourceName: name });

    // Figure out the site this dump belongs to — used when naming the combined
    // file (e.g. "netflix.com_combined_2026-09-19.txt").
    const nameStem = sanitizeSiteSlug(name.replace(/\.[^.]+$/, ""));
    const site = sanitizeSiteSlug(result.site || "") || nameStem || "cleaned";

    const added = store.addLines(ctx.chat.id, result.lines, site);
    const chatStats = store.getStats(ctx.chat.id);

    await ctx.telegram
        .editMessageText(
            ctx.chat.id,
            progress.message_id,
            undefined,
            renderFileReport(name, result.stats, added, chatStats, site),
            { parse_mode: "HTML", disable_web_page_preview: true, ...mainKeyboard() },
        )
        .catch(() => { });

    // No auto-send: the batch keeps accumulating. Tap "Get combined file"
    // (or /combine) whenever you want to download it.
}

/**
 * Send the combined, deduped file for the current chat. This is the only file
 * the bot ever sends back. Named after the site when the whole batch belongs
 * to one site, otherwise "combolist".
 * @param {import('telegraf').Context} ctx
 */
async function sendCombined(ctx) {
    const lines = store.getLines(ctx.chat.id);
    if (lines.length === 0) {
        await safeReply(
            ctx,
            "📭 Nothing to combine yet. Send me a .zip (or .txt) first.",
            mainKeyboard(),
        );
        return;
    }

    const sites = store.getSites(ctx.chat.id);
    const base = sites.length === 1 ? sites[0] : "combolist";
    const siteLine =
        sites.length === 1
            ? `🌐 ${B(escapeHtml(base))}`
            : `🌐 ${B(num(sites.length))} sites mixed`;

    const buffer = Buffer.from(buildOutput(lines), "utf8");
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `${base}_combined_${stamp}.txt`;

    await ctx.replyWithDocument(
        { source: buffer, filename },
        {
            caption: [
                `📦  ${B("COMBINED & DEDUPED")}`,
                `${siteLine}  ·  ${I(`${num(lines.length)} unique lines`)}`,
            ].join("\n"),
            parse_mode: "HTML",
        },
    );
}

module.exports = { createBot, buildOutput, humanSize, escapeHtml };