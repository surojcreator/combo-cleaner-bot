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

        // 3. Verify files remain buffered in the queue and do NOT start processing before /done
        assert.equal(downloadedFiles.length, 0);
        assert.equal(store.getStats(chatId)?.size || 0, 0);

        // 4. Finish save session with /done -> now processing starts!
        await bot.handleUpdate(command("/done", chatId));

        // 5. Wait for both files to be downloaded and added to active batch
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

        // Send forwarded file (buffered in queue)
        await bot.handleUpdate(documentUpdate({ file_id: "doc_forward_1", file_name: docName, file_size: 25 }, true, 301, chatId));

        // Ensure file is NOT processed before done signal
        assert.equal(store.getStats(chatId)?.size || 0, 0);

        // End session via callback query save:done (triggers processing)
        await bot.handleUpdate(callbackUpdate("save:done", chatId));

        // Wait for it to be saved and cleaned
        assert.equal(await waitFor(() => (store.getStats(chatId)?.size || 0) === 1, 5000), true);
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

test("/save buffers forwarded files without starting work until /done is triggered", async () => {
    const chatId = 885;
    store.clear(chatId);

    const processedOrder = [];
    const fakePeer = {
        isReady: () => true,
        downloadMessageToDisk: async (cId, messageId, options) => {
            processedOrder.push(messageId);
            const outPath = path.join(options.root, options.fileName);
            fs.writeFileSync(outPath, `user_${messageId}:secret_${messageId}\n`, "utf8");
            return {
                path: outPath,
                name: options.fileName,
                size: 40,
            };
        },
    };

    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot, fakePeer);

        // Activate save mode
        await bot.handleUpdate(command("/save", chatId));
        assert.equal(await waitFor(() => api.calls.some((c) => /SAVE MODE ACTIVE/.test(c.payload.text || ""))), true);

        // Forward 3 files
        await bot.handleUpdate(documentUpdate({ file_name: "batch_1.txt", file_size: 50 }, true, 501, chatId));
        await bot.handleUpdate(documentUpdate({ file_name: "batch_2.txt", file_size: 60 }, true, 502, chatId));
        await bot.handleUpdate(documentUpdate({ file_name: "batch_3.txt", file_size: 70 }, true, 503, chatId));

        // Ensure nothing started working yet!
        assert.equal(processedOrder.length, 0);
        assert.equal(store.getStats(chatId)?.size || 0, 0);

        // Now user sends /done
        await bot.handleUpdate(command("/done", chatId));

        // Processing should complete all 3 in order
        assert.equal(await waitFor(() => processedOrder.length === 3, 5000), true);
        assert.deepEqual(processedOrder, [501, 502, 503]);
        assert.equal(store.getStats(chatId)?.size || 0, 3);

        assert.equal(await waitFor(() => api.calls.some((c) => /SAVE SESSION COMPLETE/.test(c.payload.text || "")), 5000), true);
    } finally {
        store.clear(chatId);
        await api.close();
    }
});

test("/save correctly resolves channel forward origin and filename pattern like @moonulp - 213.txt", async () => {
    const chatId = 886;
    store.clear(chatId);

    const calls = [];
    const fakePeer = {
        isReady: () => true,
        downloadMessageToDisk: async (cId, messageId, options) => {
            calls.push({ targetPeer: cId, targetMsgId: messageId, fileName: options.fileName });
            const outPath = path.join(options.root, options.fileName);
            fs.writeFileSync(outPath, `channel_user:channel_pass\n`, "utf8");
            return {
                path: outPath,
                name: options.fileName,
                size: 25,
            };
        },
    };

    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot, fakePeer);

        // 1. Activate save mode
        await bot.handleUpdate(command("/save", chatId));

        // 2. Forward document with name "@moonulp - 213.txt"
        const forwardedDocUpdate = {
            update_id: 99999,
            message: {
                message_id: 404,
                date: Math.floor(Date.now() / 1000),
                chat: { id: chatId, type: "private" },
                from: { id: 999, is_bot: false },
                document: {
                    file_name: "@moonulp - 213.txt",
                    file_size: 50000000, // 50MB (exceeds Bot API 20MB limit)
                    file_id: "doc_moonulp_213",
                },
                forward_origin: {
                    type: "channel",
                    chat: { id: -1001234567890, username: "moonulp", title: "Moon ULP" },
                    message_id: 213,
                },
            },
        };
        await bot.handleUpdate(forwardedDocUpdate);

        // 3. User finishes forwarding with /done
        await bot.handleUpdate(command("/done", chatId));

        // 4. Verify fakePeer was called with the channel username/id and message 213!
        assert.equal(await waitFor(() => calls.length === 1, 5000), true);
        assert.equal(calls[0].targetPeer, "@moonulp");
        assert.equal(calls[0].targetMsgId, 213);
        assert.equal(store.getStats(chatId)?.size || 0, 1);

        assert.equal(await waitFor(() => api.calls.some((c) => /SAVE SESSION COMPLETE/.test(c.payload.text || "")), 5000), true);
    } finally {
        store.clear(chatId);
        await api.close();
    }
});

test("userbot extractForwardOrigin and parseChannelFilename parse channel dump names and origins", () => {
    const { extractForwardOrigin, parseChannelFilename } = require("../src/userbot");

    assert.deepEqual(parseChannelFilename("@moonulp - 213.txt"), { peer: "@moonulp", messageId: 213 });
    assert.deepEqual(parseChannelFilename("@target_channel_505.txt"), { peer: "@target_channel", messageId: 505 });
    assert.deepEqual(parseChannelFilename("@somechannel - 99.log"), { peer: "@somechannel", messageId: 99 });
    assert.equal(parseChannelFilename("somechannel - 99.log"), null);
    assert.equal(parseChannelFilename("batch_1.txt"), null);
    assert.equal(parseChannelFilename("regular_file.txt"), null);

    // Forward origin parser
    const modern = {
        forward_origin: {
            type: "channel",
            chat: { id: -1001999, username: "moonulp" },
            message_id: 213,
        },
    };
    assert.deepEqual(extractForwardOrigin(modern), { peer: "@moonulp", messageId: 213, title: "moonulp" });

    const legacy = {
        forward_from_chat: {
            id: -1001999,
            username: "moonulp",
            title: "Moon Channel",
        },
        forward_from_message_id: 213,
    };
    assert.deepEqual(extractForwardOrigin(legacy), { peer: "@moonulp", messageId: 213, title: "Moon Channel" });
});

test("channel_post updates: /save and /largefiles aliases activate Save Mode and detect forwarded files in channels", async () => {
    const api = await startFakeApi();
    const channelId = -100987654321;
    store.clear(channelId);
    try {
        const bot = createBot("123456:fake-token", {
            botUsername: "TestBot",
            telegram: { telegram: { apiRoot: api.apiRoot } },
        });

        // 1. Send /largefiles as a channel_post
        await bot.handleUpdate({
            update_id: 88801,
            channel_post: {
                message_id: 1,
                date: Math.floor(Date.now() / 1000),
                chat: { id: channelId, type: "channel" },
                text: "/largefiles",
                entities: [{ type: "bot_command", offset: 0, length: 11 }],
            },
        });

        const prompt = bot.userPromptState.get(channelId);
        assert.ok(prompt, "channel should have active prompt");
        assert.equal(prompt.action, "save:listening");

        // 2. Forward document to the channel as channel_post
        await bot.handleUpdate({
            update_id: 88802,
            channel_post: {
                message_id: 2,
                date: Math.floor(Date.now() / 1000),
                chat: { id: channelId, type: "channel" },
                document: {
                    file_name: "channel_dump.txt",
                    file_size: 1024,
                    file_id: "doc_ch_1",
                },
                forward_origin: {
                    type: "channel",
                    chat: { id: -100111222, username: "somechannel" },
                    message_id: 55,
                },
            },
        });

        assert.equal(prompt.queue.length, 1, "document should be queued in channel prompt");
        assert.equal(prompt.queue[0].name, "channel_dump.txt");

        // 3. Send /ragefiles alias as channel_post in another channel
        const channel2 = -100999888;
        await bot.handleUpdate({
            update_id: 88803,
            channel_post: {
                message_id: 1,
                date: Math.floor(Date.now() / 1000),
                chat: { id: channel2, type: "channel" },
                text: "/ragefiles",
                entities: [{ type: "bot_command", offset: 0, length: 10 }],
            },
        });
        const prompt2 = bot.userPromptState.get(channel2);
        assert.ok(prompt2, "channel 2 should have active prompt");
        assert.equal(prompt2.action, "save:listening");
    } finally {
        store.clear(channelId);
        await api.close();
    }
});

test("keyboard: Save Large Files button triggers save:start and enters Save Mode", async () => {
    const api = await startFakeApi();
    const chatId = 777123;
    store.clear(chatId);
    try {
        const bot = createBot("123456:fake-token", {
            botUsername: "TestBot",
            telegram: { telegram: { apiRoot: api.apiRoot } },
        });

        await bot.handleUpdate({
            update_id: 88804,
            callback_query: {
                id: "cb_save_start",
                from: { id: chatId },
                message: { message_id: 10, chat: { id: chatId, type: "private" } },
                data: "save:start",
            },
        });

        const prompt = bot.userPromptState.get(chatId);
        assert.ok(prompt, "prompt should be created on save:start");
        assert.equal(prompt.action, "save:listening");
        const sentCalls = api.calls.filter((c) => c.method === "sendMessage");
        assert.ok(sentCalls.length > 0);
        assert.ok(sentCalls[sentCalls.length - 1].payload.text.includes("SAVE MODE ACTIVE"));
    } finally {
        store.clear(chatId);
        await api.close();
    }
});

test.after(() => {
    fs.rmSync(PROCESSED_ROOT, { recursive: true, force: true });
    const { closeSharedPool } = require("../src/worker-pool");
    closeSharedPool();
});

