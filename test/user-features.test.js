"use strict";

const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const store = require("../src/store");
const messages = require("../src/messages");
const { createBot } = require("../src/bot");
const { getSharedPool } = require("../src/worker-pool");

describe("User Requested Features & Optimizations", () => {
    afterEach(() => {
        store.clearAll();
        messages.clearCustomEmojis();
    });

    test("1. Text responses from dump bot do NOT increment files count in store", () => {
        const chatId = 901001;
        store.clear(chatId);

        // Simulate text response from dump bot with isTextResponse: true
        const textLines = [
            "user1@gmail.com:pass123",
            "user2@gmail.com:pass456",
        ];
        const res1 = store.addLines(chatId, textLines, "gmail.com", { isTextResponse: true });
        assert.equal(res1.added, 2);

        let stats = store.getStats(chatId);
        assert.equal(stats.size, 2);
        // CRITICAL REQUIREMENT: chat.files must be 0 because it was a text response, not a file upload!
        assert.equal(stats.files, 0, "Text responses must not increment file counter");

        // Now simulate an actual file upload
        const fileLines = [
            "user3@gmail.com:pass789",
        ];
        const res2 = store.addLines(chatId, fileLines, "gmail.com");
        assert.equal(res2.added, 1);

        stats = store.getStats(chatId);
        assert.equal(stats.size, 3);
        assert.equal(stats.files, 1, "Actual file upload must increment file counter");
    });

    test("2. removeDomain removes matching credentials and updates stats & sites", () => {
        const chatId = 901002;
        store.clear(chatId);

        store.addLines(chatId, ["alice@netflix.com:secret1", "bob@netflix.com:secret2"], "netflix.com");
        store.addLines(chatId, ["charlie@spotify.com:music1"], "spotify.com");

        let stats = store.getStats(chatId);
        assert.equal(stats.size, 3);
        assert.equal(stats.sites, 2);

        // Remove domain netflix.com
        const removalResult = store.removeDomain(chatId, "netflix.com");
        assert.equal(removalResult.removed, 2);
        assert.equal(removalResult.remaining, 1);

        // Verify remaining batch content
        const remainingLines = store.getLines(chatId);
        assert.equal(remainingLines.length, 1);
        assert.equal(remainingLines[0], "charlie@spotify.com:music1");

        stats = store.getStats(chatId);
        assert.equal(stats.size, 1);
        assert.equal(stats.sites, 1);

        const siteCounts = store.getSiteCounts(chatId);
        assert.equal(siteCounts.length, 1);
        assert.equal(siteCounts[0].site, "spotify.com");
    });

    test("3. removeDomain handles non-existent or empty domains gracefully", () => {
        const chatId = 901003;
        store.clear(chatId);

        const res1 = store.removeDomain(chatId, "nonexistent.com");
        assert.equal(res1.removed, 0);
        assert.equal(res1.remaining, 0);

        store.addLines(chatId, ["user@domain.com:pass"], "domain.com");
        const res2 = store.removeDomain(chatId, "");
        assert.equal(res2.removed, 0);
        assert.equal(res2.remaining, 1);
    });

    test("4. Animated emoji mappings apply to all UI render functions", () => {
        messages.registerCustomEmojis({
            diamond: "111111",
            zap: "222222",
            search: "333333",
            rocket: "444444",
            package: "555555",
            chart: "666666",
            trash: "777777",
            calendar: "888888",
        });

        // Test renderStats
        const statsOutput = messages.renderStats({ size: 100, files: 2, totalKept: 100, sites: 1 });
        assert.ok(statsOutput.includes('emoji-id="666666"'));
        assert.ok(statsOutput.includes('emoji-id="111111"'));

        // Test renderSites
        const sitesOutput = messages.renderSites([{ site: "netflix.com", count: 50 }]);
        assert.ok(sitesOutput.includes('emoji-id="555555"'));

        // Test renderSearch
        const searchOutput = messages.renderSearch("netflix", { total: 1, matches: ["user@netflix.com:pw"] });
        assert.ok(searchOutput.includes('emoji-id="333333"'));

        // Test renderUlpHint
        const hintOutput = messages.renderUlpHint({ searcherBot: "DumpNews14Bot", stepDelayMs: 7000, maxTries: 5 });
        assert.ok(hintOutput.includes('emoji-id="444444"'));
        assert.ok(hintOutput.includes('emoji-id="888888"'));

        // Test renderServerFiles
        const filesOutput = messages.renderServerFiles({
            rawFiles: [],
            processedFiles: [],
            rawRoot: "/data",
            processedRoot: "/proc",
            humanSize: (n) => `${n}B`,
        });
        assert.ok(filesOutput.includes('emoji-id="666666"'));
    });

    test("5. sitesKeyboard provides interactive remove and pagination buttons", () => {
        const siteCounts = [
            { site: "netflix.com", count: 100 },
            { site: "spotify.com", count: 50 },
        ];
        const kb = messages.sitesKeyboard(siteCounts);
        assert.ok(kb && kb.reply_markup && Array.isArray(kb.reply_markup.inline_keyboard));
        const buttons = kb.reply_markup.inline_keyboard.flat();

        const delNetflix = buttons.find((b) => b.callback_data === "site:del:ask:netflix.com");
        assert.ok(delNetflix, "Should have delete button for netflix.com");

        const manualDelPrompt = buttons.find((b) => b.callback_data === "site:del:prompt");
        assert.ok(manualDelPrompt, "Should have manual remove domain prompt button");
    });

    test("6. Multi-core WorkerPool saturates parallel processing and handles high workloads", async () => {
        const pool = getSharedPool();
        assert.ok(pool.numWorkers >= 4, "Worker pool must utilize multiple CPU threads");

        // Test parallel cleaning across CPU cores
        const rawLines = [];
        for (let i = 0; i < 10000; i++) {
            rawLines.push(`testuser${i}@mail.com:Password123!`);
        }
        const cleanRes = await pool.cleanLinesParallel(rawLines, { keepUrl: false });
        assert.equal(cleanRes.lines.length, 10000);
        assert.equal(cleanRes.stats.kept, 10000);

        // Test parallel searching
        const searchRes = await pool.searchLinesParallel(cleanRes.lines, "testuser999", 5);
        assert.ok(searchRes.total >= 1);
        assert.ok(searchRes.matches.some((m) => m.includes("testuser999")));
    });

    test("7. /removedomain and interactive domain removal in Bot API dispatch", async () => {
        const http = require("http");
        const calls = [];
        const server = http.createServer((req, res) => {
            let body = "";
            req.on("data", (c) => { body += c; });
            req.on("end", () => {
                const method = req.url.split("/").pop();
                const p = JSON.parse(body || "{}");
                calls.push({ method, p });
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 777 }, text: p.text } }));
            });
        });
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        const port = server.address().port;

        try {
            const bot = createBot("123:MOCK_TOKEN", {
                telegram: {
                    telegram: {
                        apiRoot: `http://127.0.0.1:${port}`,
                    },
                },
            });

            const chatId = 777;
            store.clear(chatId);
            store.addLines(chatId, ["john@domain-to-remove.com:secret"], "domain-to-remove.com");
            assert.equal(store.getStats(chatId).size, 1);

            // Dispatch /removedomain domain-to-remove.com
            await bot.handleUpdate({
                update_id: 101,
                message: {
                    message_id: 1,
                    chat: { id: chatId, type: "private" },
                    from: { id: chatId, is_bot: false, first_name: "Test" },
                    text: "/removedomain domain-to-remove.com",
                    entities: [{ type: "bot_command", offset: 0, length: 13 }],
                },
            });

            assert.equal(store.getStats(chatId).size, 0, "Domain should be purged via /removedomain");
            const reply = calls.find((c) => c.method === "sendMessage" && c.p.text && c.p.text.includes("DOMAIN PURGED"));
            assert.ok(reply, "Should respond with DOMAIN PURGED message");
        } finally {
            server.close();
        }
    });

    test("8. sendCombined and ulpKeyboard provide seamless Get Combined File during active ULP search", async () => {
        const { sendCombined } = require("../src/bot");
        const searchbot = require("../src/searchbot");
        const store = require("../src/store");
        const messages = require("../src/messages");

        // 1. Check ulpKeyboard has combine button in all states
        const runningKb = messages.ulpKeyboard("running");
        const runningBtns = runningKb.reply_markup.inline_keyboard.flat();
        assert.ok(runningBtns.some((b) => b.callback_data === "combine" && /Combine/i.test(b.text)));

        const doneKb = messages.ulpKeyboard("done");
        const doneBtns = doneKb.reply_markup.inline_keyboard.flat();
        assert.ok(doneBtns.some((b) => b.callback_data === "combine" && /Combine/i.test(b.text)));

        // 2. sendCombined while ULP search is running but 0 lines yet
        const chatId = 99991;
        store.clear(chatId);
        searchbot.startRun(chatId, { query: "targetsite.com", scope: "day" });

        const replies = [];
        const mockCtxSearchingEmpty = {
            chat: { id: chatId },
            reply: async (text, extra) => {
                replies.push({ text, extra });
            },
        };

        await sendCombined(mockCtxSearchingEmpty, true);
        assert.ok(replies.some((r) => r.text && r.text.includes("ULP SEARCH IN PROGRESS") && r.text.includes("targetsite.com")));

        // 3. sendCombined while ULP search is running and lines have arrived
        store.addLines(chatId, ["alice@targetsite.com:secret123", "bob@targetsite.com:pass456"], "targetsite.com");
        const docSends = [];
        const mockCtxSearchingWithLines = {
            chat: { id: chatId },
            replyWithDocument: async (payload, extra) => {
                docSends.push({ payload, extra });
            },
        };

        await sendCombined(mockCtxSearchingWithLines, true);
        assert.equal(docSends.length, 1, "Should deliver document while search is running");
        assert.ok(docSends[0].extra.caption.includes("ULP search is actively running"), "Caption notes active search");
        assert.equal(store.getLines(chatId).length, 2, "Batch is retained while search continues");

        searchbot.finishRun(chatId, "done");
        store.clear(chatId);
    });

    test("9. serverFilesKeyboard and renderServerFiles provide modular tabbed server vault architecture", () => {
        const messages = require("../src/messages");

        const rawFiles = [
            { name: "dump1.zip", size: 5000000, mtime: new Date() },
            { name: "dump2.txt", size: 2000000, mtime: new Date() },
        ];
        const processedFiles = [
            { name: "output1_combined.txt", size: 1500000, mtime: new Date() },
        ];

        // Overview tab
        const overviewText = messages.renderServerFiles({
            rawFiles,
            processedFiles,
            rawRoot: "/var/data",
            processedRoot: "/var/data/processed",
            humanSize: (n) => `${n} B`,
            tab: "overview",
        });
        assert.match(overviewText, /SERVER STORAGE/);
        assert.match(overviewText, /VAULT/);
        assert.match(overviewText, /dump1\.zip/);
        assert.match(overviewText, /output1_combined\.txt/);

        const overviewKb = messages.serverFilesKeyboard(rawFiles, processedFiles, { tab: "overview" });
        const overviewBtns = overviewKb.reply_markup.inline_keyboard.flat();
        assert.ok(overviewBtns.some((b) => b.callback_data === "files:tab:raw"));
        assert.ok(overviewBtns.some((b) => b.callback_data === "files:tab:proc"));
        assert.ok(overviewBtns.some((b) => b.callback_data === "combine"));

        // Raw tab
        const rawText = messages.renderServerFiles({
            rawFiles,
            processedFiles,
            rawRoot: "/var/data",
            processedRoot: "/var/data/processed",
            humanSize: (n) => `${n} B`,
            tab: "raw",
        });
        assert.match(rawText, /RAW INCOMING DUMPS BROWSER/);

        const rawKb = messages.serverFilesKeyboard(rawFiles, processedFiles, { tab: "raw" });
        const rawBtns = rawKb.reply_markup.inline_keyboard.flat();
        assert.ok(rawBtns.some((b) => b.callback_data === "file:clean:0"));
        assert.ok(!rawBtns.some((b) => b.callback_data === "file:search:0"));
        assert.ok(rawBtns.some((b) => b.callback_data === "file:del:raw:ask:0"));
        assert.ok(rawBtns.some((b) => b.callback_data === "files:wipe:raw:ask"));

        const rawKbWithSearch = messages.serverFilesKeyboard(rawFiles, processedFiles, { tab: "raw", includeSearch: true });
        assert.ok(rawKbWithSearch.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === "file:search:0"));

        // Proc tab
        const procText = messages.renderServerFiles({
            rawFiles,
            processedFiles,
            rawRoot: "/var/data",
            processedRoot: "/var/data/processed",
            humanSize: (n) => `${n} B`,
            tab: "proc",
        });
        assert.match(procText, /CLEANED OUTPUTS VAULT/);

        const procKb = messages.serverFilesKeyboard(rawFiles, processedFiles, { tab: "proc" });
        const procBtns = procKb.reply_markup.inline_keyboard.flat();
        assert.ok(procBtns.some((b) => b.callback_data === "file:dl:proc:0"));
        assert.ok(!procBtns.some((b) => b.callback_data === "file:search:proc:0"));
        assert.ok(procBtns.some((b) => b.callback_data === "file:del:proc:ask:0"));
        assert.ok(procBtns.some((b) => b.callback_data === "files:wipe:proc:ask"));

        const procKbWithSearch = messages.serverFilesKeyboard(rawFiles, processedFiles, { tab: "proc", includeSearch: true });
        assert.ok(procKbWithSearch.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === "file:search:proc:0"));

        // Tools tab
        const toolsText = messages.renderServerFiles({
            rawFiles,
            processedFiles,
            rawRoot: "/var/data",
            processedRoot: "/var/data/processed",
            humanSize: (n) => `${n} B`,
            tab: "tools",
        });
        assert.match(toolsText, /STORAGE/);
        assert.match(toolsText, /PURGE MANAGER/);

        const toolsKb = messages.serverFilesKeyboard(rawFiles, processedFiles, { tab: "tools" });
        const toolsBtns = toolsKb.reply_markup.inline_keyboard.flat();
        assert.ok(toolsBtns.some((b) => b.callback_data === "files:wipe:all:ask"));
    });

    test("10. Animated emojis by default and animated emojis on keyboard buttons", () => {
        const messages = require("../src/messages");
        const bot = require("../src/bot");

        // Real custom IDs only after explicit register/sync (fake sequential IDs trip DOCUMENT_INVALID).
        messages.clearCustomEmojis();
        messages.registerCustomEmojis({
            "🚀": "5368324170671202287",
            rocket: "5368324170671202287",
            "💎": "5368324170671202286",
            diamond: "5368324170671202286",
            "🧼": "5371077759080598812",
            soap: "5371077759080598812",
            "📂": "5371077759080598835",
            folder: "5371077759080598835",
        });
        if (typeof messages.setAnimatedEmojisEnabled === "function") {
            messages.setAnimatedEmojisEnabled(true);
        }
        const rocketHtml = messages.tgEmoji("🚀");
        assert.ok(rocketHtml.includes("<tg-emoji"), "🚀 should render with <tg-emoji> after register");
        assert.ok(rocketHtml.includes('emoji-id="5368324170671202287"'), "🚀 should have registered document ID");

        const diamondHtml = messages.tgEmoji("💎");
        assert.ok(diamondHtml.includes("<tg-emoji"), "💎 should render with <tg-emoji> after register");
        assert.ok(diamondHtml.includes('emoji-id="5368324170671202286"'), "💎 should have registered document ID");

        const soapHtml = messages.tgEmoji("🧼");
        assert.ok(soapHtml.includes("<tg-emoji"), "🧼 should render with <tg-emoji> after register");

        // Keyboard buttons attach icon_custom_emoji_id when registry has a matching ID
        const mainKb = messages.mainKeyboard();
        const mainBtns = mainKb.reply_markup.inline_keyboard.flat();

        const btnUlp = mainBtns.find((b) => b.callback_data === "ulp:menu");
        assert.ok(btnUlp, "ULP button exists");
        assert.equal(btnUlp.icon_custom_emoji_id, "5368324170671202287", "🚀 button has rocket custom emoji id");

        const btnVault = mainBtns.find((b) => b.callback_data === "server_files");
        assert.ok(btnVault, "Vault button exists");
        assert.equal(btnVault.icon_custom_emoji_id, "5371077759080598835", "📂 button has folder custom emoji id");

        // Empty registry → no icon ids (plain unicode labels only)
        messages.clearCustomEmojis();
        const plainKb = messages.mainKeyboard();
        const plainBtn = plainKb.reply_markup.inline_keyboard.flat().find((b) => b.callback_data === "ulp:menu");
        assert.ok(plainBtn);
        assert.equal(plainBtn.icon_custom_emoji_id, undefined, "no icon id without registry");

        // ulp keyboard still has Stop even with plain labels
        const ulpKb = messages.ulpKeyboard("running");
        const ulpBtns = ulpKb.reply_markup.inline_keyboard.flat();
        const stopBtn = ulpBtns.find((b) => b.callback_data === "ulp:stop");
        assert.ok(stopBtn, "Stop button exists");

        // 5. Verify stripButtonEmojis fallback functionality
        const extraWithEmojis = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "🚀 Test", callback_data: "test", icon_custom_emoji_id: "12345" },
                        { text: "Plain", callback_data: "plain" },
                    ],
                ],
            },
        };
        const stripped = bot.stripButtonEmojis(extraWithEmojis);
        assert.strictEqual(stripped.reply_markup.inline_keyboard[0][0].icon_custom_emoji_id, undefined, "icon_custom_emoji_id should be stripped");
        assert.equal(stripped.reply_markup.inline_keyboard[0][0].text, "🚀 Test", "Text should be preserved");
        assert.equal(stripped.reply_markup.inline_keyboard[0][0].callback_data, "test", "Callback data should be preserved");
    });

    test("11. safeReply and safeSendDocument recover gracefully from 400: Bad Request: DOCUMENT_INVALID and auto-strip custom emojis", async () => {
        const bot = require("../src/bot");
        bot.setBotApiCustomEmojiRejected(false);

        const recoveryReplied = [];
        const mockSafeCtx = {
            chat: { id: 123456 },
            reply: async (text, extra) => {
                recoveryReplied.push({ text, extra });
                if (text.includes("<tg-emoji") || (extra && extra.reply_markup && extra.reply_markup.inline_keyboard[0][0].icon_custom_emoji_id)) {
                    throw new Error("400: Bad Request: DOCUMENT_INVALID");
                }
                return { message_id: 999 };
            },
            replyWithDocument: async (payload, extra) => {
                if ((extra && extra.caption && extra.caption.includes("<tg-emoji")) || (extra && extra.reply_markup && extra.reply_markup.inline_keyboard[0][0].icon_custom_emoji_id)) {
                    throw new Error("400: Bad Request: DOCUMENT_INVALID");
                }
                return { message_id: 1000, document: payload };
            },
        };

        const originalText = '⚡️ <tg-emoji emoji-id="5370779774618703759">⚡️</tg-emoji> Hello World';
        const originalExtra = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🚀 Start", callback_data: "start", icon_custom_emoji_id: "5368324170671202287" }],
                ],
            },
        };

        // Staged recovery: try animated → strip button icons → plain unicode. No process-wide kill switch.
        const result = await bot.safeReply(mockSafeCtx, originalText, originalExtra);
        assert.ok(result, "safeReply should return the delivered message object");
        assert.equal(result.message_id, 999);
        assert.ok(recoveryReplied.length >= 2, "Should attempt with emojis then fallback");
        const last = recoveryReplied[recoveryReplied.length - 1];
        assert.ok(!last.text.includes("<tg-emoji"), "Final text should not include tg-emoji tags");
        assert.strictEqual(
            last.extra.reply_markup.inline_keyboard[0][0].icon_custom_emoji_id,
            undefined,
            "Fallback button should have icon_custom_emoji_id stripped",
        );

        // Subsequent call still works (no permanent kill)
        const secondResult = await bot.safeReply(mockSafeCtx, "Hello plain", { reply_markup: { inline_keyboard: [[{ text: "OK", callback_data: "ok" }]] } });
        assert.ok(secondResult);

        // Test safeSendDocument recovery
        bot.setBotApiCustomEmojiRejected(false);
        const docResult = await bot.safeSendDocument(
            mockSafeCtx,
            123456,
            { source: Buffer.from("test"), filename: "test.txt" },
            {
                caption: '🎁 <tg-emoji emoji-id="123">🎁</tg-emoji> File',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "📥 Download", callback_data: "dl", icon_custom_emoji_id: "456" }],
                    ],
                },
            }
        );
        assert.ok(docResult, "safeSendDocument should recover and deliver file");
        // Process-wide kill switch is intentionally NOT set — recovery is per-send.
        assert.ok(docResult, "safeSendDocument recovers without global kill");
    });

    test("12. Cyber-ops modern UI overhaul and unnamed document protection", () => {
        // 1. Check UI templates for streamlined dashboard styling
        const helpText = messages.renderHelp("ComboBot");
        assert.match(helpText, /<b>COMBO CLEANER<\/b>/);
        assert.match(helpText, /────────────────────────────/);
        assert.match(helpText, /What you can do/);
        assert.match(helpText, /ULP Search/);

        const statsText = messages.renderStats({ size: 1000, files: 5, totalKept: 1200, sites: 3 });
        assert.match(statsText, /BATCH METRICS DASHBOARD/);
        assert.match(statsText, /────────────────────────────/);
        assert.match(statsText, /Unique Credentials/);
        assert.match(statsText, /Storage Capacity/);

        const ulpProg = messages.renderUlpProgress({
            searcherBot: "DumpNews14Bot",
            attempt: 2,
            maxTries: 5,
            sends: 2,
            stepDelayMs: 12000,
        });
        assert.match(ulpProg, /<b>ULP SEARCH IN PROGRESS<\/b>/);
        assert.match(ulpProg, /\[Day 2\/5\]/);
        assert.match(ulpProg, /40%/);
        assert.ok(ulpProg.includes("Progress:"));

        const gaugeRes = messages.renderGauge(2, 5, 12);
        assert.equal(gaugeRes.pct, 40);
        assert.equal(gaugeRes.gauge, "▰▰▰▰▰▱▱▱▱▱▱▱");

        const kbWithProg = messages.ulpKeyboard("running", { attempt: 2, maxTries: 5 });
        const kbBtns = kbWithProg.reply_markup.inline_keyboard.flat();
        assert.ok(kbBtns.some(b => b.callback_data === "ulp:status_bar" && b.text.includes("40%")));

        const keyboard = messages.mainKeyboard();
        const buttons = keyboard.reply_markup.inline_keyboard.flat().map(b => b.text);
        assert.ok(buttons.some(b => b.includes("ULP")));
        assert.ok(buttons.some(b => b.includes("Vault")));
        assert.ok(buttons.some(b => /Combine/i.test(b)));

        // 2. Check unnamed document sanitization
        const userbotMod = require("../src/userbot");
        assert.equal(userbotMod.safeDownloadName(""), "telegram-file.bin");
        assert.equal(userbotMod.safeDownloadName("../../evil:name?.txt"), "evil_name_.txt");
        assert.equal(userbotMod.safeDownloadName("clean_dump.txt"), "clean_dump.txt");
    });
});



