"use strict";

/**
 * End-to-end test for the /process command: cleans a file that already lives on
 * the server's disk (e.g. /var/data/...) instead of uploading through Telegram's
 * 20 MB Bot API cap.
 *
 * Drives the real Telegraf pipeline via bot.handleUpdate() against a fake local
 * Bot API, and writes temp files into OS tmp so nothing touches the live work.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");
const AdmZip = require("adm-zip");
const { createBot } = require("../src/bot");
const store = require("../src/store");

const OWNER_CHAT = 777;
const PROCESSED_ROOT = path.join(os.tmpdir(), `processed-${process.pid}`);
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
        telegram: { telegram: { apiRoot } },
        ...(userbot ? { userbot } : {}),
    });
}

function command(text) {
    const commandLength = String(text).split(/\s+/, 1)[0].length;
    return {
        update_id: 1,
        message: {
            message_id: 99,
            date: Math.floor(Date.now() / 1000),
            chat: { id: OWNER_CHAT, type: "private", first_name: "Tester" },
            from: { id: 999, is_bot: false, first_name: "Tester" },
            text,
            entities: [{ offset: 0, length: commandLength, type: "bot_command" }],
        },
    };
}

function saveCommand(replyToMessage) {
    const update = command("/save");
    update.message.reply_to_message = replyToMessage;
    return update;
}

async function waitFor(predicate, timeoutMs = 3000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return predicate();
}

function finalReport(calls) {
    return calls.find(
        (c) => c.method === "editMessageText" && /CLEAN REPORT/.test(c.payload.text || ""),
    );
}

test("/process cleans a plain-text file from disk and saves to the batch", async () => {
    store.clear(OWNER_CHAT);
    const tmp = path.join(os.tmpdir(), `process-${Date.now()}.txt`);
    fs.writeFileSync(
        tmp,
        [
            "user1@example.com:pass1",
            "user2@example.com:pass2",
            "user1@example.com:pass1", // duplicate within file
            "https://site.com:443", // dropped: URL
            "",
        ].join("\n"),
        "utf8",
    );

    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot);
        await bot.handleUpdate(command(`/process ${tmp}`));

        assert.equal(await waitFor(() => Boolean(finalReport(api.calls))), true);

        const report = finalReport(api.calls).payload.text;
        assert.match(report, /CLEAN REPORT/);
        assert.match(report, /Added to batch/);
        assert.match(report, /Full disk output/);

        const matches = store.searchLines(OWNER_CHAT, "example.com");
        assert.equal(matches.total, 2);
    } finally {
        store.clear(OWNER_CHAT);
        fs.rmSync(tmp, { force: true });
        await api.close();
    }
});

test("/process cleans a zip file from disk (nested text extracted)", async () => {
    store.clear(OWNER_CHAT);
    const zip = new AdmZip();
    zip.addFile("netflix_combo.txt", Buffer.from("netflix@user.com:netpass\njunk", "utf8"));
    const tmp = path.join(os.tmpdir(), `process-${Date.now()}.zip`);
    fs.writeFileSync(tmp, zip.toBuffer());

    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot);
        await bot.handleUpdate(command(`/process ${tmp}`));

        assert.equal(await waitFor(() => Boolean(finalReport(api.calls))), true);

        const report = finalReport(api.calls).payload.text;
        assert.match(report, /CLEAN REPORT/);
        assert.match(report, /Added to batch/);
        assert.match(report, /Full disk output/);

        const matches = store.searchLines(OWNER_CHAT, "netflix@user.com:netpass");
        assert.equal(matches.total, 1);
    } finally {
        store.clear(OWNER_CHAT);
        fs.rmSync(tmp, { force: true });
        await api.close();
    }
});

test("/lsearch searches the newest persistent cleaned output", async () => {
    fs.rmSync(PROCESSED_ROOT, { recursive: true, force: true });
    fs.mkdirSync(PROCESSED_ROOT, { recursive: true });
    const output = path.join(PROCESSED_ROOT, `search-${Date.now()}.txt`);
    fs.writeFileSync(output, "alpha@example.com:one\nbeta@example.net:two\n", "utf8");
    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot);
        await bot.handleUpdate(command("/lsearch example.net"));
        assert.equal(
            await waitFor(() => api.calls.some(
                (c) => c.method === "editMessageText" && /beta@example\.net:two/.test(c.payload.text || ""),
            )),
            true,
        );
    } finally {
        fs.rmSync(output, { force: true });
        await api.close();
    }
});



test("/process rejects a missing file path", async () => {
    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot);
        await bot.handleUpdate(command("/process /var/data/does-not-exist-123.zip"));

        assert.equal(await waitFor(() => api.calls.some((c) => c.method === "sendMessage")), true);
        const msg = api.calls.find((c) => c.method === "sendMessage");
        assert.match(msg.payload.text, /Not found/);
    } finally {
        await api.close();
    }
});

test("/process blocks files outside LOCAL_PROCESS_ROOT", async () => {
    const allowed = path.join(os.tmpdir(), `allowed-${process.pid}`);
    const outside = path.join(os.tmpdir(), `outside-${process.pid}.txt`);
    fs.mkdirSync(allowed, { recursive: true });
    fs.writeFileSync(outside, "a@example.com:pass\n", "utf8");
    const previous = process.env.LOCAL_PROCESS_ROOT;
    process.env.LOCAL_PROCESS_ROOT = allowed;
    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot);
        await bot.handleUpdate(command(`/process ${outside}`));
        assert.equal(
            await waitFor(() => api.calls.some(
                (c) => c.method === "sendMessage" && /Path blocked/.test(c.payload.text || ""),
            )),
            true,
        );
    } finally {
        process.env.LOCAL_PROCESS_ROOT = previous;
        fs.rmSync(allowed, { recursive: true, force: true });
        fs.rmSync(outside, { force: true });
        await api.close();
    }
});

test("/process without a path shows usage", async () => {
    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot);
        await bot.handleUpdate(command("/process"));

        assert.equal(await waitFor(() => api.calls.some((c) => c.method === "sendMessage")), true);
        const msg = api.calls.find((c) => c.method === "sendMessage");
        assert.match(msg.payload.text, /PROCESS A LOCAL FILE/);
    } finally {
        await api.close();
    }
});

test("/save explains that it must reply to a document", async () => {
    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot, { isReady: () => true });
        await bot.handleUpdate(command("/save"));
        assert.equal(
            await waitFor(() => api.calls.some(
                (c) => c.method === "sendMessage" && /REPLY TO A FILE/.test(c.payload.text || ""),
            )),
            true,
        );
    } finally {
        await api.close();
    }
});

test("/save downloads the replied document to disk and automatically processes it", async () => {
    store.clear(OWNER_CHAT);
    const savedRoot = path.join(os.tmpdir(), `save-root-${process.pid}-${Date.now()}`);
    const previousRoot = process.env.LOCAL_PROCESS_ROOT;
    process.env.LOCAL_PROCESS_ROOT = savedRoot;
    fs.mkdirSync(savedRoot, { recursive: true });

    const fakePeer = {
        isReady: () => true,
        downloadMessageToDisk: async (chatId, messageId, options) => {
            assert.equal(chatId, OWNER_CHAT);
            assert.equal(messageId, 321);
            const output = path.join(options.root, "forwarded_321.txt");
            fs.writeFileSync(output, "saved@example.com:secret\njunk\n", "utf8");
            if (options.onProgress) options.onProgress(32, 32);
            return {
                path: output,
                name: path.basename(output),
                originalName: "forwarded.txt",
                size: fs.statSync(output).size,
            };
        },
    };

    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot, fakePeer);
        await bot.handleUpdate(saveCommand({
            message_id: 321,
            date: Math.floor(Date.now() / 1000),
            chat: { id: OWNER_CHAT, type: "private" },
            from: { id: 123, is_bot: false, first_name: "Forwarder" },
            document: {
                file_id: "large-file",
                file_unique_id: "large-file-u",
                file_name: "forwarded.txt",
                file_size: 1_000_000_000,
            },
        }));

        assert.equal(
            await waitFor(() => api.calls.some(
                (c) => c.method === "editMessageText" && /CLEAN REPORT/.test(c.payload.text || ""),
            )),
            true,
        );
        assert.equal(store.searchLines(OWNER_CHAT, "saved@example.com").total, 1);
    } finally {
        process.env.LOCAL_PROCESS_ROOT = previousRoot;
        store.clear(OWNER_CHAT);
        fs.rmSync(savedRoot, { recursive: true, force: true });
        await api.close();
    }
});

test("/process on a ULP file checks for duplicates and removes the URL", async () => {
    store.clear(OWNER_CHAT);
    const tmp = path.join(os.tmpdir(), `ulp-${Date.now()}.txt`);
    fs.writeFileSync(
        tmp,
        [
            "https://netflix.com/login:john_doe:secret123",
            "https://netflix.com/login:john_doe:secret123", // duplicate
            "https://spotify.com/auth:musiclover@gmail.com:pass456",
            "https://site.com:443", // bare URL dropped
            "",
        ].join("\n"),
        "utf8",
    );

    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot);
        await bot.handleUpdate(command(`/process ${tmp}`));

        assert.equal(await waitFor(() => Boolean(finalReport(api.calls))), true);

        const report = finalReport(api.calls).payload.text;
        assert.match(report, /CLEAN REPORT/);
        // Verify duplicates were found and counted
        assert.match(report, /Duplicates\s+1/);

        // Verify the store stripped the URL and kept pure user:pass
        const netflixMatch = store.searchLines(OWNER_CHAT, "john_doe");
        assert.equal(netflixMatch.total, 1);
        assert.equal(netflixMatch.matches[0], "john_doe:secret123");

        const spotifyMatch = store.searchLines(OWNER_CHAT, "musiclover@gmail.com");
        assert.equal(spotifyMatch.total, 1);
        assert.equal(spotifyMatch.matches[0], "musiclover@gmail.com:pass456");

        // Verify disk output file also stripped URLs and deduplicated
        const diskFileMatch = report.match(/<code>(.*?)<\/code>/);
        assert.ok(diskFileMatch, "expected disk output path in report");
        const diskFile = diskFileMatch[1];
        assert.equal(fs.existsSync(diskFile), true);
        const diskContent = fs.readFileSync(diskFile, "utf8").trim().split(/\r?\n/);
        assert.deepEqual(diskContent, [
            "john_doe:secret123",
            "musiclover@gmail.com:pass456",
        ]);
        fs.rmSync(diskFile, { force: true });
    } finally {
        store.clear(OWNER_CHAT);
        fs.rmSync(tmp, { force: true });
        await api.close();
    }
});

test.after(() => {
    fs.rmSync(PROCESSED_ROOT, { recursive: true, force: true });
    const { getSharedPool } = require("../src/worker-pool");
    getSharedPool().close();
});

