"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("node:readline");
const { once } = require("node:events");
const { Telegraf, Markup } = require("telegraf");
const {
    extractAndCleanText,
    extractAndCleanZipAsync,
    extractAndCleanTextAsync,
    mergeZipFiles,
    isZipBuffer,
} = require("./extractor");
const { cleanUserPassOnly, createSearchMatcher, searchBufferCI, resolveStealerRecordFromLines, decodeBufferToText, extractSearchDomain } = require("./cleaner");
const { sanitizeSiteSlug, detectSite } = require("./sites");
const { getSharedPool } = require("./worker-pool");
const searchbot = require("./searchbot");
const store = require("./store");
const userbot = require("./userbot");
const downloads = require("./downloads");
const {
    renderStats,
    renderSites,
    renderHelp,
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
    emojisKeyboard,
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
    siteEmoji,
    sitesKeyboard,
    confirmDomainDeleteKeyboard,
    createInlineKeyboard,
    tgEmoji,
    B,
    I,
    CODE,
    RULE,
    compact,
    resolveCallbackPayload,
    registerCallbackPayload,
    ensureAnimatedEmojis,
    renderLocalSearch,
    localSearchResultKeyboard,
    renderLocalSearchHub,
    localSearchHubKeyboard,
    localFileSearchKeyboard,
    renderFileSearchProgress,
    fileSearchProgressKeyboard,
    previewKeyboard,
    statsKeyboard,
    fileReportKeyboard,
    domainActionKeyboard,
    queryActionKeyboard,
    processPromptKeyboard,
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
    if (s === null || s === undefined || typeof s === "symbol") return "";
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
    if (typeof bytes === "symbol") return "0 B";
    const b = Number(bytes || 0);
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} MB`;
    if (b < 1024 ** 4) return `${(b / (1024 ** 3)).toFixed(2)} GB`;
    return `${(b / (1024 ** 4)).toFixed(2)} TB`;
}

/**
 * Locale-formatted number.
 * @param {number|undefined} n
 */
function num(n) {
    if (typeof n === "symbol") return "0";
    return Number(n || 0).toLocaleString("en-US");
}

/**
 * Build the combined output text for a chat.
 * @param {string[]} lines
 */
function buildOutput(lines) {
    if (!Array.isArray(lines)) return "";
    return lines.map((l) => cleanUserPassOnly(l) || l).join("\n") + (lines.length ? "\n" : "");
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
    botApiCustomEmojiRejected = false;
    const bot = new Telegraf(token, {
        handlerTimeout: 10 * 60 * 1000,
        // meta.telegram lets tests and local Bot API server users override the
        // client (e.g. { telegram: { apiRoot: "http://127.0.0.1:8081" } }).
        ...(meta.telegram || {}),
    });

    // Adapter for Telegram channels: Telegram delivers channel posts under channel_post,
    // which Telegraf by default ignores for bot.command() and bot.on("document").
    // Normalize channel_post to update.message so all commands, documents, and forwarded
    // files work seamlessly in channels as well as groups and private chats.
    bot.use((ctx, next) => {
        if (!ctx.update.message && ctx.update.channel_post) {
            ctx.update.message = ctx.update.channel_post;
        }
        if (!ctx.update.edited_message && ctx.update.edited_channel_post) {
            ctx.update.edited_message = ctx.update.edited_channel_post;
        }
        return next();
    });

    // ULP search relay configuration (see src/searchbot.js).
    const searchOptions = (meta && meta.search) || searchbot.loadOptions();
    /** chatId -> timestamp of the last relay start */
    const ulpStartedAt = new Map();
    /** chatId -> timeout that closes the result window */
    const ulpWindows = new Map();
    /** chatId -> user selected search duration in days */
    const userUlpDays = new Map();
    /** chatId -> { action: string, messageId?: number } active prompt state */
    const userPromptState = new Map();
    bot.userPromptState = userPromptState;
    const activeVaultSearches = new Map();
    bot.activeVaultSearches = activeVaultSearches;
    /** chatId -> absolute path currently being processed */
    const localJobs = new Map();
    /** chatId -> { items: Array<{ doc: any, ctx: any, name: string, messageId: number }>, timer: any, noticeId: number|null, latestCtx: any } */
    const forwardBatches = new Map();
    const forwardDebounceMs = Number(process.env.FORWARD_DEBOUNCE_MS || (meta && meta.forwardDebounceMs) || 1800);

    const localProcessRoot = (override = null) => {
        return path.resolve(override || (meta && meta.localProcessRoot) || process.env.LOCAL_PROCESS_ROOT || "/var/data");
    };
    const localProcessedRoot = (override = null) => {
        return path.resolve(override || (meta && meta.localProcessedRoot) || process.env.LOCAL_PROCESSED_ROOT || "/var/data/processed");
    };

    // Pre-warm multi-core worker pool for instantaneous zero-latency searches
    try {
        getSharedPool().warmup();
    } catch (_) {}

    const handleStartHelp = async (ctx) => {
        userPromptState.delete(ctx.chat.id);
        const batch = store.getStats(ctx.chat.id);
        await safeReply(ctx, renderHelp(meta.botUsername, batch, searchOptions.botUsername), mainKeyboard());
    };

    bot.start(handleStartHelp);
    bot.help(handleStartHelp);
    bot.command(["menu", "home", "dashboard"], handleStartHelp);

    bot.command(["stats", "status", "info", "analytics", "metrics"], async (ctx) => {
        userPromptState.delete(ctx.chat.id);
        const stats = store.getStats(ctx.chat.id);
        await safeReply(ctx, renderStats(stats), statsKeyboard(stats && stats.size > 0));
    });

    bot.command(["sites", "domains"], async (ctx) => {
        userPromptState.delete(ctx.chat.id);
        const counts = store.getSiteCounts(ctx.chat.id);
        await safeReply(ctx, renderSites(counts), sitesKeyboard(counts));
    });

    bot.command(["removedomain", "deldomain", "delsite", "rmdomain"], async (ctx) => {
        userPromptState.delete(ctx.chat.id);
        const domain = (ctx.message?.text || "").replace(/^\S+\s*/, "").trim();
        if (!domain) {
            const counts = store.getSiteCounts(ctx.chat.id);
            if (counts.length === 0) {
                return safeReply(
                    ctx,
                    `${tgEmoji("📭")} No sites/domains found in current batch to remove.`,
                    mainKeyboard()
                );
            }
            userPromptState.set(ctx.chat.id, { action: "remove_domain", createdAt: Date.now() });
            return safeReply(
                ctx,
                [
                    `${tgEmoji("🗑️")}  ${B("REMOVE DOMAIN FROM BATCH")}  ${tgEmoji("⚡️")}`,
                    RULE,
                    `Please tap a domain below to remove it, or reply with the domain name:`,
                    `Example: ${CODE("netflix.com")}`,
                ].join("\n"),
                sitesKeyboard(counts)
            );
        }
        if (domain.length < 2) {
            return safeReply(
                ctx,
                `⚠️ Please specify a valid domain or keyword with at least 2 characters.`,
                mainKeyboard()
            );
        }
        const res = store.removeDomain(ctx.chat.id, domain);
        const counts = store.getSiteCounts(ctx.chat.id);
        if (res.removed === 0) {
            return safeReply(
                ctx,
                `${tgEmoji("⚠️")} No credentials found matching ${CODE(escapeHtml(domain))} in active batch.`,
                sitesKeyboard(counts)
            );
        }
        return safeReply(
            ctx,
            [
                `${tgEmoji("🗑️")}  ${B("DOMAIN PURGED")}  ${tgEmoji("⚡️")}`,
                RULE,
                `Successfully removed ${B(num(res.removed))} credentials matching ${CODE(escapeHtml(domain))}.`,
                `Remaining batch credentials: ${B(num(res.remaining))}.`,
            ].join("\n"),
            sitesKeyboard(counts)
        );
    });

    async function sendPreview(ctx) {
        const chatId = ctx.chat && ctx.chat.id;
        if (!chatId) return;
        const lines = store.getLines(chatId);
        const sample = lines.slice(0, 10);
        const text = renderPreview(sample, lines.length);
        await safeReply(ctx, text, lines.length === 0 ? emptyBatchKeyboard() : previewKeyboard(lines.length));
    }

    bot.command(["preview", "sample"], async (ctx) => {
        userPromptState.delete(ctx.chat.id);
        await sendPreview(ctx);
    });

    bot.command(["link", "directlink"], async (ctx) => {
        userPromptState.delete(ctx.chat.id);
        const chatId = ctx.chat.id;
        const lines = store.getLines(chatId);
        const lastCombined = store.getLastCombined(chatId);

        if (lines.length === 0 && !lastCombined) {
            await safeReply(
                ctx,
                [
                    `📭  ${B("No log files or batch stored yet.")}`,
                    `Forward 2 or more log files to get a combined download link, or upload files to start a batch!`,
                ].join("\n"),
                emptyBatchKeyboard()
            );
            return;
        }

        if (lines.length > 0) {
            const base = store.getSites(chatId)[0] || "combolist";
            const stamp = new Date().toISOString().slice(0, 10);
            const filename = `${sanitizeSiteSlug(base) || "combolist"}_combined_${stamp}.txt`;
            const outputPath = path.join(localProcessedRoot(), filename);
            const content = buildOutput(lines);
            const buffer = Buffer.from(content, "utf8");

            try {
                fs.mkdirSync(localProcessedRoot(), { recursive: true });
                fs.writeFileSync(outputPath, buffer);
            } catch (err) {
                console.error("Failed to write /link combined file:", err);
            }

            const dl = downloads.registerDownload({
                filename,
                filePath: outputPath,
                buffer,
                size: buffer.length,
                chatId,
                stats: { total: lines.length, kept: lines.length },
            });

            await safeReply(
                ctx,
                [
                    `⚡  ${B("DIRECT DOWNLOAD LINK READY")}  ⚡️`,
                    RULE,
                    `  • 📑 ${B("Batch Lines:")}   ${num(lines.length)} unique`,
                    `  • 💾 ${B("Filename:")}      ${CODE(escapeHtml(filename))}`,
                    `  • 📦 ${B("File Size:")}     ${humanSize(buffer.length)}`,
                    RULE,
                    `🔗 ${B("Download URL:")}`,
                    `${dl.url}`,
                    "",
                    `💡 ${I("Direct high-speed HTTP link. Tap the button below to download:")}`,
                ].join("\n"),
                forwardedLogsKeyboard(dl.url, dl.token)
            );
            return;
        }

        if (lastCombined) {
            const isZip = Boolean(lastCombined.isZip || (lastCombined.filename || "").toLowerCase().endsWith(".zip"));
            const dl = downloads.registerDownload({
                filename: lastCombined.filename || (isZip ? "merged_logs.zip" : "combolist_combined.txt"),
                buffer: lastCombined.buffer,
                size: (lastCombined.buffer && lastCombined.buffer.length) || 0,
                mimeType: isZip ? "application/zip" : "text/plain; charset=utf-8",
                chatId,
                stats: { total: lastCombined.linesCount, kept: lastCombined.linesCount, isZip },
            });

            const countLabel = isZip ? "Archived Files:" : "Lines:";
            await safeReply(
                ctx,
                [
                    `⚡  ${B(isZip ? "DIRECT DOWNLOAD LINK (MERGED ZIP)" : "DIRECT DOWNLOAD LINK (LAST COMBINED)")}  ⚡️`,
                    RULE,
                    `  • 📑 ${B(countLabel)}         ${num(lastCombined.linesCount || 0)}`,
                    `  • 💾 ${B("Filename:")}      ${CODE(escapeHtml(lastCombined.filename || ""))}`,
                    `  • 📦 ${B("File Size:")}     ${humanSize((lastCombined.buffer && lastCombined.buffer.length) || 0)}`,
                    RULE,
                    `🔗 ${B("Download URL:")}`,
                    `${dl.url}`,
                ].join("\n"),
                isZip ? forwardedZipKeyboard(dl.url, dl.token) : forwardedLogsKeyboard(dl.url, dl.token)
            );
        }
    });

    bot.command(["mergezip", "zipmerge"], async (ctx) => {
        userPromptState.delete(ctx.chat.id);
        const chatId = ctx.chat.id;
        const text = (ctx.message?.text || "").replace(/^\S+\s*/, "").trim();
        const urls = text.split(/\s+/).filter((u) => /^https?:\/\//i.test(u));

        // 1. If URLs provided in command: fetch in-memory, merge, and output direct link
        if (urls.length > 0) {
            const statusMsg = await safeReply(
                ctx,
                `⏳  ${B("Fetching and merging remote zip files")} (${num(urls.length)} URLs) without saving to disk…`
            );
            const fetched = [];
            for (let i = 0; i < urls.length; i++) {
                try {
                    const u = urls[i];
                    const res = await fetch(u);
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const buf = Buffer.from(await res.arrayBuffer());
                    if (buf.length > 0 && isZipBuffer(buf)) {
                        fetched.push({
                            name: path.basename(new URL(u).pathname) || `archive_${i + 1}.zip`,
                            buffer: buf,
                            size: buf.length,
                        });
                    }
                } catch (err) {
                    console.error(`Failed to fetch remote zip from ${urls[i]}:`, err && err.message ? err.message : err);
                }
            }

            if (fetched.length === 0) {
                await safeEdit(ctx, statusMsg.message_id, `⚠️  Could not download any valid .zip archives from the provided URLs.`);
                return;
            }

            try {
                const combinedZip = mergeZipFiles(fetched);
                const outFilename = `merged_${sanitizeSiteSlug(fetched[0].name.replace(/\.zip$/i, ""))}_${Date.now()}.zip`;
                const dl = downloads.registerDownload({
                    filename: outFilename,
                    buffer: combinedZip.buffer,
                    size: combinedZip.compressedSize || combinedZip.buffer.length,
                    mimeType: "application/zip",
                    chatId,
                    stats: {
                        isZip: true,
                        entryCount: combinedZip.entryCount,
                        totalSize: combinedZip.totalSize,
                        compressedSize: combinedZip.buffer.length,
                    },
                });

                const reportText = renderForwardedZipCombined({
                    files: fetched.map((f) => ({ name: f.name, size: f.size })),
                    entryCount: combinedZip.entryCount,
                    folderCount: combinedZip.folderCount,
                    totalSize: combinedZip.totalSize,
                    compressedSize: combinedZip.buffer.length,
                    downloadUrl: dl.url,
                    filename: outFilename,
                });

                await safeEdit(ctx, statusMsg.message_id, reportText, forwardedZipKeyboard(dl.url, dl.token));
            } catch (err) {
                console.error("In-memory zip merge failed:", err);
                await safeEdit(ctx, statusMsg.message_id, `💥  ${B("Failed to merge zip archives:")}\n${I(escapeHtml(err.message))}`);
            }
            return;
        }

        // 2. If replied to a document
        const replyMsg = (ctx.message || ctx.channelPost)?.reply_to_message;
        if (replyMsg && replyMsg.document) {
            await handleForwardedDocument(ctx, replyMsg.document);
            return;
        }

        // 3. Otherwise show usage instructions
        await safeReply(
            ctx,
            [
                `📦  ${B("ZIP MERGER PIPELINE")}`,
                RULE,
                `Merge multiple .zip files into ONE master .zip file without downloading them to your device!`,
                "",
                `💡 ${B("How to use:")}`,
                `  1. ${B("Forward")} 2 or more .zip files to this chat.`,
                `  2. Or run: ${CODE("/mergezip <url1> <url2>")}`,
                `  3. Or reply to a .zip document with ${CODE("/mergezip")}`,
                "",
                `The bot combines all files into a single unified .zip archive and gives you one direct download link.`,
            ].join("\n"),
            mainKeyboard()
        );
    });

    bot.command(["search", "find", "s", "lookup"], async (ctx) => {
        userPromptState.delete(ctx.chat.id);
        const query = (ctx.message?.text || "").replace(/^\S+\s*/, "").trim();
        if (!query) {
            userPromptState.set(ctx.chat.id, { action: "batch:search:query", createdAt: Date.now() });
            await safeReply(
                ctx,
                [
                    `🔎  ${B("QUICK BATCH SEARCH")}  ⚡️`,
                    RULE,
                    `💎  Batch size: ${B(num(store.getStats(ctx.chat.id)?.size || 0))} lines`,
                    "",
                    `👇 ${I("Type any search query directly (e.g. gmail.com) or tap a filter below:")}`,
                ].join("\n"),
                searchPromptKeyboard(),
            );
            return;
        }
        if (query.length < 2) {
            await safeReply(ctx, "⚠️ Query too short — give me at least 2 characters.", mainKeyboard());
            return;
        }
        const result = store.searchLines(ctx.chat.id, query, 20);

        if (result && Array.isArray(result.matches)) {
            result.matches = result.matches.map((m) => cleanUserPassOnly(m) || m);
        }
        await safeReply(ctx, renderSearch(query, result), searchResultKeyboard(query, result.total));
    });

    const vaultSelectState = new Map();
    const lastCompletedSaveSessions = new Map();
    const vaultRawRoot = (meta && (meta.localProcessRoot || meta.processRoot)) ? path.resolve(meta.localProcessRoot || meta.processRoot) : localProcessRoot();
    const vaultProcessedRoot = (meta && meta.localProcessedRoot) ? path.resolve(meta.localProcessedRoot) : localProcessedRoot();
    const getVaultFiles = (sortBy = "size") => getAllVaultFiles(sortBy, vaultRawRoot, vaultProcessedRoot);

    /**
     * Merge multiple files on server disk into one clean, deduplicated file without returning to Telegram.
     */
    const mergeFilesOnServer = async (ctx, fileList, options = {}) => {
        const chatId = ctx.chat.id;
        const root = vaultProcessedRoot;
        fs.mkdirSync(root, { recursive: true });

        // Normalize file items to { path, name, size, isClean, type }
        const normalized = (fileList || []).map((f) => {
            if (typeof f === "string") {
                let sz = 0;
                try { sz = fs.statSync(f).size; } catch (_) {}
                const isProc = path.resolve(f).startsWith(path.resolve(root));
                return { path: f, name: path.basename(f), size: sz, isClean: isProc, type: isProc ? "proc" : "raw" };
            }
            let sz = f.size;
            if (sz === undefined && f.path) {
                try { sz = fs.statSync(f.path).size; } catch (_) {}
            }
            const isProc = Boolean(f.isClean || f.type === "proc" || (f.path && path.resolve(f.path).startsWith(path.resolve(root))));
            return {
                path: f.path,
                name: f.name || (f.path ? path.basename(f.path) : "unknown"),
                size: sz || 0,
                isClean: isProc,
                type: isProc ? "proc" : (f.type || "raw"),
            };
        }).filter((f) => f.path && fs.existsSync(f.path));

        if (normalized.length === 0) {
            throw new Error("None of the specified files exist on server disk.");
        }

        const statusMsgId = options.statusMsgId || (options.statusMsg && options.statusMsg.message_id) || null;
        let lastProgressTime = 0;

        const reportProgress = async (prog, force = false) => {
            const now = Date.now();
            if (!force && now - lastProgressTime < 1500) {
                return;
            }
            lastProgressTime = now;

            if (typeof options.onProgress === "function") {
                try {
                    await options.onProgress(prog);
                } catch (_) {}
            }

            if (statusMsgId && ctx) {
                try {
                    const text = renderMergeProgress({
                        ...prog,
                        totalFiles: normalized.length,
                        humanSize,
                    });
                    await safeEdit(ctx, statusMsgId, text);
                } catch (_) {}
            }
        };

        const allZip = normalized.every((f) => f.name.toLowerCase().endsWith(".zip"));
        if (allZip && options.forceText !== true) {
            const zipItems = [];
            for (let i = 0; i < normalized.length; i++) {
                const f = normalized[i];
                await reportProgress({
                    currentFileIndex: i + 1,
                    totalFiles: normalized.length,
                    currentFileName: f.name,
                    currentFileSize: f.size,
                    phase: `Unpacking archive ${i + 1}/${normalized.length}…`,
                }, true);
                zipItems.push({
                    name: f.name,
                    buffer: fs.readFileSync(f.path),
                });
            }

            await reportProgress({
                currentFileIndex: normalized.length,
                totalFiles: normalized.length,
                currentFileName: "Master Archive",
                phase: `Merging folder hierarchies into master zip…`,
            }, true);

            const mergeResult = mergeZipFiles(zipItems, {
                onProgress: (zipProg) => {
                    reportProgress({
                        ...zipProg,
                        totalFiles: normalized.length,
                    }, false).catch(() => {});
                },
            });

            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            const outName = `merged_vault_${chatId}_${stamp}.zip`;
            const outPath = path.join(root, outName);
            fs.writeFileSync(outPath, mergeResult.buffer);
            const stat = fs.statSync(outPath);

            await reportProgress({
                currentFileIndex: normalized.length,
                totalFiles: normalized.length,
                currentFileName: outName,
                currentFileSize: stat.size,
                phase: `Archive complete (${humanSize(stat.size)})`,
            }, true);

            return {
                outName,
                outPath,
                totalFiles: normalized.length,
                fileSize: stat.size,
                isZip: true,
            };
        }

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const outName = `merged_vault_${chatId}_${stamp}.txt`;
        const outPath = path.join(root, outName);
        const partialPath = `${outPath}.partial`;
        const outStream = fs.createWriteStream(partialPath, { encoding: "utf8", highWaterMark: 4 * 1024 * 1024 });

        const seen = new Set();
        let totalKept = 0;
        let totalDupes = 0;
        let batch = [];

        const flushBatch = () => {
            if (batch.length === 0) return;
            store.addLines(chatId, batch, "merged_vault");
            batch = [];
        };

        let writeBuffer = "";
        const writeLine = async (line) => {
            if (seen.has(line)) {
                totalDupes++;
                return;
            }
            if (seen.size < store.MAX_LINES_PER_CHAT) {
                seen.add(line);
            }
            totalKept++;
            batch.push(line);
            writeBuffer += line + "\n";
            if (writeBuffer.length >= 262144) {
                if (!outStream.write(writeBuffer)) {
                    await once(outStream, "drain");
                }
                writeBuffer = "";
            }
            if (batch.length >= 10000) {
                flushBatch();
            }
        };

        const writeLinesBatch = async (lines) => {
            if (!lines || lines.length === 0) return;
            for (let k = 0; k < lines.length; k++) {
                const rawLine = lines[k];
                const line = cleanUserPassOnly(rawLine) || rawLine;
                if (!line) continue;
                if (seen.has(line)) {
                    totalDupes++;
                    continue;
                }
                if (seen.size < store.MAX_LINES_PER_CHAT) {
                    seen.add(line);
                }
                totalKept++;
                batch.push(line);
                writeBuffer += line + "\n";
                if (writeBuffer.length >= 262144) {
                    if (!outStream.write(writeBuffer)) {
                        await once(outStream, "drain");
                    }
                    writeBuffer = "";
                }
            }
            if (batch.length >= 10000) {
                flushBatch();
            }
        };

        try {
            for (let fileIdx = 0; fileIdx < normalized.length; fileIdx++) {
                const f = normalized[fileIdx];
                const isZip = f.name.toLowerCase().endsWith(".zip");

                await reportProgress({
                    currentFileIndex: fileIdx + 1,
                    totalFiles: normalized.length,
                    currentFileName: f.name,
                    currentFileSize: f.size,
                    keptLines: totalKept,
                    duplicatesStripped: totalDupes,
                    phase: isZip ? `Extracting entries from ${f.name}…` : `Reading and deduplicating ${f.name}…`,
                }, true);

                if (isZip) {
                    try {
                        const buf = fs.readFileSync(f.path);
                        if (isZipBuffer(buf)) {
                            const AdmZip = require("adm-zip");
                            const zip = new AdmZip(buf);
                            const entries = zip.getEntries();
                            for (let entryIdx = 0; entryIdx < entries.length; entryIdx++) {
                                const entry = entries[entryIdx];
                                if (entry.isDirectory) continue;
                                const lower = entry.entryName.toLowerCase();
                                if (lower.endsWith(".txt") || lower.endsWith(".log") || lower.endsWith(".csv") || lower.endsWith(".tsv")) {
                                    const text = entry.getData().toString("utf8");
                                    const res = await extractAndCleanTextAsync(text, { keepUrl: false, dedupe: false });
                                    await writeLinesBatch(res.lines);
                                    totalDupes += res.stats.duplicates || 0;
                                    await reportProgress({
                                        currentFileIndex: fileIdx + 1,
                                        totalFiles: normalized.length,
                                        currentFileName: f.name,
                                        currentFileSize: f.size,
                                        keptLines: totalKept,
                                        duplicatesStripped: totalDupes,
                                        phase: `Cleaned entry [${entryIdx + 1}/${entries.length}] ${path.basename(entry.entryName)}`,
                                    }, false);
                                }
                            }
                        }
                    } catch (err) {
                        console.error("Error extracting zip entry during merge:", f.name, err);
                    }
                } else if (f.isClean) {
                    const rl = readline.createInterface({
                        input: fs.createReadStream(f.path, { encoding: "utf8", highWaterMark: 4 * 1024 * 1024 }),
                        crlfDelay: Infinity,
                    });
                    let chunk = [];
                    for await (const line of rl) {
                        const trimmed = line.trim();
                        if (!trimmed) continue;
                        chunk.push(cleanUserPassOnly(trimmed) || trimmed);
                        if (chunk.length >= 25000) {
                            await writeLinesBatch(chunk);
                            chunk = [];
                            await reportProgress({
                                currentFileIndex: fileIdx + 1,
                                totalFiles: normalized.length,
                                currentFileName: f.name,
                                currentFileSize: f.size,
                                keptLines: totalKept,
                                duplicatesStripped: totalDupes,
                                phase: `Deduplicating cleaned stream…`,
                            }, false);
                        }
                    }
                    if (chunk.length > 0) {
                        await writeLinesBatch(chunk);
                        chunk = [];
                    }
                } else {
                    const rl = readline.createInterface({
                        input: fs.createReadStream(f.path, { encoding: "utf8", highWaterMark: 4 * 1024 * 1024 }),
                        crlfDelay: Infinity,
                    });
                    const { getSharedPool } = require("./worker-pool");
                    let chunk = [];
                    for await (const line of rl) {
                        chunk.push(line);
                        if (chunk.length >= 25000) {
                            const res = await getSharedPool().cleanLinesParallel(chunk, { keepUrl: false, dedupe: false });
                            chunk = [];
                            await writeLinesBatch(res.lines);
                            totalDupes += res.stats.duplicates || 0;
                            await reportProgress({
                                currentFileIndex: fileIdx + 1,
                                totalFiles: normalized.length,
                                currentFileName: f.name,
                                currentFileSize: f.size,
                                keptLines: totalKept,
                                duplicatesStripped: totalDupes,
                                phase: `Deduplicating stream…`,
                            }, false);
                        }
                    }
                    if (chunk.length > 0) {
                        const res = await getSharedPool().cleanLinesParallel(chunk, { keepUrl: false, dedupe: false });
                        chunk = [];
                        await writeLinesBatch(res.lines);
                        totalDupes += res.stats.duplicates || 0;
                    }
                }
            }

            await reportProgress({
                currentFileIndex: normalized.length,
                totalFiles: normalized.length,
                currentFileName: outName,
                keptLines: totalKept,
                duplicatesStripped: totalDupes,
                phase: `Finalizing output on server disk…`,
            }, true);

            flushBatch();
            if (writeBuffer.length > 0) {
                if (!outStream.write(writeBuffer)) {
                    await once(outStream, "drain");
                }
                writeBuffer = "";
            }
            outStream.end();
            await once(outStream, "finish");
            fs.renameSync(partialPath, outPath);
        } catch (err) {
            outStream.destroy();
            try {
                fs.rmSync(partialPath, { force: true });
            } catch (_) {}
            throw err;
        }
        const stat = fs.statSync(outPath);

        return {
            outName,
            outPath,
            totalFiles: normalized.length,
            keptLines: totalKept,
            duplicatesStripped: totalDupes,
            fileSize: stat.size,
            isZip: false,
        };
    };

    bot.vaultSelectState = vaultSelectState;
    bot.lastCompletedSaveSessions = lastCompletedSaveSessions;
    bot.mergeFilesOnServer = mergeFilesOnServer;

    const showVaultSelect = async (ctx, editMessageId = null, page = 0) => {
        userPromptState.delete(ctx.chat.id);
        const rawRoot = vaultRawRoot;
        const processedRoot = vaultProcessedRoot;
        const rawFiles = scanDirFiles(rawRoot);
        const processedFiles = scanDirFiles(processedRoot);
        const allFiles = getVaultFiles();

        let state = vaultSelectState.get(ctx.chat.id);
        if (!state) {
            state = { selected: new Set(), page: 0 };
            vaultSelectState.set(ctx.chat.id, state);
        }
        state.page = page;

        const text = renderServerFiles({
            rawFiles,
            processedFiles,
            selectFiles: allFiles,
            selected: state.selected,
            rawRoot,
            processedRoot,
            humanSize,
            tab: "select",
            page,
            pageSize: 5,
        });
        const keyboard = serverFilesKeyboard(rawFiles, processedFiles, {
            tab: "select",
            page,
            pageSize: 5,
            files: allFiles,
            selected: state.selected,
        });

        if (editMessageId) {
            await safeEdit(ctx, editMessageId, text, keyboard);
        } else {
            await safeReply(ctx, text, keyboard);
        }
    };

    const showServerFiles = async (ctx, editMessageId = null, page = 0, tab = "overview") => {
        userPromptState.delete(ctx.chat.id);
        const rawRoot = vaultRawRoot;
        const processedRoot = vaultProcessedRoot;
        const rawFiles = scanDirFiles(rawRoot);
        const processedFiles = scanDirFiles(processedRoot);
        const diskStats = getDiskStats(rawRoot);
        const batchStats = store.getStats(ctx.chat.id);
        const text = renderServerFiles({
            rawFiles,
            processedFiles,
            rawRoot,
            processedRoot,
            humanSize,
            diskStats,
            batchStats,
            tab,
            page,
            pageSize: 3,
        });
        const keyboard = serverFilesKeyboard(rawFiles, processedFiles, { page, pageSize: 3, tab });
        if (editMessageId) {
            await safeEdit(ctx, editMessageId, text, keyboard);
        } else {
            await safeReply(ctx, text, keyboard);
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

    bot.command("storage", async (ctx) => {
        await showServerFiles(ctx);
    });

    bot.command("disk", async (ctx) => {
        await showServerFiles(ctx);
    });

    bot.command("vault", async (ctx) => {
        await showServerFiles(ctx);
    });

    bot.command("selectmerge", async (ctx) => {
        await showVaultSelect(ctx);
    });

    bot.command(["mergeclean", "mergeproc"], async (ctx) => {
        userPromptState.delete(ctx.chat.id);
        const processedFiles = scanDirFiles(vaultProcessedRoot);
        if (processedFiles.length < 2) {
            await safeReply(ctx, `⚠️ Found ${processedFiles.length} cleaned file(s). Need at least 2 to merge.\nUse /vault to browse or /save to add more.`, mainKeyboard());
            return;
        }
        const statusMsg = await safeReply(ctx, `⏳ Merging ${processedFiles.length} cleaned vault files on server disk…`);
        try {
            const stats = await mergeFilesOnServer(ctx, processedFiles, {
                statusMsgId: statusMsg ? statusMsg.message_id : null,
            });
            const report = renderMergeComplete(stats);
            const kb = mergeCompleteKeyboard(stats.outName);
            if (statusMsg && statusMsg.message_id) {
                await safeEdit(ctx, statusMsg.message_id, report, kb);
            } else {
                await safeReply(ctx, report, kb);
            }
        } catch (err) {
            console.error("mergeclean command error:", err);
            await safeReply(ctx, `❌ Failed to merge cleaned files: ${err.message}`);
        }
    });

    bot.command("mergeraw", async (ctx) => {
        userPromptState.delete(ctx.chat.id);
        const rawFiles = scanDirFiles(vaultRawRoot);
        if (rawFiles.length < 2) {
            await safeReply(ctx, `⚠️ Found ${rawFiles.length} raw file(s). Need at least 2 to merge.\nUse /vault to browse or /save to add more.`, mainKeyboard());
            return;
        }
        const statusMsg = await safeReply(ctx, `⏳ Merging and cleaning ${rawFiles.length} raw dump files on server disk…`);
        try {
            const stats = await mergeFilesOnServer(ctx, rawFiles, {
                statusMsgId: statusMsg ? statusMsg.message_id : null,
            });
            const report = renderMergeComplete(stats);
            const kb = mergeCompleteKeyboard(stats.outName);
            if (statusMsg && statusMsg.message_id) {
                await safeEdit(ctx, statusMsg.message_id, report, kb);
            } else {
                await safeReply(ctx, report, kb);
            }
        } catch (err) {
            console.error("mergeraw command error:", err);
            await safeReply(ctx, `❌ Failed to merge raw files: ${err.message}`);
        }
    });

    bot.command("merge", async (ctx) => {
        userPromptState.delete(ctx.chat.id);
        const arg = (ctx.message?.text || "").replace(/^\/\S+\s*/, "").trim().toLowerCase();
        if (arg === "clean" || arg === "cleaned" || arg === "proc") {
            const processedFiles = scanDirFiles(vaultProcessedRoot);
            if (processedFiles.length < 2) {
                await safeReply(ctx, `⚠️ Found ${processedFiles.length} cleaned file(s). Need at least 2 to merge.`, mainKeyboard());
                return;
            }
            const statusMsg = await safeReply(ctx, `⏳ Merging ${processedFiles.length} cleaned vault files on server disk…`);
            try {
                const stats = await mergeFilesOnServer(ctx, processedFiles, {
                    statusMsgId: statusMsg ? statusMsg.message_id : null,
                });
                const report = renderMergeComplete(stats);
                const kb = mergeCompleteKeyboard(stats.outName);
                if (statusMsg && statusMsg.message_id) {
                    await safeEdit(ctx, statusMsg.message_id, report, kb);
                } else {
                    await safeReply(ctx, report, kb);
                }
            } catch (err) {
                await safeReply(ctx, `❌ Failed to merge: ${err.message}`);
            }
            return;
        }
        if (arg === "raw") {
            const rawFiles = scanDirFiles(vaultRawRoot);
            if (rawFiles.length < 2) {
                await safeReply(ctx, `⚠️ Found ${rawFiles.length} raw file(s). Need at least 2 to merge.`, mainKeyboard());
                return;
            }
            const statusMsg = await safeReply(ctx, `⏳ Merging ${rawFiles.length} raw dump files on server disk…`);
            try {
                const stats = await mergeFilesOnServer(ctx, rawFiles, {
                    statusMsgId: statusMsg ? statusMsg.message_id : null,
                });
                const report = renderMergeComplete(stats);
                const kb = mergeCompleteKeyboard(stats.outName);
                if (statusMsg && statusMsg.message_id) {
                    await safeEdit(ctx, statusMsg.message_id, report, kb);
                } else {
                    await safeReply(ctx, report, kb);
                }
            } catch (err) {
                await safeReply(ctx, `❌ Failed to merge: ${err.message}`);
            }
            return;
        }
        await showVaultSelect(ctx);
    });

    bot.action("server_files", async (ctx) => {
        await ctx.answerCbQuery("📂 Opening server vault…").catch(() => { });
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        await showServerFiles(ctx, msg ? msg.message_id : null, 0, "overview");
    });

    bot.action(/^files:tab:(overview|raw|proc|tools|select)$/, async (ctx) => {
        const tab = ctx.match[1];
        await ctx.answerCbQuery().catch(() => { });
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        if (tab === "select") {
            await showVaultSelect(ctx, msg ? msg.message_id : null, 0);
        } else {
            await showServerFiles(ctx, msg ? msg.message_id : null, 0, tab);
        }
    });

    bot.action(/^vault:sel:toggle:(\d+)$/, async (ctx) => {
        const idx = parseInt(ctx.match[1], 10);
        let state = vaultSelectState.get(ctx.chat.id);
        if (!state) {
            state = { selected: new Set(), page: 0 };
            vaultSelectState.set(ctx.chat.id, state);
        }
        if (state.selected.has(idx)) {
            state.selected.delete(idx);
            await ctx.answerCbQuery("Deselected").catch(() => {});
        } else {
            state.selected.add(idx);
            await ctx.answerCbQuery("Selected").catch(() => {});
        }
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        await showVaultSelect(ctx, msg ? msg.message_id : null, state.page);
    });

    bot.action("vault:sel:all", async (ctx) => {
        const allFiles = getVaultFiles();
        let state = vaultSelectState.get(ctx.chat.id);
        if (!state) state = { selected: new Set(), page: 0 };
        state.selected = new Set(allFiles.map((_, i) => i));
        vaultSelectState.set(ctx.chat.id, state);
        await ctx.answerCbQuery(`Selected all (${allFiles.length})`).catch(() => {});
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        await showVaultSelect(ctx, msg ? msg.message_id : null, state.page);
    });

    bot.action("vault:sel:clear", async (ctx) => {
        let state = vaultSelectState.get(ctx.chat.id);
        if (state) state.selected.clear();
        await ctx.answerCbQuery("Cleared selection").catch(() => {});
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        await showVaultSelect(ctx, msg ? msg.message_id : null, state ? state.page : 0);
    });

    bot.action("vault:sel:proc", async (ctx) => {
        const allFiles = getVaultFiles();
        let state = vaultSelectState.get(ctx.chat.id);
        if (!state) state = { selected: new Set(), page: 0 };
        state.selected = new Set();
        allFiles.forEach((f, i) => {
            if (f.type === "proc" || f.isClean || (f.path && path.resolve(f.path).startsWith(path.resolve(vaultProcessedRoot)))) {
                state.selected.add(i);
            }
        });
        vaultSelectState.set(ctx.chat.id, state);
        await ctx.answerCbQuery(`Selected ${state.selected.size} cleaned files`).catch(() => {});
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        await showVaultSelect(ctx, msg ? msg.message_id : null, state.page);
    });

    bot.action("vault:sel:raw", async (ctx) => {
        const allFiles = getVaultFiles();
        let state = vaultSelectState.get(ctx.chat.id);
        if (!state) state = { selected: new Set(), page: 0 };
        state.selected = new Set();
        allFiles.forEach((f, i) => {
            if (f.type !== "proc" && !f.isClean && !(f.path && path.resolve(f.path).startsWith(path.resolve(vaultProcessedRoot)))) {
                state.selected.add(i);
            }
        });
        vaultSelectState.set(ctx.chat.id, state);
        await ctx.answerCbQuery(`Selected ${state.selected.size} raw dumps`).catch(() => {});
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        await showVaultSelect(ctx, msg ? msg.message_id : null, state.page);
    });

    bot.action(/^vault:sel:page:(\d+)$/, async (ctx) => {
        const page = parseInt(ctx.match[1], 10) || 0;
        await ctx.answerCbQuery(`Page ${page + 1}`).catch(() => {});
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        await showVaultSelect(ctx, msg ? msg.message_id : null, page);
    });

    bot.action("vault:sel:merge", async (ctx) => {
        const state = vaultSelectState.get(ctx.chat.id);
        if (!state || state.selected.size === 0) {
            await ctx.answerCbQuery("⚠️ Please select at least 1 file to merge!").catch(() => {});
            return;
        }
        await ctx.answerCbQuery("🔀 Merging files on server disk...").catch(() => {});
        const allFiles = getVaultFiles();

        const selectedFiles = [];
        for (const idx of state.selected) {
            if (allFiles[idx]) {
                selectedFiles.push(allFiles[idx]);
            }
        }

        if (selectedFiles.length === 0) {
            await ctx.answerCbQuery("⚠️ Selected files were not found on disk").catch(() => {});
            return;
        }

        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        const statusMsg = msg ? msg : await safeReply(ctx, "⏳ Merging and deduplicating files on server...");

        try {
            const stats = await mergeFilesOnServer(ctx, selectedFiles, {
                statusMsgId: statusMsg ? statusMsg.message_id : null,
            });
            vaultSelectState.delete(ctx.chat.id);
            const report = renderMergeComplete(stats);
            const kb = mergeCompleteKeyboard(stats.outName);
            if (statusMsg && statusMsg.message_id) {
                await safeEdit(ctx, statusMsg.message_id, report, kb);
            } else {
                await safeReply(ctx, report, kb);
            }
        } catch (err) {
            console.error("Multi-select merge error:", err);
            await safeReply(ctx, `❌ Failed to merge files on server: ${err.message}`);
        }
    });

    bot.action("files:merge:proc:all", async (ctx) => {
        await ctx.answerCbQuery("🔀 Merging all cleaned vault files on server…").catch(() => {});
        const processedFiles = scanDirFiles(vaultProcessedRoot);
        if (processedFiles.length < 2) {
            await safeReply(ctx, "⚠️ Need at least 2 cleaned files in the vault to merge.", mainKeyboard());
            return;
        }
        const statusMsg = await safeReply(ctx, `⏳ Merging ${processedFiles.length} cleaned output files into one master deduplicated file…`);
        try {
            const stats = await mergeFilesOnServer(ctx, processedFiles, {
                statusMsgId: statusMsg ? statusMsg.message_id : null,
            });
            const report = renderMergeComplete(stats);
            const kb = mergeCompleteKeyboard(stats.outName);
            if (statusMsg && statusMsg.message_id) {
                await safeEdit(ctx, statusMsg.message_id, report, kb);
            } else {
                await safeReply(ctx, report, kb);
            }
        } catch (err) {
            console.error("Cleaned vault merge error:", err);
            await safeReply(ctx, `❌ Failed to merge cleaned files: ${err.message}`);
        }
    });

    bot.action("files:merge:raw:all", async (ctx) => {
        await ctx.answerCbQuery("🔀 Merging all raw dumps on server…").catch(() => {});
        const rawFiles = scanDirFiles(vaultRawRoot);
        if (rawFiles.length < 2) {
            await safeReply(ctx, "⚠️ Need at least 2 raw files in the vault to merge.", mainKeyboard());
            return;
        }
        const statusMsg = await safeReply(ctx, `⏳ Merging and cleaning ${rawFiles.length} raw dump files on server disk…`);
        try {
            const stats = await mergeFilesOnServer(ctx, rawFiles, {
                statusMsgId: statusMsg ? statusMsg.message_id : null,
            });
            const report = renderMergeComplete(stats);
            const kb = mergeCompleteKeyboard(stats.outName);
            if (statusMsg && statusMsg.message_id) {
                await safeEdit(ctx, statusMsg.message_id, report, kb);
            } else {
                await safeReply(ctx, report, kb);
            }
        } catch (err) {
            console.error("Raw vault merge error:", err);
            await safeReply(ctx, `❌ Failed to merge raw files: ${err.message}`);
        }
    });

    bot.action(/^files:page:(raw|proc):(\d+)$/, async (ctx) => {
        const tab = ctx.match[1];
        const page = parseInt(ctx.match[2], 10) || 0;
        await ctx.answerCbQuery(`Page ${page + 1}`).catch(() => { });
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        await showServerFiles(ctx, msg ? msg.message_id : null, page, tab);
    });

    bot.action("files:refresh", async (ctx) => {
        await ctx.answerCbQuery("🔄 Files refreshed").catch(() => { });
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        await showServerFiles(ctx, msg ? msg.message_id : null, 0, "overview");
    });

    bot.action(/^files:page:(\d+)$/, async (ctx) => {
        const page = parseInt(ctx.match[1], 10) || 0;
        await ctx.answerCbQuery(`Page ${page + 1}`).catch(() => { });
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        await showServerFiles(ctx, msg ? msg.message_id : null, page, "raw");
    });

    // Delete confirmation prompt for single raw file
    bot.action(/^file:del:raw:ask:(\d+)$/, async (ctx) => {
        const idx = parseInt(ctx.match[1], 10);
        const rawFiles = scanDirFiles(localProcessRoot());
        const file = rawFiles[idx];
        if (!file) {
            await ctx.answerCbQuery("⚠️ File not found").catch(() => { });
            return;
        }
        await ctx.answerCbQuery().catch(() => { });
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        const confirmText = [
            `🗑  ${B("DELETE RAW FILE?")}`,
            RULE,
            `📄  ${B(escapeHtml(file.name))} (${humanSize(file.size)})`,
            `📁  Location: ${CODE(escapeHtml(file.path))}`,
            "",
            `⚠️  ${I("Are you sure you want to permanently delete this file from server disk?")}`,
        ].join("\n");
        if (msg) {
            await safeEdit(ctx, msg.message_id, confirmText, confirmFileDeleteKeyboard("raw", idx, file.name));
        } else {
            await safeReply(ctx, confirmText, confirmFileDeleteKeyboard("raw", idx, file.name));
        }
    });

    // Delete confirmation prompt for single processed output file
    bot.action(/^file:del:proc:ask:(\d+)$/, async (ctx) => {
        const idx = parseInt(ctx.match[1], 10);
        const processedFiles = scanDirFiles(localProcessedRoot());
        const file = processedFiles[idx];
        if (!file) {
            await ctx.answerCbQuery("⚠️ Output not found").catch(() => { });
            return;
        }
        await ctx.answerCbQuery().catch(() => { });
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        const confirmText = [
            `🗑  ${B("DELETE CLEANED OUTPUT?")}`,
            RULE,
            `💎  ${B(escapeHtml(file.name))} (${humanSize(file.size)})`,
            `📁  Location: ${CODE(escapeHtml(file.path))}`,
            "",
            `⚠️  ${I("Are you sure you want to permanently delete this cleaned file from server disk?")}`,
        ].join("\n");
        if (msg) {
            await safeEdit(ctx, msg.message_id, confirmText, confirmFileDeleteKeyboard("proc", idx, file.name));
        } else {
            await safeReply(ctx, confirmText, confirmFileDeleteKeyboard("proc", idx, file.name));
        }
    });

    // Perform confirmed deletion of individual file
    bot.action(/^file:del:confirm:(raw|proc):(\d+)$/, async (ctx) => {
        const type = ctx.match[1];
        const idx = parseInt(ctx.match[2], 10);
        const rootDir = type === "raw" ? localProcessRoot() : localProcessedRoot();
        const files = scanDirFiles(rootDir);
        const file = files[idx];
        if (!file) {
            await ctx.answerCbQuery("⚠️ File already removed").catch(() => { });
            const msg = ctx.callbackQuery && ctx.callbackQuery.message;
            await showServerFiles(ctx, msg ? msg.message_id : null, 0, type === "raw" ? "raw" : "proc");
            return;
        }
        try {
            fs.rmSync(file.path, { force: true });
            await safeAnswerCbQuery(ctx, `🗑 Deleted ${file.name}!`);
        } catch (err) {
            await safeAnswerCbQuery(ctx, `💥 Deletion error: ${err.message}`);
        }
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        await showServerFiles(ctx, msg ? msg.message_id : null, 0, type === "raw" ? "raw" : "proc");
    });

    // Wipe all raw files prompt
    bot.action("files:wipe:raw:ask", async (ctx) => {
        const rawFiles = scanDirFiles(localProcessRoot());
        await ctx.answerCbQuery().catch(() => { });
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        const totalBytes = rawFiles.reduce((acc, f) => acc + (Number(f.size) || 0), 0);
        const confirmText = [
            `🧹  ${B("WIPE ALL RAW INCOMING FILES?")}`,
            RULE,
            `📦  ${B(num(rawFiles.length))} files (${humanSize(totalBytes)}) will be permanently deleted from:`,
            CODE(escapeHtml(localProcessRoot())),
            "",
            `Cleaned output files under ${CODE(escapeHtml(localProcessedRoot()))} will remain safe.`,
            "",
            `⚠️  ${I("Do you wish to proceed?")}`,
        ].join("\n");
        if (msg) {
            await safeEdit(ctx, msg.message_id, confirmText, confirmFileDeleteKeyboard("allraw", 0));
        } else {
            await safeReply(ctx, confirmText, confirmFileDeleteKeyboard("allraw", 0));
        }
    });

    // Wipe all processed files prompt
    bot.action("files:wipe:proc:ask", async (ctx) => {
        const processedFiles = scanDirFiles(localProcessedRoot());
        await ctx.answerCbQuery().catch(() => { });
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        const totalBytes = processedFiles.reduce((acc, f) => acc + (Number(f.size) || 0), 0);
        const confirmText = [
            `🧹  ${B("WIPE ALL CLEANED OUTPUT FILES?")}`,
            RULE,
            `💎  ${B(num(processedFiles.length))} cleaned output files (${humanSize(totalBytes)}) will be deleted from:`,
            CODE(escapeHtml(localProcessedRoot())),
            "",
            `⚠️  ${I("Do you wish to proceed?")}`,
        ].join("\n");
        if (msg) {
            await safeEdit(ctx, msg.message_id, confirmText, confirmFileDeleteKeyboard("allproc", 0));
        } else {
            await safeReply(ctx, confirmText, confirmFileDeleteKeyboard("allproc", 0));
        }
    });

    // Wipe all server storage prompt
    bot.action("files:wipe:all:ask", async (ctx) => {
        const rawFiles = scanDirFiles(localProcessRoot());
        const processedFiles = scanDirFiles(localProcessedRoot());
        await ctx.answerCbQuery().catch(() => { });
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        const totalBytes =
            rawFiles.reduce((acc, f) => acc + (Number(f.size) || 0), 0) +
            processedFiles.reduce((acc, f) => acc + (Number(f.size) || 0), 0);
        const confirmText = [
            `💥  ${B("PURGE ALL SERVER STORAGE?")}`,
            RULE,
            `⚠️  ${B("EVERYTHING ON SERVER DISK WILL BE DELETED:")}`,
            `  • ${num(rawFiles.length)} raw incoming files`,
            `  • ${num(processedFiles.length)} cleaned output files`,
            `  • Total freeing up: ${humanSize(totalBytes)}`,
            "",
            `Also clears the in-memory batch credentials for this chat.`,
            "",
            `🚨  ${I("This action cannot be undone! Are you sure?")}`,
        ].join("\n");
        if (msg) {
            await safeEdit(ctx, msg.message_id, confirmText, confirmFileDeleteKeyboard("purgeall", 0));
        } else {
            await safeReply(ctx, confirmText, confirmFileDeleteKeyboard("purgeall", 0));
        }
    });

    // Confirmed execution of bulk wipe
    bot.action(/^file:del:confirm:(allraw|allproc|purgeall):(\d+)$/, async (ctx) => {
        const action = ctx.match[1];
        let deletedCount = 0;
        let freedBytes = 0;

        const wipeDir = (dir) => {
            const files = scanDirFiles(dir);
            for (const f of files) {
                try {
                    fs.rmSync(f.path, { force: true });
                    deletedCount++;
                    freedBytes += f.size || 0;
                } catch (_) { }
            }
        };

        if (action === "allraw" || action === "purgeall") {
            wipeDir(localProcessRoot());
        }
        if (action === "allproc" || action === "purgeall") {
            wipeDir(localProcessedRoot());
        }
        if (action === "purgeall") {
            store.clear(ctx.chat.id);
            store.clearLastCombined(ctx.chat.id);
        }

        await ctx.answerCbQuery(`🧹 Deleted ${deletedCount} file(s) freeing ${humanSize(freedBytes)}!`).catch(() => { });
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        await showServerFiles(ctx, msg ? msg.message_id : null, 0);
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
        const status = await safeReply(
            ctx,
            `⚡️  ${B("MULTI-CORE CLEANING STARTED")}\n📄  ${escapeHtml(file.name)} (${humanSize(file.size)})\n🚀  Saturating all CPU cores…`
        );
        try {
            await processFile(ctx, file.path, status && status.message_id);
        } catch (err) {
            if (status && status.message_id) {
                await safeEdit(ctx, status.message_id, `💥  ${B("Cleaning failed")}: ${escapeHtml(err.message)}`, mainKeyboard());
            } else {
                await safeReply(ctx, `💥  ${B("Cleaning failed")}: ${escapeHtml(err.message)}`, mainKeyboard());
            }
        }
    });

    bot.action("files:clean:all", async (ctx) => {
        await ctx.answerCbQuery("⚡️ Batch cleaning all raw files…").catch(() => { });
        const rawFiles = scanDirFiles(localProcessRoot());
        if (rawFiles.length === 0) {
            await safeReply(ctx, "📭 No raw files to clean in server vault.", mainKeyboard());
            return;
        }
        const status = await safeReply(
            ctx,
            `⚡️  ${B("BATCH CLEANING")} ${rawFiles.length} file(s) across all CPU cores…`
        );
        for (let i = 0; i < rawFiles.length; i++) {
            const f = rawFiles[i];
            if (status && status.message_id) {
                await safeEdit(ctx, status.message_id, `🧼  ${B(`[${i + 1}/${rawFiles.length}] Cleaning`)} ${escapeHtml(f.name)}…`);
            }
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
                `${tgEmoji("🔎")}  ${B("SEARCH RAW DUMP")} \u00B7 ${B(escapeHtml(file.name))}`,
                `📁  Size: ${CODE(humanSize(file.size))}`,
                "",
                `${I("Tap a quick filter, enter a custom query, or search the entire vault:")}`,
            ].join("\n"),
            localFileSearchKeyboard(idx, false),
        );
    });

    bot.action(/^file:dosearch:(\d+):(.+)$/, async (ctx) => {
        const idx = parseInt(ctx.match[1], 10);
        const query = resolveCallbackPayload(ctx.match[2]);
        await safeAnswerCbQuery(ctx, `Searching ${query}…`);
        const rawFiles = scanDirFiles(localProcessRoot());
        const file = rawFiles[idx];
        if (!file) {
            await safeReply(ctx, "⚠️ File not found.", mainKeyboard());
            return;
        }
        const abortController = new AbortController();
        activeVaultSearches.set(ctx.chat.id, {
            query,
            startedAt: Date.now(),
            controller: abortController,
        });

        const status = await safeReply(
            ctx,
            renderFileSearchProgress({
                query,
                fileName: file.name,
                fileSize: file.size,
                current: 0,
                total: 1,
                matchesCount: 0,
                isAll: false,
            }),
            fileSearchProgressKeyboard({ current: 0, total: 1 })
        );
        try {
            const result = await searchTextFile(file.path, query, 20, { signal: abortController.signal });
            const card = renderLocalSearch({
                query,
                total: result.total,
                matches: result.matches,
                fileName: file.name,
                fileSize: file.size,
                isProc: false,
                fileIdx: idx,
            });
            const kb = localSearchResultKeyboard({
                query,
                total: result.total,
                fileIdx: idx,
                isProc: false,
                isAll: false,
            });
            if (status && status.message_id) {
                await safeEdit(ctx, status.message_id, card, kb);
            } else {
                await safeReply(ctx, card, kb);
            }
        } catch (err) {
            if (abortController.signal.aborted) {
                if (status && status.message_id) {
                    await safeEdit(ctx, status.message_id, "🚫 File search cancelled.", mainKeyboard());
                }
                return;
            }
            const errMsg = `💥 Search failed: ${escapeHtml(err.message)}`;
            if (status && status.message_id) {
                await safeEdit(ctx, status.message_id, errMsg, mainKeyboard());
            } else {
                await safeReply(ctx, errMsg, mainKeyboard());
            }
        } finally {
            activeVaultSearches.delete(ctx.chat.id);
        }
    });

    bot.action(/^file:dl:proc:(\d+)$/, async (ctx) => {
        const idx = parseInt(ctx.match[1], 10);
        await ctx.answerCbQuery("📥 Preparing download…").catch(() => { });
        const processedFiles = scanDirFiles(localProcessedRoot());
        const file = processedFiles[idx];
        if (!file) {
            await safeReply(ctx, `⚠️ Output file #${idx + 1} not found on server disk.`, mainKeyboard());
            return;
        }

        const dl = downloads.registerDownload({
            filename: file.name,
            filePath: file.path,
            size: file.size,
            chatId: ctx.chat && ctx.chat.id,
        });

        if (file.size > 48 * 1024 * 1024) {
            await safeReply(
                ctx,
                [
                    `📦  ${B("OUTPUT FILE EXCEEDS TELEGRAM UPLOAD CAP")}`,
                    RULE,
                    `📄  ${B(escapeHtml(file.name))} (${humanSize(file.size)}) exceeds Telegram's 50 MB Bot API limit.`,
                    "",
                    `🔗  ${B("Direct Download Link:")}`,
                    `${dl.url}`,
                    "",
                    `${I("Tap the button below to download directly in your browser:")}`,
                ].join("\n"),
                createInlineKeyboard([
                    [Markup.button.url("📥 Direct Download Link", dl.url)],
                    [Markup.button.callback("🔙 Server Vault", "server_files")],
                ]),
            );
            return;
        }

        try {
            await ctx.replyWithChatAction("upload_document").catch(() => { });
            await safeSendDocument(
                ctx,
                ctx.chat && ctx.chat.id,
                { source: file.path, filename: file.name },
                {
                    caption: [
                        `💎  ${B("CLEANED OUTPUT FILE")}`,
                        `📄  ${escapeHtml(file.name)} · ${CODE(humanSize(file.size))}`,
                        `📅  Created: ${CODE(formatFileDate(file.mtime))}`,
                        `🔗  Direct link: ${dl.url}`,
                    ].join("\n"),
                    parse_mode: "HTML",
                    ...serverFilesKeyboard(scanDirFiles(localProcessRoot()), processedFiles),
                },
            );
        } catch (err) {
            await safeReply(
                ctx,
                [
                    `⚠️ Telegram upload failed: ${escapeHtml(err.message)}`,
                    "",
                    `🔗  ${B("Direct Download Link:")} ${dl.url}`,
                ].join("\n"),
                createInlineKeyboard([
                    [Markup.button.url("📥 Download Directly", dl.url)],
                    [Markup.button.callback("🔙 Server Vault", "server_files")],
                ]),
            );
        }
    });

    bot.action(/^file:search:proc:(\d+)$/, async (ctx) => {
        const idx = parseInt(ctx.match[1], 10);
        await ctx.answerCbQuery().catch(() => { });
        const processedFiles = scanDirFiles(localProcessedRoot());
        const file = processedFiles[idx];
        if (!file) {
            await safeReply(ctx, `⚠️ Output file #${idx + 1} not found.`, mainKeyboard());
            return;
        }
        await safeReply(
            ctx,
            [
                `${tgEmoji("🔎")}  ${B("SEARCH CLEANED OUTPUT")} \u00B7 ${B(escapeHtml(file.name))}`,
                `📁  Size: ${CODE(humanSize(file.size))}`,
                "",
                `${I("Tap a quick filter, enter a custom query, or search the entire vault:")}`,
            ].join("\n"),
            localFileSearchKeyboard(idx, true),
        );
    });

    bot.action(/^file:dosearch:proc:(\d+):(.+)$/, async (ctx) => {
        const idx = parseInt(ctx.match[1], 10);
        const query = resolveCallbackPayload(ctx.match[2]);
        await safeAnswerCbQuery(ctx, `Searching ${query}…`);
        const processedFiles = scanDirFiles(localProcessedRoot());
        const file = processedFiles[idx];
        if (!file) {
            await safeReply(ctx, "⚠️ Output file not found.", mainKeyboard());
            return;
        }
        const abortController = new AbortController();
        activeVaultSearches.set(ctx.chat.id, {
            query,
            startedAt: Date.now(),
            controller: abortController,
        });

        const status = await safeReply(
            ctx,
            renderFileSearchProgress({
                query,
                fileName: file.name,
                fileSize: file.size,
                current: 0,
                total: 1,
                matchesCount: 0,
                isAll: false,
            }),
            fileSearchProgressKeyboard({ current: 0, total: 1 })
        );
        try {
            const result = await searchTextFile(file.path, query, 20, { signal: abortController.signal });
            const card = renderLocalSearch({
                query,
                total: result.total,
                matches: result.matches,
                fileName: file.name,
                fileSize: file.size,
                isProc: true,
                fileIdx: idx,
            });
            const kb = localSearchResultKeyboard({
                query,
                total: result.total,
                fileIdx: idx,
                isProc: true,
                isAll: false,
            });
            if (status && status.message_id) {
                await safeEdit(ctx, status.message_id, card, kb);
            } else {
                await safeReply(ctx, card, kb);
            }
        } catch (err) {
            if (abortController.signal.aborted) {
                if (status && status.message_id) {
                    await safeEdit(ctx, status.message_id, "🚫 File search cancelled.", mainKeyboard());
                }
                return;
            }
            const errMsg = `💥 Search failed: ${escapeHtml(err.message)}`;
            if (status && status.message_id) {
                await safeEdit(ctx, status.message_id, errMsg, mainKeyboard());
            } else {
                await safeReply(ctx, errMsg, mainKeyboard());
            }
        } finally {
            activeVaultSearches.delete(ctx.chat.id);
        }
    });

    bot.action(/^file:search:custom:(proc:)?(\d+)$/, async (ctx) => {
        const isProc = Boolean(ctx.match[1]);
        const idx = parseInt(ctx.match[2], 10);
        await ctx.answerCbQuery().catch(() => { });
        const files = isProc ? scanDirFiles(localProcessedRoot()) : scanDirFiles(localProcessRoot());
        const file = files[idx];
        if (!file) {
            await safeReply(ctx, `⚠️ Target file not found in vault.`, mainKeyboard());
            return;
        }
        userPromptState.set(ctx.chat.id, {
            action: "file:search:custom",
            fileIdx: idx,
            isProc,
            fileName: file.name,
            filePath: file.path,
            createdAt: Date.now(),
        });
        await safeReply(
            ctx,
            [
                `${tgEmoji("🔎")}  ${B("ENTER SEARCH QUERY FOR FILE")}`,
                RULE,
                `📄  ${B(escapeHtml(file.name))} (${humanSize(file.size)})`,
                `📂  Type: ${isProc ? "Cleaned Vault" : "Raw Dump"}`,
                "",
                `💬  ${I("Send the domain, email, username, or text to search:")}`,
            ].join("\n"),
            createInlineKeyboard([
                [Markup.button.callback("🔙 Back to File", `file:search:${isProc ? "proc:" : ""}${idx}`)],
                [Markup.button.callback("❌ Cancel", "search:cancel")],
            ]),
        );
    });

    bot.action("lsearch:prompt", async (ctx) => {
        await ctx.answerCbQuery().catch(() => { });
        const rawFiles = scanDirFiles(localProcessRoot());
        const procFiles = scanDirFiles(localProcessedRoot());
        const total = rawFiles.length + procFiles.length;
        if (total === 0) {
            userPromptState.delete(ctx.chat.id);
            await safeReply(
                ctx,
                `⚠️ No files found in server vault (${CODE(localProcessRoot())} or ${CODE(localProcessedRoot())}).\nUpload or save some dumps first!`,
                mainKeyboard()
            );
            return;
        }
        userPromptState.set(ctx.chat.id, {
            action: "lsearch:query",
            createdAt: Date.now(),
        });
        await safeReply(
            ctx,
            [
                `${tgEmoji("🔎")}  ${B("ENTER VAULT SEARCH QUERY")}`,
                RULE,
                `🌐  Search will run across ${B(num(total))} files in your server vault.`,
                "",
                `💬  ${I("Send the word, email, domain, or keyword to search across all vault files:")}`,
                `💡  ${I("Send cancel or tap below at any time to exit.")}`,
            ].join("\n"),
            createInlineKeyboard([
                [Markup.button.callback("❌ Cancel", "search:cancel")],
            ]),
        );
    });

    bot.action("search:cancel", async (ctx) => {
        userPromptState.delete(ctx.chat.id);
        if (activeVaultSearches.has(ctx.chat.id)) {
            const active = activeVaultSearches.get(ctx.chat.id);
            if (active && active.controller) active.controller.abort();
            activeVaultSearches.delete(ctx.chat.id);
        }
        await ctx.answerCbQuery("Search cancelled").catch(() => { });
        await safeReply(ctx, `🚫 Search prompt cancelled.`, mainKeyboard());
    });

    bot.action("search:status_bar", async (ctx) => {
        const active = activeVaultSearches.get(ctx.chat.id);
        const q = active && active.query ? `for "${active.query}"` : "";
        await ctx.answerCbQuery(`🔎 Search in progress ${q}…`).catch(() => {});
    });

    bot.action(/^lsearch:all:run:(.+)$/, async (ctx) => {
        const query = resolveCallbackPayload(ctx.match[1]);
        await safeAnswerCbQuery(ctx, `Searching vault for "${query}"…`);

        const rawFiles = scanDirFiles(localProcessRoot());
        const procFiles = scanDirFiles(localProcessedRoot());
        if (rawFiles.length + procFiles.length === 0) {
            await safeReply(
                ctx,
                `⚠️ No files found in server vault (${CODE(localProcessRoot())} or ${CODE(localProcessedRoot())}).\nUpload or save some dumps first!`,
                mainKeyboard()
            );
            return;
        }

        if (activeVaultSearches.has(ctx.chat.id)) {
            await safeReply(
                ctx,
                `⏳ A vault search is already running. Please wait for it to complete or send ${CODE("cancel")}.`
            );
            return;
        }

        const abortController = new AbortController();
        activeVaultSearches.set(ctx.chat.id, {
            query,
            startedAt: Date.now(),
            controller: abortController,
        });

        const totalVaultFiles = rawFiles.length + procFiles.length;
        const status = await safeReply(
            ctx,
            renderFileSearchProgress({
                query,
                fileName: "All Vault Files",
                current: 0,
                total: totalVaultFiles,
                matchesCount: 0,
                isAll: true,
            }),
            fileSearchProgressKeyboard({ current: 0, total: totalVaultFiles })
        );

        let lastEdit = Date.now();
        const onProgress = async (prog) => {
            const now = Date.now();
            if (now - lastEdit < 1000 && prog.current < prog.total) return;
            lastEdit = now;
            if (status && status.message_id) {
                await safeEdit(
                    ctx,
                    status.message_id,
                    renderFileSearchProgress({
                        query,
                        fileName: prog.currentFile || "Vault Files",
                        current: prog.current,
                        total: prog.total,
                        matchesCount: prog.matchesFound,
                        isAll: true,
                    }),
                    fileSearchProgressKeyboard({ current: prog.current, total: prog.total })
                ).catch(() => {});
            }
        };

        try {
            const result = await searchAllVaultFiles(query, {
                limit: 20,
                signal: abortController.signal,
                onProgress,
            });
            const card = renderLocalSearch({
                query,
                total: result.total,
                matches: result.matches,
                fileResults: result.fileResults,
                totalFiles: result.totalFiles,
                searchedFiles: result.searchedFiles,
                isAll: true,
            });
            const kb = localSearchResultKeyboard({
                query,
                total: result.total,
                isAll: true,
            });
            if (status && status.message_id) {
                await safeEdit(ctx, status.message_id, card, kb);
            } else {
                await safeReply(ctx, card, kb);
            }
        } catch (err) {
            if (abortController.signal.aborted) {
                if (status && status.message_id) {
                    await safeEdit(ctx, status.message_id, "🚫 Vault search cancelled.", mainKeyboard());
                }
                return;
            }
            const errMsg = `💥 Search failed: ${escapeHtml(err.message)}`;
            if (status && status.message_id) {
                await safeEdit(ctx, status.message_id, errMsg, mainKeyboard());
            } else {
                await safeReply(ctx, errMsg, mainKeyboard());
            }
        } finally {
            activeVaultSearches.delete(ctx.chat.id);
        }
    });

    bot.action(/^lsearch:dl:(.+)$/, async (ctx) => {
        const rawPayload = resolveCallbackPayload(ctx.match[1]);
        await safeAnswerCbQuery(ctx, "📥 Extracting all matching lines…");
        const parts = rawPayload.split(":");
        let query = "";
        let matches = [];
        let label = "";

        if (parts[0] === "all") {
            query = parts.slice(1).join(":");
            label = "all_vault";
            const res = await searchAllVaultFiles(query, { limit: 250000 });
            matches = res.matches;
        } else {
            const type = parts[0];
            const idx = parseInt(parts[1], 10);
            query = parts.slice(2).join(":");
            const isProc = type === "proc";
            const files = isProc ? scanDirFiles(localProcessedRoot()) : scanDirFiles(localProcessRoot());
            const file = files[idx];
            if (!file) {
                await safeReply(ctx, "⚠️ Target file not found.", mainKeyboard());
                return;
            }
            label = sanitizeSiteSlug(path.basename(file.name, path.extname(file.name)));
            const res = await searchTextFile(file.path, query, 250000);
            matches = res.matches;
        }

        if (!matches || matches.length === 0) {
            await safeReply(ctx, `⚠️ No matching lines found to export for ${CODE(escapeHtml(query))}.`, mainKeyboard());
            return;
        }

        const cleanedLines = [];
        const seen = new Set();
        for (const m of matches) {
            const clean = cleanUserPassOnly(m) || m;
            if (!seen.has(clean)) {
                seen.add(clean);
                cleanedLines.push(clean);
            }
        }
        const buffer = Buffer.from(cleanedLines.join("\n"), "utf8");
        const stamp = new Date().toISOString().slice(0, 10);
        const filename = `vault_search_${label}_${sanitizeSiteSlug(query)}_${stamp}.txt`;

        if (buffer.length > 48 * 1024 * 1024) {
            const dl = downloads.registerDownload({
                filename,
                buffer,
                size: buffer.length,
                chatId: ctx.chat && ctx.chat.id,
            });
            await safeReply(
                ctx,
                [
                    `📦  ${B("SEARCH EXPORT EXCEEDS TELEGRAM UPLOAD CAP")}`,
                    RULE,
                    `📄  ${B(escapeHtml(filename))} (${humanSize(buffer.length)}) exceeds Telegram's 50 MB Bot API limit.`,
                    "",
                    `🔗  ${B("Direct Download Link:")}`,
                    `${dl.url}`,
                    "",
                    `👇 ${I("Tap the button below to download directly in your browser:")}`,
                ].join("\n"),
                createInlineKeyboard([
                    [Markup.button.url("📥 Direct Download Link", dl.url)],
                    [Markup.button.callback("🔙 Server Vault", "server_files")],
                ]),
            );
            return;
        }

        try {
            await ctx.replyWithChatAction("upload_document").catch(() => { });
            await safeSendDocument(
                ctx,
                ctx.chat && ctx.chat.id,
                { source: buffer, filename },
                {
                    caption: [
                        `📥  ${B("VAULT SEARCH EXPORT")}  ${tgEmoji("⚡️")}`,
                        RULE,
                        `🎯  Query: ${CODE(escapeHtml(query))}`,
                        `💎  Matches: ${B(num(matches.length))} lines`,
                        `📁  Source: ${label === "all_vault" ? "All Vault Files" : label}`,
                    ].join("\n"),
                    parse_mode: "HTML",
                    ...mainKeyboard(),
                },
            );
        } catch (err) {
            const dl = downloads.registerDownload({
                filename,
                buffer,
                size: buffer.length,
                chatId: ctx.chat && ctx.chat.id,
            });
            await safeReply(
                ctx,
                [
                    `⚠️ Telegram upload failed: ${escapeHtml(err.message)}`,
                    "",
                    `🔗  ${B("Direct Download Link:")} ${dl.url}`,
                ].join("\n"),
                createInlineKeyboard([
                    [Markup.button.url("📥 Download Directly", dl.url)],
                    [Markup.button.callback("🔙 Server Vault", "server_files")],
                ]),
            );
        }
    });

    bot.action("ulp:menu", async (ctx) => {
        await ctx.answerCbQuery("🚀 ULP Target Selector").catch(() => { });
        userPromptState.delete(ctx.chat.id);
        const activeDays = (store && store.getUlpDays && store.getUlpDays(ctx.chat.id)) || userUlpDays.get(ctx.chat.id) || searchOptions.daysCount || 5;
        const customDomains = (store && store.getCustomDomains && store.getCustomDomains(ctx.chat.id)) || [];
        const text = renderUlpMenuText(searchOptions.botUsername, activeDays, customDomains.length);
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        if (msg) {
            await safeEdit(ctx, msg.message_id, text, ulpMenuKeyboard(activeDays, customDomains));
        } else {
            await safeReply(ctx, text, ulpMenuKeyboard(activeDays, customDomains));
        }
    });

    bot.action(/^ulp:setdays:(\d+)$/, async (ctx) => {
        const days = Math.max(1, Math.min(90, parseInt(ctx.match[1], 10) || 5));
        userUlpDays.set(ctx.chat.id, days);
        if (store && store.setUlpDays) store.setUlpDays(ctx.chat.id, days);
        await ctx.answerCbQuery(`📅 Duration: ${days} day(s)`).catch(() => { });
        const customDomains = (store && store.getCustomDomains && store.getCustomDomains(ctx.chat.id)) || [];
        const text = renderUlpMenuText(searchOptions.botUsername, days, customDomains.length);
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        if (msg) {
            await safeEdit(ctx, msg.message_id, text, ulpMenuKeyboard(days, customDomains));
        } else {
            await safeReply(ctx, text, ulpMenuKeyboard(days, customDomains));
        }
    });

    bot.action(/^ulp:quick:(.+)$/, async (ctx) => {
        const rawToken = ctx.match[1];
        const resolved = resolveCallbackPayload(rawToken);
        const query = searchbot.normalizeQuery(resolved) || resolved;
        if (store && store.addCustomDomain) {
            store.addCustomDomain(ctx.chat.id, query);
        }
        const activeDays = (store && store.getUlpDays && store.getUlpDays(ctx.chat.id)) || userUlpDays.get(ctx.chat.id) || searchOptions.daysCount || 5;
        await safeAnswerCbQuery(ctx, `🚀 Launching ${query} (${activeDays}d)…`);
        await beginUlpRun(ctx, {
            query,
            scope: "day",
            daysCount: activeDays,
            searchOptions,
            meta,
            ulpStartedAt,
            ulpWindows,
            cardMessageId: ctx.callbackQuery && ctx.callbackQuery.message ? ctx.callbackQuery.message.message_id : null,
        });
    });

    bot.action("ulp:custom:prompt", async (ctx) => {
        await ctx.answerCbQuery().catch(() => { });
        userPromptState.set(ctx.chat.id, { action: "ulp:search_domain", createdAt: Date.now() });
        const activeDays = (store && store.getUlpDays && store.getUlpDays(ctx.chat.id)) || userUlpDays.get(ctx.chat.id) || searchOptions.daysCount || 5;
        const text = [
            `🌐  ${B("ENTER CUSTOM DOMAIN TO SEARCH")}  ⚡️`,
            RULE,
            `📅  Active Duration: ${B(`${activeDays} Day(s)`)}`,
            "",
            `Send any domain or URL you want to search (e.g. ${CODE("target.com")} or ${CODE("https://portal.com")}):`,
            "",
            `${I("The bot will automatically clean the domain and launch ULP day-by-day search.")}`,
        ].join("\n");
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        if (msg) {
            await safeEdit(ctx, msg.message_id, text, ulpPromptCancelKeyboard());
        } else {
            await safeReply(ctx, text, ulpPromptCancelKeyboard());
        }
    });

    bot.action("ulp:custom:add:prompt", async (ctx) => {
        await ctx.answerCbQuery().catch(() => { });
        userPromptState.set(ctx.chat.id, { action: "ulp:add_domain", createdAt: Date.now() });
        const text = [
            `➕  ${B("ADD CUSTOM DOMAIN PRESET")}  ⚡️`,
            RULE,
            `Send the domain or URL you want to pin to your quick presets (e.g. ${CODE("epicgames.com")}):`,
            "",
            `${I("It will appear as a quick one-tap button in your ULP menu!")}`,
        ].join("\n");
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        if (msg) {
            await safeEdit(ctx, msg.message_id, text, ulpPromptCancelKeyboard());
        } else {
            await safeReply(ctx, text, ulpPromptCancelKeyboard());
        }
    });

    bot.action(/^ulp:custom:add:(.+)$/, async (ctx) => {
        const rawToken = ctx.match[1];
        const domain = resolveCallbackPayload(rawToken);
        if (domain && store && store.addCustomDomain) {
            store.addCustomDomain(ctx.chat.id, domain);
        }
        await safeAnswerCbQuery(ctx, `📌 Added ${domain} to targets!`).catch(() => {});
        const activeDays = (store && store.getUlpDays && store.getUlpDays(ctx.chat.id)) || userUlpDays.get(ctx.chat.id) || searchOptions.daysCount || 5;
        const customDomains = (store && store.getCustomDomains && store.getCustomDomains(ctx.chat.id)) || [];
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        const text = `✅ ${B("Pinned")} ${CODE(escapeHtml(domain))} ${B("to your quick presets!")}`;
        if (msg) {
            await safeEdit(ctx, msg.message_id, text, ulpMenuKeyboard(activeDays, customDomains));
        } else {
            await safeReply(ctx, text, ulpMenuKeyboard(activeDays, customDomains));
        }
    });

    bot.action("process:local", async (ctx) => {
        await ctx.answerCbQuery("Processing newest file…").catch(() => {});
        const target = latestFileIn(process.env.LOCAL_PROCESS_ROOT || "/var/data");
        if (!target) {
            await safeReply(ctx, `⚠️ Nothing found under ${CODE(process.env.LOCAL_PROCESS_ROOT || "/var/data")}.`, mainKeyboard());
            return;
        }
        if (localJobs.has(ctx.chat.id)) {
            await safeReply(ctx, `⏳ Already processing ${CODE(escapeHtml(localJobs.get(ctx.chat.id)))}.`);
            return;
        }
        localJobs.set(ctx.chat.id, target);
        await ctx.replyWithChatAction("typing").catch(() => {});
        void processFile(ctx, target)
            .catch((err) => safeReply(ctx, `💥 ${B("Local processing failed")}\n${I(escapeHtml(err.message))}`))
            .finally(() => localJobs.delete(ctx.chat.id));
    });

    bot.action("ulp:custom:edit", async (ctx) => {
        await ctx.answerCbQuery().catch(() => { });
        userPromptState.delete(ctx.chat.id);
        const customDomains = (store && store.getCustomDomains && store.getCustomDomains(ctx.chat.id)) || [];
        const text = [
            `✏️  ${B("MANAGE CUSTOM DOMAINS")}  ⚡️`,
            RULE,
            customDomains.length > 0
                ? `You have ${B(customDomains.length)} custom target(s). Tap ${B("❌ Delete")} to remove one, or tap a domain to test search:`
                : `You don't have any custom domains yet. Tap ${B("➕ Add Custom Domain")} below to add one!`,
        ].join("\n");
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        if (msg) {
            await safeEdit(ctx, msg.message_id, text, ulpEditDomainsKeyboard(customDomains));
        } else {
            await safeReply(ctx, text, ulpEditDomainsKeyboard(customDomains));
        }
    });

    bot.action(/^ulp:custom:del:(.+)$/, async (ctx) => {
        const domain = resolveCallbackPayload(ctx.match[1]);
        if (store && store.removeCustomDomain) store.removeCustomDomain(ctx.chat.id, domain);
        await safeAnswerCbQuery(ctx, `🗑 Removed ${domain}`);
        const customDomains = (store && store.getCustomDomains && store.getCustomDomains(ctx.chat.id)) || [];
        const text = [
            `✏️  ${B("MANAGE CUSTOM DOMAINS")}  ⚡️`,
            RULE,
            customDomains.length > 0
                ? `You have ${B(customDomains.length)} custom target(s). Tap ${B("❌ Delete")} to remove one, or tap a domain to test search:`
                : `You don't have any custom domains yet. Tap ${B("➕ Add Custom Domain")} below to add one!`,
        ].join("\n");
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        if (msg) {
            await safeEdit(ctx, msg.message_id, text, ulpEditDomainsKeyboard(customDomains));
        } else {
            await safeReply(ctx, text, ulpEditDomainsKeyboard(customDomains));
        }
    });

    bot.action("ulp:custom:clear", async (ctx) => {
        if (store && store.clearCustomDomains) store.clearCustomDomains(ctx.chat.id);
        await ctx.answerCbQuery("🗑 All custom domains cleared!").catch(() => { });
        const text = [
            `✏️  ${B("MANAGE CUSTOM DOMAINS")}  ⚡️`,
            RULE,
            `You don't have any custom domains yet. Tap ${B("➕ Add Custom Domain")} below to add one!`,
        ].join("\n");
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        if (msg) {
            await safeEdit(ctx, msg.message_id, text, ulpEditDomainsKeyboard([]));
        } else {
            await safeReply(ctx, text, ulpEditDomainsKeyboard([]));
        }
    });

    bot.action("ulp:custom:days_prompt", async (ctx) => {
        await ctx.answerCbQuery().catch(() => { });
        userPromptState.set(ctx.chat.id, { action: "ulp:set_days", createdAt: Date.now() });
        const activeDays = (store && store.getUlpDays && store.getUlpDays(ctx.chat.id)) || userUlpDays.get(ctx.chat.id) || searchOptions.daysCount || 5;
        const text = [
            `📅  ${B("EDIT SEARCH DURATION (DAYS)")}  ⚡️`,
            RULE,
            `Current Duration: ${B(`${activeDays} Day(s)`)}`,
            "",
            `Send the number of days you want to search back (${B("1 to 90")} days):`,
            `${I("Examples: 2, 4, 10, 21, 45, or 60")}`,
        ].join("\n");
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        if (msg) {
            await safeEdit(ctx, msg.message_id, text, ulpPromptCancelKeyboard());
        } else {
            await safeReply(ctx, text, ulpPromptCancelKeyboard());
        }
    });

    bot.action("ulp:custom:cancel", async (ctx) => {
        userPromptState.delete(ctx.chat.id);
        await ctx.answerCbQuery("Cancelled").catch(() => { });
        const activeDays = (store && store.getUlpDays && store.getUlpDays(ctx.chat.id)) || userUlpDays.get(ctx.chat.id) || searchOptions.daysCount || 5;
        const customDomains = (store && store.getCustomDomains && store.getCustomDomains(ctx.chat.id)) || [];
        const text = renderUlpMenuText(searchOptions.botUsername, activeDays, customDomains.length);
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        if (msg) {
            await safeEdit(ctx, msg.message_id, text, ulpMenuKeyboard(activeDays, customDomains));
        } else {
            await safeReply(ctx, text, ulpMenuKeyboard(activeDays, customDomains));
        }
    });

    bot.action("batch:search:prompt", async (ctx) => {
        await ctx.answerCbQuery().catch(() => { });
        userPromptState.set(ctx.chat.id, { action: "batch:search:query", createdAt: Date.now() });
        const text = [
            `🔎  ${B("QUICK BATCH SEARCH")}  ⚡️`,
            RULE,
            `💎  Batch size: ${B(num(store.getStats(ctx.chat.id)?.size || 0))} lines`,
            "",
            `👇 ${I("Type any search query directly (e.g. gmail.com) or tap a filter below:")}`,
        ].join("\n");
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        if (msg) {
            await safeEdit(ctx, msg.message_id, text, searchPromptKeyboard());
        } else {
            await safeReply(ctx, text, searchPromptKeyboard());
        }
    });

    bot.action(/^batch:quicksearch:(.+)$/, async (ctx) => {
        const query = resolveCallbackPayload(ctx.match[1]);
        await safeAnswerCbQuery(ctx, `Searching ${query}…`);
        const result = store.searchLines(ctx.chat.id, query, 20);
        if (result && Array.isArray(result.matches)) {
            result.matches = result.matches.map((m) => cleanUserPassOnly(m) || m);
        }
        await safeReply(ctx, renderSearch(query, result), searchResultKeyboard(query, result.total));
    });

    bot.action(/^search:dl:(.+)$/, async (ctx) => {
        const query = resolveCallbackPayload(ctx.match[1]);
        await safeAnswerCbQuery(ctx, `Preparing "${query}" export…`);
        let matches = [];
        const res = store.searchLines(ctx.chat.id, query, 100000);
        matches = res.matches;

        if (matches.length === 0) {
            await safeReply(ctx, `⚠️ No matches found in batch for ${CODE(escapeHtml(query))}.`, mainKeyboard());
            return;
        }
        const cleanedLines = [];
        const seen = new Set();
        for (const m of matches) {
            const clean = cleanUserPassOnly(m) || m;
            if (!seen.has(clean)) {
                seen.add(clean);
                cleanedLines.push(clean);
            }
        }
        const buffer = Buffer.from(cleanedLines.join("\n"), "utf8");
        const stamp = new Date().toISOString().slice(0, 10);
        const filename = `search_${sanitizeSiteSlug(query)}_${stamp}.txt`;

        if (buffer.length > 48 * 1024 * 1024) {
            const dl = downloads.registerDownload({
                filename,
                buffer,
                size: buffer.length,
                chatId: ctx.chat && ctx.chat.id,
            });
            await safeReply(
                ctx,
                [
                    `📦  ${B("SEARCH EXPORT EXCEEDS TELEGRAM UPLOAD CAP")}`,
                    RULE,
                    `📄  ${B(escapeHtml(filename))} (${humanSize(buffer.length)}) exceeds Telegram's 50 MB Bot API limit.`,
                    "",
                    `🔗  ${B("Direct Download Link:")}`,
                    `${dl.url}`,
                    "",
                    `👇 ${I("Tap the button below to download directly in your browser:")}`,
                ].join("\n"),
                createInlineKeyboard([
                    [Markup.button.url("📥 Direct Download Link", dl.url)],
                    [Markup.button.callback("🔙 Main Menu", "help")],
                ]),
            );
            return;
        }

        try {
            await ctx.replyWithChatAction("upload_document").catch(() => { });
            await safeSendDocument(
                ctx,
                ctx.chat && ctx.chat.id,
                { source: buffer, filename },
                {
                    caption: [
                        `📥  ${B("SEARCH EXPORT READY")}  ⚡️`,
                        `🎯  Query: ${CODE(escapeHtml(query))}`,
                        `💎  Matches: ${B(num(matches.length))} lines`,
                    ].join("\n"),
                    parse_mode: "HTML",
                    ...afterCombineKeyboard(),
                },
            );
        } catch (err) {
            const dl = downloads.registerDownload({
                filename,
                buffer,
                size: buffer.length,
                chatId: ctx.chat && ctx.chat.id,
            });
            await safeReply(
                ctx,
                [
                    `⚠️ Telegram upload failed: ${escapeHtml(err.message)}`,
                    "",
                    `🔗  ${B("Direct Download Link:")} ${dl.url}`,
                ].join("\n"),
                createInlineKeyboard([
                    [Markup.button.url("📥 Download Directly", dl.url)],
                    [Markup.button.callback("🔙 Main Menu", "help")],
                ]),
            );
        }
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

    bot.command(["lsearch", "vaultsearch", "vsearch", "filesearch", "fsearch"], async (ctx) => {
        const raw = (ctx.message?.text || "").replace(/^\S+\s*/, "").trim();
        const rawFiles = scanDirFiles(localProcessRoot());
        const procFiles = scanDirFiles(localProcessedRoot());

        if (!raw) {
            await safeReply(
                ctx,
                renderLocalSearchHub(rawFiles, procFiles),
                localSearchHubKeyboard(rawFiles, procFiles)
            );
            return;
        }

        const parts = raw.split(/\s+/);
        const query = parts[0];
        const target = parts.slice(1).join(" ").trim();

        if (!query) {
            await safeReply(
                ctx,
                renderLocalSearchHub(rawFiles, procFiles),
                localSearchHubKeyboard(rawFiles, procFiles)
            );
            return;
        }

        // Cleaned vault only search
        if (target.toLowerCase() === "clean" || target.toLowerCase() === "cleaned" || target.toLowerCase() === "proc") {
            const abortController = new AbortController();
            activeVaultSearches.set(ctx.chat.id, {
                query,
                startedAt: Date.now(),
                controller: abortController,
            });

            const status = await safeReply(
                ctx,
                renderFileSearchProgress({
                    query,
                    fileName: "Cleaned Vault Files",
                    current: 0,
                    total: procFiles.length,
                    matchesCount: 0,
                    isAll: true,
                }),
                fileSearchProgressKeyboard({ current: 0, total: procFiles.length })
            );

            let lastEdit = Date.now();
            const onProgress = async (prog) => {
                const now = Date.now();
                if (now - lastEdit < 1000 && prog.current < prog.total) return;
                lastEdit = now;
                if (status && status.message_id) {
                    await safeEdit(
                        ctx,
                        status.message_id,
                        renderFileSearchProgress({
                            query,
                            fileName: prog.currentFile || "Cleaned Files",
                            current: prog.current,
                            total: prog.total,
                            matchesCount: prog.matchesFound,
                            isAll: true,
                        }),
                        fileSearchProgressKeyboard({ current: prog.current, total: prog.total })
                    ).catch(() => {});
                }
            };

            try {
                const result = await searchAllVaultFiles(query, {
                    limit: 20,
                    rawRoot: null,
                    procRoot: localProcessedRoot(),
                    signal: abortController.signal,
                    onProgress,
                });
                result.fileResults = result.fileResults.filter((f) => f.type === "proc");
                result.total = result.fileResults.reduce((acc, f) => acc + f.total, 0);
                result.totalFiles = procFiles.length;
                result.searchedFiles = result.fileResults.length;
                const card = renderLocalSearch({
                    query,
                    total: result.total,
                    matches: result.matches,
                    fileResults: result.fileResults,
                    totalFiles: result.totalFiles,
                    searchedFiles: result.searchedFiles,
                    isAll: true,
                });
                const kb = localSearchResultKeyboard({
                    query,
                    total: result.total,
                    isAll: true,
                });
                if (status && status.message_id) {
                    await safeEdit(ctx, status.message_id, card, kb);
                } else {
                    await safeReply(ctx, card, kb);
                }
            } catch (err) {
                if (abortController.signal.aborted) {
                    if (status && status.message_id) {
                        await safeEdit(ctx, status.message_id, "🚫 Vault search cancelled.", mainKeyboard());
                    }
                    return;
                }
                const errMsg = `💥 Search failed: ${escapeHtml(err.message)}`;
                if (status && status.message_id) {
                    await safeEdit(ctx, status.message_id, errMsg, mainKeyboard());
                } else {
                    await safeReply(ctx, errMsg, mainKeyboard());
                }
            } finally {
                activeVaultSearches.delete(ctx.chat.id);
            }
            return;
        }

        // Raw dumps only search
        if (target.toLowerCase() === "raw" || target.toLowerCase() === "dumps") {
            const abortController = new AbortController();
            activeVaultSearches.set(ctx.chat.id, {
                query,
                startedAt: Date.now(),
                controller: abortController,
            });

            const status = await safeReply(
                ctx,
                renderFileSearchProgress({
                    query,
                    fileName: "Raw Vault Dumps",
                    current: 0,
                    total: rawFiles.length,
                    matchesCount: 0,
                    isAll: true,
                }),
                fileSearchProgressKeyboard({ current: 0, total: rawFiles.length })
            );

            let lastEdit = Date.now();
            const onProgress = async (prog) => {
                const now = Date.now();
                if (now - lastEdit < 1000 && prog.current < prog.total) return;
                lastEdit = now;
                if (status && status.message_id) {
                    await safeEdit(
                        ctx,
                        status.message_id,
                        renderFileSearchProgress({
                            query,
                            fileName: prog.currentFile || "Raw Dumps",
                            current: prog.current,
                            total: prog.total,
                            matchesCount: prog.matchesFound,
                            isAll: true,
                        }),
                        fileSearchProgressKeyboard({ current: prog.current, total: prog.total })
                    ).catch(() => {});
                }
            };

            try {
                const result = await searchAllVaultFiles(query, {
                    limit: 20,
                    rawRoot: localProcessRoot(),
                    procRoot: null,
                    signal: abortController.signal,
                    onProgress,
                });
                result.fileResults = result.fileResults.filter((f) => f.type === "raw");
                result.total = result.fileResults.reduce((acc, f) => acc + f.total, 0);
                result.totalFiles = rawFiles.length;
                result.searchedFiles = result.fileResults.length;
                const card = renderLocalSearch({
                    query,
                    total: result.total,
                    matches: result.matches,
                    fileResults: result.fileResults,
                    totalFiles: result.totalFiles,
                    searchedFiles: result.searchedFiles,
                    isAll: true,
                });
                const kb = localSearchResultKeyboard({
                    query,
                    total: result.total,
                    isAll: true,
                });
                if (status && status.message_id) {
                    await safeEdit(ctx, status.message_id, card, kb);
                } else {
                    await safeReply(ctx, card, kb);
                }
            } catch (err) {
                if (abortController.signal.aborted) {
                    if (status && status.message_id) {
                        await safeEdit(ctx, status.message_id, "🚫 Vault search cancelled.", mainKeyboard());
                    }
                    return;
                }
                const errMsg = `💥 Search failed: ${escapeHtml(err.message)}`;
                if (status && status.message_id) {
                    await safeEdit(ctx, status.message_id, errMsg, mainKeyboard());
                } else {
                    await safeReply(ctx, errMsg, mainKeyboard());
                }
            } finally {
                activeVaultSearches.delete(ctx.chat.id);
            }
            return;
        }

        // Specific file target
        if (target) {
            let matchedFile = null;
            let fileIdx = null;
            let isProc = false;

            const numTarget = parseInt(target.replace("#", ""), 10);
            if (!isNaN(numTarget) && numTarget >= 1) {
                if (numTarget <= procFiles.length) {
                    matchedFile = procFiles[numTarget - 1];
                    fileIdx = numTarget - 1;
                    isProc = true;
                } else if (numTarget - procFiles.length <= rawFiles.length) {
                    matchedFile = rawFiles[numTarget - procFiles.length - 1];
                    fileIdx = numTarget - procFiles.length - 1;
                    isProc = false;
                }
            }

            if (!matchedFile) {
                const procMatch = procFiles.findIndex((f) => f.name.toLowerCase().includes(target.toLowerCase()));
                if (procMatch !== -1) {
                    matchedFile = procFiles[procMatch];
                    fileIdx = procMatch;
                    isProc = true;
                } else {
                    const rawMatch = rawFiles.findIndex((f) => f.name.toLowerCase().includes(target.toLowerCase()));
                    if (rawMatch !== -1) {
                        matchedFile = rawFiles[rawMatch];
                        fileIdx = rawMatch;
                        isProc = false;
                    }
                }
            }

            if (matchedFile) {
                const abortController = new AbortController();
                activeVaultSearches.set(ctx.chat.id, {
                    query,
                    startedAt: Date.now(),
                    controller: abortController,
                });
                const status = await safeReply(
                    ctx,
                    renderFileSearchProgress({
                        query,
                        fileName: matchedFile.name,
                        fileSize: matchedFile.size,
                        current: 0,
                        total: 1,
                        matchesCount: 0,
                        isAll: false,
                    }),
                    fileSearchProgressKeyboard({ current: 0, total: 1 })
                );
                try {
                    const res = await searchTextFile(matchedFile.path, query, 20, { signal: abortController.signal });
                    const card = renderLocalSearch({
                        query,
                        total: res.total,
                        matches: res.matches,
                        fileName: matchedFile.name,
                        fileSize: matchedFile.size,
                        isProc,
                        fileIdx,
                    });
                    const kb = localSearchResultKeyboard({
                        query,
                        total: res.total,
                        fileIdx,
                        isProc,
                        isAll: false,
                    });
                    if (status && status.message_id) {
                        await safeEdit(ctx, status.message_id, card, kb);
                    } else {
                        await safeReply(ctx, card, kb);
                    }
                } catch (err) {
                    if (abortController.signal.aborted) {
                        if (status && status.message_id) {
                            await safeEdit(ctx, status.message_id, "🚫 File search cancelled.", mainKeyboard());
                        }
                        return;
                    }
                    const errMsg = `💥 Search failed: ${escapeHtml(err.message)}`;
                    if (status && status.message_id) {
                        await safeEdit(ctx, status.message_id, errMsg, mainKeyboard());
                    } else {
                        await safeReply(ctx, errMsg, mainKeyboard());
                    }
                } finally {
                    activeVaultSearches.delete(ctx.chat.id);
                }
                return;
            }
        }

        // Vault-wide search across ALL raw and cleaned files
        const totalVaultFiles = rawFiles.length + procFiles.length;
        if (totalVaultFiles === 0) {
            await safeReply(
                ctx,
                `⚠️ No files found in server vault (${CODE(localProcessRoot())} or ${CODE(localProcessedRoot())}).\nUpload or save some dumps first!`,
                mainKeyboard()
            );
            return;
        }

        if (activeVaultSearches.has(ctx.chat.id)) {
            await safeReply(
                ctx,
                `⏳ A vault search is already running. Please wait for it to complete or send ${CODE("cancel")}.`
            );
            return;
        }

        const abortController = new AbortController();
        activeVaultSearches.set(ctx.chat.id, {
            query,
            startedAt: Date.now(),
            controller: abortController,
        });

        const status = await safeReply(
            ctx,
            renderFileSearchProgress({
                query,
                fileName: "All Vault Files",
                current: 0,
                total: totalVaultFiles,
                matchesCount: 0,
                isAll: true,
            }),
            fileSearchProgressKeyboard({ current: 0, total: totalVaultFiles })
        );

        let lastEdit = Date.now();
        const onProgress = async (prog) => {
            const now = Date.now();
            if (now - lastEdit < 1000 && prog.current < prog.total) return;
            lastEdit = now;
            if (status && status.message_id) {
                await safeEdit(
                    ctx,
                    status.message_id,
                    renderFileSearchProgress({
                        query,
                        fileName: prog.currentFile || "Vault Files",
                        current: prog.current,
                        total: prog.total,
                        matchesCount: prog.matchesFound,
                        isAll: true,
                    }),
                    fileSearchProgressKeyboard({ current: prog.current, total: prog.total })
                ).catch(() => {});
            }
        };

        try {
            const result = await searchAllVaultFiles(query, {
                limit: 20,
                signal: abortController.signal,
                onProgress,
            });
            const card = renderLocalSearch({
                query,
                total: result.total,
                matches: result.matches,
                fileResults: result.fileResults,
                totalFiles: result.totalFiles,
                searchedFiles: result.searchedFiles,
                isAll: true,
            });
            const kb = localSearchResultKeyboard({
                query,
                total: result.total,
                isAll: true,
            });
            if (status && status.message_id) {
                await safeEdit(ctx, status.message_id, card, kb);
            } else {
                await safeReply(ctx, card, kb);
            }
        } catch (err) {
            if (abortController.signal.aborted) {
                if (status && status.message_id) {
                    await safeEdit(ctx, status.message_id, "🚫 Vault search cancelled.", mainKeyboard());
                }
                return;
            }
            const errMsg = `💥 Search failed: ${escapeHtml(err.message)}`;
            if (status && status.message_id) {
                await safeEdit(ctx, status.message_id, errMsg, mainKeyboard());
            } else {
                await safeReply(ctx, errMsg, mainKeyboard());
            }
        } finally {
            activeVaultSearches.delete(ctx.chat.id);
        }
    });

    bot.command("ping", async (ctx) => {
        const t0 = Date.now();
        try {
            await ctx.telegram.getMe();
        } catch (_) {}
        const latencyMs = Date.now() - t0;
        const uptimeSec = (Date.now() - STARTED_AT) / 1000;
        const stats = store.getStats(ctx.chat.id);
        await safeReply(ctx, renderPing({ latencyMs, uptimeSec }), statsKeyboard(stats && stats.size > 0));
    });

    bot.command("name", async (ctx) => {
        const arg = (ctx.message?.text || "").replace(/^\S+\s*/, "").trim();
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

    bot.command(["clear", "wipe", "reset", "empty", "purge"], async (ctx) => {
        userPromptState.delete(ctx.chat.id);
        const stats = store.getStats(ctx.chat.id);
        if (!stats || stats.size === 0) {
            await safeReply(ctx, "📬 Nothing stored for this chat — all clean ✨", emptyBatchKeyboard());
            return;
        }
        // Two-step confirmation so a stray tap can't wipe the batch.
        await safeReply(
            ctx,
            [
                `🧹  ${B("Clear this batch?")}`,
                `📦 It holds ${B(num(stats.size))} unique line${stats.size === 1 ? "" : "s"}`,
                "",
                `${I("This can't be undone ⚠️")}`,
            ].join("\n"),
            confirmClearKeyboard(),
        );
    });

    bot.command(["combine", "download", "get", "export", "dl"], async (ctx) => {
        userPromptState.delete(ctx.chat.id);
        await ctx.replyWithChatAction("upload_document").catch(() => { });
        await sendCombined(ctx);
    });

    bot.command("clean", async (ctx) => {
        userPromptState.delete(ctx.chat.id);
        const stats = store.getStats(ctx.chat.id);
        if (stats && stats.size > 0) {
            await ctx.replyWithChatAction("upload_document").catch(() => { });
            await sendCombined(ctx);
        } else {
            await safeReply(
                ctx,
                [
                    `⚡️  ${B("READY TO CLEAN")}`,
                    RULE,
                    `📤 ${I("Send or forward any .txt, .zip, .rar, or .7z log dump to clean it instantly!")}`,
                    `💾 ${I("Or use /save by replying to any large file to stream it directly to disk.")}`,
                ].join("\n"),
                mainKeyboard(),
            );
        }
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
    bot.command(["process", "proc"], async (ctx) => {
        userPromptState.delete(ctx.chat.id);
        const raw = (ctx.message?.text || "").replace(/^\/\S+\s*/, "").trim();
        if (!raw) {
            await safeReply(
                ctx,
                [
                    `📋  ${B("PROCESS A LOCAL FILE")}`,
                    RULE,
                    `${I("Usage:")} ${CODE("/process /var/data/file.zip")}  ${I("or")}  ${CODE("/process /var/data/file.txt")}`,
                    "",
                    `${I("Plain-text files are streamed (memory-safe). Huge zips must fit in RAM.")}`,
                    "",
                    `👇 ${I("Tap an action below to process the newest server file or browse your vault:")}`,
                ].join("\n"),
                processPromptKeyboard(),
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
    // ---- /save & aliases (/largefiles, /ragefiles, /mergefiles, /storagefiles)
    //
    // If invoked as a reply to a document, downloads that file directly to server disk and cleans it.
    // If invoked without a reply, activates interactive Save Mode: listens for forwarded or uploaded
    // files, queueing and processing each one by one into the batch.
    bot.command(["save", "largefiles", "ragefiles", "storagefiles", "mergefiles", "filesave", "savelarge"], async (ctx) => {
        let replied = ctx.message && ctx.message.reply_to_message;
        let sourceMessageId = replied && replied.message_id;
        let originalName = userbot.resolveSafeFileName(
            replied && (replied.document || replied.file_name),
            `telegram-${sourceMessageId || Date.now()}`,
        );
        let docSize = replied && replied.document && replied.document.file_size;
        let repliedMessageObj = null;

        const peer = meta.userbot;

        // If Bot API didn't deliver the replied document (e.g. Telegram Bot Privacy Mode in private groups),
        // use the MTProto userbot to inspect the chat's actual replied message or recent documents!
        if ((!replied || !replied.document) && sourceMessageId && peer && typeof peer.isReady === "function" && peer.isReady() && typeof peer.findRepliedOrRecentDocument === "function") {
            try {
                const found = await peer.findRepliedOrRecentDocument(
                    ctx.chat.id,
                    ctx.message && ctx.message.message_id,
                    sourceMessageId,
                );
                if (found) {
                    sourceMessageId = found.messageId;
                    originalName = userbot.resolveSafeFileName(found.fileName, `telegram-${sourceMessageId}`);
                    docSize = found.size;
                    repliedMessageObj = found.message || null;
                    replied = { message_id: found.messageId, document: { file_name: originalName, file_size: found.size } };
                }
            } catch (err) {
                console.error("userbot findRepliedOrRecentDocument failed:", err && err.message ? err.message : err);
            }
        }

        if (!replied || !replied.document) {
            // Interactive listening mode: wait for forwarded / uploaded documents to save one by one!
            userPromptState.set(ctx.chat.id, {
                action: "save:listening",
                startedAt: Date.now(),
                queue: [],
                active: false,
                processed: [],
                noticeId: null,
            });
            await safeReply(
                ctx,
                renderSaveListeningPrompt(meta.botUsername),
                saveListeningKeyboard(),
            );
            return;
        }

        userPromptState.delete(ctx.chat.id);
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
        originalName = userbot.resolveSafeFileName(
            replied.document || originalName,
            `dump_${sourceMessageId}`,
        );
        const status = await safeReply(
            ctx,
            [
                `\uD83D\uDCE5  ${B("DOWNLOADING FROM TELEGRAM")}`,
                RULE,
                `\uD83D\uDCC4  ${escapeHtml(originalName)}`,
                `\uD83D\uDCBE  destination: ${CODE(escapeHtml(localProcessRoot()))}`,
                "",
                `${I("The MTProto account is streaming the file directly to disk\u2026")}`,
            ].join("\n")
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

    /**
     * Enqueue a document received while in save:listening mode.
     * Files are buffered into the queue and only processed when /done is received.
     */
    async function queueSaveDocument(ctx, prompt) {
        const msg = (ctx && (ctx.message || ctx.channelPost)) || {};
        const doc = msg.document;
        if (!doc) return;

        const messageId = msg.message_id || Date.now();
        const originalName = userbot.resolveSafeFileName(
            doc,
            `dump_${messageId}`,
        );

        const sourceInfo = userbot.extractForwardOrigin(msg) || userbot.parseChannelFilename(originalName);

        prompt.queue = prompt.queue || [];
        prompt.processed = prompt.processed || [];
        prompt.queue.push({
            ctx,
            doc,
            messageId,
            name: originalName,
            size: doc.file_size || 0,
            sourceInfo,
        });

        const queueCount = prompt.queue.length;

        if (prompt.active) {
            const queuePos = queueCount;
            await safeReply(
                ctx,
                `📥  ${B("Queued for saving")} (#${prompt.processed.length + queuePos})\n📄 ${CODE(escapeHtml(originalName))} · ${humanSize(doc.file_size || 0)}`,
            );
        } else if (!prompt.noticeId) {
            const notice = await safeReply(
                ctx,
                [
                    `📥  ${B("Queued for saving")} (#${num(queueCount)})`,
                    `📄  ${CODE(escapeHtml(originalName))} · ${humanSize(doc.file_size || 0)}`,
                    "",
                    `${I("Forward more files, or send /done or tap Done when finished.")}`,
                ].join("\n"),
                saveListeningKeyboard(queueCount),
            );
            if (notice && notice.message_id) {
                prompt.noticeId = notice.message_id;
            }
        } else {
            void safeEdit(
                ctx,
                prompt.noticeId,
                [
                    `📥  ${B("Queued for saving")} (${num(queueCount)} files queued)`,
                    `📄  Latest: ${CODE(escapeHtml(originalName))} · ${humanSize(doc.file_size || 0)}`,
                    "",
                    `${I("Forward more files, or send /done or tap Done when finished.")}`,
                ].join("\n"),
                saveListeningKeyboard(queueCount),
            ).catch(() => {});
        }
    }

    /**
     * Process queued files sequentially one by one.
     */
    async function processSaveQueue(chatId, prompt) {
        if (prompt.active) return;
        prompt.active = true;

        try {
            while (prompt.queue && prompt.queue.length > 0) {
                const item = prompt.queue.shift();
                await processSingleSaveItem(chatId, item, prompt);
            }
        } catch (err) {
            console.error("processSaveQueue error:", err);
        } finally {
            prompt.active = false;
        }
    }

    /**
     * Download and clean a single queued file into the active batch.
     */
    async function processSingleSaveItem(chatId, item, prompt) {
        const ctx = item.ctx;
        const fileIndex = (prompt.processed ? prompt.processed.length : 0) + 1;
        const rawName = item.name;
        const lowerName = rawName.toLowerCase();
        const isZip = lowerName.endsWith(".zip");
        const isText = [".txt", ".csv", ".tsv", ".log", ".lst", ".list", ".dat"].some((e) => lowerName.endsWith(e));

        if (!isZip && !isText) {
            await safeReply(
                ctx,
                [
                    `⛔  ${B("Unsupported file type")}`,
                    `Skipping ${CODE(escapeHtml(rawName))}: only ${B(".zip")} archives and plain text files are supported.`,
                ].join("\n"),
            );
            return;
        }

        const peer = meta.userbot;
        const destDir = (meta && (meta.localProcessRoot || meta.processRoot)) || localProcessRoot();
        fs.mkdirSync(destDir, { recursive: true });

        // Ensure unique filename on server disk
        let diskFileName = rawName;
        const ext = path.extname(rawName) || (isZip ? ".zip" : ".txt");
        const base = path.basename(rawName, ext);
        if (fs.existsSync(path.join(destDir, diskFileName))) {
            diskFileName = `${base}_${item.messageId}${ext}`;
        }
        let destPath = path.join(destDir, diskFileName);

        const statusMsg = await safeReply(
            ctx,
            [
                `📥  ${B(`SAVING FILE #${fileIndex}`)}`,
                RULE,
                `📄  ${escapeHtml(rawName)}`,
                `📦  ${humanSize(item.size)}`,
                `💾  destination: ${CODE(escapeHtml(destDir))}`,
                "",
                `${I("Downloading and saving to disk…")}`,
            ].join("\n"),
        );
        const statusMsgId = statusMsg ? statusMsg.message_id : null;

        let downloaded = false;
        let lastDlError = null;
        localJobs.set(chatId, `save:${diskFileName}`);

        try {
            // Attempt 1: MTProto userbot download to disk
            if (peer && typeof peer.isReady === "function" && peer.isReady()) {
                const source = item.sourceInfo || userbot.extractForwardOrigin(ctx.message) || userbot.parseChannelFilename(rawName);
                if (source && source.peer && source.messageId) {
                    try {
                        let lastProgressAt = 0;
                        const saved = await peer.downloadMessageToDisk(source.peer, source.messageId, {
                            root: destDir,
                            fileName: diskFileName,
                            onProgress: (done, total) => {
                                if (Date.now() - lastProgressAt < 3000) return;
                                lastProgressAt = Date.now();
                                const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
                                if (statusMsgId) {
                                    void safeEdit(
                                        ctx,
                                        statusMsgId,
                                        [
                                            `📥  ${B(`SAVING FILE #${fileIndex}`)} · ${pct}%`,
                                            RULE,
                                            `📄  ${escapeHtml(rawName)}`,
                                            `📦  ${humanSize(done)} / ${humanSize(total || done)}`,
                                            `💾  destination: ${CODE(escapeHtml(destDir))}`,
                                        ].join("\n"),
                                    );
                                }
                            },
                        });
                        if (saved && saved.path && fs.existsSync(saved.path)) {
                            destPath = saved.path;
                            downloaded = true;
                        }
                    } catch (peerErr) {
                        console.error(`userbot download from source ${source.peer}:${source.messageId} failed:`, peerErr && peerErr.message ? peerErr.message : peerErr);
                        lastDlError = peerErr && peerErr.message ? peerErr.message : String(peerErr);
                    }
                }

                // If not downloaded yet, try from current chat (works if group contains userbot)
                if (!downloaded) {
                    try {
                        let lastProgressAt = 0;
                        const saved = await peer.downloadMessageToDisk(chatId, item.messageId, {
                            root: destDir,
                            fileName: diskFileName,
                            onProgress: (done, total) => {
                                if (Date.now() - lastProgressAt < 3000) return;
                                lastProgressAt = Date.now();
                                const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
                                if (statusMsgId) {
                                    void safeEdit(
                                        ctx,
                                        statusMsgId,
                                        [
                                            `📥  ${B(`SAVING FILE #${fileIndex}`)} · ${pct}%`,
                                            RULE,
                                            `📄  ${escapeHtml(rawName)}`,
                                            `📦  ${humanSize(done)} / ${humanSize(total || done)}`,
                                            `💾  destination: ${CODE(escapeHtml(destDir))}`,
                                        ].join("\n"),
                                    );
                                }
                            },
                        });
                        if (saved && saved.path && fs.existsSync(saved.path)) {
                            destPath = saved.path;
                            downloaded = true;
                        }
                    } catch (peerErr) {
                        console.error(`userbot download from chat ${chatId}:${item.messageId} failed:`, peerErr && peerErr.message ? peerErr.message : peerErr);
                        if (!lastDlError) {
                            lastDlError = peerErr && peerErr.message ? peerErr.message : String(peerErr);
                        }
                    }
                }
            }

            // Attempt 2: Bot API direct download if <= MAX_DOWNLOAD_BYTES
            if (!downloaded && item.doc && item.doc.file_id) {
                if (item.size > MAX_DOWNLOAD_BYTES) {
                    lastDlError = `File size (${humanSize(item.size)}) exceeds Telegram Bot API 20 MB download limit`;
                } else {
                    try {
                        const link = await ctx.telegram.getFileLink(item.doc.file_id);
                        const res = await fetch(link.href);
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                        const buf = Buffer.from(await res.arrayBuffer());
                        fs.writeFileSync(destPath, buf);
                        downloaded = true;
                    } catch (dlErr) {
                        console.error("Bot API file download error:", dlErr && dlErr.message ? dlErr.message : dlErr);
                        lastDlError = dlErr && dlErr.message ? dlErr.message : String(dlErr);
                    }
                }
            }

            if (!downloaded || !fs.existsSync(destPath)) {
                let failLines = [
                    `⚠️  ${B("Could not download or save")} ${CODE(escapeHtml(rawName))}.`,
                ];
                if (item.size > MAX_DOWNLOAD_BYTES) {
                    failLines.push(
                        `📦  ${B("Size:")} ${humanSize(item.size)} (exceeds Telegram Bot API 20 MB limit).`,
                    );
                    if (!peer || !peer.isReady()) {
                        failLines.push(`🔌  ${I("Account downloader (userbot) is offline. Start the userbot with MTProto credentials to download files > 20 MB.")}`);
                    } else {
                        failLines.push(`💡  ${I("If forwarded from a channel, make sure the userbot account has access to that channel, or forward it into a group with the userbot.")}`);
                    }
                } else if (lastDlError) {
                    failLines.push(`❌  ${I(escapeHtml(lastDlError))}`);
                }
                const failText = failLines.join("\n");
                if (statusMsgId) {
                    await safeEdit(ctx, statusMsgId, failText);
                } else {
                    await safeReply(ctx, failText);
                }
                return;
            }

            // Clean & process file into batch
            const beforeStats = store.getStats(chatId);
            const beforeSize = beforeStats ? beforeStats.size : 0;

            await processFile(ctx, destPath, statusMsgId, { root: destDir });

            const afterStats = store.getStats(chatId);
            const afterSize = afterStats ? afterStats.size : 0;
            const linesAdded = Math.max(0, afterSize - beforeSize);

            prompt.processed.push({
                name: rawName,
                size: item.size,
                linesAdded,
                path: destPath,
            });
        } catch (err) {
            console.error(`Error saving item ${rawName}:`, err);
            const errText = `⚠️  Error processing ${CODE(escapeHtml(rawName))}: ${escapeHtml(err.message || String(err))}`;
            if (statusMsgId) {
                await safeEdit(ctx, statusMsgId, errText);
            } else {
                await safeReply(ctx, errText);
            }
        } finally {
            localJobs.delete(chatId);
        }
    }

    /**
     * Finish the current save session and display complete summary.
     */
    const finishSaveSession = async (ctx) => {
        const prompt = userPromptState.get(ctx.chat.id);
        if (!prompt || prompt.action !== "save:listening") {
            const batch = store.getStats(ctx.chat.id);
            await safeReply(
                ctx,
                [
                    `ℹ️  ${B("No active save session.")}`,
                    `To start saving forwarded or uploaded files one by one, send ${CODE("/save")}.`,
                    "",
                    `📦  Active batch: ${B(num(batch ? batch.size : 0))} lines (${batch ? batch.files : 0} files)`,
                ].join("\n"),
                mainKeyboard(),
            );
            return;
        }

        if (prompt.active) {
            await safeReply(
                ctx,
                `⏳  ${B("Currently processing queued files…")}\nPlease wait a moment for the save session to finish.`,
            );
            return;
        }

        // When /done is received, process all queued files one by one!
        if (prompt.queue && prompt.queue.length > 0) {
            const total = prompt.queue.length;
            await safeReply(
                ctx,
                `⚡  ${B(`Processing ${num(total)} queued file${total === 1 ? "" : "s"} one by one…`)}`,
            );
            await processSaveQueue(ctx.chat.id, prompt);
        }

        userPromptState.delete(ctx.chat.id);
        const processed = prompt.processed || [];
        lastCompletedSaveSessions.set(ctx.chat.id, processed);
        const batch = store.getStats(ctx.chat.id);
        await safeReply(
            ctx,
            renderSaveListeningComplete({
                processed,
                totalBatchLines: batch ? batch.size : 0,
            }),
            saveListeningCompleteKeyboard(processed.length > 0),
        );
    };

    /**
     * Cancel the active save session.
     */
    const cancelSaveSession = async (ctx) => {
        const prompt = userPromptState.get(ctx.chat.id);
        if (prompt) {
            userPromptState.delete(ctx.chat.id);
            if (prompt.action === "save:listening") {
                await safeReply(ctx, `❌  ${B("Save mode cancelled.")}`, mainKeyboard());
            } else if (prompt.action === "remove_domain") {
                await safeReply(ctx, `❌  ${B("Domain removal cancelled.")}`, mainKeyboard());
            } else if (prompt.action && String(prompt.action).startsWith("ulp:")) {
                await safeReply(ctx, `❌  ${B("ULP setup cancelled.")}`, mainKeyboard());
            } else {
                await safeReply(ctx, `❌  ${B("Action cancelled.")}`, mainKeyboard());
            }
        } else {
            await safeReply(ctx, `ℹ️  No active save session to cancel.`, mainKeyboard());
        }
    };

    /**
     * Merge all files from active or last save session into one clean file on disk without sending to Telegram.
     */
    const handleMergeSession = async (ctx) => {
        const prompt = userPromptState.get(ctx.chat.id);
        let sessionFiles = [];
        if (prompt && prompt.action === "save:listening") {
            if (prompt.queue && prompt.queue.length > 0) {
                const total = prompt.queue.length;
                await safeReply(ctx, `⚡  ${B(`Processing ${num(total)} queued file${total === 1 ? "" : "s"} before merging…`)}`);
                await processSaveQueue(ctx.chat.id, prompt);
            }
            sessionFiles = prompt.processed || [];
            userPromptState.delete(ctx.chat.id);
        } else {
            sessionFiles = lastCompletedSaveSessions.get(ctx.chat.id) || [];
        }

        if (!sessionFiles || sessionFiles.length === 0) {
            await safeReply(ctx, `⚠️  ${B("No files saved in current or recent session.")}\nForward or save files with ${CODE("/save")} first!`);
            return;
        }

        const statusMsg = await safeReply(ctx, `⏳  ${B(`Merging ${sessionFiles.length} session file(s) into one clean file on disk…`)}`);
        try {
            const stats = await mergeFilesOnServer(ctx, sessionFiles, {
                statusMsgId: statusMsg ? statusMsg.message_id : null,
            });
            const report = renderMergeComplete(stats);
            const kb = mergeCompleteKeyboard(stats.outName);
            if (statusMsg && statusMsg.message_id) {
                await safeEdit(ctx, statusMsg.message_id, report, kb);
            } else {
                await safeReply(ctx, report, kb);
            }
        } catch (err) {
            console.error("Session merge error:", err);
            await safeReply(ctx, `❌ Failed to merge session files on disk: ${err.message}`);
        }
    };

    bot.command(["done", "finish"], finishSaveSession);
    bot.command("cancel", cancelSaveSession);
    bot.command("mergesession", handleMergeSession);

    bot.action("save:done", async (ctx) => {
        try {
            await ctx.answerCbQuery().catch(() => {});
        } catch (_) {}
        await finishSaveSession(ctx);
    });

    bot.action("save:cancel", async (ctx) => {
        try {
            await ctx.answerCbQuery().catch(() => {});
        } catch (_) {}
        await cancelSaveSession(ctx);
    });

    bot.action("save:merge_session", async (ctx) => {
        try {
            await ctx.answerCbQuery().catch(() => {});
        } catch (_) {}
        await handleMergeSession(ctx);
    });

    bot.action("save:merge_and_finish", async (ctx) => {
        try {
            await ctx.answerCbQuery().catch(() => {});
        } catch (_) {}
        await handleMergeSession(ctx);
    });

    bot.action("save:start", async (ctx) => {
        try {
            await ctx.answerCbQuery().catch(() => {});
        } catch (_) {}
        userPromptState.set(ctx.chat.id, {
            action: "save:listening",
            startedAt: Date.now(),
            queue: [],
            active: false,
            processed: [],
            noticeId: null,
        });
        await safeReply(
            ctx,
            renderSaveListeningPrompt(meta.botUsername),
            saveListeningKeyboard(),
        );
    });

    bot.queueSaveDocument = queueSaveDocument;
    bot.processSaveQueue = processSaveQueue;

    // ---- /batchsave [count] & /savebatch: batch save & clean multiple forwarded/uploaded files
    //
    // Finds recent documents in the chat using the MTProto userbot, downloads each to disk,
    // cleans them sequentially into the batch, and reports aggregate results.
    const batchSaveHandler = async (ctx) => {
        userPromptState.delete(ctx.chat.id);
        const peer = meta.userbot;
        if (!peer || typeof peer.isReady !== "function" || !peer.isReady()) {
            await safeReply(
                ctx,
                `⚠️  ${B("Account downloader is offline")}\nSet TELEGRAM_API_ID, TELEGRAM_API_HASH and TELEGRAM_SESSION, then redeploy.`,
            );
            return;
        }

        if (localJobs.has(ctx.chat.id)) {
            await safeReply(ctx, `⏳  Already processing ${CODE(escapeHtml(localJobs.get(ctx.chat.id)))}.`);
            return;
        }

        // Parse optional limit: e.g. "/batchsave 20" or default to 10 (max 50)
        const rawArg = (ctx.message?.text || "").replace(/^\/\S+\s*/, "").trim();
        let limit = 10;
        if (rawArg && /^\d+$/.test(rawArg)) {
            limit = Math.min(50, Math.max(1, parseInt(rawArg, 10)));
        }

        const cmdMsgId = ctx.message && ctx.message.message_id;
        const statusMsg = await safeReply(
            ctx,
            [
                `🔍  ${B("SCANNING FOR DOCUMENTS")}  ⏳`,
                RULE,
                `Scanning recent chat history for up to ${B(num(limit))} documents…`,
                "",
                I("The MTProto userbot is reading recent forwarded documents directly from the chat ⚡️"),
            ].join("\n")
        );

        let docs = [];
        try {
            if (typeof peer.findRecentDocuments === "function") {
                docs = await peer.findRecentDocuments(ctx.chat.id, limit, cmdMsgId);
            }
        } catch (err) {
            console.error("findRecentDocuments failed:", err && err.message ? err.message : err);
        }

        if (!docs || docs.length === 0) {
            await safeEdit(
                ctx,
                statusMsg.message_id,
                [
                    `📌  ${B("NO RECENT DOCUMENTS FOUND")}`,
                    RULE,
                    `Could not find any recent documents or forwarded files in this chat.`,
                    "",
                    `${B("How to batch forward:")}`,
                    `1. Select multiple .zip or .txt files in any channel or chat.`,
                    `2. Forward them all together into this chat.`,
                    `3. Run ${CODE("/batchsave")} (or ${CODE("/batchsave 20")}).`,
                    "",
                    I("The bot will automatically download and clean all of them in one go! ⚡️"),
                ].join("\n"),
            );
            return;
        }

        localJobs.set(ctx.chat.id, `batchsave:${docs.length}-files`);
        const startTime = Date.now();
        const processedFiles = [];
        let totalLinesAdded = 0;

        try {
            for (let i = 0; i < docs.length; i++) {
                const doc = docs[i];
                const currentName = userbot.resolveSafeFileName(
                    doc.fileName || doc.message || doc.document,
                    `dump_${doc.messageId}`,
                );
                const beforeStats = store.getStats(ctx.chat.id);
                const beforeSize = beforeStats ? beforeStats.size : 0;

                await safeEdit(
                    ctx,
                    statusMsg.message_id,
                    renderBatchSaveProgress({
                        current: i + 1,
                        total: docs.length,
                        currentName,
                        linesAdded: totalLinesAdded,
                        totalLines: beforeSize,
                    }),
                );

                try {
                    const saved = await peer.downloadMessageToDisk(ctx.chat.id, doc.messageId, {
                        root: localProcessRoot(),
                        fileName: currentName,
                        message: doc.message,
                    });

                    const fullPath = saved.path;
                    const lowerName = currentName.toLowerCase();
                    const isZip = lowerName.endsWith(".zip");
                    const isText = [".txt", ".csv", ".tsv", ".log", ".lst", ".list", ".dat"].some((e) => lowerName.endsWith(e));

                    if (isText) {
                        if (doc.size > 80 * 1024 * 1024) {
                            const rl = readline.createInterface({
                                input: fs.createReadStream(fullPath, { encoding: "utf8", highWaterMark: 4 * 1024 * 1024 }),
                                crlfDelay: Infinity,
                            });
                            let batch = [];
                            let fileAdded = 0;
                            let countedInFile = false;
                            const site = sanitizeSiteSlug(currentName.replace(/\.[^.]+$/, "")) || "cleaned";
                            for await (const line of rl) {
                                batch.push(line);
                                if (batch.length >= 25000) {
                                    const res = await extractAndCleanTextAsync(batch.join("\n"), { keepUrl: false });
                                    const r = store.addLines(ctx.chat.id, res.lines, site, { countFile: !countedInFile });
                                    countedInFile = true;
                                    fileAdded += r.added;
                                    batch = [];
                                }
                            }
                            if (batch.length > 0) {
                                const res = await extractAndCleanTextAsync(batch.join("\n"), { keepUrl: false });
                                const r = store.addLines(ctx.chat.id, res.lines, site, { countFile: !countedInFile });
                                countedInFile = true;
                                fileAdded += r.added;
                            }
                            totalLinesAdded += fileAdded;
                            processedFiles.push({ name: currentName, lines: fileAdded, size: doc.size });
                        } else {
                            const content = fs.readFileSync(fullPath, "utf8");
                            const res = await extractAndCleanTextAsync(content, { sourceName: currentName, keepUrl: false });
                            const site = sanitizeSiteSlug(res.site || "") || sanitizeSiteSlug(currentName.replace(/\.[^.]+$/, "")) || "cleaned";
                            const added = store.addLines(ctx.chat.id, res.lines, site);
                            totalLinesAdded += added.added;
                            processedFiles.push({ name: currentName, lines: added.added, size: doc.size });
                        }
                    } else if (isZip) {
                        const buffer = fs.readFileSync(fullPath);
                        const res = await extractAndCleanZipAsync(buffer, { sourceName: currentName, keepUrl: false });
                        const site = sanitizeSiteSlug(res.site || "") || sanitizeSiteSlug(currentName.replace(/\.[^.]+$/, "")) || "cleaned";
                        const added = store.addLines(ctx.chat.id, res.lines, site);
                        totalLinesAdded += added.added;
                        processedFiles.push({ name: currentName, lines: added.added, size: doc.size });
                    } else {
                        processedFiles.push({ name: `${currentName} (unsupported format)`, lines: 0, size: doc.size });
                    }
                } catch (fileErr) {
                    console.error(`batchsave failed for file ${currentName}:`, fileErr && fileErr.message ? fileErr.message : fileErr);
                    processedFiles.push({ name: `${currentName} (error)`, lines: 0, size: doc.size });
                }
            }

            const durationMs = Date.now() - startTime;
            const finalStats = store.getStats(ctx.chat.id);
            const totalLines = finalStats ? finalStats.size : totalLinesAdded;

            await safeEdit(
                ctx,
                statusMsg.message_id,
                renderBatchSaveComplete({
                    totalFiles: docs.length,
                    totalLines,
                    files: processedFiles,
                    durationMs,
                }),
                afterCombineKeyboard(),
            );
        } catch (err) {
            console.error("batchsave process loop failed:", err);
            await safeEdit(ctx, statusMsg.message_id, `💥  ${B("Batch save failed")}\n${I(escapeHtml(err.message))}`);
        } finally {
            localJobs.delete(ctx.chat.id);
        }
    };

    bot.command("batchsave", batchSaveHandler);
    bot.command("savebatch", batchSaveHandler);

    // ---- /emojis & /packs: inspect and sync all custom animated emoji packs from the user account
    const emojisHandler = async (ctx) => {
        userPromptState.delete(ctx.chat.id);
        const arg = (ctx.message && ctx.message.text ? ctx.message.text : "").replace(/^\S+\s*/, "").trim().toLowerCase();
        const peer = meta.userbot || userbot;
        let data = { packs: [], totalEmojis: 0 };

        if (arg === "sync") {
            let count = 0;
            if (peer && typeof peer.syncCustomEmojis === "function") {
                try {
                    count = await peer.syncCustomEmojis();
                } catch {
                    // ignore
                }
            }
            if (peer && typeof peer.getInstalledEmojiPacks === "function") {
                try {
                    data = await peer.getInstalledEmojiPacks();
                } catch {
                    // ignore
                }
            }
            const syncNotice = count > 0
                ? `✨ Successfully synced ${count} custom animated emojis from your account into the bot UI/UX!`
                : `ℹ️ Account emojis synchronized. Bot native visual palette active!`;
            await safeReply(ctx, `${syncNotice}\n\n${renderEmojiPacks(data)}`, emojisKeyboard());
            return;
        }

        if (peer && typeof peer.getInstalledEmojiPacks === "function") {
            try {
                data = await peer.getInstalledEmojiPacks();
            } catch {
                // ignore
            }
        }
        await safeReply(ctx, renderEmojiPacks(data), emojisKeyboard());
    };

    bot.command("emojis", emojisHandler);
    bot.command("packs", emojisHandler);
    bot.command("features", emojisHandler);

    bot.action("emojis:view", async (ctx) => {
        await ctx.answerCbQuery("💎 Animated Emojis").catch(() => {});
        let data = { packs: [], totalEmojis: 0 };
        const peer = meta.userbot || userbot;
        if (peer && typeof peer.getInstalledEmojiPacks === "function") {
            try {
                data = await peer.getInstalledEmojiPacks();
            } catch {
                // ignore
            }
        }
        const text = renderEmojiPacks(data);
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        if (msg) {
            await safeEdit(ctx, msg.message_id, text, emojisKeyboard());
        } else {
            await safeReply(ctx, text, emojisKeyboard());
        }
    });

    bot.action("emojis:sync", async (ctx) => {
        await ctx.answerCbQuery("🔄 Syncing account emojis…").catch(() => {});
        const peer = meta.userbot || userbot;
        if (peer && typeof peer.syncCustomEmojis === "function") {
            try {
                await peer.syncCustomEmojis();
            } catch {
                // ignore
            }
        }
        let data = { packs: [], totalEmojis: 0 };
        if (peer && typeof peer.getInstalledEmojiPacks === "function") {
            try {
                data = await peer.getInstalledEmojiPacks();
            } catch {
                // ignore
            }
        }
        const text = renderEmojiPacks(data);
        const msg = ctx.callbackQuery && ctx.callbackQuery.message;
        if (msg) {
            await safeEdit(ctx, msg.message_id, text, emojisKeyboard());
        } else {
            await safeReply(ctx, text, emojisKeyboard());
        }
    });

    // Inline button: Combine
    bot.action("combine", async (ctx) => {
        await ctx.answerCbQuery("\uD83D\uDCE6 Building file\u2026").catch(() => { });
        await ctx.replyWithChatAction("upload_document").catch(() => { });
        await sendCombined(ctx);
    });

    // Inline button: Send Telegram Document for a direct download token
    bot.action(/^send_telegram:(.+)$/, async (ctx) => {
        const token = ctx.match[1];
        const dl = downloads.getDownload(token);
        if (!dl) {
            await ctx.answerCbQuery("⚠️ Download link expired or file not found.", { show_alert: true }).catch(() => { });
            return;
        }
        await ctx.answerCbQuery("📦 Sending file to chat…").catch(() => { });
        let payload;
        if (dl.filePath && fs.existsSync(dl.filePath)) {
            payload = { source: dl.filePath, filename: dl.filename };
        } else if (dl.buffer) {
            payload = { source: dl.buffer, filename: dl.filename };
        } else {
            await safeReply(ctx, "⚠️ Could not locate file on server.");
            return;
        }
        const isZip = Boolean((dl.filename || "").toLowerCase().endsWith(".zip") || (dl.stats && dl.stats.isZip));
        const countDesc = isZip
            ? `${compact((dl.stats && dl.stats.entryCount) || 0)} files merged`
            : `${compact((dl.stats && dl.stats.kept) || dl.size || 0)} unique lines`;
        await safeSendDocument(ctx, ctx.chat.id, payload, {
            caption: `📦 <b>${escapeHtml(dl.filename)}</b>\n${isZip ? "📁" : "🔑"} ${countDesc}`,
            parse_mode: "HTML",
        });
    });

    // Inline button: Stats
    bot.action("stats", async (ctx) => {
        await ctx.answerCbQuery("\uD83D\uDCCA Loading stats\u2026").catch(() => { });
        const msgId = ctx.callbackQuery?.message?.message_id;
        const stats = store.getStats(ctx.chat.id);
        const text = renderStats(stats);
        const kb = statsKeyboard(stats && stats.size > 0);
        if (msgId) {
            await safeEdit(ctx, msgId, text, kb);
        } else {
            await safeReply(ctx, text, kb);
        }
    });

    // Inline button: Sites
    bot.action("sites", async (ctx) => {
        await ctx.answerCbQuery("📡 Loading sites…").catch(() => { });
        const counts = store.getSiteCounts(ctx.chat.id);
        const msgId = ctx.callbackQuery?.message?.message_id;
        const text = renderSites(counts);
        if (msgId) {
            await safeEdit(ctx, msgId, text, sitesKeyboard(counts));
        } else {
            await safeReply(ctx, text, sitesKeyboard(counts));
        }
    });

    // Inline button: site:del:ask:<site>
    bot.action(/^site:del:ask:(.+)$/, async (ctx) => {
        const domain = resolveCallbackPayload(ctx.match[1]);
        await ctx.answerCbQuery().catch(() => {});
        await safeReply(
            ctx,
            `⚠️ Are you sure you want to remove all credentials matching ${CODE(escapeHtml(domain))} from the batch?`,
            confirmDomainDeleteKeyboard(domain)
        );
    });

    // Inline button: site:del:confirm:<site>
    bot.action(/^site:del:confirm:(.+)$/, async (ctx) => {
        const domain = resolveCallbackPayload(ctx.match[1]);
        await ctx.answerCbQuery(`Removing ${domain}…`).catch(() => {});
        const res = store.removeDomain(ctx.chat.id, domain);
        const counts = store.getSiteCounts(ctx.chat.id);
        await safeReply(
            ctx,
            [
                `${tgEmoji("🗑️")}  ${B("DOMAIN REMOVED")}  ${tgEmoji("⚡️")}`,
                RULE,
                `Removed ${B(num(res.removed))} credentials matching domain ${CODE(escapeHtml(domain))}.`,
                `Remaining batch credentials: ${B(num(res.remaining))}.`,
            ].join("\n"),
            sitesKeyboard(counts)
        );
    });

    // Inline button: site:del:prompt
    bot.action("site:del:prompt", async (ctx) => {
        await ctx.answerCbQuery().catch(() => {});
        userPromptState.set(ctx.chat.id, { action: "remove_domain", createdAt: Date.now() });
        await safeReply(
            ctx,
            [
                `${tgEmoji("🗑️")}  ${B("ENTER DOMAIN TO REMOVE")}  ${tgEmoji("⚡️")}`,
                RULE,
                `Reply with the domain name you wish to remove from the current batch.`,
                `Example: ${CODE("netflix.com")} or ${CODE("gmail.com")}`,
            ].join("\n"),
            createInlineKeyboard([
                [Markup.button.callback("❌ Cancel", "sites")],
            ])
        );
    });

    // Inline button: site:page:<page>
    bot.action(/^site:page:(\d+)$/, async (ctx) => {
        const page = parseInt(ctx.match[1], 10) || 0;
        await ctx.answerCbQuery().catch(() => {});
        const counts = store.getSiteCounts(ctx.chat.id);
        const msgId = ctx.callbackQuery?.message?.message_id;
        const text = renderSites(counts);
        if (msgId) {
            await safeEdit(ctx, msgId, text, sitesKeyboard(counts, page));
        } else {
            await safeReply(ctx, text, sitesKeyboard(counts, page));
        }
    });

    // Inline button: site:view:<site>
    bot.action(/^site:view:(.+)$/, async (ctx) => {
        const domain = resolveCallbackPayload(ctx.match[1]);
        const res = store.searchLines(ctx.chat.id, domain, 20);
        if (res && Array.isArray(res.matches)) {
            res.matches = res.matches.map((m) => cleanUserPassOnly(m) || m);
        }
        await safeReply(ctx, renderSearch(domain, res), searchResultKeyboard(domain, res.total));
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
        const msgId = ctx.callbackQuery?.message?.message_id;
        const text = renderHelp(meta.botUsername, batch, searchOptions.botUsername);
        if (msgId) {
            await safeEdit(ctx, msgId, text, mainKeyboard());
        } else {
            await safeReply(ctx, text, mainKeyboard());
        }
    });

    // Inline buttons: Clear (two-step)
    bot.action("clear:ask", async (ctx) => {
        const stats = store.getStats(ctx.chat.id);
        const msgId = ctx.callbackQuery?.message?.message_id;
        if (!stats || stats.size === 0) {
            await ctx.answerCbQuery("\uD83D\uDCED Nothing to clear!").catch(() => { });
            const emptyText = "\uD83D\uDCED Nothing stored for this chat \u2014 all clean \u2728";
            if (msgId) {
                await safeEdit(ctx, msgId, emptyText, mainKeyboard());
            } else {
                await safeReply(ctx, emptyText, mainKeyboard());
            }
            return;
        }
        await ctx.answerCbQuery().catch(() => { });
        const askText = [
            `\uD83E\uDDF9  ${B("Clear this batch?")}`,
            `\uD83D\uDCE6 It holds ${B(num(stats.size))} unique line${stats.size === 1 ? "" : "s"}`,
            "",
            `${I("This can't be undone \u26A0\uFE0F")}`,
        ].join("\n");
        if (msgId) {
            await safeEdit(ctx, msgId, askText, confirmClearKeyboard());
        } else {
            await safeReply(ctx, askText, confirmClearKeyboard());
        }
    });

    bot.action("clear:yes", async (ctx) => {
        const existed = store.clear(ctx.chat.id);
        await ctx.answerCbQuery(existed ? "\uD83E\uDDFA Poof! Gone." : "\uD83D\uDCED Nothing to clear").catch(() => { });
        const msgId = ctx.callbackQuery?.message?.message_id;
        const wipedText = existed
            ? "\uD83E\uDDFA Batch wiped \u2014 fresh start! \u2728\n\uD83D\uDCE4 Send me your next file whenever you're ready."
            : "\uD83D\uDCED Nothing stored for this chat.";
        if (msgId) {
            await safeEdit(ctx, msgId, wipedText, emptyBatchKeyboard());
        } else {
            await safeReply(ctx, wipedText, emptyBatchKeyboard());
        }
    });

    bot.action("clear:no", async (ctx) => {
        await ctx.answerCbQuery("\uD83D\uDCCE Batch kept \u2728").catch(() => { });
        const msgId = ctx.callbackQuery?.message?.message_id;
        const keptText = "\uD83D\uDCCE Phew \u2014 batch kept! Nothing was touched. \u2728";
        if (msgId) {
            await safeEdit(ctx, msgId, keptText, mainKeyboard());
        } else {
            await safeReply(ctx, keptText, mainKeyboard());
        }
    });

    // ------------------------------------------------------------- ULP relay
    //
    // Drives the external ULP searcher bot (default @DumpNews14Bot):
    //   query -> hist:full:<day|month|year>, 7s before every try, then every
    //   answer the searcher sends back is forwarded into this chat.
    const ulpCommand = async (ctx) => {
        const raw = (ctx.message?.text || "").replace(/^\/\S+\s*/, "").trim();
        userPromptState.delete(ctx.chat.id);
        const parsed = parseUlpArg(raw, searchOptions);
        if (parsed.daysCount) {
            userUlpDays.set(ctx.chat.id, parsed.daysCount);
            if (store && store.setUlpDays) store.setUlpDays(ctx.chat.id, parsed.daysCount);
        }
        const activeDays = parsed.daysCount || (store && store.getUlpDays && store.getUlpDays(ctx.chat.id)) || userUlpDays.get(ctx.chat.id) || searchOptions.daysCount || 5;
        const customDomains = (store && store.getCustomDomains && store.getCustomDomains(ctx.chat.id)) || [];
        if (!parsed.query) {
            const hintText = parsed.daysCount
                ? `📅 ${B("Search duration set to")} ${B(`${parsed.daysCount} Day(s)`)}!\n\n` +
                  renderUlpHint({
                      searcherBot: searchOptions.botUsername,
                      stepDelayMs: searchOptions.stepDelayMs,
                      maxTries: searchOptions.maxTries,
                      daysCount: activeDays,
                  })
                : renderUlpHint({
                      searcherBot: searchOptions.botUsername,
                      stepDelayMs: searchOptions.stepDelayMs,
                      maxTries: searchOptions.maxTries,
                      daysCount: activeDays,
                  });
            await safeReply(
                ctx,
                hintText,
                ulpMenuKeyboard(activeDays, customDomains),
            );
            return;
        }
        if (parsed.query && store && store.addCustomDomain) {
            store.addCustomDomain(ctx.chat.id, parsed.query);
        }
        await beginUlpRun(ctx, {
            query: parsed.query,
            scope: parsed.scope,
            startDate: parsed.startDate || null,
            daysCount: activeDays,
            searchOptions,
            meta,
            ulpStartedAt,
            ulpWindows,
        });
    };

    bot.command(["ulp", "searchbot", "ulpsearch", "searchulp", "findulp"], ulpCommand);

    const rerunUlp = async (ctx, scope) => {
        const run = searchbot.getRun(ctx.chat.id);
        if (!run || !run.query) {
            await ctx.answerCbQuery("Select target or enter domain").catch(() => { });
            const activeDays = (store && store.getUlpDays && store.getUlpDays(ctx.chat.id)) || userUlpDays.get(ctx.chat.id) || searchOptions.daysCount || 5;
            const customDomains = (store && store.getCustomDomains && store.getCustomDomains(ctx.chat.id)) || [];
            const text = renderUlpMenuText(searchOptions.botUsername, activeDays, customDomains.length);
            const msg = ctx.callbackQuery && ctx.callbackQuery.message;
            if (msg) {
                await safeEdit(ctx, msg.message_id, text, ulpMenuKeyboard(activeDays, customDomains));
            } else {
                await safeReply(ctx, text, ulpMenuKeyboard(activeDays, customDomains));
            }
            return;
        }
        await ctx.answerCbQuery(`Scope \u00B7 ${scope}`).catch(() => { });
        const message = ctx.callbackQuery && ctx.callbackQuery.message;
        const activeDays = (store && store.getUlpDays && store.getUlpDays(ctx.chat.id)) || userUlpDays.get(ctx.chat.id) || searchOptions.daysCount || 5;
        await beginUlpRun(ctx, {
            query: run.query,
            scope,
            daysCount: activeDays,
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

    bot.action("ulp:status_bar", async (ctx) => {
        const run = searchbot.getRun(ctx.chat.id);
        const query = run && run.query ? `for "${run.query}"` : "";
        await ctx.answerCbQuery(`🔍 ULP Search in progress ${query}...`).catch(() => {});
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
        await ingestDocument(ctx, doc, { keepUrl: false });
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

    async function handleForwardedDocument(ctx, doc) {
        const chatId = ctx.chat.id;
        const msg = (ctx && (ctx.message || ctx.channelPost)) || {};
        const name = userbot.resolveSafeFileName(
            doc,
            `forwarded_${(doc && (doc.file_unique_id || doc.file_id)) || Date.now()}`,
        );
        const sourceInfo = userbot.extractForwardOrigin(msg) || userbot.parseChannelFilename(name);

        let batch = forwardBatches.get(chatId);
        if (!batch) {
            batch = {
                items: [],
                timer: null,
                noticeId: null,
                latestCtx: ctx,
            };
            forwardBatches.set(chatId, batch);
        }

        batch.items.push({ doc, ctx, name, messageId: msg.message_id || 0, sourceInfo });
        batch.latestCtx = ctx;

        if (batch.timer) {
            clearTimeout(batch.timer);
        }

        const count = batch.items.length;
        if (!batch.noticeId) {
            try {
                const notice = await safeReply(
                    ctx,
                    [
                        `📥  ${B("Receiving forwarded log files")} (${num(count)} file${count === 1 ? "" : "s"} received)…`,
                        `     ⏳  Gathering forwarded batch to merge and generate direct download link…`,
                    ].join("\n")
                );
                batch.noticeId = notice ? notice.message_id : null;
            } catch (err) {
                console.error("Failed to send forward batch notice:", err);
            }
        } else {
            void safeEdit(
                ctx,
                batch.noticeId,
                [
                    `📥  ${B("Receiving forwarded log files")} (${num(count)} files received)…`,
                    `     ⏳  Merging incoming files into a single unified combolist…`,
                ].join("\n")
            ).catch(() => {});
        }

        batch.timer = setTimeout(() => {
            processForwardedBatch(chatId).catch((err) => {
                console.error(`Error in processForwardedBatch for ${chatId}:`, err && err.message ? err.message : err);
            });
        }, forwardDebounceMs);
    }

    async function processForwardedBatch(chatId) {
        const batch = forwardBatches.get(chatId);
        if (!batch || batch.items.length === 0) {
            forwardBatches.delete(chatId);
            return;
        }
        forwardBatches.delete(chatId);

        const ctx = batch.latestCtx;
        const noticeId = batch.noticeId;
        const items = batch.items;

        if (noticeId) {
            await safeEdit(
                ctx,
                noticeId,
                [
                    `⚡  ${B("Processing Forwarded Log Batch")} (${num(items.length)} file${items.length === 1 ? "" : "s"})…`,
                    `     🧵  Downloading and combining all lines…`,
                ].join("\n")
            ).catch(() => {});
        }

        // Fetch all forwarded files into in-memory buffers (no intermediate disk writes)
        const fetchedItems = [];
        for (const item of items) {
            try {
                let buffer = null;
                if (item.doc && item.doc.file_size && item.doc.file_size <= MAX_DOWNLOAD_BYTES) {
                    try {
                        const link = await ctx.telegram.getFileLink(item.doc.file_id);
                        const res = await fetch(link.href);
                        if (res.ok) buffer = Buffer.from(await res.arrayBuffer());
                    } catch (botApiErr) {
                        console.error(`Bot API getFileLink failed for ${item.name}:`, botApiErr && botApiErr.message ? botApiErr.message : botApiErr);
                    }
                }

                // If not downloaded via Bot API (e.g. > 20 MB or channel dump), download via MTProto userbot!
                if (!buffer) {
                    const peer = meta.userbot;
                    if (peer && typeof peer.isReady === "function" && peer.isReady() && typeof peer.downloadMessageToDisk === "function") {
                        const source = item.sourceInfo || userbot.extractForwardOrigin(item.ctx && (item.ctx.message || item.ctx.channelPost)) || userbot.parseChannelFilename(item.name);
                        const targetChat = (source && source.peer) ? source.peer : chatId;
                        const targetMsgId = (source && source.messageId) ? source.messageId : item.messageId;
                        try {
                            const dlRes = await peer.downloadMessageToDisk(targetChat, targetMsgId, {
                                targetName: item.name,
                                root: localProcessRoot(),
                            });
                            if (dlRes && dlRes.path && fs.existsSync(dlRes.path)) {
                                buffer = fs.readFileSync(dlRes.path);
                            }
                        } catch (ubErr) {
                            console.error(`Userbot fallback failed for ${item.name}:`, ubErr && ubErr.message ? ubErr.message : ubErr);
                        }
                    }
                }

                if (buffer) {
                    const isZip = (item.name && item.name.toLowerCase().endsWith(".zip")) || isZipBuffer(buffer);
                    fetchedItems.push({
                        name: item.name,
                        buffer,
                        isZip,
                        doc: item.doc,
                    });
                }
            } catch (itemErr) {
                console.error(`Failed to ingest forwarded item ${item.name}:`, itemErr);
            }
        }

        if (fetchedItems.length === 0) {
            const failMsg = `⚠️  Could not download forwarded documents. Files may be inaccessible or deleted.`;
            if (noticeId) {
                await safeEdit(ctx, noticeId, failMsg);
            } else {
                await safeReply(ctx, failMsg);
            }
            return;
        }

        // If batch contains zip files, merge them into ONE master .zip file directly!
        const hasZip = fetchedItems.some((it) => it.isZip);
        if (hasZip) {
            const mergeResult = mergeZipFiles(fetchedItems);
            const stamp = new Date().toISOString().slice(0, 10);
            const baseSite = (fetchedItems.length > 0 ? sanitizeSiteSlug(fetchedItems[0].name.replace(/\.[^.]+$/, "")) : null) || "logs";
            const filename = `${baseSite}_combined_${stamp}.zip`;
            const outputPath = path.join(localProcessedRoot(), filename);

            try {
                fs.mkdirSync(localProcessedRoot(), { recursive: true });
                fs.writeFileSync(outputPath, mergeResult.buffer);
            } catch (writeErr) {
                console.error("Failed to write merged zip to disk:", writeErr);
            }

            store.setLastCombined(chatId, {
                buffer: mergeResult.buffer,
                filename,
                linesCount: mergeResult.entryCount,
                site: baseSite,
                isZip: true,
            });

            const dl = downloads.registerDownload({
                filename,
                filePath: outputPath,
                buffer: mergeResult.buffer,
                size: mergeResult.compressedSize,
                mimeType: "application/zip",
                chatId,
                stats: {
                    sourceFiles: mergeResult.sourceFiles,
                    entryCount: mergeResult.entryCount,
                    folderCount: mergeResult.folderCount,
                    totalSize: mergeResult.totalSize,
                    isZip: true,
                },
            });

            const reportText = renderForwardedZipCombined({
                files: mergeResult.sourceFiles,
                entryCount: mergeResult.entryCount,
                folderCount: mergeResult.folderCount,
                totalSize: mergeResult.totalSize,
                compressedSize: mergeResult.compressedSize,
                downloadUrl: dl.url,
                filename,
            });

            const kb = forwardedZipKeyboard(dl.url, dl.token);

            if (noticeId) {
                await safeEdit(ctx, noticeId, reportText, kb);
            } else {
                await safeReply(ctx, reportText, kb);
            }
            return;
        }

        // Otherwise (plain text / combolists), clean and merge text lines
        const fileSummaries = [];
        const combinedLinesSet = new Set();
        let totalLinesSeen = 0;
        let detectedSite = null;

        for (const item of fetchedItems) {
            try {
                const buffer = item.buffer;
                const rawText = buffer.toString("utf8");
                const cleanRes = await extractAndCleanTextAsync(rawText, { sourceName: item.name, keepUrl: false });
                totalLinesSeen += cleanRes.stats.total;
                const siteFound = cleanRes.site;
                let extractedLines = cleanRes.lines;
                if (extractedLines.length === 0) {
                    extractedLines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
                }

                if (siteFound && !detectedSite) {
                    detectedSite = siteFound;
                }

                for (const line of extractedLines) {
                    combinedLinesSet.add(line);
                }

                fileSummaries.push({
                    name: item.name,
                    size: (item.doc && item.doc.file_size) || buffer.length,
                    lines: extractedLines.length,
                });
            } catch (err) {
                console.error(`Failed to clean text item ${item.name}:`, err);
            }
        }

        const finalLines = Array.from(combinedLinesSet);
        const baseSite = detectedSite || (fileSummaries.length > 0 ? sanitizeSiteSlug(fileSummaries[0].name.replace(/\.[^.]+$/, "")) : null) || "logs";
        const stamp = new Date().toISOString().slice(0, 10);
        const filename = `${baseSite}_combined_${stamp}.txt`;
        const outputPath = path.join(localProcessedRoot(), filename);

        let combinedBuffer;
        try {
            fs.mkdirSync(localProcessedRoot(), { recursive: true });
            const outputContent = buildOutput(finalLines);
            combinedBuffer = Buffer.from(outputContent, "utf8");
            fs.writeFileSync(outputPath, combinedBuffer);
        } catch (writeErr) {
            console.error("Failed to write forwarded combined log to disk:", writeErr);
            if (!combinedBuffer) combinedBuffer = Buffer.from(buildOutput(finalLines), "utf8");
        }

        // Add to store so batch analytics & commands stay in sync
        store.addLines(chatId, finalLines, baseSite);
        store.setLastCombined(chatId, {
            buffer: combinedBuffer,
            filename,
            linesCount: finalLines.length,
            site: baseSite,
        });

        // Register in downloads manager for direct HTTP download link
        const dl = downloads.registerDownload({
            filename,
            filePath: outputPath,
            buffer: combinedBuffer,
            size: combinedBuffer.length,
            chatId,
            stats: {
                total: totalLinesSeen,
                kept: finalLines.length,
                duplicates: Math.max(0, totalLinesSeen - finalLines.length),
                files: fileSummaries,
            },
        });

        const reportText = renderForwardedLogsCombined({
            files: fileSummaries,
            stats: {
                total: totalLinesSeen,
                kept: finalLines.length,
                duplicates: Math.max(0, totalLinesSeen - finalLines.length),
            },
            downloadUrl: dl.url,
            filename,
            site: baseSite,
            chatStats: store.getStats(chatId),
        });

        const kb = forwardedLogsKeyboard(dl.url, dl.token);

        if (noticeId) {
            await safeEdit(ctx, noticeId, reportText, kb);
        } else {
            await safeReply(ctx, reportText, kb);
        }
    }

    bot.processForwardedBatch = processForwardedBatch;
    bot.forwardBatches = forwardBatches;

    bot.on(["document", "channel_post"], async (ctx) => {
        const msg = (ctx && (ctx.message || ctx.channelPost)) || {};
        const doc = msg.document;
        if (!doc) return;
        try {
            const prompt = userPromptState.get(ctx.chat.id);
            if (prompt && prompt.action === "save:listening") {
                await queueSaveDocument(ctx, prompt);
                return;
            }
            if (isForwardedDocument(ctx)) {
                await handleForwardedDocument(ctx, doc);
                return;
            }
            await ingestDocument(ctx, doc);
        } catch (err) {
            console.error("document handler error:", err);
            await safeReply(
                ctx,
                [
                    `💥  ${B("Oops — something went wrong")}`,
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
        if (msg.text && userPromptState.has(ctx.chat.id)) {
            const prompt = userPromptState.get(ctx.chat.id);
            const promptStart = prompt.startedAt || prompt.createdAt || 0;
            const promptTtl = prompt.action === "save:listening" ? 60 * 60 * 1000 : 2 * 60 * 1000;
            if (promptStart > 0 && (Date.now() - promptStart > promptTtl)) {
                userPromptState.delete(ctx.chat.id);
            } else {
                const input = msg.text.trim();
                const lower = input.toLowerCase();

                // Universal cancel across all interactive prompts
                if (lower === "cancel" || lower === "stop" || lower === "exit" || lower === "quit" || lower === "back" || lower === "menu") {
                    userPromptState.delete(ctx.chat.id);
                    if (activeVaultSearches.has(ctx.chat.id)) {
                        const active = activeVaultSearches.get(ctx.chat.id);
                        if (active && active.controller) active.controller.abort();
                        activeVaultSearches.delete(ctx.chat.id);
                    }
                    await safeReply(ctx, `🚫 Action cancelled.`, mainKeyboard());
                    return;
                }

            if (prompt.action === "batch:search:query") {
                userPromptState.delete(ctx.chat.id);
                const query = input.trim();
                if (!query || query.length < 2) {
                    await safeReply(ctx, "⚠️ Query too short — give me at least 2 characters.", mainKeyboard());
                    return;
                }
                const result = store.searchLines(ctx.chat.id, query, 20);

                if (result && Array.isArray(result.matches)) {
                    result.matches = result.matches.map((m) => cleanUserPassOnly(m) || m);
                }
                await safeReply(ctx, renderSearch(query, result), searchResultKeyboard(query, result.total));
                return;
            }

            if (prompt.action === "save:listening") {
                if (lower === "done" || lower === "finish" || lower === "complete") {
                    await finishSaveSession(ctx);
                    return;
                }
                await safeReply(
                    ctx,
                    [
                        `📥  ${B("SAVE MODE ACTIVE")}`,
                        RULE,
                        `Forward or upload log files now to save them one by one.`,
                        `Or send ${CODE("/done")} or tap Done when finished.`,
                    ].join("\n"),
                    saveListeningKeyboard(),
                );
                return;
            }

            if (prompt.action === "ulp:search_domain") {
                const parsed = parseUlpArg(input, searchOptions);
                const query = parsed.query || searchbot.normalizeQuery(input);
                if (!query) {
                    await safeReply(
                        ctx,
                        `⚠️ ${B("Invalid domain or URL.")} Please provide a valid domain (e.g. ${CODE("target.com")}):`,
                        ulpPromptCancelKeyboard()
                    );
                    return;
                }
                userPromptState.delete(ctx.chat.id);
                if (store && store.addCustomDomain) {
                    store.addCustomDomain(ctx.chat.id, query);
                }
                if (parsed.daysCount) {
                    userUlpDays.set(ctx.chat.id, parsed.daysCount);
                    if (store && store.setUlpDays) store.setUlpDays(ctx.chat.id, parsed.daysCount);
                }
                const activeDays = parsed.daysCount || (store && store.getUlpDays && store.getUlpDays(ctx.chat.id)) || userUlpDays.get(ctx.chat.id) || searchOptions.daysCount || 5;
                await safeReply(ctx, `🚀 ${B("Starting search for")} ${CODE(escapeHtml(query))} (${activeDays} days)…\n💾 ${I("Saved to your custom target domains.")}`);
                await beginUlpRun(ctx, {
                    query,
                    scope: parsed.scope || "day",
                    startDate: parsed.startDate || null,
                    daysCount: activeDays,
                    searchOptions,
                    meta,
                    ulpStartedAt,
                    ulpWindows,
                });
                return;
            }

            if (prompt.action === "ulp:add_domain") {
                const parsed = parseUlpArg(input, searchOptions);
                const domain = parsed.query || searchbot.normalizeQuery(input);
                if (!domain) {
                    await safeReply(
                        ctx,
                        `⚠️ ${B("Invalid domain or URL.")} Please provide a valid domain (e.g. ${CODE("roblox.com")}):`,
                        ulpPromptCancelKeyboard()
                    );
                    return;
                }
                userPromptState.delete(ctx.chat.id);
                if (store && store.addCustomDomain) store.addCustomDomain(ctx.chat.id, domain);
                const activeDays = (store && store.getUlpDays && store.getUlpDays(ctx.chat.id)) || userUlpDays.get(ctx.chat.id) || searchOptions.daysCount || 5;
                const customDomains = (store && store.getCustomDomains && store.getCustomDomains(ctx.chat.id)) || [];
                await safeReply(
                    ctx,
                    `✅ ${B("Added")} ${CODE(escapeHtml(domain))} ${B("to your custom targets!")}`,
                    ulpMenuKeyboard(activeDays, customDomains)
                );
                return;
            }

            if (prompt.action === "ulp:set_days") {
                const parsed = parseInt(input.replace(/[^\d]/g, ""), 10);
                if (!parsed || parsed < 1 || parsed > 90) {
                    await safeReply(
                        ctx,
                        `⚠️ ${B("Please enter a valid number of days between 1 and 90.")}`,
                        ulpPromptCancelKeyboard()
                    );
                    return;
                }
                userPromptState.delete(ctx.chat.id);
                userUlpDays.set(ctx.chat.id, parsed);
                if (store && store.setUlpDays) store.setUlpDays(ctx.chat.id, parsed);
                const customDomains = (store && store.getCustomDomains && store.getCustomDomains(ctx.chat.id)) || [];
                await safeReply(
                    ctx,
                    `📅 ${B("Search duration set to")} ${B(`${parsed} Day(s)`)}!`,
                    ulpMenuKeyboard(parsed, customDomains)
                );
                return;
            }

            if (prompt.action === "remove_domain") {
                const domain = input.trim();
                userPromptState.delete(ctx.chat.id);
                const res = store.removeDomain(ctx.chat.id, domain);
                const counts = store.getSiteCounts(ctx.chat.id);
                if (res.removed === 0) {
                    await safeReply(
                        ctx,
                        `${tgEmoji("⚠️")} No credentials found matching ${CODE(escapeHtml(domain))} in active batch.`,
                        sitesKeyboard(counts)
                    );
                    return;
                }
                await safeReply(
                    ctx,
                    [
                        `${tgEmoji("🗑️")}  ${B("DOMAIN PURGED")}  ${tgEmoji("⚡️")}`,
                        RULE,
                        `Successfully removed ${B(num(res.removed))} credentials matching ${CODE(escapeHtml(domain))}.`,
                        `Remaining batch credentials: ${B(num(res.remaining))}.`,
                    ].join("\n"),
                    sitesKeyboard(counts)
                );
                return;
            }

            if (prompt.action === "lsearch:query") {
                userPromptState.delete(ctx.chat.id);
                const query = input.trim();
                if (!query) {
                    await safeReply(ctx, "⚠️ Search query cannot be empty.", mainKeyboard());
                    return;
                }

                const rawFiles = scanDirFiles(localProcessRoot());
                const procFiles = scanDirFiles(localProcessedRoot());
                if (rawFiles.length + procFiles.length === 0) {
                    await safeReply(
                        ctx,
                        `⚠️ No files found in server vault (${CODE(localProcessRoot())} or ${CODE(localProcessedRoot())}).\nUpload or save some dumps first!`,
                        mainKeyboard()
                    );
                    return;
                }

                if (activeVaultSearches.has(ctx.chat.id)) {
                    await safeReply(
                        ctx,
                        `⏳ A vault search is already running. Please wait for it to complete or send ${CODE("cancel")}.`
                    );
                    return;
                }

                const abortController = new AbortController();
                activeVaultSearches.set(ctx.chat.id, {
                    query,
                    startedAt: Date.now(),
                    controller: abortController,
                });

                const totalVaultFiles = rawFiles.length + procFiles.length;
                const status = await safeReply(
                    ctx,
                    renderFileSearchProgress({
                        query,
                        fileName: "All Vault Files",
                        current: 0,
                        total: totalVaultFiles,
                        matchesCount: 0,
                        isAll: true,
                    }),
                    fileSearchProgressKeyboard({ current: 0, total: totalVaultFiles })
                );

                let lastEdit = Date.now();
                const onProgress = async (prog) => {
                    const now = Date.now();
                    if (now - lastEdit < 1000 && prog.current < prog.total) return;
                    lastEdit = now;
                    if (status && status.message_id) {
                        await safeEdit(
                            ctx,
                            status.message_id,
                            renderFileSearchProgress({
                                query,
                                fileName: prog.currentFile || "Vault Files",
                                current: prog.current,
                                total: prog.total,
                                matchesCount: prog.matchesFound,
                                isAll: true,
                            }),
                            fileSearchProgressKeyboard({ current: prog.current, total: prog.total })
                        ).catch(() => {});
                    }
                };

                try {
                    const result = await searchAllVaultFiles(query, {
                        limit: 20,
                        signal: abortController.signal,
                        onProgress,
                    });
                    const card = renderLocalSearch({
                        query,
                        total: result.total,
                        matches: result.matches,
                        fileResults: result.fileResults,
                        totalFiles: result.totalFiles,
                        searchedFiles: result.searchedFiles,
                        isAll: true,
                    });
                    const kb = localSearchResultKeyboard({
                        query,
                        total: result.total,
                        isAll: true,
                    });
                    if (status && status.message_id) {
                        await safeEdit(ctx, status.message_id, card, kb);
                    } else {
                        await safeReply(ctx, card, kb);
                    }
                } catch (err) {
                    if (abortController.signal.aborted) {
                        if (status && status.message_id) {
                            await safeEdit(ctx, status.message_id, "🚫 Vault search cancelled.", mainKeyboard());
                        }
                        return;
                    }
                    const errMsg = `💥 Search failed: ${escapeHtml(err.message)}`;
                    if (status && status.message_id) {
                        await safeEdit(ctx, status.message_id, errMsg, mainKeyboard());
                    } else {
                        await safeReply(ctx, errMsg, mainKeyboard());
                    }
                } finally {
                    activeVaultSearches.delete(ctx.chat.id);
                }
                return;
            }

            if (prompt.action === "file:search:custom") {
                userPromptState.delete(ctx.chat.id);
                const query = input.trim();
                if (!query) {
                    await safeReply(ctx, "⚠️ Search query cannot be empty.", mainKeyboard());
                    return;
                }

                if (activeVaultSearches.has(ctx.chat.id)) {
                    await safeReply(
                        ctx,
                        `⏳ A vault search is already running. Please wait for it to complete or send ${CODE("cancel")}.`
                    );
                    return;
                }

                const abortController = new AbortController();
                activeVaultSearches.set(ctx.chat.id, {
                    query,
                    startedAt: Date.now(),
                    controller: abortController,
                });

                let fileSize = 0;
                try {
                    fileSize = fs.statSync(prompt.filePath).size;
                } catch {}
                const status = await safeReply(
                    ctx,
                    renderFileSearchProgress({
                        query,
                        fileName: prompt.fileName,
                        fileSize,
                        current: 0,
                        total: 1,
                        matchesCount: 0,
                        isAll: false,
                    }),
                    fileSearchProgressKeyboard({ current: 0, total: 1 })
                );
                try {
                    const res = await searchTextFile(prompt.filePath, query, 20, {
                        signal: abortController.signal,
                    });
                    const card = renderLocalSearch({
                        query,
                        total: res.total,
                        matches: res.matches,
                        fileName: prompt.fileName,
                        isProc: prompt.isProc,
                        fileIdx: prompt.fileIdx,
                    });
                    const kb = localSearchResultKeyboard({
                        query,
                        total: res.total,
                        fileIdx: prompt.fileIdx,
                        isProc: prompt.isProc,
                        isAll: false,
                    });
                    if (status && status.message_id) {
                        await safeEdit(ctx, status.message_id, card, kb);
                    } else {
                        await safeReply(ctx, card, kb);
                    }
                } catch (err) {
                    if (abortController.signal.aborted) {
                        if (status && status.message_id) {
                            await safeEdit(ctx, status.message_id, "🚫 Vault search cancelled.", mainKeyboard());
                        }
                        return;
                    }
                    const errMsg = `💥 Search failed: ${escapeHtml(err.message)}`;
                    if (status && status.message_id) {
                        await safeEdit(ctx, status.message_id, errMsg, mainKeyboard());
                    } else {
                        await safeReply(ctx, errMsg, mainKeyboard());
                    }
                } finally {
                    activeVaultSearches.delete(ctx.chat.id);
                }
                return;
            }
        }
    }
        if (msg.photo || msg.video || msg.audio || msg.voice || msg.sticker) {
            await safeReply(
                ctx,
                "\uD83D\uDCF8 Cute! \u2026but I only speak \uD83D\uDCE6 <b>.zip</b> and \uD83D\uDCC4 text files. Send one of those!",
                mainKeyboard(),
            );
            return;
        }

        const rawText = (msg.text || msg.caption || "").trim();
        const lower = rawText.toLowerCase();

        // 1. Natural language single-word command shortcuts
        if (lower === "menu" || lower === "help" || lower === "start" || lower === "home") {
            const batch = store.getStats(ctx.chat.id);
            await safeReply(ctx, renderHelp(meta.botUsername, batch, searchOptions.botUsername), mainKeyboard());
            return;
        }

        if (lower === "stats" || lower === "status" || lower === "info" || lower === "analytics" || lower === "metrics") {
            const stats = store.getStats(ctx.chat.id);
            await safeReply(ctx, renderStats(stats), statsKeyboard(stats && stats.size > 0));
            return;
        }

        if (lower === "combine" || lower === "download" || lower === "get" || lower === "export" || lower === "dl") {
            await ctx.replyWithChatAction("upload_document").catch(() => {});
            await sendCombined(ctx);
            return;
        }

        if (lower === "vault" || lower === "files" || lower === "storage" || lower === "server") {
            await showServerFiles(ctx, null, 0, "overview");
            return;
        }

        if (lower === "save" || lower === "batchsave" || lower === "listen") {
            userPromptState.set(ctx.chat.id, {
                action: "save:listening",
                startedAt: Date.now(),
                queue: [],
                active: false,
                processed: [],
                noticeId: null,
            });
            await safeReply(ctx, renderSaveListeningPrompt(meta.botUsername), saveListeningKeyboard());
            return;
        }

        if (lower === "clean") {
            const stats = store.getStats(ctx.chat.id);
            if (stats && stats.size > 0) {
                await ctx.replyWithChatAction("upload_document").catch(() => {});
                await sendCombined(ctx);
            } else {
                await safeReply(
                    ctx,
                    [
                        `⚡️  ${B("READY TO CLEAN")}`,
                        RULE,
                        `📤 ${I("Send or forward any .txt, .zip, .rar, or .7z log dump to clean it instantly!")}`,
                        `💾 ${I("Or use /save by replying to any large file to stream it directly to disk.")}`,
                    ].join("\n"),
                    mainKeyboard(),
                );
            }
            return;
        }

        if (lower === "clear" || lower === "wipe" || lower === "reset" || lower === "empty" || lower === "purge") {
            const stats = store.getStats(ctx.chat.id);
            if (!stats || stats.size === 0) {
                await safeReply(ctx, "📬 Nothing stored for this chat — all clean ✨", emptyBatchKeyboard());
                return;
            }
            await safeReply(
                ctx,
                [
                    `🧹  ${B("Clear this batch?")}`,
                    `📦 It holds ${B(num(stats.size))} unique line${stats.size === 1 ? "" : "s"}`,
                    "",
                    `${I("This can't be undone ⚠️")}`,
                ].join("\n"),
                confirmClearKeyboard(),
            );
            return;
        }

        if (lower === "preview" || lower === "sample") {
            await sendPreview(ctx);
            return;
        }

        if (lower === "sites" || lower === "domains") {
            const counts = store.getSiteCounts(ctx.chat.id);
            await safeReply(ctx, renderSites(counts), sitesKeyboard(counts));
            return;
        }

        if (lower === "ulp" || lower === "searchbot") {
            const activeDays = (store && store.getUlpDays && store.getUlpDays(ctx.chat.id)) || userUlpDays.get(ctx.chat.id) || searchOptions.daysCount || 5;
            const customDomains = (store && store.getCustomDomains && store.getCustomDomains(ctx.chat.id)) || [];
            await safeReply(
                ctx,
                renderUlpHint({
                    searcherBot: searchOptions.botUsername,
                    stepDelayMs: searchOptions.stepDelayMs,
                    maxTries: searchOptions.maxTries,
                    daysCount: activeDays,
                }),
                ulpMenuKeyboard(activeDays, customDomains),
            );
            return;
        }

        // 2. Smart target domain recognition (e.g. "netflix.com", "https://portal.site.com")
        if (!rawText.includes(" ") && !rawText.includes("\n")) {
            const detectedDomain = extractSearchDomain(rawText);
            if (detectedDomain) {
                await safeReply(
                    ctx,
                    [
                        `🎯  ${B("TARGET DOMAIN DETECTED")}  ${tgEmoji("⚡️")}`,
                        RULE,
                        `🌐  Target: ${CODE(escapeHtml(detectedDomain))}`,
                        "",
                        `Choose an instant action for this target:`,
                    ].join("\n"),
                    domainActionKeyboard(detectedDomain),
                );
                return;
            }
        }

        // 3. Smart search query recognition (single search term or email, not multi-word sentences)
        if (rawText.length >= 2 && rawText.length <= 40 && !rawText.includes(" ") && !rawText.includes("\n") && (rawText.includes("@") || rawText.includes(":") || rawText.length > 3)) {
            await safeReply(
                ctx,
                [
                    `🔎  ${B("SEARCH QUERY DETECTED")}  ${tgEmoji("⚡️")}`,
                    RULE,
                    `🎯  Query: ${CODE(escapeHtml(rawText))}`,
                    "",
                    `Where would you like to search?`,
                ].join("\n"),
                queryActionKeyboard(rawText),
            );
            return;
        }

        await safeReply(
            ctx,
            [
                `📎  ${B("Send it as a file")}`,
                "",
                `Forward or upload a ${B(".zip")} — or a text file`,
                `(${B(".txt")}, .csv, .log, …) and I'll clean it 🧼`,
                "",
                `${I("Or just type /search your-query to search your batch 🔎")}`,
                `${I("Tip: if a forwarded zip arrived as text, download")}`,
                `${I("it first, then send it as a document 📂")}`,
            ].join("\n"),
            mainKeyboard(),
        );
    });

    bot.catch((err, ctx) => {
        const updateId = ctx && ctx.update ? ctx.update.update_id : "unknown";
        console.error(`Bot error for update ${updateId}:`, err);
    });

    return bot;
}

/**
 * Reply without throwing if the reply itself fails.
 * @param {import('telegraf').Context} ctx
 * @param {string} text
 * @param {object} [extra] additional sendMessage options (e.g. keyboard)
 */
let botApiCustomEmojiRejected = false;

function setBotApiCustomEmojiRejected(val) {
    botApiCustomEmojiRejected = Boolean(val);
}

function isBotApiCustomEmojiRejected() {
    return botApiCustomEmojiRejected;
}

/**
 * Strips icon_custom_emoji_id from inline keyboard buttons for API fallback.
 * @param {object} extra
 * @returns {object}
 */
function stripButtonEmojis(extra) {
    if (!extra || typeof extra !== "object") return extra;
    let clean = { ...extra };
    if (clean.reply_markup && clean.reply_markup.inline_keyboard) {
        clean.reply_markup = {
            ...clean.reply_markup,
            inline_keyboard: clean.reply_markup.inline_keyboard.map((row) =>
                Array.isArray(row)
                    ? row.map((btn) => {
                          if (btn && typeof btn === "object" && btn.icon_custom_emoji_id) {
                              const copy = { ...btn };
                              delete copy.icon_custom_emoji_id;
                              return copy;
                          }
                          return btn;
                      })
                    : row
            ),
        };
    }
    if (clean.inline_keyboard && Array.isArray(clean.inline_keyboard)) {
        clean.inline_keyboard = clean.inline_keyboard.map((row) =>
            Array.isArray(row)
                ? row.map((btn) => {
                      if (btn && typeof btn === "object" && btn.icon_custom_emoji_id) {
                          const copy = { ...btn };
                          delete copy.icon_custom_emoji_id;
                          return copy;
                      }
                      return btn;
                  })
                : row
        );
    }
    return clean;
}

const TELEGRAM_MSG_LIMIT = 4000;

/**
 * Safely answer a callback query, ensuring text is capped to Telegram's 200 character limit
 * and catching any network or expired-query errors gracefully.
 * @param {import('telegraf').Context} ctx
 * @param {string} [text]
 * @param {boolean} [showAlert]
 */
async function safeAnswerCbQuery(ctx, text = "", showAlert = false) {
    if (!ctx || typeof ctx.answerCbQuery !== "function") return;
    try {
        const safeText = text ? String(text).slice(0, 195) : undefined;
        await ctx.answerCbQuery(safeText, showAlert ? { show_alert: true } : undefined);
    } catch {
        // silently ignore callback answer failures (expired callback queries, etc.)
    }
}

/**
 * Safely send a text message using HTML parse mode, stripping custom emoji tags
 * and button emoji IDs if rejected by the Telegram API (such as DOCUMENT_INVALID).
 * @param {import('telegraf').Context} ctx
 * @param {string} text
 * @param {object} [extra] additional sendMessage options (e.g. keyboard)
 */
async function safeReply(ctx, text, extra = {}) {
    let sendText = typeof text === "string" ? text : String(text || "");
    if (!botApiCustomEmojiRejected) {
        sendText = ensureAnimatedEmojis(sendText);
    }
    if (sendText.length > TELEGRAM_MSG_LIMIT) {
        sendText = sendText.slice(0, TELEGRAM_MSG_LIMIT - 50) + "\n\n… [TRUNCATED]";
    }
    let sendExtra = extra;
    if (botApiCustomEmojiRejected) {
        if (sendText && sendText.includes("<tg-emoji")) {
            sendText = sendText.replace(/<tg-emoji[^>]*>(.*?)<\/tg-emoji>/gi, "$1");
        }
        sendExtra = stripButtonEmojis(extra);
    }
    try {
        return await ctx.reply(sendText, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            ...sendExtra,
        });
    } catch (err) {
        const msg = String((err && err.message) || err || "");
        const hasEmoji = (sendText && sendText.includes("<tg-emoji")) || (extra && extra.reply_markup);
        if (/custom_emoji|entity|button|icon|markup|document_invalid|bad request/i.test(msg) || hasEmoji) {
            botApiCustomEmojiRejected = true;
            let fallbackText = sendText;
            if (fallbackText && fallbackText.includes("<tg-emoji")) {
                fallbackText = fallbackText.replace(/<tg-emoji[^>]*>(.*?)<\/tg-emoji>/gi, "$1");
            }
            const fallbackExtra = stripButtonEmojis(extra);
            try {
                return await ctx.reply(fallbackText, {
                    parse_mode: "HTML",
                    disable_web_page_preview: true,
                    ...fallbackExtra,
                });
            } catch (fallbackErr) {
                const plainText = fallbackText.replace(/<[^>]+>/g, "").replace(/[<>]/g, "");
                const cleanExtra = { ...fallbackExtra };
                delete cleanExtra.parse_mode;
                try {
                    return await ctx.reply(plainText, {
                        disable_web_page_preview: true,
                        ...cleanExtra,
                    });
                } catch {
                    delete cleanExtra.reply_markup;
                    return await ctx.reply(plainText, {
                        disable_web_page_preview: true,
                        ...cleanExtra,
                    }).catch(() => null);
                }
            }
        }
        console.error("safeReply failed:", err.message);
        return null;
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
    let editText = typeof text === "string" ? text : String(text || "");
    if (!botApiCustomEmojiRejected) {
        editText = ensureAnimatedEmojis(editText);
    }
    if (editText.length > TELEGRAM_MSG_LIMIT) {
        editText = editText.slice(0, TELEGRAM_MSG_LIMIT - 50) + "\n\n… [TRUNCATED]";
    }
    let editExtra = extra;
    if (botApiCustomEmojiRejected) {
        if (editText && editText.includes("<tg-emoji")) {
            editText = editText.replace(/<tg-emoji[^>]*>(.*?)<\/tg-emoji>/gi, "$1");
        }
        editExtra = stripButtonEmojis(extra);
    }
    try {
        await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, editText, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            ...editExtra,
        });
    } catch (err) {
        const msg = String((err && err.message) || err || "");
        const hasEmoji = (editText && editText.includes("<tg-emoji")) || (extra && extra.reply_markup);
        if (/custom_emoji|entity|button|icon|markup|document_invalid|bad request/i.test(msg) || hasEmoji) {
            botApiCustomEmojiRejected = true;
            let fallbackText = editText;
            if (fallbackText && fallbackText.includes("<tg-emoji")) {
                fallbackText = fallbackText.replace(/<tg-emoji[^>]*>(.*?)<\/tg-emoji>/gi, "$1");
            }
            const fallbackExtra = stripButtonEmojis(extra);
            try {
                return await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, fallbackText, {
                    parse_mode: "HTML",
                    disable_web_page_preview: true,
                    ...fallbackExtra,
                });
            } catch (fallbackErr) {
                const fbMsg = String((fallbackErr && fallbackErr.message) || fallbackErr || "");
                if (/not modified/i.test(fbMsg)) return;
                const plainText = fallbackText.replace(/<[^>]+>/g, "").replace(/[<>]/g, "");
                const cleanExtra = { ...fallbackExtra };
                delete cleanExtra.parse_mode;
                try {
                    return await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, plainText, {
                        disable_web_page_preview: true,
                        ...cleanExtra,
                    });
                } catch {
                    delete cleanExtra.reply_markup;
                    try {
                        return await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, plainText, {
                            disable_web_page_preview: true,
                            ...cleanExtra,
                        });
                    } catch {
                        // ignore other edit errors (e.g. message not modified)
                    }
                }
            }
        }
        // ignore other edit errors (e.g. message not modified)
    }
}

/**
 * Clean a forwarded/uploaded/searched document with staged progress:
 * 📥 download → 📦 extract → 🧼 clean → ✅ report.
 * Used both for user uploads and for "🧼 Clean into batch" on search results.
 * @param {import('telegraf').Context} ctx
 * @param {import('telegraf').Types.Document} doc
 */
async function ingestDocument(ctx, doc, options = {}) {
    let name = userbot.resolveSafeFileName(
        doc,
        `dump_${(doc && (doc.file_unique_id || doc.file_id)) || Date.now()}`,
    );
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
    const progress = await safeReply(
        ctx,
        [
            `\uD83D\uDCE5  ${B("Downloading")} ${escapeHtml(name)}`,
            `     \uD83D\uDCC2  ${humanSize(doc.file_size || 0)}  \u00B7  \u23F3 working\u2026`,
        ].join("\n")
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
    const keepUrl = Boolean(options && options.keepUrl);
    const isZipFile = isZip || isZipBuffer(buffer);
    const fallbackUrl = options.fallbackUrl || null;

    void safeEdit(
        ctx,
        progress.message_id,
        [
            `🧼  ${B("Cleaning")} ${escapeHtml(name)}`,
            `     ✂️  multi-core filtering engine active…`,
        ].join("\n"),
    );

    const result =
        isZipFile
            ? await extractAndCleanZipAsync(buffer, { sourceName: name, keepUrl, fallbackUrl })
            : await extractAndCleanTextAsync(buffer.toString("utf8"), { sourceName: name, keepUrl, fallbackUrl });

    // Figure out the site this dump belongs to — used when naming the combined
    // file (e.g. "netflix.com_combined_2026-09-19.txt").
    const nameStem = sanitizeSiteSlug(name.replace(/\.[^.]+$/, ""));
    const site = sanitizeSiteSlug(result.site || "") || nameStem || "cleaned";

    const cleanLines = (result.lines || []).map((l) => cleanUserPassOnly(l) || l);
    const added = store.addLines(ctx.chat.id, cleanLines, site);
    const chatStats = store.getStats(ctx.chat.id);

    // Stage 4: done — full report.
    await safeEdit(
        ctx,
        progress.message_id,
        renderFileReport(name, result.stats, added, chatStats, site),
        fileReportKeyboard(),
    );

    // No auto-send: the batch keeps accumulating. Tap "Get combined file"
    // (or /combine) whenever you want to download it.
}

/**
 * Safely send a document using context or telegram instance, with fallback.
 */
async function safeSendDocument(ctx, chatId, payload, extra = {}) {
    if (typeof payload === "string") {
        const rawBase = path.basename(payload);
        const isZip = rawBase.toLowerCase().endsWith(".zip");
        const resolved = userbot.resolveSafeFileName(
            rawBase,
            "combolist_combined",
            isZip ? ".zip" : ".txt",
        );
        payload = { source: payload, filename: resolved };
    } else if (payload && typeof payload === "object") {
        const isZip = payload.filename && String(payload.filename).toLowerCase().endsWith(".zip");
        payload.filename = userbot.resolveSafeFileName(
            payload.filename,
            "combolist_combined",
            isZip ? ".zip" : ".txt",
        );
    }
    let sendExtra = extra ? { ...extra } : {};
    if (!botApiCustomEmojiRejected && sendExtra.caption && typeof sendExtra.caption === "string") {
        sendExtra.caption = ensureAnimatedEmojis(sendExtra.caption);
    }
    if (sendExtra.caption && typeof sendExtra.caption === "string" && sendExtra.caption.length > 1000) {
        sendExtra.caption = sendExtra.caption.slice(0, 950) + "…";
    }
    if (botApiCustomEmojiRejected) {
        sendExtra = stripButtonEmojis(sendExtra);
        if (sendExtra && sendExtra.caption && sendExtra.caption.includes("<tg-emoji")) {
            sendExtra = {
                ...sendExtra,
                caption: sendExtra.caption.replace(/<tg-emoji[^>]*>(.*?)<\/tg-emoji>/gi, "$1"),
            };
        }
    }
    const doSend = async (opts) => {
        let finalOpts = opts;
        if (finalOpts && typeof finalOpts.caption === "string" && finalOpts.caption.length > 1000) {
            finalOpts = { ...finalOpts, caption: finalOpts.caption.slice(0, 950) + "…" };
        }
        if (typeof ctx.replyWithDocument === "function") {
            try {
                return await ctx.replyWithDocument(payload, finalOpts);
            } catch (err) {
                if (ctx.telegram && typeof ctx.telegram.sendDocument === "function" && chatId) {
                    return await ctx.telegram.sendDocument(chatId, payload, finalOpts);
                }
                throw err;
            }
        } else if (ctx.telegram && typeof ctx.telegram.sendDocument === "function" && chatId) {
            return await ctx.telegram.sendDocument(chatId, payload, finalOpts);
        }
        throw new Error("No document delivery method available on context");
    };

    try {
        return await doSend(sendExtra);
    } catch (err) {
        const msg = String((err && err.message) || err || "");
        if (/custom_emoji|entity|button|icon|markup|document_invalid|bad request/i.test(msg)) {
            botApiCustomEmojiRejected = true;
            const fallbackExtra = stripButtonEmojis(extra);
            if (fallbackExtra && fallbackExtra.caption && fallbackExtra.caption.includes("<tg-emoji")) {
                fallbackExtra.caption = fallbackExtra.caption.replace(/<tg-emoji[^>]*>(.*?)<\/tg-emoji>/gi, "$1");
            }
            try {
                return await doSend(fallbackExtra);
            } catch (fallbackErr) {
                const plainExtra = { ...fallbackExtra };
                delete plainExtra.parse_mode;
                if (plainExtra.caption) {
                    plainExtra.caption = plainExtra.caption.replace(/<[^>]+>/g, "").replace(/[<>]/g, "");
                }
                try {
                    return await doSend(plainExtra);
                } catch {
                    delete plainExtra.reply_markup;
                    return await doSend(plainExtra).catch(() => null);
                }
            }
        }
        throw err;
    }
}

/**
 * Send the combined, deduped file for the current chat. Named after the site
 * when the whole batch belongs to one site, otherwise "combolist".
 * @param {import('telegraf').Context} ctx
 */
const lastCombineAt = new Map(); // chatId -> timestamp

async function sendCombined(ctx, force = false) {
    const chatId = ctx.chat && ctx.chat.id;
    if (!chatId) return;

    const now = Date.now();
    const last = lastCombineAt.get(chatId) || 0;
    if (!force && now - last < COMBINE_COOLDOWN_MS) {
        await safeReply(ctx, "\u23F3 One sec \u2014 already building it! \uD83E\uDDFD");
        return;
    }
    lastCombineAt.set(chatId, now);
    if (lastCombineAt.size > 500) {
        const oldest = lastCombineAt.keys().next().value;
        lastCombineAt.delete(oldest);
    }

    // Wait for any active in-flight MTProto / download ingestions to resolve
    await waitForIngestions(chatId);

    const chat = store.getRawChat(chatId);
    const customName = chat && chat.customName ? chat.customName : null;
    const activeRun = searchbot.getRun(chatId);
    const isSearching = Boolean(activeRun && activeRun.status === "running");

    const lines = store.getLines(chatId);
    if (lines.length === 0) {
        // If ULP search is actively in flight and no files have finished yet
        if (isSearching) {
            await safeReply(
                ctx,
                [
                    `${tgEmoji("⏳")}  ${B("ULP SEARCH IN PROGRESS")}  ${tgEmoji("🚀")}`,
                    RULE,
                    `${tgEmoji("🎯")}  Target: ${B(escapeHtml(activeRun.query || "target"))}`,
                    `${tgEmoji("📡")}  Search dumps are currently being queried and downloaded from ${B("@DumpNews14Bot")}.`,
                    `${tgEmoji("💎")}  As soon as dumps arrive, credentials will be automatically cleaned into your batch.`,
                    "",
                    `${I("Tap 📦 Get Combined File again in a few seconds, or wait for automatic delivery when the search completes! ⚡️")}`,
                ].join("\n"),
                ulpKeyboard("running"),
            );
            return;
        }

        const cached = store.getLastCombined(chatId);
        if (cached && cached.buffer) {
            try {
                const cachedFilename = userbot.resolveSafeFileName(cached.filename, "combolist_combined");
                const dl = downloads.registerDownload({
                    filename: cachedFilename,
                    buffer: cached.buffer,
                    size: cached.buffer.length,
                    chatId,
                    stats: { total: cached.linesCount, kept: cached.linesCount },
                });
                await safeSendDocument(
                    ctx,
                    chatId,
                    { source: cached.buffer, filename: cachedFilename },
                    {
                        caption: [
                            `🎁  ${B("COMBINED & DEDUPED (Latest Batch)")}`,
                            `📁  ${B(escapeHtml(cached.filename))}  ·  🔑 ${B(compact(cached.linesCount))} credentials`,
                            `🔗  ${B("Direct link:")} ${dl.url}`,
                            "",
                            `${I("Delivering your recent search results fresh from cache! ⚡️")}`,
                        ].join("\n"),
                        parse_mode: "HTML",
                        ...afterCombineKeyboard(dl.url),
                    },
                );
                return;
            } catch (cachedErr) {
                console.error("sendCombined cached delivery failed:", cachedErr && cachedErr.message ? cachedErr.message : cachedErr);
            }
        }

        // Check if there is any processed output on disk in the vault
        const procFiles = scanDirFiles(localProcessedRoot());
        if (procFiles.length > 0) {
            const newest = procFiles[0];
            try {
                const resolvedName = userbot.resolveSafeFileName(newest.name, "combolist_combined");
                await safeSendDocument(
                    ctx,
                    chatId,
                    { source: fs.createReadStream(newest.path), filename: resolvedName },
                    {
                        caption: [
                            `🎁  ${B("COMBINED & DEDUPED (From Server Vault)")}`,
                            `📁  ${B(escapeHtml(newest.name))}  ·  💾 ${humanSize(newest.size)}`,
                            `📅  Created: ${formatFileDate(newest.mtime)}`,
                            "",
                            `${I("Delivered fresh from your server storage vault! ⚡️")}`,
                        ].join("\n"),
                        parse_mode: "HTML",
                        ...afterCombineKeyboard(),
                    },
                );
                return;
            } catch (diskErr) {
                console.error("sendCombined disk fallback failed:", diskErr && diskErr.message ? diskErr.message : diskErr);
            }
        }

        await safeReply(
            ctx,
            [
                `📬  ${B("Nothing to combine yet")}`,
                `Your batch is empty \u2014 start a ${B("/ulp")} search or send me a ${B(".zip")} or ${B(".txt")}`,
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

    if (!base || typeof base !== "string" || !base.trim() || base === "_" || base === "undefined" || base === "null" || base === "file" || base === "unnamed" || base.startsWith("unnamed")) {
        base = "combolist";
    }
    base = sanitizeSiteSlug(base) || "combolist";
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `${base}_combined_${stamp}.txt`;
    const outputPath = path.join(localProcessedRoot(), filename);

    let buffer;
    // Always persist to localProcessedRoot so the file is never lost and accessible via /files
    try {
        fs.mkdirSync(localProcessedRoot(), { recursive: true });
        // Stream / write combined content
        const combinedContent = buildOutput(lines);
        buffer = Buffer.from(combinedContent, "utf8");
        fs.writeFileSync(outputPath, buffer);
    } catch (writeErr) {
        console.error("Failed to persist combined file to disk:", writeErr);
        if (!buffer) buffer = Buffer.from(buildOutput(lines), "utf8");
    }

    store.setLastCombined(chatId, { buffer, filename, linesCount: lines.length, site: base });

    // If file is very large (> 45 MB), Bot API cannot upload raw (> 50 MB limit).
    // Try compressing to .zip first (credentials compress by 70-85%).
    let sendPayload = { source: buffer, filename };
    let isZipped = false;
    if (buffer.length > 45 * 1024 * 1024) {
        try {
            const AdmZip = require("adm-zip");
            const zip = new AdmZip();
            zip.addFile(filename, buffer);
            const zipBuffer = zip.toBuffer();
            if (zipBuffer.length <= 48 * 1024 * 1024) {
                sendPayload = { source: zipBuffer, filename: `${base}_combined_${stamp}.zip` };
                isZipped = true;
            }
        } catch (zipErr) {
            console.error("Zip compression of large combined file failed:", zipErr);
        }
    }

    const statusNote = isSearching
        ? `${tgEmoji("⏳")}  ${I("ULP search is actively running — delivering credentials gathered so far! Final combined file will also be delivered upon completion.")}`
        : `${I("Served fresh — tap 📥 below to grab it again anytime.")}`;

    const dl = downloads.registerDownload({
        filename: isZipped ? `${base}_combined_${stamp}.zip` : filename,
        filePath: outputPath,
        buffer,
        size: buffer.length,
        chatId,
        stats: { total: lines.length, kept: lines.length },
    });

    try {
        await safeSendDocument(
            ctx,
            chatId,
            sendPayload,
            {
                caption: [
                    `🎁  ${B("COMBINED & DEDUPED")}`,
                    `${siteLine}  ·  🔑 ${B(compact(lines.length))} unique lines`,
                    isZipped ? `📦  ${I("Compressed to .zip to fit Telegram upload limits")}` : "",
                    `💾  Saved to server vault: ${CODE(escapeHtml(filename))}`,
                    `🔗  ${B("Direct link:")} ${dl.url}`,
                    "",
                    statusNote,
                ].filter(Boolean).join("\n"),
                parse_mode: "HTML",
                ...afterCombineKeyboard(dl.url),
            },
        );
    } catch (uploadErr) {
        console.error("sendCombined document upload failed:", uploadErr);
        // Fallback: Notify user with server path, direct link, and vault keyboard
        await safeReply(
            ctx,
            [
                `⚠️  ${B("Telegram Upload Limit Exceeded")}`,
                RULE,
                `The combined list contains ${B(compact(lines.length))} lines (${humanSize(buffer.length)}), which exceeds Telegram's Bot API cap.`,
                "",
                `🔗  ${B("Direct Download Link:")}`,
                `${dl.url}`,
                "",
                `✅  ${B("File safely saved to Server Disk:")}`,
                CODE(escapeHtml(outputPath)),
                "",
                `Tap the direct download link button below to download instantly!`,
            ].join("\n"),
            afterCombineKeyboard(dl.url),
        );
    }
}

/**
 * Reply with HTML and return the sent message (null when the send fails).
 * @param {import('telegraf').Context} ctx
 * @param {string} text
 * @param {object} [extra]
 */
async function sendHtml(ctx, text, extra = {}) {
    let sendText = text;
    if (!botApiCustomEmojiRejected && typeof sendText === "string") {
        sendText = ensureAnimatedEmojis(sendText);
    }
    let sendExtra = extra;
    if (botApiCustomEmojiRejected) {
        if (sendText && sendText.includes("<tg-emoji")) {
            sendText = sendText.replace(/<tg-emoji[^>]*>(.*?)<\/tg-emoji>/gi, "$1");
        }
        sendExtra = stripButtonEmojis(extra);
    }
    try {
        return await ctx.reply(sendText, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            ...sendExtra,
        });
    } catch (err) {
        const msg = String((err && err.message) || err || "");
        if (/custom_emoji|entity|button|icon|markup|document_invalid|bad request/i.test(msg)) {
            botApiCustomEmojiRejected = true;
            let fallbackText = text;
            if (text && text.includes("<tg-emoji")) {
                fallbackText = text.replace(/<tg-emoji[^>]*>(.*?)<\/tg-emoji>/gi, "$1");
            }
            const fallbackExtra = stripButtonEmojis(extra);
            try {
                return await ctx.reply(fallbackText, {
                    parse_mode: "HTML",
                    disable_web_page_preview: true,
                    ...fallbackExtra,
                });
            } catch (fallbackErr) {
                console.error("sendHtml fallback failed:", fallbackErr && fallbackErr.message ? fallbackErr.message : fallbackErr);
                const plainText = fallbackText.replace(/<[^>]+>/g, "").replace(/[<>]/g, "");
                const cleanExtra = { ...fallbackExtra };
                delete cleanExtra.reply_markup;
                delete cleanExtra.parse_mode;
                return await ctx.reply(plainText, {
                    disable_web_page_preview: true,
                    ...cleanExtra,
                }).catch(() => null);
            }
        }
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
    let sendText = text;
    if (!botApiCustomEmojiRejected && typeof sendText === "string") {
        sendText = ensureAnimatedEmojis(sendText);
    }
    if (botApiCustomEmojiRejected) {
        if (sendText && sendText.includes("<tg-emoji")) {
            sendText = sendText.replace(/<tg-emoji[^>]*>(.*?)<\/tg-emoji>/gi, "$1");
        }
    }
    try {
        return await telegram.sendMessage(chatId, sendText, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
        });
    } catch (err) {
        const msg = String((err && err.message) || err || "");
        if (/custom_emoji|entity|button|icon|markup|document_invalid|bad request/i.test(msg)) {
            botApiCustomEmojiRejected = true;
            let fallbackText = text;
            if (text && text.includes("<tg-emoji")) {
                fallbackText = text.replace(/<tg-emoji[^>]*>(.*?)<\/tg-emoji>/gi, "$1");
            }
            try {
                return await telegram.sendMessage(chatId, fallbackText, {
                    parse_mode: "HTML",
                    disable_web_page_preview: true,
                });
            } catch (fallbackErr) {
                console.error("sendHtmlTo fallback failed:", fallbackErr && fallbackErr.message ? fallbackErr.message : fallbackErr);
                const plainText = fallbackText.replace(/<[^>]+>/g, "").replace(/[<>]/g, "");
                return await telegram.sendMessage(chatId, plainText, {
                    disable_web_page_preview: true,
                }).catch(() => null);
            }
        }
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
    const run = searchbot.getRun(chatId);
    if (run) {
        if (run.delivered) return;
        run.delivered = true;
    }
    deliveringCombined.add(chatId);
    try {
        await waitForIngestions(chatId);
        await new Promise((r) => setTimeout(r, 1500));
        await waitForIngestions(chatId);
        const lines = store.getLines(chatId);
        const activeDays = (store && store.getUlpDays && store.getUlpDays(chatId)) || (userUlpDays && userUlpDays.get(chatId)) || 5;
        const customDomains = (store && store.getCustomDomains && store.getCustomDomains(chatId)) || [];
        if (lines.length > 0) {
            await sendCombined(ctx, true);
            store.clear(chatId);
            await safeReply(
                ctx,
                `${tgEmoji("🧹")} Batch automatically cleaned and reset. Ready for next search!`,
                ulpPostSearchKeyboard(activeDays, customDomains)
            );
        } else {
            await safeReply(
                ctx,
                [
                    `${tgEmoji("📭")}  ${B("NO CREDENTIALS FOUND")}  ${tgEmoji("⚡️")}`,
                    RULE,
                    `Search completed, but no credentials were found for this query in the specified days.`,
                    "",
                    `💡 ${I("Try searching with more days (e.g. 14 or 30 days) or test another target domain below:")}`,
                ].join("\n"),
                ulpPostSearchKeyboard(activeDays, customDomains)
            );
        }
    } catch (err) {
        console.error("deliverCombinedAndResetBatch failed:", err);
    } finally {
        deliveringCombined.delete(chatId);
    }
}

/**
 * Parse an optional days token like "7", "7d", "7days".
 * @param {string} token
 * @returns {number|null}
 */
function parseDaysToken(token) {
    if (!token) return null;
    const str = String(token).trim();
    const match = str.match(/^(\d{1,3})(?:d|days?)?$/i);
    if (!match) return null;
    const n = parseInt(match[1], 10);
    if (n >= 1 && n <= 180) return n;
    return null;
}

/**
 * Parse "/ulp <query> [days] [day|month|year] [start_date]" arguments.
 *
 * @param {string} raw text after the command
 * @param {string|{ defaultScope?: string }} [fallbackScope]
 * @returns {{ query: string|null, scope: string, startDate?: Date, daysCount?: number }}
 */
function parseUlpArg(raw, fallbackScope = "day") {
    const defaultScope =
        typeof fallbackScope === "string"
            ? fallbackScope
            : fallbackScope && typeof fallbackScope.defaultScope === "string"
            ? fallbackScope.defaultScope
            : "day";
    const parts = String(raw || "").split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { query: null, scope: defaultScope };

    // Support "/ulp days 7" or "/ulp setdays 7"
    if (parts.length === 2 && (parts[0].toLowerCase() === "days" || parts[0].toLowerCase() === "setdays")) {
        const d = parseDaysToken(parts[1]);
        if (d) return { query: null, scope: defaultScope, daysCount: d };
    }

    let startDate = null;
    let daysCount = null;
    let scope = defaultScope;
    const remaining = [...parts];

    let modified = true;
    while (modified && remaining.length > 0) {
        modified = false;
        const last = remaining[remaining.length - 1];

        // Is it a date?
        const parsedDate = userbot.parseDmyDate(last);
        if (parsedDate && !startDate) {
            startDate = parsedDate;
            scope = "day";
            remaining.pop();
            modified = true;
            continue;
        }

        // Is it a days count? (e.g. 7, 14d, 30days)
        const parsedDays = parseDaysToken(last);
        if (parsedDays && !daysCount) {
            daysCount = parsedDays;
            remaining.pop();
            modified = true;
            continue;
        }

        // Is it a scope? (day, month, year)
        const lastScope = searchbot.normalizeScope(last, null);
        if (lastScope && remaining.length > 1 && scope === defaultScope) {
            scope = lastScope;
            remaining.pop();
            modified = true;
            continue;
        }
    }

    // Check if only scope remains: e.g. "/ulp month"
    if (remaining.length === 1) {
        const soloScope = searchbot.normalizeScope(remaining[0], null);
        if (soloScope) {
            const out = { query: null, scope: soloScope };
            if (daysCount) out.daysCount = daysCount;
            return out;
        }
    }

    // If all tokens were consumed by date/days modifiers without a query: e.g. "/ulp 7"
    if (remaining.length === 0) {
        const out = { query: null, scope };
        if (startDate) out.startDate = startDate;
        if (daysCount) out.daysCount = daysCount;
        return out;
    }

    const query = searchbot.normalizeQuery(remaining.join(" "));
    const out = { query, scope };
    if (startDate) out.startDate = startDate;
    if (daysCount) out.daysCount = daysCount;
    return out;
}

/**
 * Is this update a message from the configured ULP searcher bot?
 * @param {import('telegraf').Context} ctx
 * @param {{ botUsername?: string, searcherBotId?: number }} meta
 * @param {{ botUsername: string }} searchOptions
 */
function isSearcherMessage(ctx, meta, searchOptions) {
    if (!ctx || typeof ctx !== "object") return false;
    const from = ctx.from;
    if (!from || !from.is_bot || !ctx.message) return false;
    const expected = String((searchOptions && searchOptions.botUsername) || "").replace(/^@+/, "").toLowerCase();
    const username = String(from.username || "").replace(/^@+/, "").toLowerCase();
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
            send: (stepOrText) => {
                const text = (stepOrText && typeof stepOrText === "object" && stepOrText.text) ? stepOrText.text : String(stepOrText || "");
                return userbot.send(text);
            },
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
        send: (stepOrText) => {
            const text = (stepOrText && typeof stepOrText === "object" && stepOrText.text) ? stepOrText.text : String(stepOrText || "");
            return ctx.telegram.sendMessage(`@${searchOptions.botUsername}`, text);
        },
    };
}

/**
 * Check if an incoming message contains a forwarded document.
 * Handles Telegram 7+ forward_origin, older forward_date/forward_from,
 * and media_group_id albums.
 *
 * @param {import('telegraf').Context} ctx
 * @returns {boolean}
 */
function isForwardedDocument(ctx) {
    const msg = (ctx && (ctx.message || ctx.channelPost)) || null;
    if (!msg || !msg.document) return false;
    return Boolean(
        msg.forward_date ||
        msg.forward_origin ||
        msg.forward_from ||
        msg.forward_from_chat ||
        msg.forward_sender_name ||
        msg.forward_signature ||
        msg.media_group_id
    );
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
    const msg = (ctx && (ctx.message || ctx.channelPost)) || null;
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

    if (msg.forward_from) {
        const username = String(msg.forward_from.username || "").toLowerCase();
        const metaId = meta && meta.searcherBotId;
        if (expected && username === expected) return true;
        if (metaId && Number(msg.forward_from.id) === Number(metaId)) return true;
    }

    if (msg.forward_from_chat) {
        const chatUsername = String(msg.forward_from_chat.username || "").toLowerCase();
        const metaId = meta && meta.searcherBotId;
        if (expected && chatUsername === expected) return true;
        if (metaId && Number(msg.forward_from_chat.id) === Number(metaId)) return true;
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
    const daysCount = Math.max(1, Math.min(90, Number(params.daysCount || (userUlpDays && userUlpDays.get(chatId)) || (searchOptions && searchOptions.daysCount) || 5)));
    const calculatedWindowMs = Math.max(searchOptions.windowMs || 300000, (daysCount * (searchOptions.stepDelayMs + 10000)) + 60000);

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
    if (ulpStartedAt.size > 500) {
        const oldest = ulpStartedAt.keys().next().value;
        ulpStartedAt.delete(oldest);
    }

    // Choose how the query reaches the searcher: the account transport
    // (MTProto bypass, needs no other bot's cooperation) or the plain Bot API.
    const transport = pickTransport(meta, searchOptions, ctx);

    const steps = searchbot.buildSteps(query, scope, searchOptions.histTemplate);
    const run = searchbot.startRun(chatId, { query, scope, windowMs: calculatedWindowMs });

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
        daysCount,
        startDate: startDate ? userbot.formatDateDmy(startDate) : null,
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
        (async () => {
            const live = searchbot.getRun(chatId);
            if (!live || live.status !== "running") return;
            searchbot.finishRun(chatId, "done");
            if (card) {
                const count = live.results ? live.results.length : 0;
                const text = count > 0
                    ? renderUlpDone({ query: live.query, scope: live.scope, count })
                    : renderUlpStopped({ query: live.query, scope: live.scope, count: 0 });
                await safeEdit(
                    ctx,
                    card.message_id,
                    text,
                    ulpKeyboard("done"),
                );
            }
            await deliverCombinedAndResetBatch(ctx);
        })().catch((timerErr) => {
            console.error("ULP window timer error:", timerErr && timerErr.message ? timerErr.message : timerErr);
        });
    }, calculatedWindowMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    ulpWindows.set(chatId, timer);

    let result;
    if (scope === "day" && transport.kind === "userbot" && typeof transport.userbot.searchDayByDay === "function") {
        let dayRes;
        let lastStatusEdit = 0;
        let pendingStatusTimer = null;
        try {
            dayRes = await transport.userbot.searchDayByDay({
                query,
                daysCount,
                startDate: startDate || null,
                chatId,
                botUsername: meta && meta.botUsername,
                stepDelayMs: searchOptions.stepDelayMs,
                shouldStop: () => !searchbot.isRunning(chatId),
                onStatus: (st) => {
                    if (!card) return;
                    const now = Date.now();
                    const text = renderUlpProgress({
                        searcherBot: searchOptions.botUsername,
                        attempt: st.attempt,
                        maxTries: st.totalDays,
                        sends: [`${st.day}: ${st.step}`],
                        stepDelayMs: searchOptions.stepDelayMs,
                        query,
                        stats: store.getStats(chatId),
                    });
                    const kb = ulpKeyboard(scope, { attempt: st.attempt, maxTries: st.totalDays });
                    if (now - lastStatusEdit >= 1200) {
                        lastStatusEdit = now;
                        if (pendingStatusTimer) {
                            clearTimeout(pendingStatusTimer);
                            pendingStatusTimer = null;
                        }
                        safeEdit(ctx, card.message_id, text, kb).catch(() => {});
                    } else if (!pendingStatusTimer) {
                        pendingStatusTimer = setTimeout(() => {
                            pendingStatusTimer = null;
                            lastStatusEdit = Date.now();
                            safeEdit(ctx, card.message_id, text, kb).catch(() => {});
                        }, 1200 - (now - lastStatusEdit));
                    }
                },
                onResult: async (m) => {
                    try {
                        const p = ingestUserbotMessage(chatId, m, transport.userbot, query);
                        trackIngestion(chatId, p);
                        await p;
                        searchbot.noteResult(transport.userbot && transport.userbot.searcherId ? transport.userbot.searcherId : 0, {
                            messageId: m && m.id,
                            kind: m && (m.media || m.document) ? "document" : "text",
                        });
                    } catch (ingestErr) {
                        console.error("ULP onResult ingestion error:", ingestErr && ingestErr.message ? ingestErr.message : ingestErr);
                    }
                },
                sleep,
            });
        } catch (dayErr) {
            console.error("searchDayByDay error:", dayErr && dayErr.message ? dayErr.message : dayErr);
            dayRes = { status: "error", error: dayErr && dayErr.message ? dayErr.message : String(dayErr) };
        } finally {
            if (pendingStatusTimer) {
                clearTimeout(pendingStatusTimer);
                pendingStatusTimer = null;
            }
        }

        await waitForIngestions(chatId).catch(() => {});
        clearUlpWindow(ulpWindows, chatId);

        if (!dayRes || dayRes.status === "stopped") {
            return;
        }

        if (dayRes.status === "error") {
            searchbot.finishRun(chatId, "done");
            if (card) {
                const text = renderUlpBlocked({
                    kind: "userbot_error",
                    searcherBot: searchOptions.botUsername,
                    ownBot: meta.botUsername || null,
                    steps: [],
                    stepDelayMs: searchOptions.stepDelayMs,
                    reason: dayRes.error || "Userbot encountered an unexpected error during search.",
                    transport: transport.kind,
                });
                await safeEdit(ctx, card.message_id, text, ulpKeyboard(scope));
            }
            return;
        }

        searchbot.finishRun(chatId, "done");
        if (card) {
            const resultCount = (searchbot.getRun(chatId) || {}).results?.length || 0;
            const text = renderUlpDone({ query, scope, count: resultCount });
            await safeEdit(
                ctx,
                card.message_id,
                text,
                ulpKeyboard("done"),
            );
        }
        await deliverCombinedAndResetBatch(ctx);
        return;
    } else {
        try {
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
                            query,
                            stats: store.getStats(chatId),
                        }),
                        ulpKeyboard(scope, { attempt: event.attempt, maxTries: searchOptions.maxTries }),
                    ).catch(() => {});
                },
            });
        } catch (searchErr) {
            console.error("searchbot.runSearch error:", searchErr && searchErr.message ? searchErr.message : searchErr);
            result = { status: "error", error: searchErr };
        }
    }

    if (!result) {
        clearUlpWindow(ulpWindows, chatId);
        searchbot.finishRun(chatId, "done");
        return;
    }

    // Results keep landing in the open window — deliver when finished.
    if (result.status === "results") {
        await waitForIngestions(chatId);
        clearUlpWindow(ulpWindows, chatId);
        searchbot.finishRun(chatId, "done");
        if (card) {
            const resultCount = (searchbot.getRun(chatId) || {}).results?.length || 0;
            const text = renderUlpDone({ query, scope, count: resultCount });
            await safeEdit(ctx, card.message_id, text, ulpKeyboard("done"));
        }
        await deliverCombinedAndResetBatch(ctx);
        return;
    }

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

    if (store.getLines(chatId).length > 0) {
        await deliverCombinedAndResetBatch(ctx);
    }
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
    const msg = (ctx && (ctx.message || ctx.channelPost)) || {};
    const searcherChatId = ctx.chat.id;
    const isDoc = Boolean(msg.document);
    const rawText = msg.text || msg.caption || "";
    const textRes = (!isDoc && rawText) ? extractAndCleanText(rawText, { keepUrl: false }) : { lines: [] };

    // Ignore text messages from searcher bot that contain no valid credentials
    // (e.g. prompts, echoes of the search URL, menus). Prevents forwarding query loops.
    if (!isDoc && textRes.lines.length === 0) {
        return;
    }

    const kind = isDoc ? "document" : msg.photo ? "photo" : msg.video ? "video" : "text";

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
        if (!msg.document && msg.text && run && run.query) {
            const res = extractAndCleanText(msg.text, { keepUrl: false });
            if (res.lines.length > 0) {
                const site = sanitizeSiteSlug(run.query) || "cleaned";
                const cleanLines = res.lines.map((l) => cleanUserPassOnly(l) || l);
                store.addLines(chatId, cleanLines, site, { isTextResponse: true });
            }
        }
        if (msg.document) {
            const doc = msg.document;
            const size = doc.file_size || 0;
            if (size <= MAX_DOWNLOAD_BYTES) {
                const p = ingestDocument({
                    telegram: ctx.telegram,
                    chat: { id: chatId },
                    reply: (text, extra) => ctx.telegram.sendMessage(chatId, text, extra),
                }, doc, { keepUrl: false }).catch((err) => {
                    console.error("auto ingestDocument in relay failed:", err && err.message ? err.message : err);
                });
                trackIngestion(chatId, p);
            }
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
 * Ingest and clean a message received from the searcher bot via userbot.
 * Directly extracts and cleans credentials from buffer or text and adds them to the chat batch.
 *
 * @param {number} chatId
 * @param {any} msg teleproto message object
 * @param {any} peer userbot peer instance
 * @param {string} [query]
 */
async function ingestUserbotMessage(chatId, msg, peer, query = "") {
    if (!chatId || !msg) return null;
    try {
        const text = msg.message || msg.text || "";
        const media = msg.media;
        let site = sanitizeSiteSlug(query) || "cleaned";

        const isRealDoc = Boolean(
            msg.document ||
            msg.file ||
            (media && (media.document || media.className === "MessageMediaDocument" || media._ === "messageMediaDocument"))
        );

        if (isRealDoc && peer && typeof peer.downloadMedia === "function") {
            const buffer = await peer.downloadMedia(msg).catch(() => null);
            if (buffer && buffer.length > 0) {
                const candidateName = (msg.file && (msg.file.name || msg.file.fileName)) ||
                    userbot.resolveSafeFileName(msg, `ulp_result_${msg.id || "file"}`);
                const name = userbot.resolveSafeFileName(candidateName, `ulp_result_${msg.id || "file"}`);
                const isZip = name.toLowerCase().endsWith(".zip") || isZipBuffer(buffer);
                const result = isZip
                    ? await extractAndCleanZipAsync(buffer, { sourceName: name, keepUrl: false })
                    : await extractAndCleanTextAsync(decodeBufferToText(buffer), { sourceName: name, keepUrl: false });
                if (result.site) {
                    site = sanitizeSiteSlug(result.site) || site;
                }
                if (result.lines.length > 0) {
                    const cleanLines = result.lines.map((l) => cleanUserPassOnly(l) || l);
                    const added = store.addLines(chatId, cleanLines, site);
                    return { lines: cleanLines.length, added: added.added, duplicates: added.duplicates, site };
                }
            }
        }

        if (text) {
            const result = await extractAndCleanTextAsync(text, { keepUrl: false });
            if (result.site) {
                site = sanitizeSiteSlug(result.site) || site;
            }
            if (result.lines.length > 0) {
                const cleanLines = result.lines.map((l) => cleanUserPassOnly(l) || l);
                const added = store.addLines(chatId, cleanLines, site, { isTextResponse: true });
                return { lines: cleanLines.length, added: added.added, duplicates: added.duplicates, site };
            }
        }
    } catch (err) {
        console.error(`ingestUserbotMessage error for chat ${chatId}:`, err && err.message ? err.message : err);
    }
    return null;
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
    const msg = (ctx && (ctx.message || ctx.channelPost)) || {};
    let chatId = ctx.chat.id;
    let run = searchbot.getRun(chatId);
    if (!run && typeof searchbot.mostRecentRun === "function") {
        const live = searchbot.mostRecentRun();
        if (live && live.status === "running") {
            chatId = live.chatId;
            run = live;
        }
    }
    const hasDocument = Boolean(msg.document);
    const rawText = msg.text || msg.caption || "";
    const query = run ? run.query : "";
    const textRes = (!hasDocument && rawText) ? extractAndCleanText(rawText, { keepUrl: false }) : { lines: [] };

    // Ignore text messages that contain no credential lines (e.g. prompts, echoes of the search URL, menus)
    if (!hasDocument && textRes.lines.length === 0) {
        return;
    }

    const scope = run ? run.scope : "day";
    const count = run ? run.results.length : 1;
    const isRelayedFromUserbot = ctx.chat && ctx.chat.id !== chatId;
    const targetCtx = isRelayedFromUserbot
        ? {
            telegram: ctx.telegram,
            chat: { id: chatId },
            reply: (text, extra) => ctx.telegram.sendMessage(chatId, text, extra),
        }
        : ctx;

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

    if (isRelayedFromUserbot) {
        if (hasDocument && msg.document) {
            try {
                await ctx.telegram.forwardMessage(chatId, ctx.chat.id, msg.message_id, {
                    ...ulpResultKeyboard(true),
                });
            } catch {
                await ctx.telegram.sendDocument(chatId, msg.document.file_id, {
                    caption: `${tgEmoji("📦")} ${escapeHtml(msg.document.file_name || "dump.txt")}`,
                    ...ulpResultKeyboard(true),
                }).catch(() => { });
            }
        } else {
            await safeReply(
                targetCtx,
                renderUlpSharedResult({
                    searcherBot: searchOptions.botUsername,
                    query,
                    scope,
                    count,
                    hasDocument,
                }),
                ulpResultKeyboard(hasDocument),
            );
        }
    } else {
        await safeReply(
            ctx,
            renderUlpSharedResult({
                searcherBot: searchOptions.botUsername,
                query,
                scope,
                count,
                hasDocument,
            }),
            {
                reply_parameters: { message_id: msg.message_id },
                ...ulpResultKeyboard(hasDocument),
            },
        );
    }

    // Auto-clean the document immediately into the batch!
    if (hasDocument) {
        const doc = msg.document;
        const size = doc.file_size || 0;
        if (size <= MAX_DOWNLOAD_BYTES) {
            const p = ingestDocument(targetCtx, doc, { keepUrl: false }).catch((err) => {
                console.error("auto ingestDocument failed:", err && err.message ? err.message : err);
            });
            trackIngestion(chatId, p);
        } else {
            const peer = meta && meta.userbot;
            if (peer && typeof peer.isReady === "function" && peer.isReady()) {
                const name = userbot.resolveSafeFileName(doc, `result_${msg.message_id || Date.now()}`);
                const p = peer.downloadMessageToDisk(chatId, msg.message_id, {
                    root: localProcessRoot(),
                    fileName: name,
                })
                    .then((saved) => processFile(targetCtx, saved.path, null, { keepUrl: false }))
                    .catch((err) => {
                        console.error("auto-process via userbot failed:", err && err.message ? err.message : err);
                    });
                trackIngestion(chatId, p);
            }
        }
    } else if (textRes.lines.length > 0) {
        const site = sanitizeSiteSlug(query) || "cleaned";
        const cleanLines = textRes.lines.map((l) => cleanUserPassOnly(l) || l);
        store.addLines(chatId, cleanLines, site, { isTextResponse: true });
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
 * Lists files in a directory sorted by size descending (default) or modification time.
 * @param {string} dir
 * @param {"size" | "mtime"} [sortBy="size"]
 * @returns {Array<{ name: string, path: string, size: number, mtime: Date }>}
 */
function scanDirFiles(dir, sortBy = "size") {
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
    if (sortBy === "mtime") {
        files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    } else {
        files.sort((a, b) => ((b.size || 0) - (a.size || 0)) || ((b.mtime && a.mtime) ? b.mtime.getTime() - a.mtime.getTime() : 0));
    }
    return files;
}

/**
 * Returns all vault files across raw and processed folders, sorted by size descending.
 * @param {"size" | "mtime"} [sortBy="size"]
 * @param {string|null} [rawOverride=null]
 * @param {string|null} [procOverride=null]
 * @returns {Array<{ name: string, path: string, size: number, mtime: Date }>}
 */
function getAllVaultFiles(sortBy = "size", rawOverride = null, procOverride = null) {
    const rawFiles = scanDirFiles(rawOverride ? path.resolve(rawOverride) : localProcessRoot(), sortBy)
        .map((f) => ({ ...f, type: "raw", isClean: false }));
    const processedFiles = scanDirFiles(procOverride ? path.resolve(procOverride) : localProcessedRoot(), sortBy)
        .map((f) => ({ ...f, type: "proc", isClean: true }));
    const combined = [...rawFiles, ...processedFiles];
    if (sortBy === "mtime") {
        combined.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    } else {
        combined.sort((a, b) => ((b.size || 0) - (a.size || 0)) || ((b.mtime && a.mtime) ? b.mtime.getTime() - a.mtime.getTime() : 0));
    }
    return combined;
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
function resolveLocalInput(inputPath, rootOverride = null) {
    if (!inputPath || typeof inputPath !== "string") {
        const err = new Error("Invalid input path: must be a non-empty string");
        err.code = "INVALID_INPUT_PATH";
        throw err;
    }
    const root = fs.realpathSync(rootOverride ? path.resolve(rootOverride) : localProcessRoot());
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
 * Get filesystem storage capacity and free space stats.
 * Uses fs.statfsSync if available on the current OS/platform.
 */
function getDiskStats(dirPath = null) {
    const target = dirPath || localProcessRoot();
    try {
        if (typeof fs.statfsSync === "function") {
            const st = fs.statfsSync(target);
            const bsize = st.bsize || 4096;
            const total = Number(st.blocks) * bsize;
            const free = Number(st.bavail || st.bfree) * bsize;
            const used = Math.max(0, total - free);
            return { total, free, used };
        }
    } catch {
        // Directory may not exist yet or statfs unsupported
    }
    return null;
}

/**
 * Search a text file or zip archive without excessive memory consumption.
 * Supports .zip archives, small-file fast path, multi-core worker slicing, and streaming fallback.
 * @param {string} filePath
 * @param {string} query
 * @param {number} [limit=20]
 * @returns {Promise<{ total: number, matches: string[], isZip?: boolean }>}
 */
async function searchTextFile(filePath, query, limit = 20, options = {}) {
    const q = String(query || "").trim();
    if (!q || !filePath) return { total: 0, matches: [] };
    if (!fs.existsSync(filePath)) return { total: 0, matches: [] };
    const signal = options && options.signal ? options.signal : null;
    if (signal && signal.aborted) {
        const err = new Error("SEARCH_ABORTED");
        err.name = "AbortError";
        throw err;
    }

    // Support zip archives
    let isZip = filePath.toLowerCase().endsWith(".zip");
    if (!isZip) {
        try {
            const fd = fs.openSync(filePath, "r");
            const head = Buffer.alloc(4);
            const n = fs.readSync(fd, head, 0, 4, 0);
            fs.closeSync(fd);
            if (n === 4 && isZipBuffer(head)) isZip = true;
        } catch {}
    }

    if (isZip) {
        try {
            const stat = fs.statSync(filePath);
            const maxZipBytes = processMaxZipBytes();
            if (stat.size > maxZipBytes) {
                console.warn(`Skipping zip search for ${filePath}: size ${stat.size} exceeds cap ${maxZipBytes}`);
                return { total: 0, matches: [], isZip: true, skipped: true };
            }

            const AdmZip = require("adm-zip");
            const zip = new AdmZip(filePath);
            const matches = [];
            const seenMatches = new Set();
            let total = 0;

            const TEXT_EXTS = new Set([
                ".txt", ".log", ".csv", ".tsv", ".lst", ".list", ".dat",
                ".json", ".xml", ".htm", ".html", ".bak", ".out", ".sql",
                ".dump", ".text", ".reg", ".ini", ".conf", ".cfg"
            ]);

            const searchZipEntries = (zipInstance, depth = 0) => {
                if (depth > 3) return;
                const entries = zipInstance.getEntries();
                for (const entry of entries) {
                    if (signal && signal.aborted) {
                        const err = new Error("SEARCH_ABORTED");
                        err.name = "AbortError";
                        throw err;
                    }
                    if (entry.isDirectory || (entry.header && entry.header.size === 0)) continue;
                    const lowerName = entry.entryName.toLowerCase();
                    if (lowerName.startsWith("__macosx/") || lowerName.endsWith(".ds_store")) continue;

                    // Support nested zips
                    if (lowerName.endsWith(".zip")) {
                        try {
                            const nestedBuf = entry.getData();
                            if (nestedBuf && isZipBuffer(nestedBuf)) {
                                const nestedZip = new AdmZip(nestedBuf);
                                searchZipEntries(nestedZip, depth + 1);
                            }
                        } catch {}
                        continue;
                    }

                    const dotIdx = lowerName.lastIndexOf(".");
                    const ext = dotIdx === -1 ? "" : lowerName.slice(dotIdx);
                    if (TEXT_EXTS.has(ext) || dotIdx === -1) {
                        const entryBuf = entry.getData();
                        const subRes = searchBufferCI(entryBuf, q, Math.max(0, limit - matches.length));
                        total += subRes.total;
                        for (const m of subRes.matches) {
                            if (matches.length < limit && !seenMatches.has(m)) {
                                seenMatches.add(m);
                                matches.push(m);
                            }
                        }
                    }
                }
            };

            searchZipEntries(zip, 0);
            return { total, matches, isZip: true };
        } catch (err) {
            if (err.name === "AbortError" || (signal && signal.aborted)) throw err;
            console.error("Error reading zip during search:", filePath, err);
            return { total: 0, matches: [], isZip: true };
        }
    }

    // Text file search
    try {
        const stat = fs.statSync(filePath);

        // Fast in-memory buffer path for files under 64 MB
        if (stat.size < 64 * 1024 * 1024) {
            const buf = await fs.promises.readFile(filePath);
            const res = searchBufferCI(buf, q, limit);
            return { total: res.total, matches: res.matches, isZip: false };
        }

        // Multi-core parallel search for larger files
        const pool = getSharedPool();
        const res = await pool.searchFileParallel(filePath, q, limit);
        if (res && typeof res.total === "number") {
            return { total: res.total, matches: res.matches || [], isZip: false };
        }
    } catch (err) {
        if (err.name === "AbortError" || (signal && signal.aborted)) throw err;
        console.error("Worker pool search error, falling back to streaming search:", err);
    }

    // Fallback streaming search via readline
    try {
        const readline = require("readline");
        const rl = readline.createInterface({
            input: fs.createReadStream(filePath, { encoding: "utf8", highWaterMark: 1024 * 1024 }),
            crlfDelay: Infinity,
        });
        const matcher = createSearchMatcher(q);
        const matches = [];
        let total = 0;
        const recentLines = [];
        for await (let line of rl) {
            if (signal && signal.aborted) {
                rl.close();
                const err = new Error("SEARCH_ABORTED");
                err.name = "AbortError";
                throw err;
            }
            if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
            recentLines.push(line);
            if (recentLines.length > 20) recentLines.shift();

            if (matcher && matcher(line)) {
                total++;
                if (matches.length < limit) {
                    let matchResult = line;
                    const stealerRec = resolveStealerRecordFromLines(recentLines, recentLines.length - 1);
                    if (stealerRec) matchResult = stealerRec;
                    matches.push(matchResult);
                }
            }
        }
        return { total, matches, isZip: false };
    } catch (fallbackErr) {
        if (fallbackErr.name === "AbortError" || (signal && signal.aborted)) throw fallbackErr;
        console.error("Streaming search failed:", fallbackErr);
        return { total: 0, matches: [], isZip: false };
    }
}

/**
 * Search across all files in the vault (raw and processed) in parallel.
 * @param {string} query
 * @param {object} [options]
 * @param {number} [options.limit=20]
 * @param {string} [options.rawRoot]
 * @param {string} [options.procRoot]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs=25000]
 * @returns {Promise<{ total: number, matches: string[], fileResults: Array, totalFiles: number, searchedFiles: number }>}
 */
async function searchAllVaultFiles(query, options = {}) {
    const limit = typeof options.limit === "number" ? options.limit : 20;
    const q = String(query || "").trim();
    if (!q) return { total: 0, matches: [], fileResults: [], totalFiles: 0, searchedFiles: 0 };
    const signal = options && options.signal ? options.signal : null;
    const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 25000;

    const rawRoot = options.rawRoot === null ? null : (options.rawRoot ? path.resolve(options.rawRoot) : localProcessRoot());
    const procRoot = options.procRoot === null ? null : (options.procRoot ? path.resolve(options.procRoot) : localProcessedRoot());
    const rawFiles = rawRoot ? scanDirFiles(rawRoot).map((f) => ({ ...f, type: "raw" })) : [];
    const procFiles = procRoot ? scanDirFiles(procRoot).map((f) => ({ ...f, type: "proc" })) : [];
    const allFiles = [...procFiles, ...rawFiles];

    if (allFiles.length === 0) {
        return { total: 0, matches: [], fileResults: [], totalFiles: 0, searchedFiles: 0 };
    }

    let grandTotal = 0;
    const combinedMatches = [];
    const fileResults = [];
    const startTime = Date.now();

    // Concurrently process vault files in batches scaled to available CPU cores (4 to 8)
    const os = require("os");
    const CONCURRENCY = Math.min(8, Math.max(4, (os.cpus() || []).length || 4));
    for (let i = 0; i < allFiles.length; i += CONCURRENCY) {
        if (signal && signal.aborted) {
            const err = new Error("SEARCH_ABORTED");
            err.name = "AbortError";
            throw err;
        }
        if (Date.now() - startTime > timeoutMs) {
            console.warn(`searchAllVaultFiles reached timeout of ${timeoutMs}ms; returning partial results`);
            break;
        }

        const batch = allFiles.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(batch.map(async (f) => {
            if (signal && signal.aborted) return null;
            if (Date.now() - startTime > timeoutMs) return null;
            try {
                const res = await searchTextFile(f.path, q, limit, { signal });
                return { f, res };
            } catch (err) {
                if (err.name === "AbortError" || (signal && signal.aborted)) throw err;
                console.error("Error searching vault file:", f.name, err);
                return null;
            }
        }));

        for (const item of batchResults) {
            if (!item || !item.res) continue;
            const { f, res } = item;
            if (res.total > 0) {
                grandTotal += res.total;
                fileResults.push({
                    name: f.name,
                    path: f.path,
                    type: f.type,
                    size: f.size,
                    total: res.total,
                    matches: res.matches,
                });
                for (const m of res.matches) {
                    if (combinedMatches.length < limit) {
                        combinedMatches.push(m);
                    }
                }
            }
        }

        if (typeof options.onProgress === "function") {
            try {
                options.onProgress({
                    current: Math.min(allFiles.length, i + batch.length),
                    total: allFiles.length,
                    currentFile: batch[batch.length - 1] ? batch[batch.length - 1].name : "",
                    matchesFound: grandTotal,
                });
            } catch {}
        }

        // Yield to event loop between file batches so the bot stays completely responsive!
        await new Promise((r) => setImmediate(r));
    }

    fileResults.sort((a, b) => b.total - a.total);

    return {
        total: grandTotal,
        matches: combinedMatches,
        fileResults,
        totalFiles: allFiles.length,
        searchedFiles: fileResults.length,
    };
}


/** Build a collision-resistant output path under LOCAL_PROCESSED_ROOT. */
function processedOutputPath(name, chatId) {
    const root = localProcessedRoot();
    fs.mkdirSync(root, { recursive: true });
    const safeName = typeof name === "string" ? name : (typeof name === "symbol" ? "cleaned" : String(name || "cleaned"));
    const stem = sanitizeSiteSlug(safeName.replace(/\.[^.]+$/, "")) || "cleaned";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeChatId = typeof chatId === "symbol" ? "chat" : String(chatId || "chat");
    return path.join(root, `${stem}_${safeChatId}_${stamp}.txt`);
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
async function processFile(ctx, inputPath, progressMessageId = null, options = {}) {
    let fullPath;
    let allowedRoot;

    try {
        const resolved = resolveLocalInput(inputPath, options && options.root);
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
        progress = await safeReply(
            ctx,
            [
                `📥  ${B("Reading")} ${escapeHtml(name)}`,
                `     📁  ${humanSize(stat.size)}  ·  ${escapeHtml(path.dirname(fullPath))}`,
                `     🔒  allowed root: ${escapeHtml(allowedRoot)}`,
            ].join("\n")
        );
    }

    const keepUrl = Boolean(options && options.keepUrl);
    if (isText) {
        await processTextFile(ctx, progress, fullPath, name, stat.size, { ...options, keepUrl });
    } else {
        await processZipFile(ctx, progress, fullPath, name, stat.size, { ...options, keepUrl });
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
    const keepUrl = Boolean(options && options.keepUrl);
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
    const output = fs.createWriteStream(partialPath, { encoding: "utf8", highWaterMark: 4 * 1024 * 1024 });
    let writtenLines = 0;
    const seen = new Set();
    const pool = getSharedPool();
    let lineBuffer = [];
    const PARALLEL_CHUNK = 25000;

    const rl = readline.createInterface({
        input: fs.createReadStream(fullPath, { encoding: "utf8", highWaterMark: 4 * 1024 * 1024 }),
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
            const { cleanLinesArray } = require("./cleaner");
            res = cleanLinesArray(currentLines, { keepUrl, dedupe: false });
        } else {
            // Execute parallel multi-core cleaning across worker threads
            res = await pool.cleanLinesParallel(currentLines, { keepUrl, dedupe: false });
        }
        stats.dropped += res.stats.dropped;

        let writeBuffer = "";
        for (let i = 0; i < res.lines.length; i++) {
            const cleaned = cleanUserPassOnly(res.lines[i]) || res.lines[i];
            if (seen.has(cleaned)) {
                stats.duplicates += 1;
                continue;
            }
            if (seen.size < store.MAX_LINES_PER_CHAT) {
                seen.add(cleaned);
            }
            stats.kept += 1;
            writtenLines += 1;
            writeBuffer += cleaned + "\n";
            if (writeBuffer.length >= 262144) {
                if (!output.write(writeBuffer)) await once(output, "drain");
                writeBuffer = "";
            }
            batch.push(cleaned);
            if (batch.length >= PROCESS_BATCH_SIZE) flushBatch();
        }
        if (writeBuffer.length > 0) {
            if (!output.write(writeBuffer)) await once(output, "drain");
            writeBuffer = "";
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
            `💾  ${B("Full disk output")} · ${num(writtenLines)} cleaned lines`,
            `${CODE(escapeHtml(outputPath))}`,
            `${I("Search it with /lsearch your-query. Disk output may contain repeated cleaned lines; the RAM batch remains deduped.")}`,
        ].join("\n"),
        fileReportKeyboard(),
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
            `📦  ${B("Extracting")} ${escapeHtml(name)}`,
            `     🧵  unzipping nested archives…`,
        ].join("\n"),
    );

    const buffer = fs.readFileSync(fullPath);
    const keepUrl = Boolean(options && options.keepUrl);

    // Stage 3: cleaning.
    void safeEdit(
        ctx,
        progress.message_id,
        [
            `🧼  ${B("Cleaning")} ${escapeHtml(name)}`,
            `     ✂️  multi-core filtering engine active…`,
        ].join("\n"),
    );

    const result = await extractAndCleanZipAsync(buffer, { sourceName: name, keepUrl });

    const nameStem = sanitizeSiteSlug(name.replace(/\.[^.]+$/, ""));
    const site = sanitizeSiteSlug(result.site || "") || nameStem || "cleaned";

    const cleanLines = (result.lines || []).map((l) => cleanUserPassOnly(l) || l);
    const added = store.addLines(ctx.chat.id, cleanLines, site);
    const chatStats = store.getStats(ctx.chat.id);
    const outputPath = processedOutputPath(name, ctx.chat.id);
    fs.writeFileSync(outputPath, buildOutput(cleanLines), "utf8");

    await safeEdit(
        ctx,
        progress.message_id,
        [
            renderFileReport(name, result.stats, added, chatStats, site),
            "",
            `💾  ${B("Full disk output")}`,
            `${CODE(escapeHtml(outputPath))}`,
            `${I("Search it with /lsearch your-query.")}`,
        ].join("\n"),
        fileReportKeyboard(),
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
    isForwardedDocument,
    pickTransport,
    processFile,
    latestFileIn,
    localProcessRoot,
    localProcessedRoot,
    getDiskStats,
    resolveLocalInput,
    searchTextFile,
    searchAllVaultFiles,
    processedOutputPath,
    renderSaveError,
    scanDirFiles,
    getAllVaultFiles,
    sendCombined,
    deliverCombinedAndResetBatch,
    ingestUserbotMessage,
    trackIngestion,
    waitForIngestions,
    stripButtonEmojis,
    setBotApiCustomEmojiRejected,
    isBotApiCustomEmojiRejected,
    safeReply,
    safeEdit,
    safeSendDocument,
    sendHtml,
    sendHtmlTo,
};


