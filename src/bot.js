"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("node:readline");
const { once } = require("node:events");
const { Telegraf } = require("telegraf");
const { extractAndCleanZip, extractAndCleanText, isZipBuffer } = require("./extractor");
const { sanitizeSiteSlug, detectSite } = require("./sites");
const { cleanLine } = require("./cleaner");
const searchbot = require("./searchbot");
const store = require("./store");
const {
    renderStats,
    renderSites,
    renderHelp,
    renderFileReport,
    renderPing,
    renderPreview,
    renderSearch,
    renderUlpHint,
    renderUlpStart,
    renderUlpProgress,
    renderUlpResults,
    renderUlpEmpty,
    renderUlpStopped,
    renderUlpBlocked,
    renderUlpSharedResult,
    mainKeyboard,
    confirmClearKeyboard,
    afterCombineKeyboard,
    emptyBatchKeyboard,
    ulpKeyboard,
    ulpResultKeyboard,
    siteEmoji,
    B,
    I,
    CODE,
    RULE,
    compact,
} = require("./messages");

// Telegram Bot API caps bot downloads at 20 MB.
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

// Local /process files are NOT limited by Telegram (they're read from disk).
// Extraction is still memory-bound by adm-zip, so these caps apply only to the
// in-memory zip path — plain-text files stream line-by-line and never hit them.
const DEFAULT_PROCESS_MAX_ZIP_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB
const PROCESS_BATCH_SIZE = 5000; // cleaned lines per store.addLines call
const PROCESS_SAMPLE_BYTES = 1024 * 1024; // 1 MB of raw text kept for site detection
const PROCESS_PROGRESS_EVERY = 250_000; // progress edit every N source lines

// Cooldown between combine calls, per chat (anti double-tap spam).
const COMBINE_COOLDOWN_MS = 3000;

// Cooldown between ULP relay runs, per chat (keeps us polite to the searcher bot).
const ULP_COOLDOWN_MS = 5000;

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
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    if (bytes < 1024 ** 4) return `${(bytes / (1024 ** 3)).toFixed(2)} GB`;
    return `${(bytes / (1024 ** 4)).toFixed(2)} TB`;
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
    const bot = new Telegraf(token, {
        handlerTimeout: 10 * 60 * 1000,
        // meta.telegram lets tests and local Bot API server users override the
        // client (e.g. { telegram: { apiRoot: "http://127.0.0.1:8081" } }).
        ...(meta.telegram || {}),
    });

    // ULP search relay configuration (see src/searchbot.js).
    const searchOptions = (meta && meta.search) || searchbot.loadOptions();
    /** chatId -> timestamp of the last relay start */
    const ulpStartedAt = new Map();
    /** chatId -> timeout that closes the result window */
    const ulpWindows = new Map();
    /** chatId -> absolute path currently being processed */
    const localJobs = new Map();

    bot.start(async (ctx) => {
        const batch = store.getStats(ctx.chat.id);
        await safeReply(ctx, renderHelp(meta.botUsername, batch, searchOptions.botUsername), mainKeyboard());
    });

    bot.help(async (ctx) => {
        const batch = store.getStats(ctx.chat.id);
        await safeReply(ctx, renderHelp(meta.botUsername, batch, searchOptions.botUsername), mainKeyboard());
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

    bot.command("lsearch", async (ctx) => {
        const query = (ctx.message.text || "").replace(/^\S+\s*/, "").trim();
        if (query.length < 2) {
            await safeReply(
                ctx,
                `${I("Usage:")} ${CODE("/lsearch example.com")}\nSearches the newest cleaned file under ${CODE(localProcessedRoot())}.`,
            );
            return;
        }
        const file = latestFileIn(localProcessedRoot());
        if (!file) {
            await safeReply(ctx, `\u26A0\uFE0F  No processed output found under ${CODE(localProcessedRoot())}. Run ${CODE("/process /var/data/file.txt")} first.`);
            return;
        }
        const status = await ctx.reply(
            `\uD83D\uDD0E  ${B("LOCAL SEARCH")}\n${CODE(escapeHtml(query))}\n${I(escapeHtml(path.basename(file)))}`,
            { parse_mode: "HTML" },
        );
        try {
            const result = await searchTextFile(file, query, 20);
            await safeEdit(ctx, status.message_id, renderSearch(query, result), mainKeyboard());
        } catch (err) {
            await safeEdit(ctx, status.message_id, `\uD83D\uDCA5  ${B("Local search failed")}\n${I(escapeHtml(err.message))}`);
        }
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

    // ---- /process: clean a file already on the server's disk (e.g. /var/data/...)
    //
    // Bypasses Telegram's 20 MB upload cap entirely: the bot reads the file
    // directly from the server's filesystem, cleans it, and feeds the result into
    // the batch. Plain-text files are streamed (memory-bounded); zip files are
    // still loaded into memory (adm-zip), so huge zips should be split first.
    //
    // Usage:
    //   /process /var/data/netflix.zip
    //   /process /var/data/dump.txt
    //   /process local          -> pick the latest file under /var/data (optional)
    bot.command("process", async (ctx) => {
        const raw = (ctx.message.text || "").replace(/^\/\S+\s*/, "").trim();
        if (!raw) {
            await safeReply(
                ctx,
                [
                    `\uD83D\uDCCB  ${B("PROCESS A LOCAL FILE")}`,
                    RULE,
                    `${I("Usage:")} ${CODE("/process /var/data/file.zip")}  ${I("or")}  ${CODE("/process /var/data/file.txt")}`,
                    "",
                    `${I("Plain-text files are streamed (memory-safe). HUGE zips must fit in RAM \u2014 split them first if needed.")}`,
                    "",
                    `A ${CODE("/var/data")} disk is mounted on this server for local files.`,
                ].join("\n"),
                mainKeyboard(),
            );
            return;
        }

        const input = raw.trim();
        // "/process local" -> newest file in /var/data. Anything else is treated
        // as an absolute path (Linux "/var/data/..." or Windows "C:\\...").
        let target = input;
        if (input === "local" || input === ".local") {
            target = latestFileIn(process.env.LOCAL_PROCESS_ROOT || "/var/data");
            if (!target) {
                await safeReply(ctx, `\u26A0\uFE0F  Nothing found under ${CODE(process.env.LOCAL_PROCESS_ROOT || "/var/data")}.`);
                return;
            }
        }

        if (localJobs.has(ctx.chat.id)) {
            await safeReply(ctx, `\u23F3  Already processing ${CODE(escapeHtml(localJobs.get(ctx.chat.id)))}.`);
            return;
        }

        localJobs.set(ctx.chat.id, target);
        await ctx.replyWithChatAction("typing").catch(() => { });
        // Do not hold a Telegram webhook request open for a multi-hour 50 GB job.
        // The job continues in the background and edits its progress message.
        void processFile(ctx, target)
            .catch((err) => safeReply(ctx, `\uD83D\uDCA5  ${B("Local processing failed")}\n${I(escapeHtml(err.message))}`))
            .finally(() => localJobs.delete(ctx.chat.id));
    });

    // ---- /save: reply to a Telegram document in a shared group.
    //
    // The Bot API only downloads files up to 20 MB. The logged-in MTProto
    // account can see the replied-to group message and stream its document
    // directly to /var/data, then the existing /process pipeline takes over.
    bot.command("save", async (ctx) => {
        const replied = ctx.message && ctx.message.reply_to_message;
        if (!replied || !replied.document) {
            await safeReply(
                ctx,
                [
                    `\uD83D\uDCCC  ${B("REPLY TO A FILE")}`,
                    RULE,
                    `Forward the document into a private group containing:`,
                    `  \u2022 your MTProto user account`,
                    `  \u2022 ${B(meta.botUsername ? `@${escapeHtml(meta.botUsername)}` : "this bot")}`,
                    `Then reply to the document with ${CODE("/save")}.`,
                    "",
                    `${I("Direct private forwarding to the bot stays limited to 20 MB. Telegram itself usually caps user files at 2 GB, or 4 GB with Premium.")}`,
                ].join("\n"),
            );
            return;
        }

        const peer = meta.userbot;
        if (!peer || typeof peer.isReady !== "function" || !peer.isReady()) {
            await safeReply(
                ctx,
                `\u26A0\uFE0F  ${B("Account downloader is offline")}\nSet TELEGRAM_API_ID, TELEGRAM_API_HASH and TELEGRAM_SESSION, then redeploy.`,
            );
            return;
        }
        if (localJobs.has(ctx.chat.id)) {
            await safeReply(ctx, `\u23F3  Already processing ${CODE(escapeHtml(localJobs.get(ctx.chat.id)))}.`);
            return;
        }

        const sourceMessageId = replied.message_id;
        const originalName = replied.document.file_name || `telegram-${sourceMessageId}.bin`;
        const status = await ctx.reply(
            [
                `\uD83D\uDCE5  ${B("DOWNLOADING FROM TELEGRAM")}`,
                RULE,
                `\uD83D\uDCC4  ${escapeHtml(originalName)}`,
                `\uD83D\uDCBE  destination: ${CODE(escapeHtml(localProcessRoot()))}`,
                "",
                `${I("The MTProto account is streaming the file directly to disk\u2026")}`,
            ].join("\n"),
            { parse_mode: "HTML" },
        );

        localJobs.set(ctx.chat.id, `telegram:${ctx.chat.id}/${sourceMessageId}`);
        let lastProgressAt = 0;
        void peer.downloadMessageToDisk(ctx.chat.id, sourceMessageId, {
            root: localProcessRoot(),
            fileName: originalName,
            onProgress: (done, total) => {
                if (Date.now() - lastProgressAt < 3000) return;
                lastProgressAt = Date.now();
                const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
                void safeEdit(
                    ctx,
                    status.message_id,
                    [
                        `\uD83D\uDCE5  ${B("DOWNLOADING FROM TELEGRAM")} \u00B7 ${pct}%`,
                        RULE,
                        `\uD83D\uDCC4  ${escapeHtml(originalName)}`,
                        `\uD83D\uDCE6  ${humanSize(done)} / ${humanSize(total || done)}`,
                    ].join("\n"),
                );
            },
        })
            .then(async (saved) => {
                await safeEdit(
                    ctx,
                    status.message_id,
                    [
                        `\u2705  ${B("SAVED TO DISK")}`,
                        RULE,
                        `\uD83D\uDCC4  ${escapeHtml(saved.originalName)}`,
                        `\uD83D\uDCE6  ${humanSize(saved.size)}`,
                        `\uD83D\uDCBE  ${CODE(escapeHtml(saved.path))}`,
                        "",
                        `${I("Starting the local cleaner now\u2026")}`,
                    ].join("\n"),
                );
                await processFile(ctx, saved.path);
            })
            .catch((err) => safeEdit(
                ctx,
                status.message_id,
                [
                    `\uD83D\uDCA5  ${B("TELEGRAM DOWNLOAD FAILED")}`,
                    RULE,
                    `${I(escapeHtml(err.message || String(err)))}`,
                    "",
                    `Make sure the MTProto account is a member of this group and can see the replied-to message.`,
                ].join("\n"),
            ))
            .finally(() => localJobs.delete(ctx.chat.id));
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

    // ------------------------------------------------------------- ULP relay
    //
    // Drives the external ULP searcher bot (default @DumpNews14Bot):
    //   query -> hist:full:<day|month|year>, 7s before every try, then every
    //   answer the searcher sends back is forwarded into this chat.
    const ulpCommand = async (ctx) => {
        const raw = (ctx.message.text || "").replace(/^\/\S+\s*/, "").trim();
        const parsed = parseUlpArg(raw, searchOptions);
        if (!parsed.query) {
            await safeReply(
                ctx,
                renderUlpHint({
                    searcherBot: searchOptions.botUsername,
                    stepDelayMs: searchOptions.stepDelayMs,
                    maxTries: searchOptions.maxTries,
                }),
                ulpKeyboard(parsed.scope),
            );
            return;
        }
        await beginUlpRun(ctx, {
            query: parsed.query,
            scope: parsed.scope,
            searchOptions,
            meta,
            ulpStartedAt,
            ulpWindows,
        });
    };

    bot.command("ulp", ulpCommand);
    bot.command("searchbot", ulpCommand); // alias

    const rerunUlp = async (ctx, scope) => {
        const run = searchbot.getRun(ctx.chat.id);
        if (!run) {
            await ctx.answerCbQuery("No search to re-run \u2014 use /ulp <query>").catch(() => { });
            return;
        }
        await ctx.answerCbQuery(`Scope \u00B7 ${scope}`).catch(() => { });
        const message = ctx.callbackQuery && ctx.callbackQuery.message;
        await beginUlpRun(ctx, {
            query: run.query,
            scope,
            searchOptions,
            meta,
            ulpStartedAt,
            ulpWindows,
            cardMessageId: message ? message.message_id : null,
        });
    };

    bot.action(/^ulp:(day|month|year)$/, async (ctx) => {
        await rerunUlp(ctx, ctx.match[1]);
    });

    bot.action("ulp:again", async (ctx) => {
        const run = searchbot.getRun(ctx.chat.id);
        await rerunUlp(ctx, run ? run.scope : "day");
    });

    bot.action("ulp:stop", async (ctx) => {
        const run = searchbot.finishRun(ctx.chat.id, "stopped");
        clearUlpWindow(ulpWindows, ctx.chat.id);
        await ctx.answerCbQuery(run ? "\uD83D\uDED1 Stopped" : "Nothing running").catch(() => { });
        if (!run) return;
        const message = ctx.callbackQuery && ctx.callbackQuery.message;
        if (message) {
            await safeEdit(
                ctx,
                message.message_id,
                renderUlpStopped({ query: run.query, scope: run.scope, count: run.results.length }),
                ulpKeyboard(run.scope),
            );
        }
    });

    // "Clean into batch" on a relayed document. The button lives on our card,
    // which replies to the result message — so the file may come from the
    // reply target rather than the card itself.
    bot.action("ulp:clean", async (ctx) => {
        const message = ctx.callbackQuery && ctx.callbackQuery.message;
        const doc =
            (message && message.document) ||
            (message && message.reply_to_message && message.reply_to_message.document) ||
            null;
        if (!doc) {
            await ctx.answerCbQuery("\uD83E\uDDF9 Nothing to clean here").catch(() => { });
            return;
        }
        await ctx.answerCbQuery("\uD83E\uDDFC Cleaning\u2026").catch(() => { });
        await ingestDocument(ctx, doc);
    });


    // Messages sent *by* the searcher bot (bot-to-bot private chat) are relayed
    // into the chat that asked for the search. Results that the account
    // bypass already shared into this chat are only *acknowledged* with tools.
    // Both are registered before the document handler so search results are
    // never mistaken for plain user uploads.
    bot.on("message", async (ctx, next) => {
        if (isSearcherMessage(ctx, meta, searchOptions)) {
            await relaySearcherMessage(ctx, { searchOptions });
            return;
        }
        if (ctx.message && isSearcherForward(ctx, meta, searchOptions)) {
            await ackSharedResult(ctx, { searchOptions });
            return;
        }
        return next();
    });

    bot.on("document", async (ctx) => {
        try {
            await ingestDocument(ctx, ctx.message.document);
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
 * Clean a forwarded/uploaded/searched document with staged progress:
 * 📥 download → 📦 extract → 🧼 clean → ✅ report.
 * Used both for user uploads and for "🧼 Clean into batch" on search results.
 * @param {import('telegraf').Context} ctx
 * @param {import('telegraf').Types.Document} doc
 */
async function ingestDocument(ctx, doc) {
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

/**
 * Reply with HTML and return the sent message (null when the send fails).
 * @param {import('telegraf').Context} ctx
 * @param {string} text
 * @param {object} [extra]
 */
async function sendHtml(ctx, text, extra = {}) {
    try {
        return await ctx.reply(text, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            ...extra,
        });
    } catch (err) {
        console.error("sendHtml failed:", err.message);
        return null;
    }
}

/**
 * Same as sendHtml, but for an explicit chat id instead of the current context.
 * @param {import('telegraf').Telegram} telegram
 * @param {number} chatId
 * @param {string} text
 */
async function sendHtmlTo(telegram, chatId, text) {
    try {
        return await telegram.sendMessage(chatId, text, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
        });
    } catch (err) {
        console.error("sendHtmlTo failed:", err.message);
        return null;
    }
}

/**
 * Real sleep — injected in tests so the 7s pacing costs nothing to verify.
 * @param {number} ms
 */
function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse "/ulp <query> [day|month|year]" arguments.
 * The scope is optional and may also be written first ("/ulp month htzone.co.il"
 * is *not* supported — scope must be last, like "/ulp htzone.co.il month").
 *
 * @param {string} raw text after the command
 * @param {string} [fallbackScope]
 * @returns {{ query: string|null, scope: string }}
 */
function parseUlpArg(raw, fallbackScope = "day") {
    const parts = String(raw || "").split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { query: null, scope: fallbackScope };

    const lastScope = searchbot.normalizeScope(parts[parts.length - 1], null);
    // "/ulp month" — a scope without a query: show the usage card instead.
    if (lastScope && parts.length === 1) return { query: null, scope: lastScope };

    const scope = lastScope && parts.length > 1 ? lastScope : fallbackScope;
    const queryParts = lastScope && parts.length > 1 ? parts.slice(0, -1) : parts;
    return { query: searchbot.normalizeQuery(queryParts.join(" ")), scope };
}

/**
 * Is this update a message from the configured ULP searcher bot?
 * @param {import('telegraf').Context} ctx
 * @param {{ botUsername?: string, searcherBotId?: number }} meta
 * @param {{ botUsername: string }} searchOptions
 */
function isSearcherMessage(ctx, meta, searchOptions) {
    const from = ctx.from;
    if (!from || !from.is_bot || !ctx.message) return false;
    const expected = String(searchOptions.botUsername || "").toLowerCase();
    const username = String(from.username || "").toLowerCase();
    if (expected && username === expected) return true;
    if (meta && meta.searcherBotId && from.id === meta.searcherBotId) return true;
    return false;
}

/**
 * Pick the transport for a run: the account (MTProto bypass) when it is
 * connected and wanted, otherwise the plain Bot API.
 *
 * @param {{ userbot?: { isReady?: () => boolean, searcherId?: number, send: (text: string) => Promise<any>, classify: (err: any) => string } }} meta
 * @param {{ botUsername: string, transport?: string }} searchOptions
 * @param {import('telegraf').Context} ctx
 */
function pickTransport(meta, searchOptions, ctx) {
    const want = String((searchOptions && searchOptions.transport) || "auto").toLowerCase();
    const userbot = meta && meta.userbot;
    const userbotReady = Boolean(userbot && typeof userbot.isReady === "function" && userbot.isReady());

    if ((want === "userbot" || want === "auto") && userbotReady) {
        return {
            kind: "userbot",
            userbot,
            classify: (err) => userbot.classify(err),
            send: (text) => userbot.send(text),
        };
    }
    if (want === "userbot" && !userbotReady) {
        return {
            kind: "userbot",
            userbot: null,
            classify: () => "userbot_not_ready",
            send: async () => {
                throw new Error("USERBOT_NOT_READY: start the MTProto userbot first (see README)");
            },
        };
    }
    return {
        kind: "bot",
        userbot: null,
        classify: (err) => searchbot.classifySendError(err),
        send: (text) => ctx.telegram.sendMessage(`@${searchOptions.botUsername}`, text),
    };
}

/**
 * Did this message bring a result that the account transport shared here?
 * Covers Telegram 7+ forward_origin and the older forward_from field, plus
 * pinned copies the bypass leaves behind.
 *
 * @param {import('telegraf').Context} ctx
 * @param {{ searcherBotId?: number }} meta
 * @param {{ botUsername: string }} searchOptions
 * @param {string} [marker]
 */
function isSearcherForward(ctx, meta, searchOptions, marker = "#ulp") {
    const msg = ctx.message;
    if (!msg || ctx.from.is_bot) return false;
    const expected = String(searchOptions.botUsername || "").toLowerCase();

    const origin =
        msg.forward_origin ||
        (msg.forward_from
            ? { type: "user", sender_user: msg.forward_from }
            : null);
    if (origin && origin.type === "user" && origin.sender_user) {
        const user = origin.sender_user;
        const username = String(user.username || "").toLowerCase();
        const metaId = meta && meta.searcherBotId;
        if (user.is_bot && expected && username === expected) return true;
        if (user.is_bot && metaId && user.id === metaId) return true;
    }

    if (typeof msg.text === "string" && msg.text.startsWith(marker + " ")) return true;
    if (typeof msg.caption === "string" && msg.caption.startsWith(marker + " ")) return true;
    return false;
}

/**
 * Cancel a chat's result-window timer.
 * @param {Map<number, NodeJS.Timeout>} windows
 * @param {number} chatId
 */
function clearUlpWindow(windows, chatId) {
    const timer = windows.get(chatId);
    if (timer) {
        clearTimeout(timer);
        windows.delete(chatId);
    }
}

/**
 * Start (or restart) a relayed ULP search:
 * query -> hist:full:<scope>, 7s before every try, every answer forwarded back.
 *
 * @param {import('telegraf').Context} ctx
 * @param {{
 *   query: string,
 *   scope: string,
 *   searchOptions: ReturnType<typeof searchbot.loadOptions>,
 *   meta: { botUsername?: string, searcherBotId?: number, userbot?: any },
 *   ulpStartedAt: Map<number, number>,
 *   ulpWindows: Map<number, NodeJS.Timeout>,
 *   cardMessageId?: number|null,
 *   sleep?: (ms: number) => Promise<void>
 * }} params
 */
async function beginUlpRun(ctx, params) {
    const { query, scope, searchOptions, meta, ulpStartedAt, ulpWindows, cardMessageId = null } = params;
    const chatId = ctx.chat.id;
    const sleep = params.sleep || defaultSleep;

    if (searchbot.isRunning(chatId)) {
        await safeReply(ctx, "\u23F3 A search is already running \u2014 tap \uD83D\uDED1 Stop first, or let it finish.");
        return;
    }
    const now = Date.now();
    const since = now - (ulpStartedAt.get(chatId) || 0);
    if (since < ULP_COOLDOWN_MS) {
        await safeReply(
            ctx,
            `\u23F3 Easy there \u2014 give it ${Math.ceil((ULP_COOLDOWN_MS - since) / 1000)}s before the next try.`,
        );
        return;
    }
    ulpStartedAt.set(chatId, now);

    // Choose how the query reaches the searcher: the account transport
    // (MTProto bypass, needs no other bot's cooperation) or the plain Bot API.
    const transport = pickTransport(meta, searchOptions, ctx);

    const steps = searchbot.buildSteps(query, scope, searchOptions.histTemplate);
    const run = searchbot.startRun(chatId, { query, scope, windowMs: searchOptions.windowMs });

    // In the bypass path the answers arrive through the account, so remember
    // where they belong even before the first send.
    if (transport.kind === "userbot" && transport.userbot.searcherId) {
        searchbot.rememberOwner(transport.userbot.searcherId, chatId);
    }

    const cardText = renderUlpStart({
        query,
        scope,
        searcherBot: searchOptions.botUsername,
        steps,
        stepDelayMs: searchOptions.stepDelayMs,
        maxTries: searchOptions.maxTries,
        transport: transport.kind,
    });

    let card;
    if (cardMessageId) {
        card = { message_id: cardMessageId };
        await safeEdit(ctx, cardMessageId, cardText, ulpKeyboard(scope));
    } else {
        card = await sendHtml(ctx, cardText, ulpKeyboard(scope));
    }

    // Hard stop for the result window, so a run can never linger forever.
    clearUlpWindow(ulpWindows, chatId);
    const timer = setTimeout(() => {
        const live = searchbot.getRun(chatId);
        if (!live || live.status !== "running") return;
        searchbot.finishRun(chatId, "expired");
        if (card) {
            safeEdit(
                ctx,
                card.message_id,
                renderUlpStopped({ query: live.query, scope: live.scope, count: live.results.length }),
                ulpKeyboard(live.scope),
            );
        }
    }, searchOptions.windowMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    ulpWindows.set(chatId, timer);

    const result = await searchbot.runSearch({
        steps,
        sleep,
        stepDelayMs: searchOptions.stepDelayMs,
        resultWaitMs: searchOptions.resultWaitMs,
        maxTries: searchOptions.maxTries,
        classify: transport.classify,
        send: async (step) => {
            const sent = await transport.send(step.text);
            if (sent && sent.chat) searchbot.rememberOwner(sent.chat.id, chatId);
            return sent;
        },
        hasResults: () => {
            const live = searchbot.getRun(chatId);
            return Boolean(live && live.results.length > 0);
        },
        shouldStop: () => !searchbot.isRunning(chatId),
        onEvent: (event) => {
            if (event.type !== "sent" || !card) return;
            safeEdit(
                ctx,
                card.message_id,
                renderUlpProgress({
                    searcherBot: searchOptions.botUsername,
                    attempt: event.attempt,
                    maxTries: searchOptions.maxTries,
                    sends: event.sends,
                    stepDelayMs: searchOptions.stepDelayMs,
                }),
                ulpKeyboard(scope),
            );
        },
    });

    // Results keep landing in the open window — nothing else to do here.
    if (result.status === "results") return;

    if (result.status === "stopped") {
        clearUlpWindow(ulpWindows, chatId);
        return; // the stop button already refreshed the card
    }

    clearUlpWindow(ulpWindows, chatId);
    searchbot.finishRun(chatId, "done");

    let text;
    if (result.status === "exhausted") {
        text = renderUlpEmpty({
            searcherBot: searchOptions.botUsername,
            query,
            scope,
            attempts: result.attempts,
            stepDelayMs: searchOptions.stepDelayMs,
        });
    } else {
        const reason = result.error && (result.error.description || result.error.errorMessage || result.error.message);
        text = renderUlpBlocked({
            kind: result.kind || "other",
            searcherBot: searchOptions.botUsername,
            ownBot: meta.botUsername || null,
            steps,
            stepDelayMs: searchOptions.stepDelayMs,
            reason: reason || null,
            transport: transport.kind,
        });
    }

    if (card) await safeEdit(ctx, card.message_id, text, ulpKeyboard(scope));
    else await safeReply(ctx, text, ulpKeyboard(scope));
}

/**
 * Forward a message that arrived from the searcher bot into every chat waiting
 * for results (or, for late answers, the chat that searched last).
 *
 * @param {import('telegraf').Context} ctx
 * @param {{ searchOptions: ReturnType<typeof searchbot.loadOptions> }} params
 */
async function relaySearcherMessage(ctx, params) {
    const { searchOptions } = params;
    const msg = ctx.message;
    const searcherChatId = ctx.chat.id;
    const kind = msg.document ? "document" : msg.photo ? "photo" : msg.video ? "video" : "text";

    const targets = searchbot.noteResult(searcherChatId, { messageId: msg.message_id, kind });

    for (const chatId of targets) {
        const run = searchbot.getRun(chatId);
        if (run && !run.headerSent) {
            run.headerSent = true;
            await sendHtmlTo(
                ctx.telegram,
                chatId,
                renderUlpResults({
                    searcherBot: searchOptions.botUsername,
                    query: run.query,
                    scope: run.scope,
                    count: run.results.length,
                }),
            );
        }
        try {
            await ctx.telegram.forwardMessage(chatId, searcherChatId, msg.message_id, {
                ...ulpResultKeyboard(Boolean(msg.document)),
            });
        } catch (err) {
            console.error("relay forward failed:", err.message);
        }
    }
}

/**
 * Acknowledge a result the account bypass already shared into this chat:
 * it is *here*, so only tools are added (header once per run + clean button).
 *
 * @param {import('telegraf').Context} ctx
 * @param {{ searchOptions: ReturnType<typeof searchbot.loadOptions> }} params
 */
async function ackSharedResult(ctx, params) {
    const { searchOptions } = params;
    const msg = ctx.message;
    const chatId = ctx.chat.id;
    const hasDocument = Boolean(msg.document);
    const run = searchbot.getRun(chatId);
    const query = run ? run.query : "";
    const scope = run ? run.scope : "day";
    const count = run ? run.results.length : 1;

    if (run && !run.headerSent) {
        run.headerSent = true;
        await sendHtmlTo(
            ctx.telegram,
            chatId,
            renderUlpResults({
                searcherBot: searchOptions.botUsername,
                query,
                scope,
                count,
            }),
        );
    }

    try {
        await ctx.reply(
            renderUlpSharedResult({
                searcherBot: searchOptions.botUsername,
                query,
                scope,
                count,
                hasDocument,
            }),
            {
                parse_mode: "HTML",
                disable_web_page_preview: true,
                reply_parameters: { message_id: msg.message_id },
                ...ulpResultKeyboard(hasDocument),
            },
        );
    } catch (err) {
        console.error("shared-result card failed:", err.message);
    }
}

/**
 * Find the newest processable file in a directory (used by `/process local`).
 * @param {string} dir
 * @returns {string|null} full path of the newest file, or null
 */
function latestFileIn(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return null;
    }
    let newest = null;
    let newestMtime = 0;
    for (const e of entries) {
        if (!e.isFile()) continue;
        const p = path.join(dir, e.name);
        let st;
        try {
            st = fs.statSync(p);
        } catch {
            continue;
        }
        if (st.mtimeMs > newestMtime) {
            newest = p;
            newestMtime = st.mtimeMs;
        }
    }
    return newest;
}

/** Root directory from which /process is allowed to read. */
function localProcessRoot() {
    return path.resolve(process.env.LOCAL_PROCESS_ROOT || "/var/data");
}

/** Configurable admission cap for RAM-bound zip processing. */
function processMaxZipBytes() {
    const configured = Number(process.env.PROCESS_MAX_ZIP_BYTES || 0);
    return Number.isFinite(configured) && configured > 0
        ? Math.floor(configured)
        : DEFAULT_PROCESS_MAX_ZIP_BYTES;
}

/**
 * Resolve a requested input and ensure its real path remains inside the mount.
 * realpath prevents `..` and symlink escapes from exposing arbitrary host files.
 * @param {string} inputPath
 * @returns {{ path: string, root: string }}
 */
function resolveLocalInput(inputPath) {
    const root = fs.realpathSync(localProcessRoot());
    const candidate = fs.realpathSync(path.resolve(inputPath));
    const relative = path.relative(root, candidate);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
        return { path: candidate, root };
    }
    const err = new Error(`Path must stay under ${root}`);
    err.code = "OUTSIDE_LOCAL_PROCESS_ROOT";
    throw err;
}

/** Persistent directory for full cleaned outputs from /process. */
function localProcessedRoot() {
    return path.resolve(process.env.LOCAL_PROCESSED_ROOT || "/var/data/processed");
}

/**
 * Search a huge text file without loading it into memory.
 * @param {string} filePath
 * @param {string} query
 * @param {number} limit
 */
async function searchTextFile(filePath, query, limit = 20) {
    const q = String(query || "").toLowerCase();
    if (!q) return { total: 0, matches: [] };
    let total = 0;
    const matches = [];
    const rl = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: "utf8" }),
        crlfDelay: Infinity,
    });
    for await (const line of rl) {
        if (!line.toLowerCase().includes(q)) continue;
        total += 1;
        if (matches.length < limit) matches.push(line);
    }
    return { total, matches };
}

/** Build a collision-resistant output path under LOCAL_PROCESSED_ROOT. */
function processedOutputPath(name, chatId) {
    const root = localProcessedRoot();
    fs.mkdirSync(root, { recursive: true });
    const stem = sanitizeSiteSlug(name.replace(/\.[^.]+$/, "")) || "cleaned";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return path.join(root, `${stem}_${chatId}_${stamp}.txt`);
}

/**
 * Process a file already on the server's disk (e.g. /var/data/dump.zip).
 *
 * Bypasses Telegram's 20 MB upload cap entirely. Text files are streamed
 * line-by-line (memory-bounded); zip files are loaded into memory by adm-zip,
 * so huge zips should be split first.
 *
 * @param {import('telegraf').Context} ctx
 * @param {string} inputPath absolute path on the server
 */
async function processFile(ctx, inputPath) {
    let fullPath;
    let allowedRoot;

    try {
        const resolved = resolveLocalInput(inputPath);
        fullPath = resolved.path;
        allowedRoot = resolved.root;
    } catch (err) {
        if (err && err.code === "OUTSIDE_LOCAL_PROCESS_ROOT") {
            await safeReply(
                ctx,
                `\u26D4  ${B("Path blocked")}\nFiles must be under ${CODE(escapeHtml(localProcessRoot()))}.`,
            );
            return;
        }
        await safeReply(ctx, `\u26A0\uFE0F  Not found: ${CODE(escapeHtml(path.resolve(inputPath)))}`);
        return;
    }

    let stat;
    try {
        stat = fs.statSync(fullPath);
    } catch {
        await safeReply(ctx, `\u26A0\uFE0F  Not found: ${CODE(escapeHtml(fullPath))}`);
        return;
    }

    if (stat.isDirectory()) {
        await safeReply(ctx, `\u26A0\uFE0F  That's a directory. Give a file path like ${CODE("/var/data/dump.zip")}.`);
        return;
    }

    const name = path.basename(fullPath);
    const lower = name.toLowerCase();
    const isZip = lower.endsWith(".zip");
    const isText = [".txt", ".csv", ".tsv", ".log", ".lst", ".list", ".dat"].some((e) => lower.endsWith(e));

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

    const zipLimit = processMaxZipBytes();
    if (isZip && stat.size > zipLimit) {
        await safeReply(
            ctx,
            [
                `\uD83D\uDCA5  ${B("Zip too big for memory")}`,
                `That zip is ${humanSize(stat.size)} \u2014 over the`,
                `${humanSize(zipLimit)} in-memory limit.`,
                "",
                `${I("Split it on the server first (unzip to /var/data/... and process the .txt).")}`,
            ].join("\n"),
        );
        return;
    }

    // Stage 1: reading from disk.
    const progress = await ctx.reply(
        [
            `\uD83D\uDCE5  ${B("Reading")} ${escapeHtml(name)}`,
            `     \uD83D\uDCC2  ${humanSize(stat.size)}  \u00B7  ${escapeHtml(path.dirname(fullPath))}`,
            `     \uD83D\uDD12  allowed root: ${escapeHtml(allowedRoot)}`,
        ].join("\n"),
        { parse_mode: "HTML" },
    );

    if (isText) {
        await processTextFile(ctx, progress, fullPath, name, stat.size);
    } else {
        await processZipFile(ctx, progress, fullPath, name, stat.size);
    }
}

/**
 * Stream a plain-text file line-by-line, cleaning and batching as we go.
 * Memory-bounded even for 50 GB files — only one batch lives in RAM.
 *
 * @param {import('telegraf').Context} ctx
 * @param {{ message_id: number }} progress
 * @param {string} fullPath
 * @param {string} name
 * @param {number} size
 */
async function processTextFile(ctx, progress, fullPath, name, size) {
    const chatId = ctx.chat.id;
    const stats = { files: 1, total: 0, kept: 0, dropped: 0, duplicates: 0, truncated: false, skippedLarge: 0 };
    let batch = [];
    let added = { added: 0, duplicates: 0, capped: false, size: 0 };
    let lastProgressAt = 0;
    let rawSample = "";
    // site is used while flushing batches, so compute it up front (from the file
    // name) and refine it from a content sample once the file is fully read.
    const siteBase = sanitizeSiteSlug(name.replace(/\.[^.]+$/, "")) || "cleaned";
    let site = siteBase;
    let countedFile = false;
    const outputPath = processedOutputPath(name, chatId);
    const partialPath = `${outputPath}.partial`;
    const output = fs.createWriteStream(partialPath, { encoding: "utf8" });
    let writtenLines = 0;

    const rl = readline.createInterface({
        input: fs.createReadStream(fullPath, { encoding: "utf8" }),
        crlfDelay: Infinity,
    });

    const flushBatch = () => {
        if (batch.length === 0) return;
        const r = store.addLines(chatId, batch, site, { countFile: !countedFile });
        countedFile = true;
        added.added += r.added;
        added.duplicates += r.duplicates;
        added.capped = added.capped || r.capped;
        added.size = r.size;
        batch = [];
    };

    try {
        for await (const line of rl) {
            if (rawSample.length < PROCESS_SAMPLE_BYTES) rawSample += line + "\n";
            stats.total += 1;
            const cleaned = cleanLine(line);
            if (cleaned === null) {
                if (line.trim() !== "") stats.dropped += 1;
                continue;
            }
            stats.kept += 1;
            writtenLines += 1;
            if (!output.write(cleaned + "\n")) await once(output, "drain");
            batch.push(cleaned);
            if (batch.length >= PROCESS_BATCH_SIZE) flushBatch();

            if (stats.total % PROCESS_PROGRESS_EVERY === 0 && Date.now() - lastProgressAt > 3000) {
                lastProgressAt = Date.now();
                await safeEdit(
                    ctx,
                    progress.message_id,
                    [
                        `\uD83E\uDDFC  ${B("Cleaning")} ${escapeHtml(name)}`,
                        `     \u2702\uFE0F  ${num(stats.total)} lines so far \u2014 ${num(stats.kept)} kept`,
                        `     \uD83D\uDCBE  full output \u2192 ${escapeHtml(outputPath)}`,
                    ].join("\n"),
                );
            }
        }
        flushBatch();
        if (!countedFile) store.addLines(chatId, [], site, { countFile: true });
        output.end();
        await once(output, "finish");
        fs.renameSync(partialPath, outputPath);
    } catch (err) {
        output.destroy();
        fs.rmSync(partialPath, { force: true });
        throw err;
    }

    site = sanitizeSiteSlug(detectSite(rawSample, name) || "") || siteBase;
    const chatStats = store.getStats(chatId);

    await safeEdit(
        ctx,
        progress.message_id,
        [
            renderFileReport(name, stats, added, chatStats, site),
            "",
            `\uD83D\uDCBE  ${B("Full disk output")} \u00B7 ${num(writtenLines)} cleaned lines`,
            `${CODE(escapeHtml(outputPath))}`,
            `${I("Search it with /lsearch your-query. Disk output may contain repeated cleaned lines; the RAM batch remains deduped.")}`,
        ].join("\n"),
        mainKeyboard(),
    );
}

/**
 * Load and clean a zip from disk. adm-zip reads the whole archive into memory,
 * so this is capped by RAM — huge zips should be split before calling /process.
 *
 * @param {import('telegraf').Context} ctx
 * @param {{ message_id: number }} progress
 * @param {string} fullPath
 * @param {string} name
 * @param {number} size
 */
async function processZipFile(ctx, progress, fullPath, name, size) {
    // Stage 2: extracting.
    await safeEdit(
        ctx,
        progress.message_id,
        [
            `\uD83D\uDCE6  ${B("Extracting")} ${escapeHtml(name)}`,
            `     \uD83E\uDDF0  unzipping nested archives\u2026`,
        ].join("\n"),
    );

    const buffer = fs.readFileSync(fullPath);

    // Stage 3: cleaning.
    const result = extractAndCleanZip(buffer, { sourceName: name });

    await safeEdit(
        ctx,
        progress.message_id,
        [
            `\uD83E\uDDFC  ${B("Cleaning")} ${escapeHtml(name)}`,
            `     \u2702\uFE0F  filtering ${num(result.stats.total)} lines\u2026`,
        ].join("\n"),
    );

    const nameStem = sanitizeSiteSlug(name.replace(/\.[^.]+$/, ""));
    const site = sanitizeSiteSlug(result.site || "") || nameStem || "cleaned";

    const added = store.addLines(ctx.chat.id, result.lines, site);
    const chatStats = store.getStats(ctx.chat.id);
    const outputPath = processedOutputPath(name, ctx.chat.id);
    fs.writeFileSync(outputPath, buildOutput(result.lines), "utf8");

    await safeEdit(
        ctx,
        progress.message_id,
        [
            renderFileReport(name, result.stats, added, chatStats, site),
            "",
            `\uD83D\uDCBE  ${B("Full disk output")}`,
            `${CODE(escapeHtml(outputPath))}`,
            `${I("Search it with /lsearch your-query.")}`,
        ].join("\n"),
        mainKeyboard(),
    );
}

module.exports = {
    createBot,
    buildOutput,
    humanSize,
    escapeHtml,
    parseUlpArg,
    isSearcherMessage,
    isSearcherForward,
    pickTransport,
    processFile,
    latestFileIn,
    localProcessRoot,
    resolveLocalInput,
    searchTextFile,
    processedOutputPath,
};


