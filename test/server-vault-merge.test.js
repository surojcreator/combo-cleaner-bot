"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { createBot, scanDirFiles, getAllVaultFiles } = require("../src/bot");
const store = require("../src/store");
const messages = require("../src/messages");

const OWNER_CHAT = 991;
const TEST_ROOT = path.join(os.tmpdir(), `vault-merge-test-${process.pid}`);
const RAW_ROOT = path.join(TEST_ROOT, "raw");
const PROC_ROOT = path.join(TEST_ROOT, "proc");

fs.mkdirSync(RAW_ROOT, { recursive: true });
fs.mkdirSync(PROC_ROOT, { recursive: true });
process.env.LOCAL_PROCESS_ROOT = RAW_ROOT;
process.env.LOCAL_PROCESSED_ROOT = PROC_ROOT;

async function startFakeApi() {
    const calls = [];
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            const urlPath = String(req.url || "");
            const method = urlPath.split("/").pop();

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

function makeBot(apiRoot) {
    return createBot("123456:TEST", {
        botUsername: "ulpsorter69bot",
        localProcessRoot: RAW_ROOT,
        localProcessedRoot: PROC_ROOT,
        telegram: { telegram: { apiRoot } },
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

test("Server Vault Overview renders clean, uncluttered dashboard with Multi-Select option", async () => {
    const rawFiles = [
        { name: "test_dump1.txt", size: 5000, mtime: new Date() },
        { name: "test_dump2.txt", size: 3000, mtime: new Date() },
    ];
    const procFiles = [
        { name: "cleaned_output1.txt", size: 2500, mtime: new Date() },
    ];

    // Check keyboard for { tab: "overview" }
    const kb = messages.serverFilesKeyboard(rawFiles, procFiles, { tab: "overview" });
    const btns = kb.reply_markup.inline_keyboard.flat();

    // Verify prominent multi-select action exists
    assert.ok(btns.some((b) => b.callback_data === "files:tab:select" && b.text.includes("Multi-Select")));
    // Verify tab navigation exists
    assert.ok(btns.some((b) => b.callback_data === "files:tab:raw"));
    assert.ok(btns.some((b) => b.callback_data === "files:tab:proc"));
    assert.ok(btns.some((b) => b.callback_data === "combine"));
    assert.ok(btns.some((b) => b.callback_data === "files:tab:tools"));

    // Verify it is NOT cluttered with individual file clean/search/del buttons on the overview screen
    assert.ok(!btns.some((b) => b.text.includes("Clean Raw #1")));
    assert.ok(!btns.some((b) => b.text.includes("Download Output #1")));

    // Legacy fallback without options still retains legacy buttons for older suites
    const legacyKb = messages.serverFilesKeyboard(rawFiles, procFiles);
    const legacyBtns = legacyKb.reply_markup.inline_keyboard.flat();
    assert.ok(legacyBtns.some((b) => b.text.includes("Clean Raw #1")));
    assert.ok(legacyBtns.some((b) => b.text.includes("Download Output #1")));
});

test("Multi-Select mode toggles checkmarks and enables merging", async () => {
    const chatId = 992;
    store.clear(chatId);
    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot);

        // Open vault
        await bot.handleUpdate(command("/vault", chatId));
        assert.equal(await waitFor(() => api.calls.some((c) => /SERVER STORAGE & FILES VAULT/.test(c.payload.text || ""))), true);

        // Switch to multi-select tab
        await bot.handleUpdate(callbackUpdate("files:tab:select", chatId));
        assert.equal(await waitFor(() => api.calls.some((c) => /MULTI-FILE SELECT & MERGE/.test(c.payload.text || ""))), true);

        const selectMsg = api.calls.find((c) => /MULTI-FILE SELECT & MERGE/.test(c.payload.text || ""));
        assert.ok(selectMsg);
        const kb = selectMsg.payload.reply_markup.inline_keyboard.flat();
        assert.ok(kb.some((b) => b.callback_data === "vault:sel:all"));
        assert.ok(kb.some((b) => b.callback_data === "vault:sel:clear"));
        assert.ok(kb.some((b) => b.callback_data === "vault:sel:merge"));
    } finally {
        await api.close();
    }
});

test("Multi-Select Merge combines selected files into one clean file on disk WITHOUT returning to Telegram", async () => {
    const chatId = 993;
    store.clear(chatId);

    // Create 2 test raw credential files on server disk
    const file1Path = path.join(RAW_ROOT, `file1_${Date.now()}.txt`);
    const file2Path = path.join(RAW_ROOT, `file2_${Date.now()}.txt`);
    fs.writeFileSync(file1Path, "user1@test.com:pass1\nuser2@test.com:pass2\ndupe@test.com:same\n", "utf8");
    fs.writeFileSync(file2Path, "user3@test.com:pass3\ndupe@test.com:same\nuser4@test.com:pass4\n", "utf8");

    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot);

        // Open select tab
        await bot.handleUpdate(callbackUpdate("files:tab:select", chatId));
        assert.equal(await waitFor(() => api.calls.some((c) => /MULTI-FILE SELECT & MERGE/.test(c.payload.text || ""))), true);

        // Select all files
        await bot.handleUpdate(callbackUpdate("vault:sel:all", chatId));

        // Click merge
        await bot.handleUpdate(callbackUpdate("vault:sel:merge", chatId));

        // Verify merge completion message was sent
        assert.equal(
            await waitFor(() => api.calls.some((c) => /FILES MERGED ON SERVER VAULT/.test(c.payload.text || ""))),
            true,
        );

        const mergeMsg = api.calls.find((c) => /FILES MERGED ON SERVER VAULT/.test(c.payload.text || ""));
        assert.match(mergeMsg.payload.text, /merged_vault_/);
        assert.match(mergeMsg.payload.text, /Duplicates Stripped:/);
        assert.match(mergeMsg.payload.text, /NOT sent back to Telegram/i);

        // CRITICAL CHECK: Verify that NO document was sent to Telegram (no sendDocument call)
        const sentDocumentCalls = api.calls.filter((c) => c.method === "sendDocument");
        assert.equal(sentDocumentCalls.length, 0, "Expected NO document to be uploaded/returned to Telegram!");

        // Verify merged file was created on server disk under PROC_ROOT
        const procFiles = fs.readdirSync(PROC_ROOT).filter((f) => f.startsWith("merged_vault_") && f.endsWith(".txt"));
        assert.ok(procFiles.length > 0, "Expected merged file to exist on server disk!");

        const mergedContent = fs.readFileSync(path.join(PROC_ROOT, procFiles[procFiles.length - 1]), "utf8");
        assert.match(mergedContent, /user1@test\.com:pass1/);
        assert.match(mergedContent, /user4@test\.com:pass4/);
        // Verify deduplication: dupe@test.com:same should only appear once
        const occurrences = (mergedContent.match(/dupe@test\.com:same/g) || []).length;
        assert.equal(occurrences, 1, "Expected duplicate credential to be deduplicated!");
    } finally {
        store.clear(chatId);
        await api.close();
    }
});

test("/mergesession merges all files saved in current session into clean disk file without returning", async () => {
    const chatId = 994;
    store.clear(chatId);

    // Seed fake files
    const sessionFile1 = path.join(RAW_ROOT, `session1_${Date.now()}.txt`);
    const sessionFile2 = path.join(RAW_ROOT, `session2_${Date.now()}.txt`);
    fs.writeFileSync(sessionFile1, "alpha@corp.com:secret1\nbeta@corp.com:secret2\n", "utf8");
    fs.writeFileSync(sessionFile2, "gamma@corp.com:secret3\nalpha@corp.com:secret1\n", "utf8");

    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot);

        // Start /save mode
        await bot.handleUpdate(command("/save", chatId));
        assert.equal(await waitFor(() => api.calls.some((c) => /SAVE MODE ACTIVE/.test(c.payload.text || ""))), true);

        // Simulate save session with mock items
        const prompt = bot.userPromptState ? bot.userPromptState.get(chatId) : null;
        if (prompt) {
            prompt.processed = [
                { name: path.basename(sessionFile1), path: sessionFile1, size: 50, linesAdded: 2 },
                { name: path.basename(sessionFile2), path: sessionFile2, size: 50, linesAdded: 1 },
            ];
        }

        // Call /mergesession command
        await bot.handleUpdate(command("/mergesession", chatId));

        assert.equal(
            await waitFor(() => api.calls.some((c) => /FILES MERGED ON SERVER VAULT/.test(c.payload.text || ""))),
            true,
        );

        // Verify NO document was sent to Telegram
        assert.equal(api.calls.filter((c) => c.method === "sendDocument").length, 0);

        // Verify clean merged file on server disk
        const procFiles = fs.readdirSync(PROC_ROOT).filter((f) => f.startsWith("merged_vault_") && f.endsWith(".txt"));
        assert.ok(procFiles.length > 0);
    } finally {
        store.clear(chatId);
        await api.close();
    }
});

test("scanDirFiles sorts files descending by size by default and supports mtime sorting", () => {
    const sortTestDir = path.join(TEST_ROOT, `sort-test-${Date.now()}`);
    fs.mkdirSync(sortTestDir, { recursive: true });
    try {
        const small = path.join(sortTestDir, "small.txt");
        const med = path.join(sortTestDir, "medium.txt");
        const large = path.join(sortTestDir, "large.txt");

        fs.writeFileSync(small, "a".repeat(100));
        fs.writeFileSync(med, "b".repeat(500));
        fs.writeFileSync(large, "c".repeat(2000));

        // Default should be size descending: large (2000), medium (500), small (100)
        const sortedBySize = scanDirFiles(sortTestDir);
        assert.equal(sortedBySize.length, 3);
        assert.equal(sortedBySize[0].name, "large.txt");
        assert.equal(sortedBySize[1].name, "medium.txt");
        assert.equal(sortedBySize[2].name, "small.txt");

        // Explicit "size" sort
        const explicitSize = scanDirFiles(sortTestDir, "size");
        assert.equal(explicitSize[0].name, "large.txt");
        assert.equal(explicitSize[2].name, "small.txt");

        // Explicit "mtime" sort
        const now = Date.now();
        fs.utimesSync(small, new Date(now + 3000), new Date(now + 3000));
        fs.utimesSync(med, new Date(now + 2000), new Date(now + 2000));
        fs.utimesSync(large, new Date(now + 1000), new Date(now + 1000));
        const sortedByMtime = scanDirFiles(sortTestDir, "mtime");
        assert.equal(sortedByMtime[0].name, "small.txt");
        assert.equal(sortedByMtime[2].name, "large.txt");
    } finally {
        fs.rmSync(sortTestDir, { recursive: true, force: true });
    }
});

test("renderMergeProgress renders visual gauge, file progress, line counts, and status phase", () => {
    const text = messages.renderMergeProgress({
        currentFileIndex: 3,
        totalFiles: 10,
        currentFileName: "dump_chunk_03.txt",
        currentFileSize: 5242880,
        keptLines: 45000,
        duplicatesStripped: 6200,
        phase: "Deduplicating credentials stream…",
        humanSize: (n) => `${Math.round(n / (1024 * 1024))} MB`,
    });

    assert.match(text, /MERGING FILES IN VAULT/);
    assert.match(text, /\[███░░░░░░░\].*30%/);
    assert.ok(text.includes("(<b>3</b>/<b>10</b> files)"));
    assert.match(text, /dump_chunk_03\.txt/);
    assert.match(text, /5 MB/);
    assert.match(text, /45,000/);
    assert.match(text, /6,200/);
    assert.match(text, /Deduplicating credentials stream/);
});

test("mergeFilesOnServer reports live progress via onProgress callback", async () => {
    const api = await startFakeApi();
    try {
        const bot = makeBot(api.apiRoot);
        const f1 = path.join(RAW_ROOT, `progress_test1_${Date.now()}.txt`);
        const f2 = path.join(RAW_ROOT, `progress_test2_${Date.now()}.txt`);
        fs.writeFileSync(f1, "user1@site.com:p1\nuser2@site.com:p2\n");
        fs.writeFileSync(f2, "user3@site.com:p3\nuser1@site.com:p1\n");

        const progressList = [];
        const ctx = { chat: { id: 8888 }, answerCbQuery: async () => {} };
        const stats = await bot.mergeFilesOnServer(ctx, [f1, f2], {
            onProgress: (p) => {
                progressList.push({ ...p });
            },
        });

        assert.ok(progressList.length >= 2, `Expected at least 2 progress events, got ${progressList.length}`);
        assert.equal(progressList[0].totalFiles, 2);
        assert.ok(progressList.some((p) => p.currentFileIndex === 1));
        assert.ok(progressList.some((p) => p.currentFileIndex === 2));
        assert.equal(stats.totalFiles, 2);
        assert.equal(stats.keptLines, 3);
        assert.equal(stats.duplicatesStripped, 1);
    } finally {
        await api.close();
    }
});

test.after(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    const { closeSharedPool } = require("../src/worker-pool");
    closeSharedPool();
});
