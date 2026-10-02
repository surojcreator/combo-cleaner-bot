"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createBot, parseUlpArg, isSearcherMessage, isSearcherForward, pickTransport, renderSaveError } = require("../src/bot");
const userbot = require("../src/userbot");

test("userbot config reads env and spots missing secrets", () => {
    const full = userbot.loadConfig({
        TELEGRAM_API_ID: "12345",
        TELEGRAM_API_HASH: "abc",
        TELEGRAM_SESSION: "1xxxxx",
        SEARCH_BOT_USERNAME: "@DumpNews14Bot",
        SEARCH_TRANSPORT: "UserBot",
    });
    assert.equal(full.apiId, 12345);
    assert.equal(full.apiHash, "abc");
    assert.equal(full.searcher, "DumpNews14Bot");
    assert.equal(full.transport, "userbot");
    assert.equal(userbot.isConfigured(full), true);

    const missing = userbot.loadConfig({ SEARCH_BOT_USERNAME: "DumpNews14Bot" });
    assert.equal(userbot.isConfigured(missing), false);
});

test("classifyUserbotError maps MTProto failures to relay kinds", () => {
    assert.equal(userbot.classifyUserbotError({ errorMessage: "SESSION_REVOKED" }), "userbot_auth");
    assert.equal(userbot.classifyUserbotError({ message: "SESSION_INVALID: run login again" }), "userbot_auth");
    assert.equal(userbot.classifyUserbotError({ errorMessage: "USERBOT_NOT_READY" }), "userbot_auth");
    assert.equal(userbot.classifyUserbotError({ errorMessage: "USERNAME_NOT_OCCUPIED" }), "not_found");
    assert.equal(userbot.classifyUserbotError({ errorMessage: "FLOOD_WAIT_30" }), "flood_wait");
    assert.equal(userbot.classifyUserbotError({ errorMessage: "YOU_BLOCKED_USER" }), "blocked");
    assert.equal(userbot.classifyUserbotError(new Error("socket hang up")), "other");
});

test("pickTransport prefers the connected account, else the Bot API", () => {
    const prevSession = process.env.TELEGRAM_SESSION;
    const prevId = process.env.TELEGRAM_API_ID;
    const prevHash = process.env.TELEGRAM_API_HASH;
    delete process.env.TELEGRAM_SESSION;
    delete process.env.TELEGRAM_API_ID;
    delete process.env.TELEGRAM_API_HASH;
    try {
        const ctx = { telegram: { sendMessage: async () => true } };
        const searchOptions = { botUsername: "DumpNews14Bot", transport: "auto" };

        const ready = { isReady: () => true, send: async (t) => ({ message_id: 1, chat: { id: 7 } }), classify: () => "other" };
        assert.equal(pickTransport({ userbot: ready }, searchOptions, ctx).kind, "userbot");

        // auto + configured-but-down peer: stay on userbot path so we never hit bot-to-bot disabled
        const down = { isReady: () => false, send: async () => true, classify: () => "other" };
        const autoDown = pickTransport({ userbot: down, userbotConfigured: true }, searchOptions, ctx);
        assert.equal(autoDown.kind, "userbot");
        assert.equal(autoDown.userbot, null);
        assert.equal(autoDown.classify(new Error("x")), "userbot_not_ready");

        // auto with nothing configured falls back to Bot API
        assert.equal(pickTransport({}, searchOptions, ctx).kind, "bot");

        // env session alone also forces userbot path
        process.env.TELEGRAM_SESSION = "1fake";
        const envForced = pickTransport({}, searchOptions, ctx);
        assert.equal(envForced.kind, "userbot");
        delete process.env.TELEGRAM_SESSION;

        const forcedDown = pickTransport({ userbot: down }, { botUsername: "DumpNews14Bot", transport: "userbot" }, ctx);
        assert.equal(forcedDown.kind, "userbot");
        assert.equal(forcedDown.classify(new Error("x")), "userbot_not_ready");
    } finally {
        if (prevSession !== undefined) process.env.TELEGRAM_SESSION = prevSession;
        else delete process.env.TELEGRAM_SESSION;
        if (prevId !== undefined) process.env.TELEGRAM_API_ID = prevId;
        else delete process.env.TELEGRAM_API_ID;
        if (prevHash !== undefined) process.env.TELEGRAM_API_HASH = prevHash;
        else delete process.env.TELEGRAM_API_HASH;
    }
});

test("isSearcherForward spots results shared by the bypass", () => {
    const searchOptions = { botUsername: "DumpNews14Bot" };
    const meta = { searcherBotId: 8844520471 };

    const modern = {
        from: { is_bot: false, id: 999 },
        message: { message_id: 1, forward_origin: { type: "user", sender_user: { id: 8844520471, is_bot: true, username: "DumpNews14Bot" } }, document: { file_id: "x" } },
    };
    assert.equal(isSearcherForward(modern, meta, searchOptions), true);

    const legacy = {
        from: { is_bot: false, id: 999 },
        message: { message_id: 2, forward_from: { id: 8844520471, is_bot: true, username: "DumpNews14Bot" }, text: "hi" },
    };
    assert.equal(isSearcherForward(legacy, meta, searchOptions), true);

    const markedCopy = {
        from: { is_bot: false, id: 999 },
        message: { message_id: 3, text: "#ulp htzone.co.il:a@b.com:pass" },
    };
    assert.equal(isSearcherForward(markedCopy, meta, searchOptions), true);

    const otherForward = {
        from: { is_bot: false, id: 999 },
        message: { message_id: 4, forward_origin: { type: "user", sender_user: { id: 5, is_bot: true, username: "OtherBot" } }, text: "hi" },
    };
    assert.equal(isSearcherForward(otherForward, meta, searchOptions), false);

    const plainText = {
        from: { is_bot: false, id: 999 },
        message: { message_id: 5, text: "hello" },
    };
    assert.equal(isSearcherForward(plainText, meta, searchOptions), false);
});

test("safeDownloadName removes path traversal and Windows-invalid characters", () => {
    assert.equal(userbot.safeDownloadName("../../evil:name?.txt"), "evil_name_.txt");
    assert.equal(userbot.safeDownloadName("..\\..\\dump.txt"), "dump.txt");
    assert.equal(userbot.safeDownloadName(""), "telegram-file.bin");
});

test("downloadPath always stays under the requested root", () => {
    const path = require("node:path");
    const root = path.resolve("test-download-root");
    const output = userbot.downloadPath(root, "../../dump.txt", 42);
    assert.equal(path.dirname(output), root);
    assert.match(path.basename(output), /^dump_42_.*\.txt$/);
});

test("renderSaveError gives specific group and message guidance", () => {
    assert.match(renderSaveError(new Error("ACCOUNT_CANNOT_SEE_CHAT:-100123")), /ACCOUNT CANNOT SEE THIS GROUP/);
    assert.match(renderSaveError(new Error("MESSAGE_NOT_VISIBLE:42")), /MESSAGE NOT VISIBLE/);
    assert.match(renderSaveError(new Error("REPLIED_MESSAGE_HAS_NO_MEDIA:42")), /NO DOWNLOADABLE FILE/);
});

test("date formatting and decrementing utilities work correctly", () => {
    const d = new Date(2026, 8, 20); // 20.09.2026
    assert.equal(userbot.formatDateDmy(d), "20.09.2026");

    const prev = userbot.previousDate(d);
    assert.equal(userbot.formatDateDmy(prev), "19.09.2026");

    const parsed = userbot.parseDmyDate("20.09.2026");
    assert.equal(parsed.getDate(), 20);
    assert.equal(parsed.getMonth(), 8);
    assert.equal(parsed.getFullYear(), 2026);
});

test("isSearcherForward handles @ in username and chat/channel forwards", () => {
    const searchOptions = { botUsername: "@DumpNews14Bot" };
    const meta = { searcherBotId: 8844520471 };

    const chanForward = {
        from: { is_bot: false, id: 999 },
        message: {
            message_id: 10,
            forward_origin: { type: "channel", chat: { id: 8844520471, username: "DumpNews14Bot" } },
            document: { file_id: "doc1" },
        },
    };
    assert.equal(isSearcherForward(chanForward, meta, searchOptions), true);
});

test("detectLatestBatchDate extracts the latest batch date from menu buttons", () => {
    const mockMenu = {
        replyMarkup: {
            rows: [
                {
                    buttons: [
                        { text: "📅 19.09.2026", data: Buffer.from("folder:19.09.2026:0") },
                        { text: "📅 18.09.2026", data: Buffer.from("folder:18.09.2026:0") },
                    ],
                },
                {
                    buttons: [
                        { text: "⬅️", data: Buffer.from("menu:page:0") },
                        { text: "➡️", data: Buffer.from("menu:page:1") },
                    ],
                },
            ],
        },
    };
    const detected = userbot.detectLatestBatchDate(mockMenu);
    assert.ok(detected instanceof Date);
    assert.equal(userbot.formatDateDmy(detected), "19.09.2026");

    assert.equal(userbot.detectLatestBatchDate(null), null);
    assert.equal(userbot.detectLatestBatchDate({}), null);
});

test("renderServerFiles and scanDirFiles formats file vault with animated emojis", () => {
    const { scanDirFiles } = require("../src/bot");
    const { renderServerFiles, serverFilesKeyboard } = require("../src/messages");

    const out = renderServerFiles({
        rawFiles: [
            { name: "dump-2026-09-20.zip", size: 104857600, mtime: new Date() },
            { name: "group-file.txt", size: 5242880, mtime: new Date() },
        ],
        processedFiles: [
            { name: "cleaned_dump.txt", size: 20971520, mtime: new Date() },
        ],
        rawRoot: "/var/data",
        processedRoot: "/var/data/processed",
        humanSize: (n) => `${Math.round(n / (1024 * 1024))} MB`,
    });

    assert.match(out, /SERVER.*FILES VAULT/);
    assert.match(out, /dump-2026-09-20\.zip/);
    assert.match(out, /cleaned_dump\.txt/);
    assert.match(out, /\/var\/data/);

    const kb = serverFilesKeyboard();
    assert.ok(kb.reply_markup.inline_keyboard.length >= 2);
});

test("renderUlpDone renders completed status card with query and count", () => {
    const { renderUlpDone } = require("../src/messages");
    const out = renderUlpDone({ query: "example.com", count: 7 });
    assert.match(out, /ULP SEARCH COMPLETED/);
    assert.match(out, /example\.com/);
    assert.match(out, /<b>7<\/b> message/);
});

test("searchDayByDay sends /start first, selects date folder, then writes domain only on first iteration", async () => {
    const actions = [];
    const cfg = {
        apiId: 12345,
        apiHash: "hash",
        session: "session",
        searcher: "DumpNews14Bot",
        transport: "userbot",
    };

    let msgCounter = 100;
    const date1 = "21.09.2026";
    const date2 = "20.09.2026";

    // Inventory-first flow needs both dump dates visible on the root menu.
    const mockRootMenu = {
        id: ++msgCounter,
        out: false,
        replyMarkup: {
            rows: [
                {
                    buttons: [
                        { text: `📅 ${date1}`, data: Buffer.from(`folder:${date1}:0`) },
                        { text: `📅 ${date2}`, data: Buffer.from(`folder:${date2}:0`) },
                    ],
                },
            ],
        },
    };

    const mockFolderViewDay1 = {
        id: mockRootMenu.id,
        out: false,
        replyMarkup: {
            rows: [
                { buttons: [{ text: "📦 Full hist", data: Buffer.from(`hist:${date1}:0`) }] },
            ],
        },
    };

    const mockFolderViewDay2 = {
        id: mockRootMenu.id,
        out: false,
        replyMarkup: {
            rows: [
                { buttons: [{ text: "📦 Full hist", data: Buffer.from(`hist:${date2}:0`) }] },
            ],
        },
    };

    let activeFolder = null; // date string currently open

    const mockClient = {
        async sendMessage(target, { message }) {
            actions.push({ type: "sendMessage", message });
            if (message === "/start") activeFolder = null;
            return { id: ++msgCounter, out: true, message };
        },
        async getMessages(target, opts = {}) {
            if (opts.ids && opts.ids.length) {
                if (activeFolder === date1) return [mockFolderViewDay1];
                if (activeFolder === date2) return [mockFolderViewDay2];
                return [mockRootMenu];
            }
            if (activeFolder) {
                const dumpDoc = {
                    id: ++msgCounter,
                    out: false,
                    media: { document: { size: 1024 } },
                    document: { size: 1024 },
                };
                return [dumpDoc, activeFolder === date1 ? mockFolderViewDay1 : mockFolderViewDay2];
            }
            return [mockRootMenu];
        },
        async invoke(req) {
            const dataStr = req.data ? req.data.toString() : "";
            actions.push({ type: "callback", data: dataStr });
            if (dataStr.startsWith(`folder:${date1}`)) activeFolder = date1;
            else if (dataStr.startsWith(`folder:${date2}`)) activeFolder = date2;
            else if (dataStr.startsWith("hist:")) activeFolder = null; // back to root after dump request
            return true;
        },
        async getInputEntity() { return { id: 999 }; },
    };

    const ub = userbot.createUserbot(cfg, {
        client: mockClient,
        searcherEntity: { id: 888 },
    });

    const receivedResults = [];
    const res = await ub.searchDayByDay({
        query: "netflix.com",
        daysCount: 2,
        startDate: new Date("2026-09-21T12:00:00Z"),
        stepDelayMs: 10,
        onResult: (m) => receivedResults.push(m),
        sleep: () => Promise.resolve(),
    });

    assert.equal(res.status, "done");

    // Improved flow: /start once → domain once → folder/hist per day (no re-/start).
    const starts = actions.filter((a) => a.type === "sendMessage" && a.message === "/start");
    assert.equal(starts.length, 1, "/start should be sent exactly once for the whole run");
    assert.equal(actions[0].type, "sendMessage");
    assert.equal(actions[0].message, "/start");

    const domainSends = actions.filter((a) => a.type === "sendMessage" && a.message === "netflix.com");
    assert.equal(domainSends.length, 1, "Domain query should only be sent once");

    const folderClicks = actions.filter((a) => a.type === "callback" && String(a.data || "").startsWith("folder:"));
    const histClicks = actions.filter((a) => a.type === "callback" && String(a.data || "").startsWith("hist:"));
    assert.ok(folderClicks.some((a) => a.data === `folder:${date1}:0`), "expected day1 folder click");
    assert.ok(folderClicks.some((a) => a.data === `folder:${date2}:0`), "expected day2 folder click");
    assert.ok(histClicks.some((a) => a.data === `hist:${date1}:0`), "expected day1 hist click");
    assert.ok(histClicks.some((a) => a.data === `hist:${date2}:0`), "expected day2 hist click");

    // Domain is set before walking days (or once on first folder) — never repeated mid-run after hist pairs.
    const firstDomainIdx = actions.findIndex((a) => a.type === "sendMessage" && a.message === "netflix.com");
    const lastStartIdx = actions.findIndex((a) => a.type === "sendMessage" && a.message === "/start");
    assert.ok(firstDomainIdx > lastStartIdx, "domain should come after the single /start");
});

test("searchDayByDay navigates pagination loop when date folder is on page 2", async () => {
    const actions = [];
    const cfg = {
        apiId: 12345,
        apiHash: "hash",
        session: "session",
        searcher: "DumpNews14Bot",
        transport: "userbot",
    };

    let msgCounter = 200;
    const targetDate = "15.09.2026";

    // Page 1 has other dates and a Next page button
    const page1Msg = {
        id: ++msgCounter,
        out: false,
        replyMarkup: {
            rows: [
                { buttons: [{ text: "📅 21.09.2026", data: Buffer.from("folder:21.09.2026:0") }] },
                { buttons: [{ text: "➡️ Next", data: Buffer.from("menu:page:1") }] },
            ],
        },
    };

    // Page 2 has the target date
    const page2Msg = {
        id: page1Msg.id,
        out: false,
        replyMarkup: {
            rows: [
                { buttons: [{ text: `📅 ${targetDate}`, data: Buffer.from(`folder:${targetDate}:0`) }] },
            ],
        },
    };

    const folderViewMsg = {
        id: page1Msg.id,
        out: false,
        replyMarkup: {
            rows: [
                { buttons: [{ text: "📦 Full hist", data: Buffer.from(`hist:${targetDate}:0`) }] },
            ],
        },
    };

    let currentPage = 0;
    let folderOpened = false;

    const mockClient = {
        async sendMessage(target, { message }) {
            actions.push({ type: "sendMessage", message });
            return { id: ++msgCounter, out: true, message };
        },
        async getMessages(target, opts = {}) {
            if (opts.ids && opts.ids.length) {
                if (folderOpened) return [folderViewMsg];
                return currentPage === 0 ? [page1Msg] : [page2Msg];
            }
            if (folderOpened) {
                return [{ id: ++msgCounter, out: false, media: { document: { size: 500 } } }, folderViewMsg];
            }
            return currentPage === 0 ? [page1Msg] : [page2Msg];
        },
        async invoke(req) {
            const dataStr = req.data ? req.data.toString() : "";
            actions.push({ type: "callback", data: dataStr });
            if (dataStr === "menu:page:1") {
                currentPage = 1;
            } else if (dataStr.startsWith("folder:")) {
                folderOpened = true;
            }
            return true;
        },
        async getInputEntity() { return { id: 999 }; },
    };

    const ub = userbot.createUserbot(cfg, {
        client: mockClient,
        searcherEntity: { id: 888 },
    });

    const res = await ub.searchDayByDay({
        query: "paypal.com",
        daysCount: 1,
        startDate: new Date("2026-09-15T12:00:00Z"),
        stepDelayMs: 10,
        sleep: () => Promise.resolve(),
    });

    assert.equal(res.status, "done");

    // Inventory scan pages forward to discover dates, then processes the target folder.
    assert.equal(actions[0].message, "/start");
    assert.ok(
        actions.some((a) => a.type === "callback" && a.data === "menu:page:1"),
        "expected pagination to page 2 during inventory/search",
    );
    assert.ok(
        actions.some((a) => a.type === "callback" && a.data === `folder:${targetDate}:0`),
        "expected folder click for target date on page 2",
    );
    assert.ok(
        actions.some((a) => a.type === "sendMessage" && a.message === "paypal.com"),
        "expected domain query once",
    );
    assert.ok(
        actions.some((a) => a.type === "callback" && a.data === `hist:${targetDate}:0`),
        "expected hist/download click",
    );
});

test("searchDayByDay invokes forwardResult without error when chatId is specified", async () => {
    const cfg = {
        apiId: 12345,
        apiHash: "hash123",
        session: "sess123",
        searcher: "DumpNews14Bot",
        botUsername: "ComboCleanerBot",
    };

    const targetDate = "15.09.2026";
    let msgCounter = 100;
    const actions = [];

    const menuMsg = {
        id: 101,
        message: "Menu",
        replyMarkup: {
            rows: [
                { buttons: [{ text: targetDate, data: Buffer.from(`folder:${targetDate}:0`) }] },
            ],
        },
    };

    const folderViewMsg = {
        id: 102,
        message: `Date folder: ${targetDate}`,
        replyMarkup: {
            rows: [
                { buttons: [{ text: "📦 Full hist", data: Buffer.from(`hist:${targetDate}:0`) }] },
            ],
        },
    };

    let folderOpened = false;
    let forwardCalled = false;

    const mockClient = {
        async sendMessage(target, { message }) {
            actions.push({ type: "sendMessage", message });
            return { id: ++msgCounter, out: true, message };
        },
        async getMessages(target, opts = {}) {
            if (opts.ids && opts.ids.length) {
                return folderOpened ? [folderViewMsg] : [menuMsg];
            }
            if (folderOpened) {
                return [
                    { id: ++msgCounter, out: false, media: { document: { size: 500 } }, message: "dump.txt" },
                    folderViewMsg,
                ];
            }
            return [menuMsg];
        },
        async invoke(req) {
            const dataStr = req.data ? req.data.toString() : "";
            actions.push({ type: "callback", data: dataStr });
            if (dataStr.startsWith("folder:")) folderOpened = true;
            return true;
        },
        async getInputEntity() { return { id: 999 }; },
        async forwardMessages(targetPeer, { messages, fromPeer }) {
            forwardCalled = true;
            actions.push({ type: "forwardMessages", targetPeer, messages });
            return true;
        },
    };

    const ub = userbot.createUserbot(cfg, {
        client: mockClient,
        searcherEntity: { id: 888 },
    });

    const res = await ub.searchDayByDay({
        query: "domain.com",
        daysCount: 1,
        startDate: new Date("2026-09-15T12:00:00Z"),
        chatId: 12345,
        stepDelayMs: 10,
        sleep: () => Promise.resolve(),
    });

    assert.equal(res.status, "done");
    assert.equal(forwardCalled, true, "forwardResult should be called when chatId and results are present");
});

test("searchDayByDay paces day-to-day search with 14 seconds (14000ms) by default", async () => {
    const cfg = {
        apiId: 12345,
        apiHash: "hash",
        session: "session",
        searcher: "DumpNews14Bot",
        transport: "userbot",
    };
    let folderOpened = false;
    const mockClient = {
        async sendMessage(peer, { message }) {
            if (message === "/start") folderOpened = false;
            return { id: 101, message };
        },
        async getMessages(peer, { limit, ids }) {
            if (ids && ids.length) {
                return [{
                    id: 102,
                    replyMarkup: {
                        rows: [
                            {
                                buttons: [
                                    { text: "Download Full History (0.1 MB)", data: Buffer.from("hist:2026-09-15") },
                                ],
                            },
                        ],
                    },
                }];
            }
            if (limit) {
                if (!folderOpened) {
                    return [{
                        id: 102,
                        replyMarkup: {
                            rows: [
                                {
                                    buttons: [
                                        { text: "15.09.2026", data: Buffer.from("folder:15.09.2026:batch") },
                                        { text: "14.09.2026", data: Buffer.from("folder:14.09.2026:batch") },
                                    ],
                                },
                            ],
                        },
                    }];
                } else {
                    return [
                        { id: 105, text: "Result dump document", media: { document: { id: 777 } } },
                    ];
                }
            }
            return [];
        },
        async invoke(req) {
            const dataStr = req.data ? req.data.toString() : "";
            if (dataStr.startsWith("folder:")) folderOpened = true;
            return true;
        },
        async getInputEntity() { return { id: 999 }; },
    };

    const ub = userbot.createUserbot(cfg, {
        client: mockClient,
        searcherEntity: { id: 888 },
    });

    const sleeps = [];
    const res = await ub.searchDayByDay({
        query: "domain.com",
        daysCount: 2,
        startDate: new Date("2026-09-15T12:00:00Z"),
        sleep: async (ms) => { sleeps.push(ms); },
    });

    assert.equal(res.status, "done");
    assert.ok(sleeps.includes(14000), `expected sleep(14000) for pacing between days, got: ${JSON.stringify(sleeps)}`);
});






