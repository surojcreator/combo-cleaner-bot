"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { WorkerPool, getSharedPool } = require("../src/worker-pool");
const {
    renderHelp,
    renderServerFiles,
    renderSaveGuide,
    renderUlpProgress,
    renderUlpStart,
    renderUlpHint,
    ulpMenuKeyboard,
    ulpEditDomainsKeyboard,
    ulpPromptCancelKeyboard,
    renderUlpMenuText,
    saveGuideKeyboard,
    searchPromptKeyboard,
    serverFilesKeyboard,
    mainKeyboard,
} = require("../src/messages");
const { createBot } = require("../src/bot");
const store = require("../src/store");

test("WorkerPool cleans 12,000 lines in parallel across CPU cores with dedupe", async () => {
    const pool = new WorkerPool(null, 4);
    try {
        const lines = [];
        for (let i = 0; i < 6000; i++) {
            lines.push(`user${i}@gmail.com:Password${i}!`);
        }
        // Add 3000 duplicates
        for (let i = 0; i < 3000; i++) {
            lines.push(`user${i}@gmail.com:Password${i}!`);
        }
        // Add 3000 junk lines
        for (let i = 0; i < 3000; i++) {
            lines.push(`https://example.com/login-page-with-no-creds`);
        }

        const res = await pool.cleanLinesParallel(lines, { keepUrl: false, dedupe: true });
        assert.equal(res.stats.total, 12000);
        assert.equal(res.stats.kept, 6000);
        assert.equal(res.stats.duplicates, 3000);
        assert.equal(res.stats.dropped, 3000);
        assert.equal(res.lines.length, 6000);
        assert.equal(res.lines[0], "user0@gmail.com:Password0!");
    } finally {
        pool.close();
    }
});

test("WorkerPool searches 12,000 lines in parallel across CPU cores", async () => {
    const pool = new WorkerPool(null, 4);
    try {
        const lines = [];
        for (let i = 0; i < 10000; i++) {
            lines.push(`user${i}@yahoo.com:pass${i}`);
        }
        // Add specific search hits
        for (let i = 0; i < 25; i++) {
            lines.push(`special_user_${i}@targetbrand.com:SecretPass${i}`);
        }

        const res = await pool.searchLinesParallel(lines, "targetbrand.com");
        assert.equal(res.total, 25);
        assert.equal(res.matches.length, 25);
        assert.match(res.matches[0], /special_user_0@targetbrand\.com/);

        // Test with custom limit
        const limitedRes = await pool.searchLinesParallel(lines, "targetbrand.com", 10);
        assert.equal(limitedRes.total, 25);
        assert.equal(limitedRes.matches.length, 10);
    } finally {
        pool.close();
    }
});

test("WorkerPool searches large files on disk in parallel across CPU slices with exact line boundaries", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-slice-test-"));
    const tmpFile = path.join(tmpDir, "large-disk-dump.txt");
    const ws = fs.createWriteStream(tmpFile);

    // Create 40,000 lines (~1.5 MB) so it splits into multiple slices
    for (let i = 0; i < 40000; i++) {
        if (i % 200 === 0) {
            ws.write(`target_admin_${i}@cryptoexchange.com:UltraSecret${i}\n`);
        } else {
            ws.write(`user_${i}@freemail.org:SomePassword${i}\n`);
        }
    }
    await new Promise((r) => ws.end(r));

    const pool = new WorkerPool(null, 4);
    try {
        const res = await pool.searchFileParallel(tmpFile, "cryptoexchange.com", 20);
        assert.equal(res.total, 200, "expected exactly 200 matches with zero duplicates or lost lines");
        assert.equal(res.matches.length, 20);
        assert.match(res.matches[0], /target_admin_0@cryptoexchange\.com/);

        // Test with a higher limit
        const allRes = await pool.searchFileParallel(tmpFile, "cryptoexchange.com", 500);
        assert.equal(allRes.total, 200);
        assert.equal(allRes.matches.length, 200);

        // Test small file fast path
        const smallFile = path.join(tmpDir, "small.txt");
        fs.writeFileSync(smallFile, "admin@small.org:p1\nuser@small.org:p2\n");
        const smallRes = await pool.searchFileParallel(smallFile, "small.org");
        assert.equal(smallRes.total, 2);
        assert.equal(smallRes.matches.length, 2);
    } finally {
        pool.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});


test("renderHelp and keyboards display animated emojis and button dashboard", () => {
    const help = renderHelp("TestCleanerBot", { size: 12500, files: 3 }, "DumpNews14Bot");
    assert.match(help, /COMBO CLEANER ULTIMATE/);
    assert.match(help, /Multi-Core Workers:/);
    assert.match(help, /Parallel CPU Cores Active/);
    assert.match(help, /INTERACTIVE ACTION DASHBOARD/);

    const main = mainKeyboard();
    const mainBtns = main.reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.ok(mainBtns.some((t) => t.includes("Run ULP Search")));
    assert.ok(mainBtns.some((t) => t.includes("Server Vault")));
    assert.ok(mainBtns.some((t) => t.includes("Fast /save Guide")));

    const ulpMenu = ulpMenuKeyboard();
    const ulpBtns = ulpMenu.reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.ok(!ulpBtns.some((t) => t.includes("Netflix")), "expected no default Netflix button");
    assert.ok(!ulpBtns.some((t) => t.includes("Spotify")), "expected no default Spotify button");
    assert.ok(ulpBtns.some((t) => t.includes("Enter Custom Domain")), "expected enter custom domain button");
    assert.ok(ulpBtns.some((t) => t.includes("Add Domain")), "expected add domain button");

    const saveGuide = renderSaveGuide();
    assert.match(saveGuide, /FAST SERVER SAVE GUIDE/);
    assert.match(saveGuide, /\/save/);

    const serverFiles = renderServerFiles({
        rawFiles: [
            { name: "test-dump.zip", size: 50000000, mtime: new Date() },
        ],
        processedFiles: [],
        rawRoot: "/var/data",
        processedRoot: "/var/data/processed",
        humanSize: (n) => `${n} bytes`,
    });
    assert.match(serverFiles, /\[1\]/);
    assert.match(serverFiles, /test-dump\.zip/);
    assert.match(serverFiles, /Tap any button below to Clean, Search, or Download files directly/);
});

test("renderUlpProgress, renderUlpStart, and renderUlpHint format days and steps cleanly without NaN", () => {
    // Array sends in renderUlpProgress
    const arrayProgress = renderUlpProgress({
        searcherBot: "DumpNews14Bot",
        attempt: 2,
        maxTries: 7,
        sends: ["20.09.2026: Opening folder", "hist:20.09.2026"],
        stepDelayMs: 12000,
    });
    assert.match(arrayProgress, /SEARCH IN PROGRESS/);
    assert.match(arrayProgress, /2\/7/);
    assert.match(arrayProgress, /20\.09\.2026: Opening folder · hist:20\.09\.2026/);
    assert.ok(!arrayProgress.includes("NaN"), "expected no NaN in progress card");

    // Number sends in renderUlpProgress
    const numProgress = renderUlpProgress({
        searcherBot: "DumpNews14Bot",
        attempt: 1,
        maxTries: 5,
        sends: 3,
        stepDelayMs: 7000,
    });
    assert.match(numProgress, /3 step\(s\) sent/);
    assert.ok(!numProgress.includes("NaN"));

    // renderUlpStart with daysCount and startDate
    const startCard = renderUlpStart({
        query: "netflix.com",
        scope: "day",
        searcherBot: "DumpNews14Bot",
        steps: [{ id: "query", text: "netflix.com" }],
        stepDelayMs: 12000,
        maxTries: 7,
        transport: "userbot",
        daysCount: 14,
        startDate: "20.09.2026",
    });
    assert.match(startCard, /Day-by-Day \(Last 14 days from 20\.09\.2026\)/);
    assert.match(startCard, /netflix\.com/);

    // renderUlpHint with active daysCount
    const hintCard = renderUlpHint({
        searcherBot: "DumpNews14Bot",
        stepDelayMs: 12000,
        maxTries: 5,
        daysCount: 7,
    });
    assert.match(hintCard, /7 days active/);
    assert.match(hintCard, /\/ulp &lt;query&gt; \[days\] \[start_date\]/);

    // ulpMenuKeyboard active checkmark for 7 days
    const menu7 = ulpMenuKeyboard(7);
    const btns7 = menu7.reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.ok(btns7.includes("📅 7d ✅"), "expected checkmark on 7d");
    assert.ok(btns7.includes("📅 1 Day"), "expected other days buttons without checkmark");

    // ulpMenuKeyboard active checkmark for 14 days
    const menu14 = ulpMenuKeyboard(14);
    const btns14 = menu14.reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.ok(btns14.includes("📅 14d ✅"), "expected checkmark on 14d");

    // ulpMenuKeyboard with custom domains and custom action buttons
    const menuCustom = ulpMenuKeyboard(5, ["targetsite.com", "cryptoapp.io"]);
    const customBtns = menuCustom.reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.ok(customBtns.includes("🌐 targetsite.com"), "expected custom target button");
    assert.ok(customBtns.includes("🌐 cryptoapp.io"), "expected second custom target button");
    assert.ok(customBtns.includes("🌐 Enter Custom Domain"), "expected enter custom domain action button");
    assert.ok(customBtns.includes("➕ Add Domain"), "expected add domain button");
    assert.ok(customBtns.some((t) => t.includes("✏️ Edit Domains")), "expected edit domains button");
    assert.ok(customBtns.some((t) => t.includes("📅 Custom Days")), "expected custom days prompt button");

    // ulpEditDomainsKeyboard
    const editMenu = ulpEditDomainsKeyboard(["targetsite.com"]);
    const editBtns = editMenu.reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.ok(editBtns.includes("🌐 targetsite.com"));
    assert.ok(editBtns.includes("❌ Delete"));
    assert.ok(editBtns.includes("➕ Add Custom Domain"));
    assert.ok(editBtns.includes("🔙 Back to ULP Menu"));

    // ulpPromptCancelKeyboard
    const cancelMenu = ulpPromptCancelKeyboard();
    const cancelBtns = cancelMenu.reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.ok(cancelBtns.includes("❌ Cancel"));
    assert.ok(cancelBtns.includes("🔙 ULP Menu"));

    // renderUlpMenuText
    const menuText = renderUlpMenuText("DumpNews14Bot", 10, 2);
    assert.match(menuText, /SELECT ULP SEARCH TARGET/);
    assert.match(menuText, /Search Duration: <b>10 Day\(s\)<\/b>/);
    assert.match(menuText, /Custom Targets: <b>2 saved<\/b>/);
});

test("store manages custom ULP domains and search days per chat", () => {
    const testChat = 987654321;
    store.clearCustomDomains(testChat);
    assert.deepEqual(store.getCustomDomains(testChat), []);
    assert.equal(store.getUlpDays(testChat), 5);

    // Add domains
    assert.equal(store.addCustomDomain(testChat, "https://Shopify.com/login"), true);
    assert.equal(store.addCustomDomain(testChat, "portal.gov"), true);
    assert.deepEqual(store.getCustomDomains(testChat), ["https://shopify.com/login", "portal.gov"]);

    // Remove domain
    assert.equal(store.removeCustomDomain(testChat, "https://shopify.com/login"), true);
    assert.deepEqual(store.getCustomDomains(testChat), ["portal.gov"]);

    // Set custom days
    assert.equal(store.setUlpDays(testChat, 21), 21);
    assert.equal(store.getUlpDays(testChat), 21);

    // Clear custom domains
    store.clearCustomDomains(testChat);
    assert.deepEqual(store.getCustomDomains(testChat), []);
});

async function startFakeApi() {
    const calls = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            const method = String(req.url || "").split("/").pop();
            let payload = {};
            try {
                payload = JSON.parse(body || "{}");
            } catch {
                payload = {};
            }
            if (body && body.includes('name="chat_id"')) {
                const match = body.match(/name="chat_id"\r?\n\r?\n([^\r\n]+)/);
                if (match) payload.chat_id = isNaN(match[1]) ? match[1].trim() : Number(match[1].trim());
            }
            if (body && body.includes('name="caption"')) {
                const match = body.match(/name="caption"\r?\n\r?\n([^\r\n]+)/);
                if (match) payload.caption = match[1].trim();
            }
            calls.push({ method, payload, body });
            const now = Math.floor(Date.now() / 1000);
            const chat = { id: payload.chat_id, type: "private" };
            const reply = (json) => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(json));
            };
            if (method === "getMe") {
                reply({ ok: true, result: { id: 1, is_bot: true, username: "ulpsorter69bot" } });
            } else if (method === "sendMessage") {
                reply({ ok: true, result: { message_id: calls.length, date: now, chat, text: payload.text } });
            } else if (method === "editMessageText") {
                reply({ ok: true, result: { message_id: payload.message_id, date: now, chat, text: payload.text } });
            } else if (method === "answerCallbackQuery") {
                reply({ ok: true, result: true });
            } else {
                reply({ ok: true, result: true });
            }
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    return {
        apiRoot: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

test("bot handles interactive button callbacks: ulp:menu, help:save, batch:search:prompt", async () => {
    const api = await startFakeApi();
    try {
        const bot = createBot("123456:fake-token", {
            botUsername: "TestBot",
            telegram: { telegram: { apiRoot: api.apiRoot } },
        });

        const callbackUpdate = (data) => ({
            update_id: Date.now(),
            callback_query: {
                id: "cb_1",
                from: { id: 999, is_bot: false, first_name: "Test" },
                message: {
                    message_id: 10,
                    chat: { id: 999, type: "private" },
                    text: "Original Menu",
                },
                data,
            },
        });

        // Test ulp:menu callback
        await bot.handleUpdate(callbackUpdate("ulp:menu"));
        const ulpEdit = api.calls.find((c) => c.method === "editMessageText" && c.payload.text.includes("SELECT ULP SEARCH TARGET"));
        assert.ok(ulpEdit, "expected editMessageText with ULP search target menu");

        // Test help:save callback
        await bot.handleUpdate(callbackUpdate("help:save"));
        const saveEdit = api.calls.find((c) => c.method === "editMessageText" && c.payload.text.includes("FAST SERVER SAVE GUIDE"));
        assert.ok(saveEdit, "expected editMessageText with save guide");

        // Test batch:search:prompt callback
        await bot.handleUpdate(callbackUpdate("batch:search:prompt"));
        const searchEdit = api.calls.find((c) => c.method === "editMessageText" && c.payload.text.includes("QUICK BATCH SEARCH"));
        assert.ok(searchEdit, "expected editMessageText with quick batch search prompt");
    } finally {
        await api.close();
    }
});

test("bot handles ULP custom domains and days editing workflow", async () => {
    const api = await startFakeApi();
    const testChatId = 123999;
    try {
        const bot = createBot("123456:fake-token", {
            botUsername: "TestBot",
            telegram: { telegram: { apiRoot: api.apiRoot } },
            search: { botUsername: "DumpNews14Bot", stepDelayMs: 10, maxTries: 1 },
        });

        const callbackUpdate = (data) => ({
            update_id: Date.now(),
            callback_query: {
                id: "cb_ulp_" + Date.now(),
                from: { id: testChatId, is_bot: false, first_name: "TestUser" },
                message: {
                    message_id: 100,
                    chat: { id: testChatId, type: "private" },
                    text: "Current Menu",
                },
                data,
            },
        });

        const messageUpdate = (text) => ({
            update_id: Date.now(),
            message: {
                message_id: 200,
                from: { id: testChatId, is_bot: false, first_name: "TestUser" },
                chat: { id: testChatId, type: "private" },
                date: Math.floor(Date.now() / 1000),
                text,
            },
        });

        // 1. Trigger custom days prompt
        await bot.handleUpdate(callbackUpdate("ulp:custom:days_prompt"));
        const daysPrompt = api.calls.find((c) => c.method === "editMessageText" && c.payload.text && c.payload.text.includes("EDIT SEARCH DURATION (DAYS)"));
        assert.ok(daysPrompt, "expected days prompt message");

        // Send invalid days -> should reject with error
        await bot.handleUpdate(messageUpdate("abc"));
        const invalidDays = api.calls.find((c) => c.method === "sendMessage" && c.payload.text && c.payload.text.includes("between 1 and 90"));
        assert.ok(invalidDays, "expected rejection of invalid days");

        // Send valid days -> should set to 15 days
        await bot.handleUpdate(messageUpdate("15"));
        const validDays = api.calls.find((c) => c.method === "sendMessage" && c.payload.text && c.payload.text.includes("15 Day(s)"));
        assert.ok(validDays, "expected duration updated message");
        assert.equal(store.getUlpDays(testChatId), 15);

        // 2. Trigger add custom domain preset prompt
        await bot.handleUpdate(callbackUpdate("ulp:custom:add:prompt"));
        const addPrompt = api.calls.find((c) => c.method === "editMessageText" && c.payload.text && c.payload.text.includes("ADD CUSTOM DOMAIN PRESET"));
        assert.ok(addPrompt, "expected add domain prompt message");

        // Send custom domain "https://mycustomforum.com/login"
        await bot.handleUpdate(messageUpdate("https://mycustomforum.com/login"));
        const addedMsg = api.calls.find((c) => c.method === "sendMessage" && c.payload.text && c.payload.text.includes("Added"));
        assert.ok(addedMsg, "expected domain added confirmation message");
        assert.ok(store.getCustomDomains(testChatId).includes("mycustomforum.com"), "expected normalized domain stored");

        // 3. Edit custom domains menu
        await bot.handleUpdate(callbackUpdate("ulp:custom:edit"));
        const editMenu = api.calls.find((c) => c.method === "editMessageText" && c.payload.text && c.payload.text.includes("MANAGE CUSTOM DOMAINS"));
        assert.ok(editMenu, "expected edit custom domains card");

        // 4. Delete custom domain
        await bot.handleUpdate(callbackUpdate("ulp:custom:del:mycustomforum.com"));
        assert.equal(store.getCustomDomains(testChatId).includes("mycustomforum.com"), false, "expected domain deleted from custom domains");

        // 5. Enter custom domain on the fly prompt
        await bot.handleUpdate(callbackUpdate("ulp:custom:prompt"));
        const searchPrompt = api.calls.find((c) => c.method === "editMessageText" && c.payload.text && c.payload.text.includes("ENTER CUSTOM DOMAIN TO SEARCH"));
        assert.ok(searchPrompt, "expected search custom domain prompt");

        // Cancel prompt
        await bot.handleUpdate(callbackUpdate("ulp:custom:cancel"));
        const cancelEdit = api.calls.find((c) => c.method === "editMessageText" && c.payload.text && c.payload.text.includes("SELECT ULP SEARCH TARGET"));
        assert.ok(cancelEdit, "expected cancellation to return to ULP menu");

        // 6. Enter custom domain on the fly and verify it is automatically saved
        await bot.handleUpdate(callbackUpdate("ulp:custom:prompt"));
        await bot.handleUpdate(messageUpdate("autosaved-target.com"));
        assert.ok(store.getCustomDomains(testChatId).includes("autosaved-target.com"), "expected domain entered to search to be automatically saved to custom domains");
        const menuWithAutoSaved = ulpMenuKeyboard(5, store.getCustomDomains(testChatId));
        assert.ok(menuWithAutoSaved.reply_markup.inline_keyboard.flat().some((b) => b.text.includes("autosaved-target.com")));
    } finally {
        store.clearCustomDomains(testChatId);
        await api.close();
    }
});

test("formatFileDate formats valid dates and handles invalid inputs gracefully", () => {
    const { formatFileDate } = require("../src/messages");
    const d = new Date(2026, 8, 20, 14, 35);
    assert.equal(formatFileDate(d), "2026-09-20 14:35");
    assert.equal(formatFileDate(null), "Recent");
    assert.equal(formatFileDate(new Date("invalid")), "Recent");
});

test("serverFilesKeyboard generates organized buttons for both raw files and processed outputs", () => {
    const raw = [
        { name: "raw1.zip", size: 1000, mtime: new Date() },
        { name: "raw2.txt", size: 2000, mtime: new Date() },
    ];
    const proc = [
        { name: "cleaned1.txt", size: 500, mtime: new Date() },
    ];
    const kb = serverFilesKeyboard(raw, proc);
    const btns = kb.reply_markup.inline_keyboard.flat();
    assert.ok(btns.some((b) => b.text.includes("Clean Raw #1")));
    assert.ok(!btns.some((b) => b.text.includes("Search Raw #1")));
    assert.ok(btns.some((b) => b.text.includes("Del #1") && b.callback_data === "file:del:raw:ask:0"));
    assert.ok(btns.some((b) => b.text.includes("Clean All Raw (2)")));
    assert.ok(btns.some((b) => b.text.includes("Wipe All Raw")));
    assert.ok(btns.some((b) => b.text.includes("Download Output #1") && b.callback_data === "file:dl:proc:0"));
    assert.ok(!btns.some((b) => b.text.includes("Search Output #1") && b.callback_data === "file:search:proc:0"));
    assert.ok(btns.some((b) => b.text.includes("Del #1") && b.callback_data === "file:del:proc:ask:0"));
    assert.ok(btns.some((b) => b.text.includes("Wipe All Outputs")));
    assert.ok(btns.some((b) => b.text.includes("Purge All") && b.callback_data === "files:wipe:all:ask"));
});

test("parseUlpArg handles object fallbackScope gracefully and prevents object scope", () => {
    const { parseUlpArg } = require("../src/bot");
    const optionsObj = { botUsername: "DumpNews14Bot", defaultScope: "day" };
    const resEmpty = parseUlpArg("", optionsObj);
    assert.equal(typeof resEmpty.scope, "string");
    assert.equal(resEmpty.scope, "day");
    assert.equal(resEmpty.query, null);

    const resQuery = parseUlpArg("target.com", optionsObj);
    assert.equal(resQuery.query, "target.com");
    assert.equal(resQuery.scope, "day");
});

test("deliverCombinedAndResetBatch executes once per run and prevents duplicate empty messages", async () => {
    const api = await startFakeApi();
    const searchbot = require("../src/searchbot");
    const { deliverCombinedAndResetBatch, createBot } = require("../src/bot");
    try {
        const bot = createBot("123456:fake-token", {
            botUsername: "TestBot",
            telegram: { telegram: { apiRoot: api.apiRoot } },
        });
        const testChatId = 88888;
        searchbot.startRun(testChatId, { query: "emptyquery.com", scope: "day" });

        const ctx = {
            chat: { id: testChatId },
            reply: async (text, extra) => {
                api.calls.push({ method: "sendMessage", payload: { chat_id: testChatId, text, ...extra } });
            },
        };

        // First call: should deliver the "Search completed, but no credentials were found" message
        await deliverCombinedAndResetBatch(ctx);
        const firstCount = api.calls.filter((c) => c.method === "sendMessage" && c.payload.text.includes("no credentials were found")).length;
        assert.equal(firstCount, 1, "expected exactly 1 empty completion message");

        // Second call on the same run: should be skipped!
        await deliverCombinedAndResetBatch(ctx);
        const secondCount = api.calls.filter((c) => c.method === "sendMessage" && c.payload.text.includes("no credentials were found")).length;
        assert.equal(secondCount, 1, "expected no duplicate empty completion message");
    } finally {
        await api.close();
    }
});

test("batchsave command finds multiple documents, downloads and cleans them in batch", async () => {
    const api = await startFakeApi();
    const store = require("../src/store");
    const { createBot } = require("../src/bot");
    const testChatId = 77777;
    store.clear(testChatId);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "batchsave-test-"));
    const file1 = path.join(tmpDir, "dump1.txt");
    const file2 = path.join(tmpDir, "dump2.txt");
    fs.writeFileSync(file1, "user1@domain.com:pass1\nuser2@domain.com:pass2\n");
    fs.writeFileSync(file2, "user3@domain.com:pass3\nuser4@domain.com:pass4\n");

    try {
        const mockUserbot = {
            isReady: () => true,
            findRecentDocuments: async () => [
                { messageId: 101, fileName: "dump1.txt", size: 40, message: {} },
                { messageId: 102, fileName: "dump2.txt", size: 40, message: {} },
            ],
            downloadMessageToDisk: async (chatId, msgId) => {
                const target = msgId === 101 ? file1 : file2;
                return { path: target, size: 40 };
            },
        };

        const bot = createBot("123456:fake-token", {
            botUsername: "TestBot",
            telegram: { telegram: { apiRoot: api.apiRoot } },
            userbot: mockUserbot,
        });

        await bot.handleUpdate({
            update_id: 1,
            message: {
                message_id: 200,
                date: Math.floor(Date.now() / 1000),
                chat: { id: testChatId, type: "private" },
                from: { id: 999, is_bot: false },
                text: "/batchsave 5",
                entities: [{ offset: 0, length: 10, type: "bot_command" }],
            },
        });

        const lines = store.getLines(testChatId);
        assert.equal(lines.length, 4, "expected 4 cleaned credentials in batch");
        const completeEdit = api.calls.find((c) => c.method === "editMessageText" && c.payload.text && c.payload.text.includes("BATCH SAVE COMPLETE"));
        assert.ok(completeEdit, "expected editMessageText with BATCH SAVE COMPLETE report");
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        store.clear(testChatId);
        await api.close();
    }
});

test("emojis command and emojis:view action render installed account emoji packs", async () => {
    const api = await startFakeApi();
    const { createBot } = require("../src/bot");
    try {
        const mockUserbot = {
            isReady: () => true,
            getInstalledEmojiPacks: async () => ({
                packs: [
                    { title: "Alpha Pack", shortName: "AlphaPack", id: "1001", count: 50, sample: ["😀", "🚀"] },
                    { title: "Omega Pack", shortName: "OmegaPack", id: "1002", count: 80, sample: ["🔥", "💎"] },
                ],
                totalEmojis: 130,
            }),
        };

        const bot = createBot("123456:fake-token", {
            botUsername: "TestBot",
            telegram: { telegram: { apiRoot: api.apiRoot } },
            userbot: mockUserbot,
        });

        // Test command /emojis
        await bot.handleUpdate({
            update_id: 1,
            message: {
                message_id: 201,
                date: Math.floor(Date.now() / 1000),
                chat: { id: 11111, type: "private" },
                from: { id: 999, is_bot: false },
                text: "/emojis",
                entities: [{ offset: 0, length: 7, type: "bot_command" }],
            },
        });

        const emojiMsg = api.calls.find((c) => (c.method === "sendMessage" || c.method === "editMessageText") && c.payload.text && c.payload.text.includes("EMOJI"));
        assert.ok(emojiMsg, "expected reply with bot emoji dashboard");
        assert.ok(emojiMsg.payload.text.includes("Alpha Pack"), "expected Alpha Pack in list");

        // Test callback emojis:view
        await bot.handleUpdate({
            update_id: 2,
            callback_query: {
                id: "cb_emoji",
                from: { id: 999, is_bot: false },
                message: { message_id: 202, chat: { id: 11111, type: "private" }, text: "Old menu" },
                data: "emojis:view",
            },
        });

        const cbEdit = api.calls.find((c) => c.method === "editMessageText" && c.payload.text && c.payload.text.includes("EMOJI"));
        assert.ok(cbEdit, "expected callback editMessageText with bot emoji dashboard");
    } finally {
        await api.close();
    }
});

test("sendCombined falls back to cached last combined file after batch is cleared", async () => {
    const api = await startFakeApi();
    const store = require("../src/store");
    const { createBot } = require("../src/bot");
    const testChatId = 66666;
    store.clear(testChatId);

    try {
        const bot = createBot("123456:fake-token", {
            botUsername: "TestBot",
            telegram: { telegram: { apiRoot: api.apiRoot } },
        });

        // Background search completed, stored combined file in cache, and cleared the batch:
        const buffer = Buffer.from("user@test.com:pass1\nuser2@test.com:pass2\n", "utf8");
        store.setLastCombined(testChatId, { buffer, filename: "testsite_combined_2026-09-20.txt", linesCount: 2, site: "testsite" });
        assert.equal(store.getLines(testChatId).length, 0);

        // Click combine button on empty batch: should deliver cached file!
        await bot.handleUpdate({
            update_id: 1,
            callback_query: {
                id: "cb_comb",
                from: { id: 999, is_bot: false },
                message: { message_id: 302, chat: { id: testChatId, type: "private" }, text: "Card" },
                data: "combine",
            },
        });

        const docs = api.calls.filter((c) => c.method === "sendDocument");
        assert.equal(docs.length, 1, "expected sendDocument from cache");
        assert.ok(docs[0].payload.caption.includes("Latest Batch"), "expected cached batch caption");
    } finally {
        store.clear(testChatId);
        await api.close();
    }
});

test("bot storage manager handles interactive file deletion and bulk wipe", async () => {
    const api = await startFakeApi();
    const { createBot, localProcessRoot, localProcessedRoot } = require("../src/bot");
    const testChatId = 77777;

    // Create temporary test files in localProcessRoot and localProcessedRoot
    const rawDir = localProcessRoot();
    const procDir = localProcessedRoot();
    fs.mkdirSync(rawDir, { recursive: true });
    fs.mkdirSync(procDir, { recursive: true });

    const rawTestFile = path.join(rawDir, `test_delete_raw_${Date.now()}.txt`);
    const procTestFile = path.join(procDir, `test_delete_proc_${Date.now()}.txt`);
    fs.writeFileSync(rawTestFile, "user1:pass1\n", "utf8");
    fs.writeFileSync(procTestFile, "user2:pass2\n", "utf8");

    try {
        const bot = createBot("123456:fake-token", {
            botUsername: "TestBot",
            telegram: { telegram: { apiRoot: api.apiRoot } },
        });

        // 1. Trigger /storage command
        await bot.handleUpdate({
            update_id: 10,
            message: {
                message_id: 501,
                date: Math.floor(Date.now() / 1000),
                chat: { id: testChatId, type: "private" },
                from: { id: 999, is_bot: false },
                text: "/storage",
                entities: [{ offset: 0, length: 8, type: "bot_command" }],
            },
        });

        const storageMsg = api.calls.find((c) => c.method === "sendMessage" && c.payload.text && c.payload.text.includes("SERVER STORAGE"));
        assert.ok(storageMsg, "expected /storage reply message with SERVER STORAGE dashboard");

        // 2. Ask to delete single raw file
        await bot.handleUpdate({
            update_id: 11,
            callback_query: {
                id: "cb_del_raw_ask",
                from: { id: 999, is_bot: false },
                message: { message_id: 502, chat: { id: testChatId, type: "private" }, text: "Storage" },
                data: "file:del:raw:ask:0",
            },
        });

        const askMsg = api.calls.find((c) => c.method === "editMessageText" && c.payload.text && c.payload.text.includes("DELETE RAW FILE?"));
        assert.ok(askMsg, "expected confirmation prompt before deletion");

        // 3. Confirm deletion of single raw file
        await bot.handleUpdate({
            update_id: 12,
            callback_query: {
                id: "cb_del_raw_confirm",
                from: { id: 999, is_bot: false },
                message: { message_id: 502, chat: { id: testChatId, type: "private" }, text: "Confirm" },
                data: "file:del:confirm:raw:0",
            },
        });

        assert.equal(fs.existsSync(rawTestFile), false, "expected raw test file to be deleted from disk");

        // 4. Test bulk wipe of processed files
        assert.equal(fs.existsSync(procTestFile), true);
        await bot.handleUpdate({
            update_id: 13,
            callback_query: {
                id: "cb_wipe_proc",
                from: { id: 999, is_bot: false },
                message: { message_id: 502, chat: { id: testChatId, type: "private" }, text: "Confirm" },
                data: "file:del:confirm:allproc:0",
            },
        });

        assert.equal(fs.existsSync(procTestFile), false, "expected processed test file to be deleted by bulk wipe");
    } finally {
        if (fs.existsSync(rawTestFile)) fs.rmSync(rawTestFile, { force: true });
        if (fs.existsSync(procTestFile)) fs.rmSync(procTestFile, { force: true });
        await api.close();
    }
});

test("bot handles QoL command aliases and interactive batch search flow", async () => {
    const api = await startFakeApi();
    const testChatId = 887766;
    try {
        const bot = createBot("123456:fake-token", {
            botUsername: "TestBot",
            telegram: { telegram: { apiRoot: api.apiRoot } },
            search: { botUsername: "DumpNews14Bot", stepDelayMs: 10, maxTries: 1 },
        });

        const store = require("../src/store");
        store.addLines(testChatId, ["target.com:alpha@target.com:Pass1", "beta@other.com:Pass2"]);

        // 1. /find alias executes search directly
        await bot.handleUpdate({
            update_id: 101,
            message: {
                message_id: 601,
                date: Math.floor(Date.now() / 1000),
                chat: { id: testChatId, type: "private" },
                from: { id: 999, is_bot: false },
                text: "/find target.com",
                entities: [{ offset: 0, length: 5, type: "bot_command" }],
            },
        });
        const findReply = api.calls.find((c) => c.method === "sendMessage" && c.payload.text && c.payload.text.includes("SEARCH RESULTS"));
        assert.ok(findReply, "expected /find alias to return search results");

        // 2. /s without query activates interactive batch:search:query prompt
        await bot.handleUpdate({
            update_id: 102,
            message: {
                message_id: 602,
                date: Math.floor(Date.now() / 1000),
                chat: { id: testChatId, type: "private" },
                from: { id: 999, is_bot: false },
                text: "/s",
                entities: [{ offset: 0, length: 2, type: "bot_command" }],
            },
        });
        const promptPrompt = api.calls.find((c) => c.method === "sendMessage" && c.payload.text && c.payload.text.includes("QUICK BATCH SEARCH"));
        assert.ok(promptPrompt, "expected /s without query to render quick batch search prompt");

        // 3. User types plain text query "alpha" which answers the prompt
        await bot.handleUpdate({
            update_id: 103,
            message: {
                message_id: 603,
                date: Math.floor(Date.now() / 1000),
                chat: { id: testChatId, type: "private" },
                from: { id: 999, is_bot: false },
                text: "alpha",
            },
        });
        const searchRes = api.calls.find((c) => c.method === "sendMessage" && c.payload.text && c.payload.text.includes("alpha@target.com"));
        assert.ok(searchRes, "expected typing 'alpha' to find alpha@target.com credential");

        // 4. /clean alias with existing batch sends combined file
        await bot.handleUpdate({
            update_id: 104,
            message: {
                message_id: 604,
                date: Math.floor(Date.now() / 1000),
                chat: { id: testChatId, type: "private" },
                from: { id: 999, is_bot: false },
                text: "/clean",
                entities: [{ offset: 0, length: 6, type: "bot_command" }],
            },
        });
        const docSend = api.calls.find((c) => c.method === "sendDocument");
        assert.ok(docSend, "expected /clean to send combined document");
    } finally {
        await api.close();
    }
});

test.after(() => {
    const { getSharedPool } = require("../src/worker-pool");
    getSharedPool().close();
});


