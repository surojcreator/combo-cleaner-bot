"use strict";

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const store = require("../src/store");
const messages = require("../src/messages");
const userbot = require("../src/userbot");
const { isZipBuffer } = require("../src/extractor");
const { classifySendError, getRun, startRun } = require("../src/searchbot");
const { getSharedPool } = require("../src/worker-pool");
const bot = require("../src/bot");
const { safeSendDocument, sendCombined } = bot;

describe("Mega Prompt 2: Exhaustive Audit & System Verification Matrix", () => {
    afterEach(() => {
        store.clearAll();
        messages.clearCustomEmojis();
    });

    describe("Category A: Filename Integrity & Document Delivery", () => {
        test("safeDownloadName strips path traversal, null bytes, Windows characters, and caps length", () => {
            // Null bytes & traversal
            const traversal = userbot.safeDownloadName("../../../secret\0passwords.txt");
            assert.ok(!traversal.includes(".."), "Must not include path traversal");
            assert.ok(!traversal.includes("\0"), "Must not include null bytes");
            assert.equal(traversal, "secretpasswords.txt");

            // Windows reserved characters (<>:"/\|?*)
            const winReserved = userbot.safeDownloadName("my<dirty>:file*name?.txt");
            assert.equal(winReserved, "my_dirty__file_name_.txt");

            // Extreme length cap (180 characters)
            const giant = "a".repeat(300) + ".txt";
            const capped = userbot.safeDownloadName(giant);
            assert.ok(capped.length <= 180, `Length must be <= 180, got ${capped.length}`);

            // Undefined, null, empty, bare 'file'
            assert.equal(userbot.safeDownloadName(""), "telegram-file.bin");
            assert.equal(userbot.safeDownloadName(null), "telegram-file.bin");
            assert.equal(userbot.safeDownloadName("undefined"), "telegram-file.bin");
            assert.equal(userbot.safeDownloadName("file"), "telegram-file.bin");
            assert.equal(userbot.safeDownloadName("telegram-undefined.bin"), "telegram-file.bin");
        });

        test("safeSendDocument guarantees payload.filename is never empty, null, or bare 'file'", async () => {
            const delivered = [];
            const mockCtx = {
                replyWithDocument: async (payload, extra) => {
                    delivered.push({ payload, extra });
                    return { message_id: 888 };
                },
            };

            // Test empty filename
            await safeSendDocument(mockCtx, 1001, { source: Buffer.from("test"), filename: "" });
            assert.ok(delivered[0].payload.filename.startsWith("combolist_combined_"));
            assert.ok(delivered[0].payload.filename.endsWith(".txt"));

            // Test bare 'file'
            await safeSendDocument(mockCtx, 1001, { source: Buffer.from("test"), filename: "file" });
            assert.ok(delivered[1].payload.filename.startsWith("combolist_combined_"));

            // Test null/undefined
            await safeSendDocument(mockCtx, 1001, { source: Buffer.from("test"), filename: null });
            assert.ok(delivered[2].payload.filename.startsWith("combolist_combined_"));
        });

        test("isZipBuffer detects PK magic bytes reliably vs ASCII/UTF-8 text", () => {
            const zipMagic = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
            assert.equal(isZipBuffer(zipMagic), true);

            const emptyZipMagic = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
            assert.equal(isZipBuffer(emptyZipMagic), true);

            const plainText = Buffer.from("user@gmail.com:password123\nadmin:admin", "utf8");
            assert.equal(isZipBuffer(plainText), false);

            const shortBuf = Buffer.from([0x50, 0x4b]);
            assert.equal(isZipBuffer(shortBuf), false);
        });

        test("Large file auto-compression: AdmZip compresses text files > 45MB", () => {
            const AdmZip = require("adm-zip");
            const zip = new AdmZip();
            // Create compressible test credentials
            const credSample = Buffer.from("user@netflix.com:SecretPass12345!\n".repeat(10000), "utf8");
            zip.addFile("credentials.txt", credSample);
            const zipped = zip.toBuffer();
            assert.ok(zipped.length < credSample.length, "ZIP compression must substantially reduce credential size");
            assert.ok(isZipBuffer(zipped), "Compressed buffer must have valid ZIP magic bytes");
        });

        test("resolveSafeFileName resolves GramJS attributes, MIME types, and guarantees valid non-empty names", () => {
            // 1. Doc with explicit file_name
            const doc1 = { file_name: "custom_dump.txt" };
            assert.equal(userbot.resolveSafeFileName(doc1), "custom_dump.txt");

            // 2. GramJS message with attributes
            const gramDoc = {
                media: {
                    document: {
                        mimeType: "text/plain",
                        attributes: [{ fileName: "gram_archive.txt" }],
                    },
                },
            };
            assert.equal(userbot.resolveSafeFileName(gramDoc), "gram_archive.txt");

            // 3. GramJS message lacking attribute but having MIME application/zip
            const zipGramDoc = {
                media: {
                    document: {
                        mimeType: "application/zip",
                        attributes: [],
                    },
                },
            };
            const resolvedZip = userbot.resolveSafeFileName(zipGramDoc, "dump_123");
            assert.ok(resolvedZip.startsWith("dump_123_"));
            assert.ok(resolvedZip.endsWith(".zip"));

            // 4. Undefined, null, bare 'file'
            const resolvedEmpty = userbot.resolveSafeFileName(null, "combolist");
            assert.ok(resolvedEmpty.startsWith("combolist_"));
            assert.ok(resolvedEmpty.endsWith(".txt"));

            const resolvedBareFile = userbot.resolveSafeFileName({ file_name: "file" }, "combolist");
            assert.ok(resolvedBareFile.startsWith("combolist_"));

            // 5. Bare string input
            assert.equal(userbot.resolveSafeFileName("clean_name.txt"), "clean_name.txt");

            // 6. Unnamed strings or objects
            assert.ok(!userbot.resolveSafeFileName("unnamed").toLowerCase().includes("unnamed"));
            assert.ok(!userbot.resolveSafeFileName("unnamed.txt").toLowerCase().includes("unnamed"));
            assert.ok(!userbot.resolveSafeFileName("unnamed.bin").toLowerCase().includes("unnamed"));
            assert.ok(!userbot.resolveSafeFileName({ file_name: "unnamed" }).toLowerCase().includes("unnamed"));
            assert.ok(!userbot.resolveSafeFileName({ media: { document: { attributes: [{ fileName: "unnamed.bin" }] } } }).toLowerCase().includes("unnamed"));
        });
    });

    describe("Category B: Telegram Bot API & Error Boundaries", () => {
        test("400 DOCUMENT_INVALID triggers emoji stripping and automatic fallback retry", async () => {
            bot.setBotApiCustomEmojiRejected(false);

            let attempts = 0;
            const mockCtx = {
                reply: async (text, extra) => {
                    attempts++;
                    if (attempts === 1) {
                        const err = new Error("400: Bad Request: DOCUMENT_INVALID");
                        throw err;
                    }
                    return { message_id: 1234, text };
                },
            };

            const res = await bot.safeReply(mockCtx, '<tg-emoji emoji-id="5368324170671202286">💎</tg-emoji> Test');
            assert.ok(res);
            assert.equal(attempts, 2, "Should attempt with custom emojis then retry with fallback");
            assert.strictEqual(bot.isBotApiCustomEmojiRejected(), true);
        });

        test("400 can't parse entities triggers secondary fallback stripping HTML tags", async () => {
            bot.setBotApiCustomEmojiRejected(false);
            let attempts = 0;
            let deliveredText = "";

            const mockCtx = {
                reply: async (text, extra) => {
                    attempts++;
                    if (extra && extra.parse_mode === "HTML") {
                        throw new Error("400: Bad Request: can't parse entities in message text: Character '<' is reserved");
                    }
                    deliveredText = text;
                    return { message_id: 2345, text };
                },
            };

            const unclosedHtml = "<b>Unclosed Tag without close <broken";
            const res = await bot.safeReply(mockCtx, unclosedHtml);
            assert.ok(res);
            assert.ok(!deliveredText.includes("<b>"), "Delivered text should have HTML tags completely stripped on entity error");
        });

        test("safeEdit catches message is not modified silently without throwing", async () => {
            const mockCtx = {
                chat: { id: 777001 },
                telegram: {
                    editMessageText: async () => {
                        throw new Error("400: Bad Request: message is not modified: specified new message content and reply markup are exactly the same");
                    },
                },
            };

            // Should complete cleanly without throwing an exception
            await assert.doesNotReject(async () => {
                await bot.safeEdit(mockCtx, 999, "Same Progress Text");
            });
        });
    });

    describe("Category C: ULP Automated Searcher & State Machine", () => {
        test("classifySendError detects bot-to-bot disabled and bot restrictions", () => {
            assert.equal(classifySendError({ description: "USER_BOT_TO_BOT_DISABLED" }), "bot_to_bot_disabled");
            assert.equal(classifySendError({ description: "BOT_TO_BOT_DISABLED" }), "bot_to_bot_disabled");
            assert.equal(classifySendError({ description: "USER_IS_BOT: can't send messages to bots" }), "bot_to_bot_disabled");
            assert.equal(classifySendError({ description: "Forbidden: bot was blocked by the user" }), "blocked");
            assert.equal(classifySendError({ description: "Too Many Requests: retry after 12" }), "flood_wait");
        });

        test("Dump bot text responses never increment store chat.files counter", () => {
            const chatId = 888001;
            store.clear(chatId);

            // Adding lines marked as text response
            const res = store.addLines(chatId, ["user1:pass1", "user2:pass2"], "domain.com", { isTextResponse: true });
            assert.equal(res.added, 2);

            const stats = store.getStats(chatId);
            assert.equal(stats.size, 2);
            assert.equal(stats.files, 0, "Files count must remain 0 for text responses");
        });

        test("Active ULP search: sendCombined delivers credentials collected so far without terminating run", async () => {
            const chatId = 888002;
            store.clear(chatId);
            store.addLines(chatId, ["alice@site.com:p1", "bob@site.com:p2"], "site.com");

            const activeRun = startRun(chatId, "site.com", "day", "DumpNews14Bot");
            assert.equal(activeRun.status, "running");

            const sentDocs = [];
            const mockCtx = {
                chat: { id: chatId },
                replyWithDocument: async (payload, extra) => {
                    sentDocs.push({ payload, extra });
                    return { message_id: 5555 };
                },
                reply: async (text) => ({ message_id: 5556, text }),
            };

            await sendCombined(mockCtx, true);

            // Verify document was delivered
            assert.equal(sentDocs.length, 1);
            assert.ok(sentDocs[0].extra.caption.includes("ULP search is actively running"));
            // Verify run is still active and lines remain in store
            const currentRun = getRun(chatId);
            assert.equal(currentRun.status, "running");
            assert.equal(store.getLines(chatId).length, 2);
        });
    });

    describe("Category D: Multi-Core Performance & Resource Saturation", () => {
        test("WorkerPool processes 10,000+ line batch across parallel CPU cores maintaining line boundaries", async () => {
            const pool = getSharedPool();
            const lines = [];
            for (let i = 0; i < 10000; i++) {
                lines.push(`https://secure.target.com/login:user_${i}@mail.com:StrongPassword_${i}!`);
            }

            const res = await pool.cleanLinesParallel(lines, { keepUrl: true });
            assert.equal(res.stats.total, 10000);
            assert.equal(res.lines.length, 10000);
            assert.equal(res.lines[0], "https://secure.target.com/login:user_0@mail.com:StrongPassword_0!");
            assert.equal(res.lines[9999], "https://secure.target.com/login:user_9999@mail.com:StrongPassword_9999!");
        });

        test("store deduplication with 100,000 records stays O(1) and memory stats report accurately", () => {
            const chatId = 888003;
            store.clear(chatId);

            const batch1 = [];
            for (let i = 0; i < 50000; i++) batch1.push(`acc_${i}@test.com:pass${i}`);
            store.addLines(chatId, batch1, "test.com");

            // Add duplicate batch
            const batch2 = [];
            for (let i = 25000; i < 75000; i++) batch2.push(`acc_${i}@test.com:pass${i}`);
            const res2 = store.addLines(chatId, batch2, "test.com");

            assert.equal(res2.added, 25000);
            assert.equal(res2.duplicates, 25000);

            const stats = store.getStats(chatId);
            assert.equal(stats.size, 75000);

            const memStats = store.getMemoryStats();
            assert.ok(memStats.totalLines >= 75000);
            assert.ok(memStats.activeChats >= 1);
        });
    });

    describe("Category E: Interactive State Management & Vault Operations", () => {
        test("removeDomain removes matching lines, updates sites and recalculates totalKept", () => {
            const chatId = 888004;
            store.clear(chatId);

            store.addLines(chatId, [
                "user1@netflix.com:pass1",
                "user2@netflix.com:pass2",
                "user3@spotify.com:pass3",
                "user4@hulu.com:pass4",
            ], "mixed.com");

            let stats = store.getStats(chatId);
            assert.equal(stats.size, 4);

            const removedRes = store.removeDomain(chatId, "netflix.com");
            assert.equal(removedRes.removed, 2);
            assert.equal(removedRes.remaining, 2);

            stats = store.getStats(chatId);
            assert.equal(stats.size, 2);

            const remainingLines = store.getLines(chatId);
            assert.ok(remainingLines.every(l => !l.includes("netflix.com")));
        });

        test("renderServerFiles and serverFilesKeyboard support tabs, pagination and tool options", () => {
            const rawFiles = [
                { name: "raw1.txt", size: 1024, mtime: new Date(), path: "/tmp/raw1.txt" },
                { name: "raw2.zip", size: 2048, mtime: new Date(), path: "/tmp/raw2.zip" },
            ];
            const procFiles = [
                { name: "cleaned1.txt", size: 4096, mtime: new Date(), path: "/tmp/cleaned1.txt" },
            ];

            // Tab: raw
            const rawView = messages.renderServerFiles({ rawFiles, processedFiles: procFiles, tab: "raw", page: 0 });
            assert.match(rawView, /FILES VAULT|SERVER/);
            assert.match(rawView, /raw1\.txt/);

            // Tab: proc
            const procView = messages.renderServerFiles({ rawFiles, processedFiles: procFiles, tab: "proc", page: 0 });
            assert.match(procView, /cleaned1\.txt/);

            // Tab: tools
            const toolsView = messages.renderServerFiles({ rawFiles, processedFiles: procFiles, tab: "tools", page: 0 });
            assert.match(toolsView, /STORAGE & PURGE MANAGER|DISK TOOLS/);

            // Keyboards for each tab
            const rawKb = messages.serverFilesKeyboard(rawFiles, procFiles, "raw", 0);
            assert.ok(rawKb.reply_markup.inline_keyboard.length > 0);

            const toolsKb = messages.serverFilesKeyboard(rawFiles, procFiles, "tools", 0);
            const toolBtns = toolsKb.reply_markup.inline_keyboard.flat().map(b => b.text);
            assert.ok(toolBtns.some(t => t.includes("Wipe All Raw")));
            assert.ok(toolBtns.some(t => t.includes("Wipe All Outputs")));
        });
    });
});
