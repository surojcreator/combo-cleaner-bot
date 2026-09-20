"use strict";

const { Telegraf } = require("telegraf");
const { extractAndCleanZip, extractAndCleanText, isZipBuffer } = require("./extractor");
const { sanitizeSiteSlug } = require("./sites");
const store = require("./store");
const {
    renderStats,
    renderSites,
    renderHelp,
    renderFileReport,
    renderPing,
    renderPreview,
    renderSearch,
    mainKeyboard,
    confirmClearKeyboard,
    afterCombineKeyboard,
    emptyBatchKeyboard,
    siteEmoji,
    B,
    I,
    compact,
} = require("./messages");

// Telegram Bot API caps bot downloads at 20 MB.
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

// Cooldown between combine calls, per chat (anti double-tap spam).
const COMBINE_COOLDOWN_MS = 3000;

const STARTED_AT = Date.now();

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
        const batch = store.getStats(ctx.chat.id);
        await safeReply(ctx, renderHelp(meta.botUsername, batch), mainKeyboard());
    });

    bot.help(async (ctx) => {
        const batch = store.getStats(ctx.chat.id);
        await safeReply(ctx, renderHelp(meta.botUsername, batch), mainKeyboard());
    });

    bot.command("stats", async (ctx) => {
        await safeReply(ctx, renderStats(store.getStats(ctx.chat.id)), mainKeyboard());
    });

    bot.command("sites", async (ctx) => {
        await safeReply(ctx, renderSites(store.getSiteCounts(ctx.chat.id)), mainKeyboard());
    });

    bot.command("preview", async (ctx) => {
        await sendPreview(ctx);
    });

    bot.command("search", async (ctx) => {
        const query = (ctx.message.text || "").replace(/^\S+\s*/, "").trim();
        if (!query) {
            await safeReply(
                ctx,
                [
                    `\uD83D\uDD0E  ${B("SEARCH")}`,
                    "",
                    `${I("Usage: /search gmail.com \u2014 finds matches in your batch")}`,
                    `${I("At least 2 characters, searches everything you uploaded \uD83D\uDCE6")}`,
                ].join("\n"),
                mainKeyboard(),
            );
            return;
        }
        if (query.length < 2) {
            await safeReply(ctx, "\u26A0\uFE0F Query too short \u2014 give me at least 2 characters.", mainKeyboard());
            return;
        }
        const result = store.searchLines(ctx.chat.id, query, 20);
        await safeReply(ctx, renderSearch(query, result), mainKeyboard());
    });

    bot.command("ping", async (ctx) => {
        const t0 = Date.now();
        await ctx.telegram.getMe();
        const latencyMs = Date.now() - t0;
        const uptimeSec = (Date.now() - STARTED_AT) / 1000;
        await safeReply(ctx, renderPing({ latencyMs, uptimeSec }));
    });

    bot.command("name", async (ctx) => {
        const arg = (ctx.message.text || "").replace(/^\S+\s*/, "").trim();
        const chat = store.getRawChat(ctx.chat.id);
        if (!arg) {
            const current = chat && chat.customName ? chat.customName : null;
            await safeReply(
                ctx,
                [
                    `\uD83C\uDFF7\uFE0F  ${B("File naming")}`,
                    current
                        ? `Locked to ${B(escapeHtml(current))} \uD83D\uDD12`
                        : `Auto-detecting the site \uD83E\uDD16`,
                    "",
                    `${I("Usage: /name netflix.com \u2014 forces the filename")}`,
                    `${I("Send /name clear to restore auto-detect")}`,
                ].join("\n"),
                mainKeyboard(),
            );
            return;
        }
        if (arg.toLowerCase() === "clear") {
            if (chat) chat.customName = null;
            await safeReply(ctx, "\uD83E\uDDFC Auto-detection restored \u2728", mainKeyboard());
            return;
        }
        const clean = sanitizeSiteSlug(arg) || arg.toLowerCase();
        if (chat) chat.customName = clean;
        await safeReply(
            ctx,
            [
                `\uD83C\uDFF7\uFE0F  ${B("Custom name locked!")} \uD83D\uDD12`,
                `Future files will be named ${B(escapeHtml(clean))}`,
                "",
                `${I("Send /name clear to go back to auto-detect")}`,
            ].join("\n"),
            mainKeyboard(),
        );
    });

    bot.command("clear", async (ctx) => {
        const stats = store.getStats(ctx.chat.id);
        if (!stats || stats.size === 0) {
            await safeReply(ctx, "\uD83D\uDCED Nothing stored for this chat \u2014 all clean \u2728");
            return;
        }
        // Two-step confirmation so a stray tap can't wipe the batch.
        await safeReply(
            ctx,
            [
                `\uD83E\uDDF9  ${B("Clear this batch?")}`,
                `\uD83D\uDCE6 It holds ${B(num(stats.size))} unique line${stats.size === 1 ? "" : "s"}`,
                "",
                `${I("This can't be undone \u26A0\uFE0F")}`,
            ].join("\n"),
            confirmClearKeyboard(),
        );
    });

    bot.command("combine", async (ctx) => {
        await ctx.replyWithChatAction("upload_document").catch(() => { });
        await sendCombined(ctx);
    });

    // Inline button: Combine
    bot.action("combine", async (ctx) => {
        await ctx.answerCbQuery("\uD83D\uDCE6 Building file\u2026").catch(() => { });
        await ctx.replyWithChatAction("upload_document").catch(() => { });
        await sendCombined(ctx);
    });

    // Inline button: Stats
    bot.action("stats", async (ctx) => {
        await ctx.answerCbQuery("\uD83D\uDCCA Loading stats\u2026").catch(() => { });
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

    // Inline button: Sites
    bot.action("sites", async (ctx) => {
        await ctx.answerCbQuery("\uD83D\uDCE1 Loading sites\u2026").catch(() => { });
        try {
            await ctx.editMessageText(renderSites(store.getSiteCounts(ctx.chat.id)), {
                parse_mode: "HTML",
                disable_web_page_preview: true,
                ...mainKeyboard(),
            });
        } catch {
            await safeReply(ctx, renderSites(store.getSiteCounts(ctx.chat.id)), mainKeyboard());
        }
    });

    // Inline button: Preview
    bot.action("preview", async (ctx) => {
        await ctx.answerCbQuery("\uD83D\uDC41 Peeking\u2026").catch(() => { });
        await sendPreview(ctx);
    });

    // Inline button: Help
    bot.action("help", async (ctx) => {
        await ctx.answerCbQuery("\u2753").catch(() => { });
        const batch = store.getStats(ctx.chat.id);
        try {
            await ctx.editMessageText(renderHelp(meta.botUsername, batch), {
                parse_mode: "HTML",
                disable_web_page_preview: true,
                ...mainKeyboard(),
            });
        } catch {
            await safeReply(ctx, renderHelp(meta.botUsername, batch), mainKeyboard());
        }
    });

    // Inline buttons: Clear (two-step)
    bot.action("clear:ask", async (ctx) => {
        const stats = store.getStats(ctx.chat.id);
        if (!stats || stats.size === 0) {
            await ctx.answerCbQuery("\uD83D\uDCED Nothing to clear!").catch(() => { });
            try {
                await ctx.editMessageText(
                    "\uD83D\uDCED Nothing stored for this chat \u2014 all clean \u2728",
                );
            } catch {
                // ignore
            }
            return;
        }
        await ctx.answerCbQuery().catch(() => { });
        try {
            await ctx.editMessageText(
                [
                    `\uD83E\uDDF9  ${B("Clear this batch?")}`,
                    `\uD83D\uDCE6 It holds ${B(num(stats.size))} unique line${stats.size === 1 ? "" : "s"}`,
                    "",
                    `${I("This can't be undone \u26A0\uFE0F")}`,
                ].join("\n"),
                { parse_mode: "HTML", ...confirmClearKeyboard() },
            );
        } catch {
            // ignore
        }
    });

    bot.action("clear:yes", async (ctx) => {
        const existed = store.clear(ctx.chat.id);
        await ctx.answerCbQuery(existed ? "\uD83E\uDDFA Poof! Gone." : "\uD83D\uDCED Nothing to clear").catch(() => { });
        try {
            await ctx.editMessageText(
                existed
                    ? "\uD83E\uDDFA Batch wiped \u2014 fresh start! \u2728\n\uD83D\uDCE4 Send me your next file whenever you're ready."
                    : "\uD83D\uDCED Nothing stored for this chat.",
                { parse_mode: "HTML", ...emptyBatchKeyboard() },
            );
        } catch {
            // ignore
        }
    });

    bot.action("clear:no", async (ctx) => {
        await ctx.answerCbQuery("\uD83D\uDCCE Batch kept \u2728").catch(() => { });
        try {
            await ctx.editMessageText(
                "\uD83D\uDCCE Phew \u2014 batch kept! Nothing was touched. \u2728",
                { parse_mode: "HTML", ...mainKeyboard() },
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
                [
                    `\uD83D\uDCA5  ${B("Oops \u2014 something went wrong")}`,
                    `That file couldn't be processed. It may be corrupt,`,
                    `password-protected, or too large. Try re-sending it.`,
                ].join("\n"),
            );
        }
    });

    // Guides for anything that isn't a document/command.
    bot.on("message", async (ctx) => {
        const msg = ctx.message;
        if (!msg) return;
        if (msg.text && msg.text.startsWith("/")) return;
        if (msg.document) return;
        if (msg.photo || msg.video || msg.audio || msg.voice || msg.sticker) {
            await safeReply(
                ctx,
                "\uD83D\uDCF8 Cute! \u2026but I only speak \uD83D\uDCE6 <b>.zip</b> and \uD83D\uDCC4 text files. Send one of those!",
                mainKeyboard(),
            );
            return;
        }
        await safeReply(
            ctx,
            [
                `\uD83D\uDCCE  ${B("Send it as a file")}`,
                "",
                `Forward or upload a ${B(".zip")} \u2014 or a text file`,
                `(${B(".txt")}, .csv, .log, \u2026) and I'll clean it \uD83E\uDDFC`,
                "",
                `${I("Or just type /search your-query to search your batch \uD83D\uDD0E")}`,
                `${I("Tip: if a forwarded zip arrived as text, download")}`,
                `${I("it first, then send it as a document \uD83D\uDCC2")}`,
            ].join("\n"),
            mainKeyboard(),
        );
    });

    bot.catch((err, ctx) => {
        console.error(`Bot error for update ${ctx.update && ctx.update.update_id}:`, err);
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
 * Edit a progress message without throwing (e.g. "message not modified").
 * @param {import('telegraf').Context} ctx
 * @param {number} messageId
 * @param {string} text
 * @param {object} [extra]
 */
async function safeEdit(ctx, messageId, text, extra = {}) {
    try {
        await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, text, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            ...extra,
        });
    } catch {
        // ignore
    }
}

/**
 * Handle a forwarded/uploaded document with staged, animated progress:
 * 📥 download → 📦 extract → 🧼 clean → ✅ report.
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
            [
                `\u26D4  ${B("Unsupported file type")}`,
                `I only handle ${B(".zip")} archives and plain text files`,
                `(${B(".txt")}, .csv, .tsv, .log, \u2026) \uD83D\uDCC2`,
            ].join("\n"),
        );
        return;
    }

    if (doc.file_size && doc.file_size > MAX_DOWNLOAD_BYTES) {
        await safeReply(
            ctx,
            [
                `\uD83D\uDCA5  ${B("Too big for Telegram")}`,
                `That file is ${humanSize(doc.file_size)} \u2014 over the`,
                `${humanSize(MAX_DOWNLOAD_BYTES)} bot download limit \uD83D\uDCCF`,
                "",
                `${I("Split it into smaller zips and send them all \u2014")}`,
                `${I("I merge everything into one batch \uD83E\uDDF2")}`,
            ].join("\n"),
        );
        return;
    }

    // Stage 1: downloading.
    const progress = await ctx.reply(
        [
            `\uD83D\uDCE5  ${B("Downloading")} ${escapeHtml(name)}`,
            `     \uD83D\uDCC2  ${humanSize(doc.file_size || 0)}  \u00B7  \u23F3 working\u2026`,
        ].join("\n"),
        { parse_mode: "HTML" },
    );

    const link = await ctx.telegram.getFileLink(doc.file_id);
    const res = await fetch(link.href);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());

    // Stage 2: extracting.
    await safeEdit(
        ctx,
        progress.message_id,
        [
            `\uD83D\uDCE6  ${B("Extracting")} ${escapeHtml(name)}`,
            `     \uD83E\uDDF0  unzipping nested archives\u2026`,
        ].join("\n"),
    );
    await ctx.replyWithChatAction("typing").catch(() => { });

    // Stage 3: cleaning.
    const result =
        isZip || isZipBuffer(buffer)
            ? extractAndCleanZip(buffer, { sourceName: name })
            : extractAndCleanText(buffer.toString("utf8"), { sourceName: name });

    await safeEdit(
        ctx,
        progress.message_id,
        [
            `\uD83E\uDDFC  ${B("Cleaning")} ${escapeHtml(name)}`,
            `     \u2702\uFE0F  filtering ${num(result.stats.total)} lines\u2026`,
        ].join("\n"),
    );

    // Figure out the site this dump belongs to — used when naming the combined
    // file (e.g. "netflix.com_combined_2026-09-19.txt").
    const nameStem = sanitizeSiteSlug(name.replace(/\.[^.]+$/, ""));
    const site = sanitizeSiteSlug(result.site || "") || nameStem || "cleaned";

    const added = store.addLines(ctx.chat.id, result.lines, site);
    const chatStats = store.getStats(ctx.chat.id);

    // Stage 4: done — full report.
    await safeEdit(
        ctx,
        progress.message_id,
        renderFileReport(name, result.stats, added, chatStats, site),
        mainKeyboard(),
    );

    // No auto-send: the batch keeps accumulating. Tap "Get combined file"
    // (or /combine) whenever you want to download it.
}

/**
 * Peek at the first stored lines.
 * @param {import('telegraf').Context} ctx
 */
async function sendPreview(ctx) {
    const lines = store.getLines(ctx.chat.id);
    const sample = lines.slice(0, 10);
    await safeReply(ctx, renderPreview(sample, lines.length), mainKeyboard());
}

/**
 * Send the combined, deduped file for the current chat. Named after the site
 * when the whole batch belongs to one site, otherwise "combolist".
 * @param {import('telegraf').Context} ctx
 */
const lastCombineAt = new Map(); // chatId -> timestamp

async function sendCombined(ctx) {
    const chatId = ctx.chat && ctx.chat.id;
    const now = Date.now();
    const last = lastCombineAt.get(chatId) || 0;
    if (now - last < COMBINE_COOLDOWN_MS) {
        await safeReply(ctx, "\u23F3 One sec \u2014 already building it! \uD83E\uDDFD");
        return;
    }
    lastCombineAt.set(chatId, now);

    const chat = store.getRawChat(chatId);
    const customName = chat && chat.customName ? chat.customName : null;

    const lines = store.getLines(chatId);
    if (lines.length === 0) {
        await safeReply(
            ctx,
            [
                `\uD83D\uDCED  ${B("Nothing to combine yet")}`,
                `Your batch is empty \u2014 send me a ${B(".zip")} or ${B(".txt")}`,
                `first and I'll get cleaning \uD83E\uDDFC\u2728`,
            ].join("\n"),
            emptyBatchKeyboard(),
        );
        return;
    }

    let base;
    let siteLine;
    if (customName) {
        base = customName;
        siteLine = `\uD83D\uDD12  ${B(escapeHtml(base))}  ${I("(custom name)")}`;
    } else {
        const sites = store.getSites(chatId);
        if (sites.length === 1) {
            base = sites[0];
        } else if (sites.length === 0) {
            base = "combolist";
        } else {
            // Multiple sites: name after the biggest one instead of a generic
            // "combolist" — keeps the filename meaningful.
            const counts = store.getSiteCounts(chatId);
            base = counts.length > 0 ? counts[0].site : "combolist";
        }
        const emoji = siteEmoji(base);
        siteLine =
            sites.length === 1
                ? `${emoji}  ${B(escapeHtml(base))}`
                : `${emoji}  ${B(num(sites.length))} sites mixed`;
    }

    const buffer = Buffer.from(buildOutput(lines), "utf8");
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `${base}_combined_${stamp}.txt`;

    await ctx.replyWithDocument(
        { source: buffer, filename },
        {
            caption: [
                `\uD83C\uDF81  ${B("COMBINED & DEDUPED")}`,
                `${siteLine}  \u00B7  \uD83D\uDD10 ${B(compact(lines.length))} unique lines`,
                "",
                `${I("Served fresh \u2014 tap \uD83D\uDCE5 below to grab it again anytime.")}`,
            ].join("\n"),
            parse_mode: "HTML",
            ...afterCombineKeyboard(),
        },
    );
}

module.exports = { createBot, buildOutput, humanSize, escapeHtml };




