"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const AdmZip = require("adm-zip");

const {
    createBot,
    searchTextFile,
    searchAllVaultFiles,
} = require("../src/bot");
const {
    renderLocalSearch,
    localSearchResultKeyboard,
    renderLocalSearchHub,
    localSearchHubKeyboard,
    localFileSearchKeyboard,
} = require("../src/messages");

const TEST_DIR = path.join(os.tmpdir(), `lsearch-test-${process.pid}-${Date.now()}`);
const RAW_DIR = path.join(TEST_DIR, "raw");
const PROC_DIR = path.join(TEST_DIR, "proc");

fs.mkdirSync(RAW_DIR, { recursive: true });
fs.mkdirSync(PROC_DIR, { recursive: true });

process.env.LOCAL_PROCESS_ROOT = RAW_DIR;
process.env.LOCAL_PROCESSED_ROOT = PROC_DIR;

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
            } else if (method === "sendDocument") {
                reply({ ok: true, result: { message_id: calls.length + 10, date: now, chat, document: { file_id: "doc123" } } });
            } else {
                reply({ ok: true, result: true });
            }
        });
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    return {
        port,
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
        localProcessRoot: RAW_DIR,
        localProcessedRoot: PROC_DIR,
        telegram: { telegram: { apiRoot } },
    });
}

function commandUpdate(text, chatId = 8881) {
    const commandLength = String(text).split(/\s+/, 1)[0].length;
    return {
        update_id: Math.floor(Math.random() * 100000),
        message: {
            message_id: 100,
            date: Math.floor(Date.now() / 1000),
            chat: { id: chatId, type: "private", first_name: "Tester" },
            from: { id: chatId, is_bot: false, first_name: "Tester" },
            text,
            entities: [{ offset: 0, length: commandLength, type: "bot_command" }],
        },
    };
}

function textUpdate(text, chatId = 8881) {
    return {
        update_id: Math.floor(Math.random() * 100000),
        message: {
            message_id: 101,
            date: Math.floor(Date.now() / 1000),
            chat: { id: chatId, type: "private", first_name: "Tester" },
            from: { id: chatId, is_bot: false, first_name: "Tester" },
            text,
        },
    };
}

function callbackUpdate(data, chatId = 8881) {
    return {
        update_id: Math.floor(Math.random() * 100000),
        callback_query: {
            id: `cb_${Date.now()}`,
            from: { id: chatId, is_bot: false },
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

test("1. searchTextFile finds matches in UTF-8 text files", async () => {
    const txtPath = path.join(RAW_DIR, "combo1.txt");
    fs.writeFileSync(txtPath, [
        "user1@gmail.com:pass1",
        "user2@yahoo.com:pass2",
        "user3@gmail.com:pass3",
        "user4@hotmail.com:pass4",
    ].join("\n"), "utf8");

    const res = await searchTextFile(txtPath, "gmail.com", 10);
    assert.equal(res.total, 2);
    assert.equal(res.matches.length, 2);
    assert.ok(res.matches.includes("user1@gmail.com:pass1"));
    assert.ok(res.matches.includes("user3@gmail.com:pass3"));
});

test("2. searchTextFile strips UTF-8 BOM correctly", async () => {
    const bomPath = path.join(RAW_DIR, "bom_combo.txt");
    const bomContent = "\uFEFFadmin@domain.com:secretPass\nuser@other.com:test";
    fs.writeFileSync(bomPath, bomContent, "utf8");

    const res = await searchTextFile(bomPath, "admin@domain.com", 10);
    assert.equal(res.total, 1);
    assert.equal(res.matches[0], "admin@domain.com:secretPass");
    assert.ok(!res.matches[0].startsWith("\uFEFF"));
});

test("3. searchTextFile extracts and searches inside .zip archives", async () => {
    const zipPath = path.join(RAW_DIR, "archive_dumps.zip");
    const zip = new AdmZip();
    zip.addFile("logs/passwords.txt", Buffer.from("target1@site.com:p1\ntarget2@site.com:p2\nother@domain.com:p3", "utf8"));
    zip.addFile("data.csv", Buffer.from("target3@site.com,p4\nuser@test.org,p5", "utf8"));
    zip.writeZip(zipPath);

    const res = await searchTextFile(zipPath, "site.com", 10);
    assert.equal(res.isZip, true);
    assert.equal(res.total, 3);
    assert.equal(res.matches.length, 3);
    assert.ok(res.matches.some((m) => m.includes("target1@site.com")));
    assert.ok(res.matches.some((m) => m.includes("target3@site.com")));
});

test("4. searchTextFile handles non-existent or empty files safely", async () => {
    const noFile = await searchTextFile(path.join(RAW_DIR, "doesnotexist.txt"), "query");
    assert.deepEqual(noFile, { total: 0, matches: [] });

    const emptyPath = path.join(RAW_DIR, "empty.txt");
    fs.writeFileSync(emptyPath, "", "utf8");
    const emptyRes = await searchTextFile(emptyPath, "query");
    assert.equal(emptyRes.total, 0);

    const emptyQuery = await searchTextFile(emptyPath, "");
    assert.equal(emptyQuery.total, 0);
});

test("5. searchAllVaultFiles aggregates results across raw dumps and cleaned files", async () => {
    const rawFile = path.join(RAW_DIR, "raw_dump.txt");
    fs.writeFileSync(rawFile, "target_user@service.com:pass1\nalpha@beta.com:pass2\n", "utf8");

    const procFile = path.join(PROC_DIR, "cleaned_vault.txt");
    fs.writeFileSync(procFile, "target_user@service.com:pass1\nother_target@service.com:pass3\n", "utf8");

    const res = await searchAllVaultFiles("service.com", {
        rawRoot: RAW_DIR,
        procRoot: PROC_DIR,
        limit: 10,
    });

    assert.equal(res.total, 3);
    assert.equal(res.searchedFiles, 2);
    assert.equal(res.matches.length, 3);
    assert.ok(res.fileResults.some((fr) => fr.name === "cleaned_vault.txt" && fr.total === 2));
    assert.ok(res.fileResults.some((fr) => fr.name === "raw_dump.txt" && fr.total === 1));
});

test("6. searchAllVaultFiles supports scope restriction with null roots", async () => {
    const resProcOnly = await searchAllVaultFiles("service.com", {
        rawRoot: null,
        procRoot: PROC_DIR,
    });
    assert.equal(resProcOnly.total, 2);
    assert.ok(resProcOnly.fileResults.every((fr) => fr.type === "proc"));

    const resRawOnly = await searchAllVaultFiles("service.com", {
        rawRoot: RAW_DIR,
        procRoot: null,
    });
    assert.ok(resRawOnly.total >= 1);
    assert.ok(resRawOnly.fileResults.every((fr) => fr.type === "raw"));
});

test("7. renderLocalSearch formats single file and vault-wide cards properly", () => {
    const singleCard = renderLocalSearch({
        query: "gmail.com",
        total: 5,
        matches: ["user1@gmail.com:pass1", "user2@gmail.com:pass2"],
        fileName: "combo.txt",
        fileSize: 1024,
        isProc: true,
        fileIdx: 0,
    });
    assert.match(singleCard, /LOCAL FILE SEARCH/);
    assert.match(singleCard, /combo\.txt/);
    assert.match(singleCard, /5.*hit/);
    assert.match(singleCard, /user1@gmail\.com:pass1/);

    const vaultCard = renderLocalSearch({
        query: "yahoo.com",
        total: 12,
        matches: ["user@yahoo.com:123"],
        fileResults: [
            { name: "dump1.txt", type: "raw", total: 8 },
            { name: "out1.txt", type: "proc", total: 4 },
        ],
        totalFiles: 5,
        searchedFiles: 2,
        isAll: true,
    });
    assert.match(vaultCard, /VAULT SEARCH RESULTS/);
    assert.match(vaultCard, /dump1\.txt.*<b>8<\/b> matches/);
    assert.match(vaultCard, /out1\.txt.*<b>4<\/b> matches/);
});

test("8. localSearchResultKeyboard generates proper download and navigation buttons", () => {
    const singleKb = localSearchResultKeyboard({
        query: "target.com",
        total: 10,
        fileIdx: 0,
        isProc: false,
        isAll: false,
    });
    const btns = singleKb.reply_markup.inline_keyboard.flat();
    assert.ok(btns.some((b) => b.text.includes("Download Matches (10)")));
    assert.ok(btns.some((b) => b.text.includes("Search File Again") && b.callback_data === "file:search:0"));
    assert.ok(btns.some((b) => b.text.includes("Search All Vault")));

    const allKb = localSearchResultKeyboard({
        query: "test",
        total: 5,
        isAll: true,
    });
    const allBtns = allKb.reply_markup.inline_keyboard.flat();
    assert.ok(allBtns.some((b) => b.text.includes("Download Matches (5)")));
    assert.ok(allBtns.some((b) => b.text.includes("New Vault Search") && b.callback_data === "lsearch:prompt"));
});

test("9. renderLocalSearchHub and localSearchHubKeyboard render complete overview", () => {
    const hubText = renderLocalSearchHub([{ name: "f1" }], [{ name: "p1" }, { name: "p2" }]);
    assert.match(hubText, /LOCAL VAULT SEARCH HUB/);
    assert.match(hubText, /Raw Dumps:.*<b>1<\/b> files/);
    assert.match(hubText, /Cleaned Vault:.*<b>2<\/b> files/);
    assert.match(hubText, /\/lsearch <query>/);

    const hubKb = localSearchHubKeyboard([{ name: "f1" }], [{ name: "p1" }]);
    const buttons = hubKb.reply_markup.inline_keyboard.flat();
    assert.ok(buttons.some((b) => b.text.includes("Enter Search Query") && b.callback_data === "lsearch:prompt"));
    assert.ok(buttons.some((b) => b.text.includes("Search Gmail")));
});

test("10. localFileSearchKeyboard includes custom query prompt and quick filters", () => {
    const kbRaw = localFileSearchKeyboard(0, false);
    const btnsRaw = kbRaw.reply_markup.inline_keyboard.flat();
    assert.ok(btnsRaw.some((b) => b.text.includes("Type Custom Query") && b.callback_data === "file:search:custom:0"));
    assert.ok(btnsRaw.some((b) => b.text.includes("Gmail") && b.callback_data === "file:dosearch:0:gmail.com"));

    const kbProc = localFileSearchKeyboard(1, true);
    const btnsProc = kbProc.reply_markup.inline_keyboard.flat();
    assert.ok(btnsProc.some((b) => b.text.includes("Type Custom Query") && b.callback_data === "file:search:custom:proc:1"));
    assert.ok(btnsProc.some((b) => b.text.includes("Gmail") && b.callback_data === "file:dosearch:proc:1:gmail.com"));
});

test("11. Bot /lsearch interactive hub and search flow", async () => {
    const fake = await startFakeApi();
    const bot = makeBot(fake.apiRoot);

    const chatId = 8881;

    // Call /lsearch without args -> shows hub
    await bot.handleUpdate(commandUpdate("/lsearch", chatId));

    const hubFound = await waitFor(() => fake.calls.some((c) => c.method === "sendMessage" && c.payload.text && c.payload.text.includes("LOCAL VAULT SEARCH HUB")));
    assert.ok(hubFound, "Should display LOCAL VAULT SEARCH HUB");

    // Call /lsearch target_user -> searches all vault files
    await bot.handleUpdate(commandUpdate("/lsearch target_user", chatId));

    const cardFound = await waitFor(() => fake.calls.some((c) => c.payload.text && c.payload.text.includes("VAULT SEARCH RESULTS")));
    assert.ok(cardFound, "Should render VAULT SEARCH RESULTS card");

    // Tap lsearch:prompt -> sets userPromptState and replies with prompt
    await bot.handleUpdate(callbackUpdate("lsearch:prompt", chatId));

    assert.ok(bot.userPromptState.has(chatId));
    assert.equal(bot.userPromptState.get(chatId).action, "lsearch:query");

    // User types search query in chat
    await bot.handleUpdate(textUpdate("service.com", chatId));

    assert.ok(!bot.userPromptState.has(chatId), "userPromptState should be cleared after query");

    await fake.close();
});

test("12. Bot file search custom query and download export flow", async () => {
    const fake = await startFakeApi();
    const bot = makeBot(fake.apiRoot);

    const chatId = 8882;

    // Trigger file:search:custom:0
    await bot.handleUpdate(callbackUpdate("file:search:custom:0", chatId));

    assert.ok(bot.userPromptState.has(chatId));
    assert.equal(bot.userPromptState.get(chatId).action, "file:search:custom");

    // User types query for this specific file
    await bot.handleUpdate(textUpdate("gmail.com", chatId));

    assert.ok(!bot.userPromptState.has(chatId));

    // Cancel prompt test
    bot.userPromptState.set(chatId, { action: "lsearch:query" });
    await bot.handleUpdate(callbackUpdate("search:cancel", chatId));
    assert.ok(!bot.userPromptState.has(chatId), "search:cancel should clear prompt");

    await fake.close();
});

test("13. Universal cancel words typed by user cancel search prompts immediately", async () => {
    const fake = await startFakeApi();
    const bot = makeBot(fake.apiRoot);
    const chatId = 8883;

    bot.userPromptState.set(chatId, { action: "lsearch:query", createdAt: Date.now() });
    await bot.handleUpdate(textUpdate("cancel", chatId));

    assert.ok(!bot.userPromptState.has(chatId), "Typing 'cancel' should clear userPromptState");
    const cancelledMsg = fake.calls.some((c) => c.payload.text && c.payload.text.includes("Action cancelled"));
    assert.ok(cancelledMsg, "Should reply with Action cancelled message");

    // Test with 'stop'
    bot.userPromptState.set(chatId, { action: "file:search:custom", createdAt: Date.now() });
    await bot.handleUpdate(textUpdate("stop", chatId));
    assert.ok(!bot.userPromptState.has(chatId), "Typing 'stop' should clear userPromptState");

    await fake.close();
});

test("14. Search prompt expires after TTL and does not hijack subsequent messages", async () => {
    const fake = await startFakeApi();
    const bot = makeBot(fake.apiRoot);
    const chatId = 8884;

    // Set an expired prompt state (> 2 minutes old)
    bot.userPromptState.set(chatId, {
        action: "lsearch:query",
        createdAt: Date.now() - (3 * 60 * 1000),
    });

    await bot.handleUpdate(textUpdate("hello bot", chatId));

    assert.ok(!bot.userPromptState.has(chatId), "Expired prompt should be removed");
    // Should have sent the default file guidance rather than SEARCHING ALL VAULT FILES
    const searchMsg = fake.calls.some((c) => c.payload.text && c.payload.text.includes("SEARCHING ALL VAULT FILES"));
    assert.equal(searchMsg, false, "Expired prompt must not trigger SEARCHING ALL VAULT FILES");

    await fake.close();
});

test("15. Concurrency guard prevents duplicate simultaneous vault searches", async () => {
    const fake = await startFakeApi();
    const bot = makeBot(fake.apiRoot);
    const chatId = 8885;

    // Simulate active search running
    bot.activeVaultSearches.set(chatId, {
        query: "existing_query",
        startedAt: Date.now(),
        controller: new AbortController(),
    });

    bot.userPromptState.set(chatId, { action: "lsearch:query", createdAt: Date.now() });
    await bot.handleUpdate(textUpdate("new_query", chatId));

    const alreadyRunningMsg = fake.calls.some(
        (c) => c.payload.text && c.payload.text.includes("vault search is already running")
    );
    assert.ok(alreadyRunningMsg, "Should inform user that a search is already running");

    // Clean up
    bot.activeVaultSearches.delete(chatId);
    await fake.close();
});

test.after(() => {
    try {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch (_) {}
    const { getSharedPool } = require("../src/worker-pool");
    getSharedPool().close();
});
