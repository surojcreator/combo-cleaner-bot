"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const http = require("http");
const { WorkerPool, getSharedPool } = require("../src/worker-pool");
const {
    renderHelp,
    renderServerFiles,
    renderSaveGuide,
    ulpMenuKeyboard,
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
    } finally {
        pool.close();
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
    assert.ok(ulpBtns.some((t) => t.includes("Netflix")));
    assert.ok(ulpBtns.some((t) => t.includes("Spotify")));

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
    assert.match(serverFiles, /Tap any button below to clean or search immediately without typing commands/);
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
            calls.push({ method, payload });
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
