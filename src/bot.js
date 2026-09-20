"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("node:readline");
const { once } = require("node:events");
const { Telegraf, Markup } = require("telegraf");
const { extractAndCleanZip, extractAndCleanText, isZipBuffer } = require("./extractor");
const { sanitizeSiteSlug, detectSite } = require("./sites");
const { cleanLine } = require("./cleaner");
const { getSharedPool } = require("./worker-pool");
const searchbot = require("./searchbot");
const store = require("./store");
const userbot = require("./userbot");
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
    renderUlpDone,
    renderUlpEmpty,
    renderUlpStopped,
    renderUlpBlocked,
    renderUlpSharedResult,
    renderServerFiles,
    renderSaveGuide,
    serverFilesKeyboard,
    ulpMenuKeyboard,
    saveGuideKeyboard,
    searchPromptKeyboard,
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
const PROCESS_BATCH_SIZE = 25000; // cleaned lines per store.addLines call
const PROCESS_SAMPLE_BYTES = 1024 * 1024; // 1 MB of raw text kept for site detection
const PROCESS_PROGRESS_EVERY = 500_000; // progress edit every N source lines

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

/** Convert MTProto /save failures into actionable, HTML-safe guidance. */
function renderSaveError(err) {
    const raw = String((err && (err.errorMessage || err.message)) || err || "Unknown error");
    if (raw.includes("ACCOUNT_CANNOT_SEE_CHAT")) {
        return [
            `\uD83D\uDEAB  ${B("ACCOUNT CANNOT SEE THIS GROUP")}`,
            RULE,
            `The Telegram account behind ${B("TELEGRAM_SESSION")} could not resolve this group.`,
            "",
            `\u2022 Confirm ${B("@bullxgod")} is still a member of this exact group`,
            `\u2022 Open the group once from that account so it appears in its chat list`,
            `\u2022 Forward the file again, then reply with ${CODE("/save@ulpsorter69bot")}`,
        ].join("\n");
    }
    if (raw.includes("MESSAGE_NOT_VISIBLE")) {
        return [
            `\uD83D\uDC40  ${B("MESSAGE NOT VISIBLE TO THE ACCOUNT")}`,
            RULE,
            `The group is visible, but the MTProto account cannot fetch that replied message.`,
            "",
            `Forward the original file into the group again, then reply directly to the new message with`,
            CODE("/save@ulpsorter69bot"),
        ].join("\n");
    }
    if (raw.includes("REPLIED_MESSAGE_HAS_NO_MEDIA")) {
        return [
            `\uD83D\uDCCC  ${B("REPLY HAS NO DOWNLOADABLE FILE")}`,
            RULE,
            `Reply directly to a Telegram ${B("document/file")}, not a text message, album caption, or service message.`,
        ].join("\n");
    }
    if (/FILE_TOO_BIG|FILE_PART|LIMIT/i.test(raw)) {
        return [
            `\uD83D\uDCE6  ${B("TELEGRAM FILE LIMIT REACHED")}`,
            RULE,
            `Telegram refused the account download. This bypasses the bot's 20 MB cap, but not Telegram's own user-file limit.`,
            `${I("For very large files, upload directly to /var/data and run /process.")}`,
        ].join("\n");
    }
    return [
        `\uD83D\uDCA5  ${B("TELEGRAM DOWNLOAD FAILED")}`,
        RULE,
        `${I(escapeHtml(raw))}`,
        "",
        `Confirm the MTProto account is a member of this group, open the group from that account once, and try again.`,
    ].join("\n");
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

    const showServerFiles = async (ctx, editMessageId = null) => {
        const rawRoot = localProcessRoot();
        const processedRoot = localProcessedRoot();
        const rawFiles = scanDirFiles(rawRoot);
        const processedFiles = scanDirFiles(processedRoot);
        const text = renderServerFiles({
            rawFiles,
            processedFiles,
            rawRoot,
            processedRoot,
            humanSize,
        });
        if (editMessageId) {
            await safeEdit(ctx, editMessageId, text, serverFilesKeyboard(rawFiles, processedFiles));
        } else {
            await safeReply(ctx, text, serverFilesKeyboard(rawFiles, processedFiles));
        }
    };

    bot.command("files", async (ctx) => {
        await showServerFiles(ctx);
    });

    bot.command("serverfiles", async (ctx) => {
        await showServerFiles(ctx);
    });

    bot.command("list", async (ctx) => {
        await showServerFiles(ctx);
    });

    bot.action("server_files", async (ctx) => {
        await ctx.answerCbQuery("📂 Opening server vault…").catch(() => { });
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        await showServerFiles(ctx, msg ? msg.message_id : null);
    });

    bot.action("files:refresh", async (ctx) => {
        await ctx.answerCbQuery("🔄 Files refreshed").catch(() => { });
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        await showServerFiles(ctx, msg ? msg.message_id : null);
    });

    bot.action(/^file:clean:(\d+)$/, async (ctx) => {
        const idx = parseInt(ctx.match[1], 10);
        await ctx.answerCbQuery(`🧼 Cleaning file #${idx + 1}…`).catch(() => { });
        const rawFiles = scanDirFiles(localProcessRoot());
        if (!rawFiles[idx]) {
            await safeReply(ctx, `⚠️ File #${idx + 1} not found in server vault.`, mainKeyboard());
            return;
        }
        const file = rawFiles[idx];
        const status = await ctx.reply(
            `⚡️  ${B("MULTI-CORE CLEANING STARTED")}\n📄  ${escapeHtml(file.name)} (${humanSize(file.size)})\n🚀  Saturating all CPU cores…`,
            { parse_mode: "HTML" },
        );
        try {
            await processFile(ctx, file.path, status.message_id);
        } catch (err) {
            await safeEdit(ctx, status.message_id, `💥  ${B("Cleaning failed")}: ${escapeHtml(err.message)}`, mainKeyboard());
        }
    });

    bot.action("files:clean:all", async (ctx) => {
        await ctx.answerCbQuery("⚡️ Batch cleaning all raw files…").catch(() => { });
        const rawFiles = scanDirFiles(localProcessRoot());
        if (rawFiles.length === 0) {
            await safeReply(ctx, "📭 No raw files to clean in server vault.", mainKeyboard());
            return;
        }
        const status = await ctx.reply(
            `⚡️  ${B("BATCH CLEANING")} ${rawFiles.length} file(s) across all CPU cores…`,
            { parse_mode: "HTML" },
        );
        for (let i = 0; i < rawFiles.length; i++) {
            const f = rawFiles[i];
            await safeEdit(ctx, status.message_id, `🧼  ${B(`[${i + 1}/${rawFiles.length}] Cleaning`)} ${escapeHtml(f.name)}…`);
            try {
                await processFile(ctx, f.path, null);
            } catch (err) {
                console.error(`Error processing ${f.name}:`, err);
            }
        }
        await safeEdit(
            ctx,
            status.message_id,
            `✨  ${B("All files cleaned successfully into batch!")}\n📦  Tap below to download the combined result:`,
            afterCombineKeyboard(),
        );
    });

    bot.action(/^file:search:(\d+)$/, async (ctx) => {
        const idx = parseInt(ctx.match[1], 10);
        await ctx.answerCbQuery().catch(() => { });
        const rawFiles = scanDirFiles(localProcessRoot());
        const file = rawFiles[idx];
        if (!file) {
            await safeReply(ctx, `⚠️ File #${idx + 1} not found.`, mainKeyboard());
            return;
        }
        await safeReply(
            ctx,
            [
                `🔎  ${B("SEARCH FILE")} \u00B7 ${B(escapeHtml(file.name))}`,
                `📁  Size: ${humanSize(file.size)}`,
                "",
                `${I("Tap a quick filter below or type /lsearch <query>:")}`,
            ].join("\n"),
            Markup.inlineKeyboard([
                [
                    Markup.button.callback("📧 Gmail", `file:dosearch:${idx}:gmail.com`),
                    Markup.button.callback("📧 Hotmail", `file:dosearch:${idx}:hotmail.com`),
                ],
                [
                    Markup.button.callback("📧 Yahoo", `file:dosearch:${idx}:yahoo.com`),
                    Markup.button.callback("🌐 .com", `file:dosearch:${idx}:.com`),
                ],
                [
                    Markup.button.callback("🔙 Server Vault", "server_files"),
                ],
            ]),
        );
    });

    bot.action(/^file:dosearch:(\d+):(.+)$/, async (ctx) => {
        const idx = parseInt(ctx.match[1], 10);
        const query = ctx.match[2];
        await ctx.answerCbQuery(`Searching ${query}…`).catch(() => { });
        const rawFiles = scanDirFiles(localProcessRoot());
        const file = rawFiles[idx];
        if (!file) {
            await safeReply(ctx, "⚠️ File not found.", mainKeyboard());
            return;
        }
        const status = await ctx.reply(
            `🔎  ${B("MULTI-CORE SEARCH")} ${escapeHtml(file.name)} for ${CODE(escapeHtml(query))}…`,
            { parse_mode: "HTML" },
        );
        try {
            const result = await searchTextFile(file.path, query, 20);
            await safeEdit(ctx, status.message_id, renderSearch(query, result), mainKeyboard());
        } catch (err) {
            await safeEdit(ctx, status.message_id, `💥 Search failed: ${escapeHtml(err.message)}`, mainKeyboard());
        }
    });

    bot.action("ulp:menu", async (ctx) => {
        await ctx.answerCbQuery("🚀 ULP Target Selector").catch(() => { });
        const text = [
            `🚀  ${B("SELECT ULP SEARCH TARGET")}  ⚡️`,
            RULE,
            `🤖  Searcher: ${CODE(`@${escapeHtml(searchOptions.botUsername || "DumpNews14Bot")}`)}`,
            `🎯  Mode: ${B("Automatic Latest Batch Step-Down")}`,
            "",
            `👇 ${I("Tap any target button below to start searching immediately:")}`,
        ].join("\n");
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        if (msg) {
            await safeEdit(ctx, msg.message_id, text, ulpMenuKeyboard());
        } else {
            await safeReply(ctx, text, ulpMenuKeyboard());
        }
    });

    bot.action(/^ulp:quick:(.+)$/, async (ctx) => {
        const query = ctx.match[1];
        await ctx.answerCbQuery(`🚀 Launching ${query}…`).catch(() => { });
        await beginUlpRun(ctx, {
            query,
            scope: "day",
            searchOptions,
            meta,
            ulpStartedAt,
            ulpWindows,
            cardMessageId: ctx.callbackQuery && ctx.callbackQuery.message ? ctx.callbackQuery.message.message_id : null,
        });
    });

    bot.action("batch:search:prompt", async (ctx) => {
        await ctx.answerCbQuery().catch(() => { });
        const text = [
            `🔎  ${B("QUICK BATCH SEARCH")}  ⚡️`,
            RULE,
            `💎  Batch size: ${B(num(store.getStats(ctx.chat.id)?.size || 0))} lines`,
            "",
            `👇 ${I("Tap a quick domain filter below or type /search <query>:")}`,
        ].join("\n");
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        if (msg) {
            await safeEdit(ctx, msg.message_id, text, searchPromptKeyboard());
        } else {
            await safeReply(ctx, text, searchPromptKeyboard());
        }
    });

    bot.action(/^batch:quicksearch:(.+)$/, async (ctx) => {
        const query = ctx.match[1];
        await ctx.answerCbQuery(`Searching ${query}…`).catch(() => { });
        const chatStats = store.getStats(ctx.chat.id);
        let result;
        if (chatStats && chatStats.size > 5000) {
            result = await getSharedPool().searchLinesParallel(store.getLines(ctx.chat.id), query, 20);
        } else {
            result = store.searchLines(ctx.chat.id, query, 20);
        }
        await safeReply(ctx, renderSearch(query, result), mainKeyboard());
    });

    bot.action("help:save", async (ctx) => {
        await ctx.answerCbQuery().catch(() => { });
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        if (msg) {
            await safeEdit(ctx, msg.message_id, renderSaveGuide(), saveGuideKeyboard());
        } else {
            await safeReply(ctx, renderSaveGuide(), saveGuideKeyboard());
        }
    });

    bot.command("lsearch", async (ctx) => {
        const raw = (ctx.message.text || "").replace(/^\S+\s*/, "").trim();
        const parts = raw.split(/\s+/);
        const query = parts[0] || "";
        const specifiedName = parts[1] || "";

        if (query.length < 2) {
            await safeReply(
                ctx,
                `${I("Usage:")} ${CODE("/lsearch example.com [filename]")}\nSearches cleaned files under ${CODE(localProcessedRoot())} or raw dumps in ${CODE(localProcessRoot())}.`,
            );
            return;
        }

        let file = null;
        if (specifiedName) {
            const p1 = path.join(localProcessedRoot(), specifiedName);
            const p2 = path.join(localProcessRoot(), specifiedName);
            if (fs.existsSync(p1)) file = p1;
            else if (fs.existsSync(p2)) file = p2;
            else {
                const allProcessed = scanDirFiles(localProcessedRoot());
                const match = allProcessed.find((f) => f.name.toLowerCase().includes(specifiedName.toLowerCase()));
                if (match) file = match.path;
            }
        }
        if (!file) {
            file = latestFileIn(localProcessedRoot()) || latestFileIn(localProcessRoot());
        }
        if (!file) {
            await safeReply(ctx, `\u26A0\uFE0F  No processed output found under ${CODE(localProcessedRoot())}. Run ${CODE("/process /var/data/file.txt")} first.`);
            return;
        }
        const status = await ctx.reply(
            `🔎  ${B("LOCAL SEARCH")}  ⚡️\n${CODE(escapeHtml(query))}\n📂 ${I(escapeHtml(path.basename(file)))}`,
            { parse_mode: "HTML" },
        );
        try {
            const result = await searchTextFile(file, query, 20);
            await safeEdit(ctx, status.message_id, renderSearch(query, result), mainKeyboard());
        } catch (err) {
            await safeEdit(ctx, status.message_id, `💥  ${B("Local search failed")}\n${I(escapeHtml(err.message))}`);
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
        let replied = ctx.message && ctx.message.reply_to_message;
        let sourceMessageId = replied && replied.message_id;
        let originalName = replied && replied.document && (replied.document.file_name || `telegram-${sourceMessageId}.bin`);
        let docSize = replied && replied.document && replied.document.file_size;
        let repliedMessageObj = null;

        const peer = meta.userbot;

        // If Bot API didn't deliver the replied document (e.g. Telegram Bot Privacy Mode in private groups),
        // use the MTProto userbot to inspect the chat's actual replied message or recent documents!
        if ((!replied || !replied.document) && peer && typeof peer.isReady === "function" && peer.isReady() && typeof peer.findRepliedOrRecentDocument === "function") {
            try {
                const found = await peer.findRepliedOrRecentDocument(
                    ctx.chat.id,
                    ctx.message && ctx.message.message_id,
                    sourceMessageId,
                );
                if (found) {
                    sourceMessageId = found.messageId;
                    originalName = found.fileName || `telegram-${sourceMessageId}.bin`;
                    docSize = found.size;
                    repliedMessageObj = found.message || null;
                    replied = { message_id: found.messageId, document: { file_name: originalName, file_size: found.size } };
                }
            } catch (err) {
                console.error("userbot findRepliedOrRecentDocument failed:", err && err.message ? err.message : err);
            }
        }

        if (!replied || !replied.document) {
            await safeReply(
                ctx,
                [
                    `📌  ${B("REPLY TO A FILE")}`,
                    RULE,
                    `Forward or upload the document into a private group containing:`,
                    `  • your MTProto user account`,
                    `  • ${B(meta.botUsername ? `@${escapeHtml(meta.botUsername)}` : "this bot")}`,
                    `Then reply directly to the document with ${CODE("/save")}.`,
                    "",
                    `${I("Tip: If you already replied and see this message, make the bot an admin in this group or disable Group Privacy in @BotFather so Telegram sends replies directly.")}`,
                    "",
                    `${I("Direct private forwarding to the bot stays limited to 20 MB. Telegram itself usually caps user files at 2 GB, or 4 GB with Premium.")}`,
                ].join("\n"),
            );
            return;
        }

        if (!peer || typeof peer.isReady !== "function" || !peer.isReady()) {
            await safeReply(
                ctx,
                `⚠️  ${B("Account downloader is offline")}\nSet TELEGRAM_API_ID, TELEGRAM_API_HASH and TELEGRAM_SESSION, then redeploy.`,
            );
            return;
        }
        if (localJobs.has(ctx.chat.id)) {
            await safeReply(ctx, `\u23F3  Already processing ${CODE(escapeHtml(localJobs.get(ctx.chat.id)))}.`);
            return;
        }

        sourceMessageId = replied.message_id;
        originalName = (replied.document && replied.document.file_name) || originalName || `telegram-${sourceMessageId}.bin`;
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
            message: repliedMessageObj,
            onProgress: (done, total) => {
                if (Date.now() - lastProgressAt < 3000) return;
                lastProgressAt = Date.now();
                const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
                void safeEdit(
                    ctx,
                    status.message_id,
                    [
                        `📥  ${B("DOWNLOADING FROM TELEGRAM")} · ${pct}%`,
                        RULE,
                        `📄  ${escapeHtml(originalName)}`,
                        `📦  ${humanSize(done)} / ${humanSize(total || done)}`,
                    ].join("\n"),
                );
            },
        })
            .then(async (saved) => {
                await processFile(ctx, saved.path, status.message_id);
            })
            .catch((err) => safeEdit(
                ctx,
                status.message_id,
                renderSaveError(err),
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
            startDate: parsed.startDate || null,
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
                ulpKeyboard("stopped"),
            );
        }
        await deliverCombinedAndResetBatch(ctx);
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
            await ackSharedResult(ctx, { searchOptions, meta });
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

    // Stage 2: extracting (async notification without blocking processing)
    void safeEdit(
        ctx,
        progress.message_id,
        [
            `📦  ${B("Extracting")} ${escapeHtml(name)}`,
            `     🧵  unzipping nested archives…`,
        ].join("\n"),
    );
    void ctx.replyWithChatAction("typing").catch(() => { });

    // Stage 3: cleaning.
    const keepUrl = true;
    const result =
        isZip || isZipBuffer(buffer)
            ? extractAndCleanZip(buffer, { sourceName: name, keepUrl })
            : extractAndCleanText(buffer.toString("utf8"), { sourceName: name, keepUrl });

    void safeEdit(
        ctx,
        progress.message_id,
        [
            `🧼  ${B("Cleaning")} ${escapeHtml(name)}`,
            `     ✂️  filtering ${num(result.stats.total)} lines…`,
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

const activeIngestions = new Map(); // chatId -> Set<Promise<any>>

function trackIngestion(chatId, promise) {
    if (!chatId || !promise || typeof promise.finally !== "function") return;
    if (!activeIngestions.has(chatId)) {
        activeIngestions.set(chatId, new Set());
    }
    const set = activeIngestions.get(chatId);
    set.add(promise);
    promise.finally(() => {
        set.delete(promise);
        if (set.size === 0) activeIngestions.delete(chatId);
    });
}

async function waitForIngestions(chatId) {
    const set = activeIngestions.get(chatId);
    if (set && set.size > 0) {
        await Promise.allSettled(Array.from(set));
    }
}

const deliveringCombined = new Set();

async function deliverCombinedAndResetBatch(ctx) {
    const chatId = ctx.chat && ctx.chat.id;
    if (!chatId || deliveringCombined.has(chatId)) return;
    deliveringCombined.add(chatId);
    try {
        await waitForIngestions(chatId);
        await new Promise((r) => setTimeout(r, 1200));
        const lines = store.getLines(chatId);
        if (lines.length > 0) {
            await sendCombined(ctx);
            store.clear(chatId);
            await safeReply(ctx, "\uD83E\uDDF9 Batch automatically cleaned and reset.");
        } else {
            await safeReply(ctx, "\uD83D\uDCED Search completed, but no credentials were found in the batch.");
        }
    } catch (err) {
        console.error("deliverCombinedAndResetBatch failed:", err);
    } finally {
        deliveringCombined.delete(chatId);
    }
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

    const lastToken = parts[parts.length - 1];
    const parsedDate = userbot.parseDmyDate(lastToken);
    if (parsedDate && parts.length > 1) {
        const queryParts = parts.slice(0, -1);
        return {
            query: searchbot.normalizeQuery(queryParts.join(" ")),
            scope: "day",
            startDate: parsedDate,
        };
    }

    const lastScope = searchbot.normalizeScope(lastToken, null);
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
    if (!msg || (ctx.from && ctx.from.is_bot)) return false;
    const expected = String((searchOptions && searchOptions.botUsername) || "").replace(/^@+/, "").toLowerCase();

    const origin =
        msg.forward_origin ||
        (msg.forward_from
            ? { type: "user", sender_user: msg.forward_from }
            : null);
    if (origin && origin.type === "user" && origin.sender_user) {
        const user = origin.sender_user;
        const username = String(user.username || "").toLowerCase();
        const metaId = meta && meta.searcherBotId;
        if (expected && username === expected) return true;
        if (metaId && Number(user.id) === Number(metaId)) return true;
    }

    if (origin && (origin.type === "channel" || origin.type === "chat") && origin.chat) {
        const chatUsername = String(origin.chat.username || "").toLowerCase();
        const metaId = meta && meta.searcherBotId;
        if (expected && chatUsername === expected) return true;
        if (metaId && Number(origin.chat.id) === Number(metaId)) return true;
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
    const { query, scope, startDate = null, searchOptions, meta, ulpStartedAt, ulpWindows, cardMessageId = null } = params;
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

    let result;
    if (scope === "day" && transport.kind === "userbot" && typeof transport.userbot.searchDayByDay === "function") {
        const daysCount = searchOptions.daysCount || 5;
        const dayRes = await transport.userbot.searchDayByDay({
            query,
            daysCount,
            startDate: startDate || new Date(),
            chatId,
            stepDelayMs: searchOptions.stepDelayMs,
            shouldStop: () => !searchbot.isRunning(chatId),
            onStatus: (st) => {
                if (!card) return;
                safeEdit(
                    ctx,
                    card.message_id,
                    renderUlpProgress({
                        searcherBot: searchOptions.botUsername,
                        attempt: st.attempt,
                        maxTries: st.totalDays,
                        sends: [`${st.day}: ${st.step}`],
                        stepDelayMs: searchOptions.stepDelayMs,
                    }),
                    ulpKeyboard(scope),
                );
            },
            sleep,
        });

        clearUlpWindow(ulpWindows, chatId);
        const finalStatus = dayRes.status === "stopped" ? "stopped" : "done";
        searchbot.finishRun(chatId, finalStatus);
        if (card) {
            const resultCount = (searchbot.getRun(chatId) || {}).results?.length || 0;
            const text = finalStatus === "done"
                ? renderUlpDone({ query, scope, count: resultCount })
                : renderUlpStopped({ query, scope, count: resultCount });
            await safeEdit(
                ctx,
                card.message_id,
                text,
                ulpKeyboard(finalStatus),
            );
        }
        await deliverCombinedAndResetBatch(ctx);
        return;
    } else {
        result = await searchbot.runSearch({
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
    }

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
 * When a document is attached, it is automatically processed and cleaned into the batch.
 *
 * @param {import('telegraf').Context} ctx
 * @param {{ searchOptions: ReturnType<typeof searchbot.loadOptions>, meta?: any }} params
 */
async function ackSharedResult(ctx, params) {
    const { searchOptions, meta = {} } = params;
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

    // Auto-clean the document immediately into the batch!
    if (hasDocument) {
        const doc = msg.document;
        const size = doc.file_size || 0;
        if (size <= MAX_DOWNLOAD_BYTES) {
            const p = ingestDocument(ctx, doc).catch((err) => {
                console.error("auto ingestDocument failed:", err && err.message ? err.message : err);
            });
            trackIngestion(chatId, p);
        } else {
            const peer = meta && meta.userbot;
            if (peer && typeof peer.isReady === "function" && peer.isReady()) {
                const name = doc.file_name || `result-${msg.message_id}.txt`;
                const p = peer.downloadMessageToDisk(chatId, msg.message_id, {
                    root: localProcessRoot(),
                    fileName: name,
                })
                    .then((saved) => processFile(ctx, saved.path))
                    .catch((err) => {
                        console.error("auto-process via userbot failed:", err && err.message ? err.message : err);
                    });
                trackIngestion(chatId, p);
            }
        }
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

/**
 * Scan a directory for files, returning metadata sorted newest first.
 * @param {string} dir
 * @returns {Array<{ name: string, path: string, size: number, mtime: Date }>}
 */
function scanDirFiles(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const files = [];
    for (const e of entries) {
        if (!e.isFile()) continue;
        const p = path.join(dir, e.name);
        try {
            const st = fs.statSync(p);
            files.push({
                name: e.name,
                path: p,
                size: st.size,
                mtime: st.mtime,
            });
        } catch {
            continue;
        }
    }
    files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return files;
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
    const q = String(query || "").trim();
    if (!q) return { total: 0, matches: [] };
    const pool = getSharedPool();
    let total = 0;
    const matches = [];
    let buffer = [];
    const CHUNK_SIZE = 25000;

    const rl = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: "utf8", highWaterMark: 1024 * 1024 }),
        crlfDelay: Infinity,
    });
    for await (const line of rl) {
        buffer.push(line);
        if (buffer.length >= CHUNK_SIZE) {
            const res = await pool.searchLinesParallel(buffer, q);
            total += res.total;
            for (const m of res.matches) {
                if (matches.length < limit) matches.push(m);
            }
            buffer = [];
        }
    }
    if (buffer.length > 0) {
        const res = await pool.searchLinesParallel(buffer, q);
        total += res.total;
        for (const m of res.matches) {
            if (matches.length < limit) matches.push(m);
        }
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
async function processFile(ctx, inputPath, progressMessageId = null) {
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
                `⛔  ${B("Path blocked")}\nFiles must be under ${CODE(escapeHtml(localProcessRoot()))}.`,
            );
            return;
        }
        await safeReply(ctx, `⚠️  Not found: ${CODE(escapeHtml(path.resolve(inputPath)))}`);
        return;
    }

    let stat;
    try {
        stat = fs.statSync(fullPath);
    } catch {
        await safeReply(ctx, `⚠️  Not found: ${CODE(escapeHtml(fullPath))}`);
        return;
    }

    if (stat.isDirectory()) {
        await safeReply(ctx, `⚠️  That's a directory. Give a file path like ${CODE("/var/data/dump.zip")}.`);
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
                `⛔  ${B("Unsupported file type")}`,
                `I only handle ${B(".zip")} archives and plain text files`,
                `(${B(".txt")}, .csv, .tsv, .log, …) 📁`,
            ].join("\n"),
        );
        return;
    }

    const zipLimit = processMaxZipBytes();
    if (isZip && stat.size > zipLimit) {
        await safeReply(
            ctx,
            [
                `💥  ${B("Zip too big for memory")}`,
                `That zip is ${humanSize(stat.size)} — over the`,
                `${humanSize(zipLimit)} in-memory limit.`,
                "",
                `${I("Split it on the server first (unzip to /var/data/... and process the .txt).")}`,
            ].join("\n"),
        );
        return;
    }

    // Stage 1: reading from disk.
    let progress;
    if (progressMessageId) {
        progress = { message_id: progressMessageId };
        void safeEdit(
            ctx,
            progressMessageId,
            [
                `📥  ${B("Reading")} ${escapeHtml(name)}`,
                `     📁  ${humanSize(stat.size)}  ·  ${escapeHtml(path.dirname(fullPath))}`,
            ].join("\n"),
        );
    } else {
        progress = await ctx.reply(
            [
                `📥  ${B("Reading")} ${escapeHtml(name)}`,
                `     📁  ${humanSize(stat.size)}  ·  ${escapeHtml(path.dirname(fullPath))}`,
                `     🔒  allowed root: ${escapeHtml(allowedRoot)}`,
            ].join("\n"),
            { parse_mode: "HTML" },
        );
    }

    if (isText) {
        await processTextFile(ctx, progress, fullPath, name, stat.size, { keepUrl: true });
    } else {
        await processZipFile(ctx, progress, fullPath, name, stat.size, { keepUrl: true });
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
async function processTextFile(ctx, progress, fullPath, name, size, options = {}) {
    const chatId = ctx.chat.id;
    const keepUrl = options.keepUrl !== false;
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
    const output = fs.createWriteStream(partialPath, { encoding: "utf8", highWaterMark: 1024 * 1024 });
    let writtenLines = 0;
    const seen = new Set();
    const pool = getSharedPool();
    let lineBuffer = [];
    const PARALLEL_CHUNK = 25000;

    const rl = readline.createInterface({
        input: fs.createReadStream(fullPath, { encoding: "utf8", highWaterMark: 1024 * 1024 }),
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

    const processBuffer = async () => {
        if (lineBuffer.length === 0) return;
        const currentLines = lineBuffer;
        lineBuffer = [];
        stats.total += currentLines.length;

        let res;
        if (currentLines.length < 5000) {
            const { cleanText } = require("./cleaner");
            res = cleanText(currentLines.join("\n"), { keepUrl, dedupe: false });
        } else {
            // Execute parallel multi-core cleaning across worker threads
            res = await pool.cleanLinesParallel(currentLines, { keepUrl, dedupe: false });
        }
        stats.dropped += res.stats.dropped;

        for (let i = 0; i < res.lines.length; i++) {
            const cleaned = res.lines[i];
            if (seen.has(cleaned)) {
                stats.duplicates += 1;
                continue;
            }
            if (seen.size < 2_000_000) {
                seen.add(cleaned);
            }
            stats.kept += 1;
            writtenLines += 1;
            if (!output.write(cleaned + "\n")) await once(output, "drain");
            batch.push(cleaned);
            if (batch.length >= PROCESS_BATCH_SIZE) flushBatch();
        }

        if (stats.total >= PROCESS_PROGRESS_EVERY && Date.now() - lastProgressAt > 3000) {
            lastProgressAt = Date.now();
            await safeEdit(
                ctx,
                progress.message_id,
                [
                    `⚡️  ${B("Multi-Core Cleaning")} ${escapeHtml(name)}`,
                    `     🚀  ${num(stats.total)} lines scanned \u2014 ${num(stats.kept)} kept`,
                    `     💎  full output \u2192 ${escapeHtml(outputPath)}`,
                ].join("\n"),
            );
        }
    };

    try {
        for await (const line of rl) {
            if (rawSample.length < PROCESS_SAMPLE_BYTES) rawSample += line + "\n";
            lineBuffer.push(line);
            if (lineBuffer.length >= PARALLEL_CHUNK) {
                await processBuffer();
            }
        }
        if (lineBuffer.length > 0) {
            await processBuffer();
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
async function processZipFile(ctx, progress, fullPath, name, size, options = {}) {
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
    const keepUrl = options.keepUrl !== false;

    // Stage 3: cleaning.
    const result = extractAndCleanZip(buffer, { sourceName: name, keepUrl });

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
    renderSaveError,
    scanDirFiles,
};


