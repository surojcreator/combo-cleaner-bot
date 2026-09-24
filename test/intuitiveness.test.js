"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { createBot } = require("../src/bot");
const store = require("../src/store");
const { renderHelp } = require("../src/messages");

const OWNER_CHAT = 8888;
const PROCESSED_ROOT = path.join(os.tmpdir(), `processed-intuit-${process.pid}`);
process.env.LOCAL_PROCESS_ROOT = os.tmpdir();
process.env.LOCAL_PROCESSED_ROOT = PROCESSED_ROOT;

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
        close: () =>
            new Promise((resolve) => {
                if (typeof server.closeAllConnections === "function") server.closeAllConnections();
                server.close(resolve);
            }),
    };
}

function makeBot(apiRoot) {
    return createBot("123456:TEST", {
        botUsername: "ulpsorter69bot",
        telegram: { telegram: { apiRoot } },
    });
}

function makeUpdate(text, messageId = 1, isCommand = false) {
    const entities = isCommand ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] : [];
    return {
        update_id: messageId,
        message: {
            message_id: messageId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: OWNER_CHAT, type: "private" },
            from: { id: OWNER_CHAT, is_bot: false, first_name: "Tester" },
            text,
            entities,
        },
    };
}

function makeCallbackUpdate(data, callbackId = 1) {
    return {
        update_id: callbackId,
        callback_query: {
            id: String(callbackId),
            from: { id: OWNER_CHAT, is_bot: false, first_name: "Tester" },
            message: {
                message_id: 100,
                chat: { id: OWNER_CHAT, type: "private" },
                text: "Original message",
            },
            data,
        },
    };
}

test.after(() => {
    fs.rmSync(PROCESSED_ROOT, { recursive: true, force: true });
    const { getSharedPool } = require("../src/worker-pool");
    getSharedPool().close();
});

test("Intuitiveness: renderHelp includes COMMAND SHORTCUTS cheat-sheet", () => {
    const help = renderHelp("testbot", { size: 100, files: 2 }, "DumpBot");
    assert.match(help, /COMMAND SHORTCUTS/);
    assert.match(help, /\/ulp <domain>/);
    assert.match(help, /\/combine/);
    assert.match(help, /\/save/);
    assert.match(help, /\/vault/);
    assert.match(help, /\/search/);
});

test("Intuitiveness: command aliases (/menu, /status, /info, /domains, /sample) work seamlessly", async () => {
    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot);

        // /menu
        await bot.handleUpdate(makeUpdate("/menu", 1, true));
        let sent = api.calls.filter((c) => c.method === "sendMessage");
        assert.equal(sent.length, 1);
        assert.match(sent[0].payload.text, /COMBO CLEANER ULTIMATE/);

        // /status
        await bot.handleUpdate(makeUpdate("/status", 2, true));
        sent = api.calls.filter((c) => c.method === "sendMessage");
        assert.equal(sent.length, 2);
        assert.match(sent[1].payload.text, /BATCH METRICS DASHBOARD/);

        // /domains
        await bot.handleUpdate(makeUpdate("/domains", 3, true));
        sent = api.calls.filter((c) => c.method === "sendMessage");
        assert.equal(sent.length, 3);
        assert.match(sent[2].payload.text, /SITE RECONNAISSANCE/);

        // /sample
        await bot.handleUpdate(makeUpdate("/sample", 4, true));
        sent = api.calls.filter((c) => c.method === "sendMessage");
        assert.equal(sent.length, 4);
        assert.match(sent[3].payload.text, /PREVIEW/);
    } finally {
        await api.close();
    }
});

test("Intuitiveness: plain text single-word shortcuts (menu, stats, sites) invoke actions without slash", async () => {
    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot);

        // User types "menu"
        await bot.handleUpdate(makeUpdate("menu", 10));
        let sent = api.calls.filter((c) => c.method === "sendMessage");
        assert.equal(sent.length, 1);
        assert.match(sent[0].payload.text, /COMBO CLEANER ULTIMATE/);

        // User types "stats"
        await bot.handleUpdate(makeUpdate("stats", 11));
        sent = api.calls.filter((c) => c.method === "sendMessage");
        assert.equal(sent.length, 2);
        assert.match(sent[1].payload.text, /BATCH METRICS DASHBOARD/);

        // User types "sites"
        await bot.handleUpdate(makeUpdate("sites", 12));
        sent = api.calls.filter((c) => c.method === "sendMessage");
        assert.equal(sent.length, 3);
        assert.match(sent[2].payload.text, /SITE RECONNAISSANCE/);
    } finally {
        await api.close();
    }
});

test("Intuitiveness: smart target domain detection for bare domains like 'netflix.com'", async () => {
    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot);

        await bot.handleUpdate(makeUpdate("netflix.com", 20));
        const sent = api.calls.filter((c) => c.method === "sendMessage");
        assert.equal(sent.length, 1);
        assert.match(sent[0].payload.text, /TARGET DOMAIN DETECTED/);
        assert.match(sent[0].payload.text, /netflix\.com/);
        assert.ok(sent[0].payload.reply_markup, "expected action keyboard with buttons");
        const buttons = JSON.stringify(sent[0].payload.reply_markup);
        assert.match(buttons, /Run ULP Search/);
        assert.match(buttons, /Search Batch/);
        assert.match(buttons, /Vault Search/);
    } finally {
        await api.close();
    }
});

test("Intuitiveness: smart search query detection for email like 'admin@gmail.com'", async () => {
    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot);

        await bot.handleUpdate(makeUpdate("admin@gmail.com", 21));
        const sent = api.calls.filter((c) => c.method === "sendMessage");
        assert.equal(sent.length, 1);
        assert.match(sent[0].payload.text, /SEARCH QUERY DETECTED/);
        assert.match(sent[0].payload.text, /admin@gmail\.com/);
        assert.ok(sent[0].payload.reply_markup);
        const buttons = JSON.stringify(sent[0].payload.reply_markup);
        assert.match(buttons, /Search Batch/);
        assert.match(buttons, /Search Vault Files/);
    } finally {
        await api.close();
    }
});

test("Intuitiveness: /process without arguments offers processPromptKeyboard with 1-tap Process Newest File", async () => {
    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot);

        await bot.handleUpdate(makeUpdate("/process", 30, true));
        const sent = api.calls.filter((c) => c.method === "sendMessage");
        assert.equal(sent.length, 1);
        assert.match(sent[0].payload.text, /PROCESS A LOCAL FILE/);
        const buttons = JSON.stringify(sent[0].payload.reply_markup);
        assert.match(buttons, /Process Newest File/);
        assert.match(buttons, /Server Vault/);
    } finally {
        await api.close();
    }
});

test("Intuitiveness: ulp:custom:add pins domain and refreshes ULP menu with preset button", async () => {
    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot);

        await bot.handleUpdate(makeCallbackUpdate("ulp:custom:add:roblox.com", 40));
        const edits = api.calls.filter((c) => c.method === "editMessageText");
        assert.ok(edits.length >= 1);
        assert.match(edits[0].payload.text, /Pinned.*roblox\.com/);
        const buttons = JSON.stringify(edits[0].payload.reply_markup);
        assert.match(buttons, /roblox\.com/);
    } finally {
        await api.close();
    }
});
