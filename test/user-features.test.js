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
        assert.ok(runningBtns.some((b) => b.callback_data === "combine" && b.text.includes("Combined")));

        const doneKb = messages.ulpKeyboard("done");
        const doneBtns = doneKb.reply_markup.inline_keyboard.flat();
        assert.ok(doneBtns.some((b) => b.callback_data === "combine" && b.text.includes("Combined")));

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
        assert.match(overviewText, /SERVER STORAGE & FILES VAULT/);
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
        assert.ok(rawBtns.some((b) => b.callback_data === "file:search:0"));
        assert.ok(rawBtns.some((b) => b.callback_data === "file:del:raw:ask:0"));
        assert.ok(rawBtns.some((b) => b.callback_data === "files:wipe:raw:ask"));

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
        assert.ok(procBtns.some((b) => b.callback_data === "file:search:proc:0"));
        assert.ok(procBtns.some((b) => b.callback_data === "file:del:proc:ask:0"));
        assert.ok(procBtns.some((b) => b.callback_data === "files:wipe:proc:ask"));

        // Tools tab
        const toolsText = messages.renderServerFiles({
            rawFiles,
            processedFiles,
            rawRoot: "/var/data",
            processedRoot: "/var/data/processed",
            humanSize: (n) => `${n} B`,
            tab: "tools",
        });
        assert.match(toolsText, /STORAGE & PURGE MANAGER/);

        const toolsKb = messages.serverFilesKeyboard(rawFiles, processedFiles, { tab: "tools" });
        const toolsBtns = toolsKb.reply_markup.inline_keyboard.flat();
        assert.ok(toolsBtns.some((b) => b.callback_data === "files:wipe:all:ask"));
    });
});
