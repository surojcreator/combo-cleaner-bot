"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { createBot } = require("../src/bot");
const store = require("../src/store");

const OWNER_CHAT = 888;
const PROCESSED_ROOT = path.join(os.tmpdir(), `processed-save-${process.pid}`);
process.env.LOCAL_PROCESS_ROOT = os.tmpdir();
process.env.LOCAL_PROCESSED_ROOT = PROCESSED_ROOT;

async function startFakeApi(filesMap = {}) {
    const calls = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            const urlPath = String(req.url || "");
            const method = urlPath.split("/").pop();

            // Handle file downloads: /file/bot<token>/<filepath>
            if (urlPath.includes("/file/bot")) {
                const parts = urlPath.split("/file/bot")[1] ? urlPath.split("/file/bot")[1].split("/") : [];
                parts.shift(); // remove bot token
                const filePathKey = parts.join("/");
                const fileName = urlPath.split("/").pop();
                const matched = filesMap[filePathKey] || filesMap[fileName] || Buffer.from("test@example.com:pass123\n", "utf8");
                res.writeHead(200, { "Content-Type": "application/octet-stream" });
                res.end(matched);
                return;
            }

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
                reply({ ok: true, result: { message_id: calls.length + 10, date: now, chat, text: payload.text } });
            } else if (method === "editMessageText") {
                reply({ ok: true, result: { message_id: payload.message_id, date: now, chat, text: payload.text } });
            } else if (method === "getFile") {
                const fileId = payload.file_id;
                reply({ ok: true, result: { file_id: fileId, file_path: fileId } });
            } else {
                reply({ ok: true, result: true });
            }
        });
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    return {
        calls,
        apiRoot: `http://127.0.0.1:${port}`,
        close: () =>
            new Promise((resolve) => {
                if (typeof server.closeAllConnections === "function") server.closeAllConnections();
                server.close(resolve);
            }),
    };
}

function makeBot(apiRoot, userbot) {
    return createBot("123456:TEST", {
        botUsername: "ulpsorter69bot",
        localProcessRoot: os.tmpdir(),
        telegram: { telegram: { apiRoot } },
        ...(userbot ? { userbot } : {}),
    });
}

function command(text, chatId = OWNER_CHAT) {
    const commandLength = String(text).split(/\s+/, 1)[0].length;
    return {
        update_id: Math.floor(Math.random() * 100000),
        message: {
            message_id: 100,
            date: Math.floor(Date.now() / 1000),
            chat: { id: chatId, type: "private", first_name: "Tester" },
            from: { id: 999, is_bot: false, first_name: "Tester" },
            text,
            entities: [{ offset: 0, length: commandLength, type: "bot_command" }],
        },
    };
}

function documentUpdate(doc, isForwarded = false, messageId = 101, chatId = OWNER_CHAT) {
    return {
        update_id: Math.floor(Math.random() * 100000),
        message: {
            message_id: messageId,
            date: Math.floor(Date.now() / 1000),
            chat: { id: chatId, type: "private" },
            from: { id: 999, is_bot: false },
            document: doc,
            ...(isForwarded ? { forward_date: Math.floor(Date.now() / 1000) } : {}),
        },
    };
}

function callbackUpdate(data, chatId = OWNER_CHAT) {
    return {
        update_id: Math.floor(Math.random() * 100000),
        callback_query: {
            id: `cb_${Date.now()}`,
            from: { id: 999, is_bot: false },
            message: {
                message_id: 10,
                chat: { id: chatId, type: "private" },
                date: Math.floor(Date.now() / 1000),
            },
            data,
        },
    };
}

async function waitFor(predicate, timeoutMs = 4000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 20));
    }
    return false;
}

test("/save without reply activates Save Mode and prompts for forwarded files", async () => {
    const chatId = 881;
    store.clear(chatId);
    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot);
        await bot.handleUpdate(command("/save", chatId));

        assert.equal(
            await waitFor(() => api.calls.some(
                (c) => c.method === "sendMessage" && /SAVE MODE ACTIVE/.test(c.payload.text || "")
            )),
            true,
        );

        const promptMsg = api.calls.find((c) => c.method === "sendMessage" && /SAVE MODE ACTIVE/.test(c.payload.text || ""));
        assert.match(promptMsg.payload.text, /one by one/i);
        assert.match(promptMsg.payload.text, /REPLY TO A FILE/);

        // Verify keyboard contains Done and Cancel buttons
        const kb = promptMsg.payload.reply_markup;
        assert.ok(kb && kb.inline_keyboard);
        const flatBtns = kb.inline_keyboard.flat();
        assert.ok(flatBtns.some((b) => b.callback_data === "save:done"));
        assert.ok(flatBtns.some((b) => b.callback_data === "save:cancel"));
    } finally {
        await api.close();
    }
});

test("/save mode processes forwarded files one by one into the batch via userbot", async () => {
    const chatId = 882;
    store.clear(chatId);

    const downloadedFiles = [];
    const fakePeer = {
        isReady: () => true,
        downloadMessageToDisk: async (cId, messageId, options) => {
            downloadedFiles.push({ chatId: cId, messageId, fileName: options.fileName });
            const outPath = path.join(options.root, options.fileName);
            fs.writeFileSync(outPath, `user${messageId}@service.com:pass${messageId}\n`, "utf8");
            return {
                path: outPath,
                name: options.fileName,
                size: 30,
            };
        },
    };

    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot, fakePeer);

        // 1. Send /save first to enter save mode
        await bot.handleUpdate(command("/save", chatId));
        assert.equal(await waitFor(() => api.calls.some((c) => /SAVE MODE ACTIVE/.test(c.payload.text || ""))), true);

        // 2. Forward two files in sequence
        await bot.handleUpdate(documentUpdate({ file_name: `logs_part1_${Date.now()}.txt`, file_size: 100 }, true, 201, chatId));
        await bot.handleUpdate(documentUpdate({ file_name: `logs_part2_${Date.now()}.txt`, file_size: 150 }, true, 202, chatId));

        // 3. Wait for both files to be downloaded and added to active batch
        assert.equal(
            await waitFor(() => downloadedFiles.length === 2, 5000),
            true,
        );

        assert.equal(downloadedFiles[0].messageId, 201);
        assert.equal(downloadedFiles[1].messageId, 202);

        // Verify lines were added to active batch (processing finished)
        assert.equal(
            await waitFor(() => (store.getStats(chatId)?.size || 0) === 2, 5000),
            true,
        );

        // 4. Finish save session with /done
        await bot.handleUpdate(command("/done", chatId));
        assert.equal(
            await waitFor(() => api.calls.some((c) => /SAVE SESSION COMPLETE/.test(c.payload.text || "")), 5000),
            true,
        );

        const doneMsg = api.calls.find((c) => /SAVE SESSION COMPLETE/.test(c.payload.text || ""));
        assert.match(doneMsg.payload.text, /logs_part1_/);
        assert.match(doneMsg.payload.text, /logs_part2_/);
        assert.match(doneMsg.payload.text, /Active Batch Total/);
    } finally {
        store.clear(chatId);
        await api.close();
    }
});

test("/save mode falls back to Bot API download when userbot is offline", async () => {
    const chatId = 883;
    store.clear(chatId);

    const docName = `botapi_${Date.now()}_log.txt`;
    const filesMap = {
        doc_forward_1: Buffer.from("botapi@test.com:secret123\n", "utf8"),
    };

    const api = await startFakeApi(filesMap);
    try {
        // userbot is offline / not ready
        const bot = makeBot(api.apiRoot, { isReady: () => false });

        // Activate /save
        await bot.handleUpdate(command("/save", chatId));
        assert.equal(await waitFor(() => api.calls.some((c) => /SAVE MODE ACTIVE/.test(c.payload.text || ""))), true);

        // Send forwarded file
        await bot.handleUpdate(documentUpdate({ file_id: "doc_forward_1", file_name: docName, file_size: 25 }, true, 301, chatId));

        // Wait for it to be saved and cleaned
        assert.equal(await waitFor(() => (store.getStats(chatId)?.size || 0) === 1, 5000), true);

        // End session via callback query save:done
        await bot.handleUpdate(callbackUpdate("save:done", chatId));
        assert.equal(await waitFor(() => api.calls.some((c) => /SAVE SESSION COMPLETE/.test(c.payload.text || "")), 5000), true);

        const doneMsg = api.calls.find((c) => /SAVE SESSION COMPLETE/.test(c.payload.text || ""));
        assert.ok(doneMsg);
        assert.match(doneMsg.payload.text, new RegExp(docName.replace(/\./g, "\\.")));
    } finally {
        store.clear(chatId);
        await api.close();
    }
});

test("/save mode supports cancellation via /cancel or save:cancel", async () => {
    const chatId = 884;
    store.clear(chatId);
    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot);

        // Activate /save
        await bot.handleUpdate(command("/save", chatId));
        assert.equal(await waitFor(() => api.calls.some((c) => /SAVE MODE ACTIVE/.test(c.payload.text || ""))), true);

        // Cancel save mode
        await bot.handleUpdate(command("/cancel", chatId));
        assert.equal(
            await waitFor(() => api.calls.some((c) => /Save mode cancelled/.test(c.payload.text || ""))),
            true,
        );
    } finally {
        await api.close();
    }
});

test.after(() => {
    fs.rmSync(PROCESSED_ROOT, { recursive: true, force: true });
    const { closeSharedPool } = require("../src/worker-pool");
    closeSharedPool();
});
