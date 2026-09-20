"use strict";

/**
 * End-to-end wiring test for the ULP relay.
 *
 * The real Telegraf pipeline is driven with bot.handleUpdate(), while the
 * Telegram Bot API is replaced by a local HTTP server (apiRoot) — so no request
 * ever leaves the machine and the live deployment is untouched.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { createBot } = require("../src/bot");
const searchbot = require("../src/searchbot");

const SEARCHER_ID = 8844520471;
const OWNER_CHAT = 555;
const SEARCHER_CHAT = "@DumpNews14Bot";

const SEARCH_OPTIONS = {
    botUsername: "DumpNews14Bot",
    histTemplate: "hist:full:{scope}",
    stepDelayMs: 1, // pacing itself is unit-tested; keep the flow fast
    resultWaitMs: 5,
    maxTries: 1,
    windowMs: 60_000,
};

/**
 * Minimal fake Bot API server: records every call and answers like Telegram.
 * @param {{ blockSends?: boolean }} [opts]
 */
async function startFakeApi(opts = {}) {
    const calls = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => {
            body += chunk;
        });
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
            const reply = (status, json) => {
                res.writeHead(status, { "Content-Type": "application/json" });
                res.end(JSON.stringify(json));
            };

            if (method === "sendMessage" && payload.chat_id === SEARCHER_CHAT) {
                if (opts.failWith) {
                    reply(400, { ok: false, error_code: 400, description: opts.failWith });
                    return; // do not record blocked sends
                }
            }

            calls.push({ method, payload });
            const now = Math.floor(Date.now() / 1000);
            const chat = { id: payload.chat_id, type: "private" };

            switch (method) {
                case "getMe":
                    reply(200, {
                        ok: true,
                        result: { id: 8912553102, is_bot: true, first_name: "ulp sorter bot", username: "ulpsorter69bot" },
                    });
                    return;
                case "sendMessage":
                    reply(200, { ok: true, result: { message_id: calls.length, date: now, chat, text: payload.text } });
                    return;
                case "editMessageText":
                    reply(200, { ok: true, result: { message_id: payload.message_id, date: now, chat, text: payload.text } });
                    return;
                case "getFile":
                    reply(200, { ok: true, result: { file_id: payload.file_id, file_path: "documents/dump.txt" } });
                    return;
                case "forwardMessage":
                    reply(200, { ok: true, result: { message_id: 4242, date: now, chat, text: "forwarded" } });
                    return;
                case "sendDocument":
                    reply(200, { ok: true, result: { message_id: 8888, date: now, chat, document: { file_name: "combined.txt" } } });
                    return;
                default:
                    reply(200, { ok: true, result: true });
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
                // Drop keep-alive sockets, otherwise close() waits for them.
                if (typeof server.closeAllConnections === "function") server.closeAllConnections();
                server.close(resolve);
            }),
    };
}

function makeBot(apiRoot, userbotPeer) {
    return createBot("123456:TEST", {
        search: SEARCH_OPTIONS,
        botUsername: "ulpsorter69bot",
        telegram: { telegram: { apiRoot } },
        ...(userbotPeer ? { userbot: wireFakePeer(userbotPeer) } : {}),
    });
}

/**
 * Totally optional knock-on: make a plain stub look enough like a real
 * userbot to drive the bypass path (routing + sharing included).
 */
function wireFakePeer(peer) {
    peer.share = async (self, update) => {
        const messageId = Number(update.message_id) || null;
        const kind = update.kind === "document" || update.document ? "document" : "text";
        const targets = searchbot.noteResult(SEARCHER_ID, { messageId, kind });
        for (const chatId of targets) {
            const info = {
                message_id: messageId + 1000,
                date: Math.floor(Date.now() / 1000),
                chat: { id: chatId, type: "private" },
                from: { id: 999, is_bot: false, first_name: "Tester" },
                ...(update.document ? { document: update.document } : {}),
                ...(update.text ? { text: update.text } : {}),
            };
            await peer.botRef.handleUpdate({
                update_id: 90000 + messageId,
                message: {
                    ...info,
                    forward_origin: {
                        type: "user",
                        date: info.date,
                        sender_user: { id: SEARCHER_ID, is_bot: true, username: "DumpNews14Bot" },
                    },
                },
            });
        }
    };
    return peer;
}

/**
 * Build a callback query update as if a button on a bot message was tapped.
 */
function ulpCallbackUpdate(messageId, data) {
    return {
        update_id: 3,
        callback_query: {
            id: "cb-1",
            from: { id: 999, is_bot: false, first_name: "Tester" },
            chat_instance: "ci-1",
            data,
            message: {
                message_id: messageId,
                date: Math.floor(Date.now() / 1000),
                chat: { id: OWNER_CHAT, type: "private" },
                from: { id: 8912553102, is_bot: true, username: "ulpsorter69bot" },
                text: "shared card",
                reply_to_message: {
                    message_id: 8001,
                    date: Math.floor(Date.now() / 1000),
                    chat: { id: OWNER_CHAT, type: "private" },
                    from: { id: 999, is_bot: false, first_name: "Tester" },
                    document: { file_id: "res-file-1", file_unique_id: "u1", file_name: "dump.txt", file_size: 24 },
                },
            },
        },
    };
}

function commandUpdate(text) {
    return {
        update_id: 1,
        message: {
            message_id: 10,
            date: Math.floor(Date.now() / 1000),
            chat: { id: OWNER_CHAT, type: "private", first_name: "Tester" },
            from: { id: 999, is_bot: false, first_name: "Tester" },
            text,
            entities: [{ offset: 0, length: 4, type: "bot_command" }],
        },
    };
}

function searcherUpdate(message) {
    return {
        update_id: 2,
        message: {
            message_id: 77,
            date: Math.floor(Date.now() / 1000),
            chat: { id: SEARCHER_ID, type: "private" },
            from: { id: SEARCHER_ID, is_bot: true, username: "DumpNews14Bot", first_name: "DUMP" },
            ...message,
        },
    };
}

/**
 * Wait until a recorded call matches the predicate.
 */
async function waitFor(predicate, timeoutMs = 2000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return false;
}

test("ULP flow: sends the query, then forwards the searcher's answer back", async () => {
    searchbot.resetRuns();
    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot);
        const running = bot.handleUpdate(commandUpdate("/ulp htzone.co.il day"));

        // The launch card goes to the caller and lists the paced sequence.
        assert.ok(await waitFor(() => api.calls.some((c) => c.method === "sendMessage" && c.payload.chat_id === OWNER_CHAT)));
        const card = api.calls.find((c) => c.method === "sendMessage" && c.payload.chat_id === OWNER_CHAT);
        assert.match(card.payload.text, /ULP SEARCH/);
        assert.match(card.payload.text, /htzone\.co\.il/);
        assert.match(JSON.stringify(card.payload.reply_markup || {}), /ulp:stop/);

        // The query reaches the searcher bot...
        assert.ok(
            await waitFor(() =>
                api.calls.some(
                    (c) => c.method === "sendMessage" && c.payload.chat_id === SEARCHER_CHAT && c.payload.text === "htzone.co.il",
                ),
            ),
            "expected the raw query to be sent to the searcher bot",
        );

        // ...and its answer arrives while the run is still listening.
        await bot.handleUpdate(searcherUpdate({ text: "htzone.co.il:user@example.com:pass123" }));
        await running;

        // Both steps of the protocol went out, query first.
        const toSearcher = api.calls
            .filter((c) => c.method === "sendMessage" && c.payload.chat_id === SEARCHER_CHAT)
            .map((c) => c.payload.text);
        assert.deepEqual(toSearcher, ["htzone.co.il", "hist:full:day"]);

        const header = api.calls.find(
            (c) => c.method === "sendMessage" && c.payload.chat_id === OWNER_CHAT && /RESULTS INCOMING/.test(c.payload.text || ""),
        );
        assert.ok(header, "expected a results header in the caller's chat");

        const forward = api.calls.find((c) => c.method === "forwardMessage");
        assert.ok(forward, "expected the result to be forwarded");
        assert.equal(forward.payload.chat_id, OWNER_CHAT);
        assert.equal(forward.payload.from_chat_id, SEARCHER_ID);
        assert.equal(forward.payload.message_id, 77);
        assert.match(JSON.stringify(forward.payload.reply_markup || {}), /ulp:clean|combine/);

        // Results arrived, so the run stays open to relay whatever else comes.
        assert.equal(searchbot.getRun(OWNER_CHAT).results.length, 1);
        searchbot.finishRun(OWNER_CHAT, "done");
    } finally {
        await api.close();
        searchbot.resetRuns();
    }
});

test("ULP flow: a bot-to-bot block explains the BotFather switch", async () => {
    searchbot.resetRuns();
    const api = await startFakeApi({ failWith: "Bad Request: USER_BOT_TO_BOT_DISABLED" });
    try {
        const bot = makeBot(api.apiRoot);
        await bot.handleUpdate(commandUpdate("/ulp htzone.co.il month"));

        const text = api.calls
            .filter((c) => c.method === "editMessageText")
            .map((c) => c.payload.text || "")
            .join("\n");
        assert.match(text, /BOT-TO-BOT IS OFF/);
        assert.match(text, /Bot-to-Bot Communication/);
        // The blocked query must never reach the searcher bot.
        assert.equal(api.calls.filter((c) => c.payload.chat_id === SEARCHER_CHAT).length, 0);
        // The manual fallback lists both steps so it can be done by hand.
        assert.match(text, /htzone\.co\.il/);
        assert.match(text, /hist:full:month/);
        assert.equal(searchbot.isRunning(OWNER_CHAT), false);
    } finally {
        await api.close();
        searchbot.resetRuns();
    }
});

test("ULP flow: a userbot path never touches the Bot API on its way out", async () => {
    searchbot.resetRuns();
    const api = await startFakeApi();
    try {
        const peer = {
            kind: "userbot",
            isReady: () => true,
            searcherId: SEARCHER_ID,
            sent: [],
            classify: () => "other",
            send: async function (text) {
                this.sent.push(text);
                return { message_id: this.sent.length, chat: { id: SEARCHER_ID } };
            },
        };
        const bot = makeBot(api.apiRoot, peer);
        peer.botRef = bot;
        const running = bot.handleUpdate(commandUpdate("/ulp bypass.co year"));

        // The pair went out through the account transport...
        const deadline = Date.now() + 2000;
        while (peer.sent.length < 2 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.deepEqual(peer.sent, ["bypass.co", "hist:full:year"]);
        assert.equal(api.calls.filter((c) => c.payload.chat_id === SEARCHER_CHAT).length, 0);

        // Card shows the account as the sender...
        const card = api.calls.find((c) => c.method === "sendMessage" && c.payload.chat_id === OWNER_CHAT);
        assert.match(card.payload.text, /MTProto bypass/);

        // ...then the account shares the answer back, and the bot acknowledges it.
        await peer.share(peer, { message_id: 9001, kind: "document", document: { file_id: "res-file-1", file_name: "dump.txt" } });
        await running;

        const ack = api.calls.find(
            (c) => c.method === "sendMessage" && c.payload.chat_id === OWNER_CHAT && /RESULT IN/.test(c.payload.text || ""),
        );
        assert.ok(ack, "expected a shared-result card");
        assert.match(JSON.stringify(ack.payload.reply_markup || {}), /ulp:clean/);

        // The clean button resolves the file through the reply target.
        const cb = ulpCallbackUpdate(ack.payload.message_id, "ulp:clean");
        await bot.handleUpdate(cb);
        assert.ok(
            api.calls.some((c) => c.method === "getFile"),
            "expected the bot to fetch the shared file for cleaning",
        );
        searchbot.resetRuns();
    } finally {
        await api.close();
        searchbot.resetRuns();
    }
});

test("ULP flow: /ulp without a query only shows usage", async () => {
    searchbot.resetRuns();
    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot);
        await bot.handleUpdate(commandUpdate("/ulp"));

        assert.equal(api.calls.filter((c) => c.payload.chat_id === SEARCHER_CHAT).length, 0);
        const sent = api.calls.filter((c) => c.method === "sendMessage");
        assert.equal(sent.length, 1);
        assert.match(sent[0].payload.text, /ULP SEARCH RELAY/);
    } finally {
        await api.close();
        searchbot.resetRuns();
    }
});

test("ordinary messages still reach the normal handlers", async () => {
    searchbot.resetRuns();
    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot);
        await bot.handleUpdate(commandUpdate("hello there"));

        const sent = api.calls.filter((c) => c.method === "sendMessage");
        assert.equal(sent.length, 1);
        assert.match(sent[0].payload.text, /Send it as a file/);
    } finally {
        await api.close();
        searchbot.resetRuns();
    }
});

test("ULP flow: userbot day search drives button day-by-day search", async () => {
    searchbot.resetRuns();
    const api = await startFakeApi();
    try {
        let searchedDayOptions = null;
        const peer = {
            kind: "userbot",
            isReady: () => true,
            searcherId: SEARCHER_ID,
            classify: () => "other",
            send: async () => ({ message_id: 1, chat: { id: SEARCHER_ID } }),
            searchDayByDay: async (opts) => {
                searchedDayOptions = opts;
                opts.onStatus({ day: "20.09.2026", attempt: 1, totalDays: 5, step: "Clicking folder:20.09.2026:0" });
                return { status: "done", daysProcessed: 5 };
            },
        };
        const bot = makeBot(api.apiRoot, peer);
        peer.botRef = bot;
        await bot.handleUpdate(commandUpdate("/ulp testsite.com 20.09.2026"));

        assert.ok(searchedDayOptions, "expected searchDayByDay to be called");
        assert.equal(searchedDayOptions.query, "testsite.com");
        assert.equal(searchedDayOptions.startDate instanceof Date, true);
        assert.equal(searchedDayOptions.startDate.getDate(), 20);
        searchbot.resetRuns();
    } finally {
        await api.close();
        searchbot.resetRuns();
    }
});

test("ULP flow: automatically delivers combined file and clears batch when search finishes", async () => {
    searchbot.resetRuns();
    const api = await startFakeApi();
    const store = require("../src/store");
    try {
        const peer = {
            kind: "userbot",
            isReady: () => true,
            searcherId: SEARCHER_ID,
            classify: () => "other",
            send: async () => ({ message_id: 1, chat: { id: SEARCHER_ID } }),
            searchDayByDay: async () => {
                store.addLines(OWNER_CHAT, ["user@test.com:pass123", "user2@test.com:pass456"], { site: "testsite.com" });
                return { status: "done", daysProcessed: 1 };
            },
        };
        const bot = makeBot(api.apiRoot, peer);
        peer.botRef = bot;
        await bot.handleUpdate(commandUpdate("/ulp testsite.com 20.09.2026"));

        const docCall = api.calls.find((c) => c.method === "sendDocument");
        assert.ok(docCall, "expected sendDocument to deliver combined file");
        assert.equal(docCall.payload.chat_id, OWNER_CHAT);
        assert.equal(store.getLines(OWNER_CHAT).length, 0, "expected batch to be cleared");
        searchbot.resetRuns();
    } finally {
        await api.close();
        searchbot.resetRuns();
    }
});

test("ULP flow: searchDayByDay automatically cleans onResult messages and combines results", async () => {
    searchbot.resetRuns();
    const api = await startFakeApi();
    const store = require("../src/store");
    try {
        const dummyZipContent = "user@testdomain.com:pass123\nuser2@testdomain.com:secret456\n";
        const peer = {
            kind: "userbot",
            isReady: () => true,
            searcherId: SEARCHER_ID,
            classify: () => "other",
            send: async () => ({ message_id: 1, chat: { id: SEARCHER_ID } }),
            downloadMedia: async (msg) => Buffer.from(dummyZipContent, "utf8"),
            searchDayByDay: async (opts) => {
                if (opts.onResult) {
                    await opts.onResult({
                        id: 777,
                        media: true,
                        file: { name: "testdomain.com_20.09.2026.txt" },
                    });
                }
                return { status: "done", daysProcessed: 1 };
            },
        };
        const bot = makeBot(api.apiRoot, peer);
        peer.botRef = bot;
        await bot.handleUpdate(commandUpdate("/ulp testdomain.com 20.09.2026"));

        const docCall = api.calls.find((c) => c.method === "sendDocument");
        assert.ok(docCall, "expected sendDocument to deliver combined file");
        assert.equal(docCall.payload.chat_id, OWNER_CHAT);
        assert.equal(store.getLines(OWNER_CHAT).length, 0, "expected batch to be cleared after combine");
        searchbot.resetRuns();
    } finally {
        await api.close();
        searchbot.resetRuns();
    }
});

test("ULP flow: removes URL prefixes from credentials and query when searching", async () => {
    searchbot.resetRuns();
    const api = await startFakeApi();
    const store = require("../src/store");
    try {
        const dummyContent = "https://example.com/path:user@example.com:pass123\nexample.com:anotheruser:secret456\n";
        let capturedLines = [];
        let searchedOpts = null;
        const peer = {
            kind: "userbot",
            isReady: () => true,
            searcherId: SEARCHER_ID,
            classify: () => "other",
            send: async () => ({ message_id: 1, chat: { id: SEARCHER_ID } }),
            downloadMedia: async () => Buffer.from(dummyContent, "utf8"),
            searchDayByDay: async (opts) => {
                searchedOpts = opts;
                if (opts.onResult) {
                    await opts.onResult({
                        id: 999,
                        media: true,
                        file: { name: "example.com_20.09.2026.txt" },
                    });
                    capturedLines = [...store.getLines(OWNER_CHAT)];
                }
                return { status: "done", daysProcessed: 1 };
            },
        };
        const bot = makeBot(api.apiRoot, peer);
        peer.botRef = bot;
        await bot.handleUpdate(commandUpdate("/ulp https://example.com/login 20.09.2026"));

        assert.ok(searchedOpts, "expected searchDayByDay to be called");
        assert.equal(searchedOpts.query, "example.com", "expected query to have URL and path removed");
        assert.deepEqual(capturedLines, [
            "user@example.com:pass123",
            "anotheruser:secret456",
        ], "expected URLs to be stripped from combo results");
        searchbot.resetRuns();
    } finally {
        await api.close();
        searchbot.resetRuns();
    }
});

test.after(() => {
    const { getSharedPool } = require("../src/worker-pool");
    getSharedPool().close();
});



