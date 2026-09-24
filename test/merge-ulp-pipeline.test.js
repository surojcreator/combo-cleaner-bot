"use strict";

const { test, describe, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");

const downloads = require("../src/downloads");
const store = require("../src/store");
const messages = require("../src/messages");
const botModule = require("../src/bot");
const AdmZip = require("adm-zip");
const { getSharedPool } = require("../src/worker-pool");
const { createBot, localProcessedRoot } = botModule;

describe("ULP Files Merge Pipeline & Server Vault Integration", () => {
    let tmpDir;
    let oldProcessRoot;
    let oldProcessedRoot;
    let oldDownloadUrl;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ulp-merge-test-"));
        oldProcessRoot = process.env.LOCAL_PROCESS_ROOT;
        oldProcessedRoot = process.env.LOCAL_PROCESSED_ROOT;
        oldDownloadUrl = process.env.DOWNLOAD_BASE_URL;

        process.env.LOCAL_PROCESS_ROOT = path.join(tmpDir, "raw");
        process.env.LOCAL_PROCESSED_ROOT = path.join(tmpDir, "processed");
        process.env.DOWNLOAD_BASE_URL = "http://127.0.0.1:9099";

        fs.mkdirSync(process.env.LOCAL_PROCESS_ROOT, { recursive: true });
        fs.mkdirSync(process.env.LOCAL_PROCESSED_ROOT, { recursive: true });

        downloads.clearAll();
        store.clearAll();
        messages.clearCustomEmojis();
    });

    afterEach(() => {
        downloads.clearAll();
        store.clearAll();
        messages.clearCustomEmojis();

        if (oldProcessRoot !== undefined) process.env.LOCAL_PROCESS_ROOT = oldProcessRoot;
        else delete process.env.LOCAL_PROCESS_ROOT;

        if (oldProcessedRoot !== undefined) process.env.LOCAL_PROCESSED_ROOT = oldProcessedRoot;
        else delete process.env.LOCAL_PROCESSED_ROOT;

        if (oldDownloadUrl !== undefined) process.env.DOWNLOAD_BASE_URL = oldDownloadUrl;
        else delete process.env.DOWNLOAD_BASE_URL;

        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (_) {}
    });

    after(async () => {
        try {
            await getSharedPool().destroy();
        } catch (_) {}
    });

    test("isUlpFile recognizes ULP, combolists, logs, and dumps across text and zip formats", () => {
        const bot = createBot("123:MOCK_TOKEN", { disableDebounce: true });
        assert.ok(typeof bot.isUlpFile === "function");

        // Positive matches
        assert.equal(bot.isUlpFile("netflix_ulp_2026-09-24.txt"), true);
        assert.equal(bot.isUlpFile("stealer_passwords.txt"), true);
        assert.equal(bot.isUlpFile("redline_dump.zip"), true);
        assert.equal(bot.isUlpFile("cluster_nodeA.zip"), true);
        assert.equal(bot.isUlpFile("credentials_output.log"), true);
        assert.equal(bot.isUlpFile("all_combos.txt"), true);
        assert.equal(bot.isUlpFile("dump_data.csv"), true);

        // Negative matches
        assert.equal(bot.isUlpFile("photo.jpg"), false);
        assert.equal(bot.isUlpFile("audio.mp3"), false);
        assert.equal(bot.isUlpFile("archive.rar"), false);
        assert.equal(bot.isUlpFile(""), false);
        assert.equal(bot.isUlpFile(null), false);
    });

    test("mergeFilesOnServer with asUlp: true extracts and cleans credentials into master combolist with direct download link", async () => {
        const chatId = 888101;
        const bot = createBot("123:MOCK_TOKEN", { disableDebounce: true });

        // Create sample ULP txt dump 1
        const txtFile1 = path.join(process.env.LOCAL_PROCESS_ROOT, "dump_target1.txt");
        fs.writeFileSync(
            txtFile1,
            "https://netflix.com:user1@gmail.com:pass111\nhttps://spotify.com:user2@gmail.com:pass222\n",
            "utf8"
        );

        // Create sample ULP zip dump 2 with UTF-16LE file inside
        const zipFile2 = path.join(process.env.LOCAL_PROCESS_ROOT, "stealer_logs.zip");
        const zip = new AdmZip();
        // UTF-16LE encoded content for stealer passwords
        const utf16Buf = Buffer.from("https://netflix.com:user1@gmail.com:pass111\nhttps://amazon.com:user3@gmail.com:pass333\n", "utf16le");
        zip.addFile("Stealer/passwords.txt", utf16Buf);
        fs.writeFileSync(zipFile2, zip.toBuffer());

        const stats = await bot.mergeFilesOnServer(
            { chat: { id: chatId } },
            [txtFile1, zipFile2],
            { asUlp: true }
        );

        assert.ok(stats.outName.startsWith("ulp_combined_"));
        assert.ok(stats.outName.endsWith(".txt"));
        assert.equal(stats.isZip, false);
        assert.equal(stats.keptLines, 3); // user1, user2, user3 (user1 was deduped!)
        assert.equal(stats.duplicatesStripped, 1);
        assert.ok(stats.downloadUrl && stats.downloadUrl.startsWith("http://127.0.0.1:9099/download/"));

        // Verify the on-disk file content
        const savedText = fs.readFileSync(stats.outPath, "utf8");
        assert.ok(savedText.includes("user1@gmail.com:pass111"));
        assert.ok(savedText.includes("user2@gmail.com:pass222"));
        assert.ok(savedText.includes("user3@gmail.com:pass333"));
    });

    test("/mergeulp command shows usage when fewer than 2 files exist in vault", async () => {
        const botCalls = [];
        const botApiServer = http.createServer((req, res) => {
            let body = "";
            req.on("data", (chunk) => { body += chunk; });
            req.on("end", () => {
                const url = new URL(req.url, "http://localhost");
                const method = url.pathname.replace(/^\/bot[^/]+\//, "");
                botCalls.push({ method, body: body ? JSON.parse(body) : {} });
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: { message_id: 1111 } }));
            });
        });
        await new Promise((r) => botApiServer.listen(0, r));
        const apiPort = botApiServer.address().port;

        try {
            const bot = createBot("123:MOCK_TOKEN", {
                disableDebounce: true,
                telegram: { telegram: { apiRoot: `http://127.0.0.1:${apiPort}` } },
            });

            await bot.handleUpdate({
                update_id: 101,
                message: {
                    message_id: 501,
                    chat: { id: 888102, type: "private" },
                    from: { id: 888102, is_bot: false },
                    text: "/mergeulp",
                    entities: [{ type: "bot_command", offset: 0, length: 9 }],
                },
            });

            const sent = botCalls.find((c) => c.method === "sendMessage");
            assert.ok(sent, "Must reply to /mergeulp");
            assert.ok(sent.body.text.includes("ULP / COMBO MERGE PIPELINE"));
        } finally {
            botApiServer.close();
        }
    });

    test("/mergeulp command automatically merges vault ULP files when 2 or more exist", async () => {
        const chatId = 888103;
        // Create 2 vault files
        const f1 = path.join(process.env.LOCAL_PROCESS_ROOT, "vault_ulp_1.txt");
        const f2 = path.join(process.env.LOCAL_PROCESS_ROOT, "vault_ulp_2.txt");
        fs.writeFileSync(f1, "alice@test.com:passA1\nbob@test.com:passB2\n", "utf8");
        fs.writeFileSync(f2, "alice@test.com:passA1\ncharlie@test.com:passC3\n", "utf8");

        const botCalls = [];
        const botApiServer = http.createServer((req, res) => {
            let body = "";
            req.on("data", (chunk) => { body += chunk; });
            req.on("end", () => {
                const url = new URL(req.url, "http://localhost");
                const method = url.pathname.replace(/^\/bot[^/]+\//, "");
                botCalls.push({ method, body: body ? JSON.parse(body) : {} });
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: { message_id: 2222 } }));
            });
        });
        await new Promise((r) => botApiServer.listen(0, r));
        const apiPort = botApiServer.address().port;

        try {
            const bot = createBot("123:MOCK_TOKEN", {
                disableDebounce: true,
                telegram: { telegram: { apiRoot: `http://127.0.0.1:${apiPort}` } },
            });

            await bot.handleUpdate({
                update_id: 102,
                message: {
                    message_id: 502,
                    chat: { id: chatId, type: "private" },
                    from: { id: chatId, is_bot: false },
                    text: "/mergeulp",
                    entities: [{ type: "bot_command", offset: 0, length: 9 }],
                },
            });

            // Must edit or send ULP CREDENTIALS MERGED status
            const completeCall = botCalls.find(
                (c) => (c.method === "editMessageText" || c.method === "sendMessage") &&
                       c.body.text && c.body.text.includes("ULP CREDENTIALS MERGED")
            );
            assert.ok(completeCall, "Must render ULP CREDENTIALS MERGED summary card");
            assert.ok(completeCall.body.text.includes("3")); // 3 unique credentials
            assert.ok(completeCall.body.reply_markup.inline_keyboard.flat().some((b) => b.url && b.url.includes("/download/")));
        } finally {
            botApiServer.close();
        }
    });

    test("/merge ulp sub-command merges vault ULP files into deduplicated combolist", async () => {
        const chatId = 888104;
        const f1 = path.join(process.env.LOCAL_PROCESS_ROOT, "combos_alpha.txt");
        const f2 = path.join(process.env.LOCAL_PROCESS_ROOT, "combos_beta.txt");
        fs.writeFileSync(f1, "userA@mail.com:secret1\n", "utf8");
        fs.writeFileSync(f2, "userB@mail.com:secret2\n", "utf8");

        const botCalls = [];
        const botApiServer = http.createServer((req, res) => {
            let body = "";
            req.on("data", (chunk) => { body += chunk; });
            req.on("end", () => {
                const url = new URL(req.url, "http://localhost");
                const method = url.pathname.replace(/^\/bot[^/]+\//, "");
                botCalls.push({ method, body: body ? JSON.parse(body) : {} });
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: { message_id: 3333 } }));
            });
        });
        await new Promise((r) => botApiServer.listen(0, r));
        const apiPort = botApiServer.address().port;

        try {
            const bot = createBot("123:MOCK_TOKEN", {
                disableDebounce: true,
                telegram: { telegram: { apiRoot: `http://127.0.0.1:${apiPort}` } },
            });

            await bot.handleUpdate({
                update_id: 103,
                message: {
                    message_id: 503,
                    chat: { id: chatId, type: "private" },
                    from: { id: chatId, is_bot: false },
                    text: "/merge ulp",
                    entities: [{ type: "bot_command", offset: 0, length: 6 }],
                },
            });

            const mergeReport = botCalls.find(
                (c) => (c.method === "editMessageText" || c.method === "sendMessage") &&
                       c.body.text && c.body.text.includes("ULP CREDENTIALS MERGED")
            );
            assert.ok(mergeReport, "Must reply with ULP CREDENTIALS MERGED report");
        } finally {
            botApiServer.close();
        }
    });

    test("Interactive actions vault:sel:ulp, vault:sel:merge:ulp and files:merge:ulp:all work seamlessly", async () => {
        const chatId = 888105;
        const f1 = path.join(process.env.LOCAL_PROCESS_ROOT, "dump_one.txt");
        const f2 = path.join(process.env.LOCAL_PROCESS_ROOT, "dump_two.txt");
        fs.writeFileSync(f1, "foo@bar.com:pwd1\n", "utf8");
        fs.writeFileSync(f2, "bar@baz.com:pwd2\n", "utf8");

        const botCalls = [];
        const botApiServer = http.createServer((req, res) => {
            let body = "";
            req.on("data", (chunk) => { body += chunk; });
            req.on("end", () => {
                const url = new URL(req.url, "http://localhost");
                const method = url.pathname.replace(/^\/bot[^/]+\//, "");
                botCalls.push({ method, body: body ? JSON.parse(body) : {} });
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: { message_id: 4444 } }));
            });
        });
        await new Promise((r) => botApiServer.listen(0, r));
        const apiPort = botApiServer.address().port;

        try {
            const bot = createBot("123:MOCK_TOKEN", {
                disableDebounce: true,
                telegram: { telegram: { apiRoot: `http://127.0.0.1:${apiPort}` } },
            });

            // 1. Test vault:sel:ulp action
            await bot.handleUpdate({
                update_id: 104,
                callback_query: {
                    id: "cb_ulp_sel",
                    from: { id: chatId, is_bot: false },
                    message: { message_id: 4444, chat: { id: chatId, type: "private" }, text: "Select Menu" },
                    data: "vault:sel:ulp",
                },
            });
            const state = bot.vaultSelectState.get(chatId);
            assert.ok(state, "vaultSelectState must be initialized");
            assert.ok(state.selected.size >= 2, "Both dump files must be selected by vault:sel:ulp");

            // 2. Test vault:sel:merge:ulp action
            await bot.handleUpdate({
                update_id: 105,
                callback_query: {
                    id: "cb_ulp_merge",
                    from: { id: chatId, is_bot: false },
                    message: { message_id: 4444, chat: { id: chatId, type: "private" }, text: "Select Menu" },
                    data: "vault:sel:merge:ulp",
                },
            });
            const mergedCard = botCalls.find(
                (c) => c.body.text && c.body.text.includes("ULP CREDENTIALS MERGED")
            );
            assert.ok(mergedCard, "Must render ULP CREDENTIALS MERGED card");

            // 3. Test files:merge:ulp:all 1-click action
            botCalls.length = 0;
            await bot.handleUpdate({
                update_id: 106,
                callback_query: {
                    id: "cb_ulp_all",
                    from: { id: chatId, is_bot: false },
                    message: { message_id: 4444, chat: { id: chatId, type: "private" }, text: "Vault Menu" },
                    data: "files:merge:ulp:all",
                },
            });
            const allMergedCard = botCalls.find(
                (c) => c.body.text && c.body.text.includes("ULP CREDENTIALS MERGED")
            );
            assert.ok(allMergedCard, "Must merge all ULP files with files:merge:ulp:all");
        } finally {
            botApiServer.close();
        }
    });

    test("ulp:merge_from_zip extracts ULP credentials from an existing merged zip and produces direct download link", async () => {
        const chatId = 888106;

        // Create a zip with credentials
        const zip = new AdmZip();
        zip.addFile("logs/victim1/passwords.txt", Buffer.from("https://site.com:targetuser:targetpass123\n", "utf8"));
        zip.addFile("logs/victim2/passwords.txt", Buffer.from("https://site.com:targetuser2:targetpass456\n", "utf8"));
        const zipBuf = zip.toBuffer();

        const dl = downloads.registerDownload({
            filename: "cluster_merged.zip",
            buffer: zipBuf,
            size: zipBuf.length,
            mimeType: "application/zip",
            chatId,
        });

        const botCalls = [];
        const botApiServer = http.createServer((req, res) => {
            let body = "";
            req.on("data", (chunk) => { body += chunk; });
            req.on("end", () => {
                const url = new URL(req.url, "http://localhost");
                const method = url.pathname.replace(/^\/bot[^/]+\//, "");
                botCalls.push({ method, body: body ? JSON.parse(body) : {} });
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: { message_id: 5555 } }));
            });
        });
        await new Promise((r) => botApiServer.listen(0, r));
        const apiPort = botApiServer.address().port;

        try {
            const bot = createBot("123:MOCK_TOKEN", {
                disableDebounce: true,
                telegram: { telegram: { apiRoot: `http://127.0.0.1:${apiPort}` } },
            });

            await bot.handleUpdate({
                update_id: 107,
                callback_query: {
                    id: "cb_from_zip",
                    from: { id: chatId, is_bot: false },
                    message: { message_id: 5555, chat: { id: chatId, type: "private" }, text: "Zip Report" },
                    data: `ulp:merge_from_zip:${dl.token}`,
                },
            });

            const extractCard = botCalls.find(
                (c) => c.body.text && c.body.text.includes("ULP CREDENTIALS MERGED")
            );
            assert.ok(extractCard, "Must extract and merge ULP credentials from zip");
            assert.ok(extractCard.body.text.includes("2")); // 2 credentials
            assert.ok(extractCard.body.reply_markup.inline_keyboard.flat().some((b) => b.url && b.url.includes("/download/")));
        } finally {
            botApiServer.close();
        }
    });
});
