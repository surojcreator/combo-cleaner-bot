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
    const ctx = { telegram: { sendMessage: async () => true } };
    const searchOptions = { botUsername: "DumpNews14Bot", transport: "auto" };

    const ready = { isReady: () => true, send: async (t) => ({ message_id: 1, chat: { id: 7 } }), classify: () => "other" };
    assert.equal(pickTransport({ userbot: ready }, searchOptions, ctx).kind, "userbot");

    const down = { isReady: () => false, send: async () => true, classify: () => "other" };
    assert.equal(pickTransport({ userbot: down }, searchOptions, ctx).kind, "bot");
    assert.equal(pickTransport({}, searchOptions, ctx).kind, "bot");

    const forcedDown = pickTransport({ userbot: down }, { botUsername: "DumpNews14Bot", transport: "userbot" }, ctx);
    assert.equal(forcedDown.kind, "userbot");
    assert.equal(forcedDown.classify(new Error("x")), "userbot_not_ready");
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

    const mockMenuDay1 = {
        id: ++msgCounter,
        out: false,
        replyMarkup: {
            rows: [
                { buttons: [{ text: `📅 ${date1}`, data: Buffer.from(`folder:${date1}:0`) }] },
            ],
        },
    };

    const mockFolderViewDay1 = {
        id: mockMenuDay1.id,
        out: false,
        replyMarkup: {
            rows: [
                { buttons: [{ text: "📦 Full hist", data: Buffer.from(`hist:${date1}:0`) }] },
            ],
        },
    };

    const mockMenuDay2 = {
        id: ++msgCounter,
        out: false,
        replyMarkup: {
            rows: [
                { buttons: [{ text: `📅 ${date2}`, data: Buffer.from(`folder:${date2}:0`) }] },
            ],
        },
    };

    const mockFolderViewDay2 = {
        id: mockMenuDay2.id,
        out: false,
        replyMarkup: {
            rows: [
                { buttons: [{ text: "📦 Full hist", data: Buffer.from(`hist:${date2}:0`) }] },
            ],
        },
    };

    let currentDay = 1;
    let folderOpened = false;

    const mockClient = {
        async sendMessage(target, { message }) {
            actions.push({ type: "sendMessage", message });
            return { id: ++msgCounter, out: true, message };
        },
        async getMessages(target, opts = {}) {
            if (opts.ids && opts.ids.length) {
                if (currentDay === 1 && folderOpened) return [mockFolderViewDay1];
                if (currentDay === 2 && folderOpened) return [mockFolderViewDay2];
                return currentDay === 1 ? [mockMenuDay1] : [mockMenuDay2];
            }
            if (folderOpened) {
                const dumpDoc = {
                    id: ++msgCounter,
                    out: false,
                    media: { document: { size: 1024 } },
                    document: { size: 1024 },
                };
                return [dumpDoc, currentDay === 1 ? mockFolderViewDay1 : mockFolderViewDay2];
            }
            return currentDay === 1 ? [mockMenuDay1] : [mockMenuDay2];
        },
        async invoke(req) {
            const dataStr = req.data ? req.data.toString() : "";
            actions.push({ type: "callback", data: dataStr });
            if (dataStr.startsWith("folder:")) {
                folderOpened = true;
            } else if (dataStr.startsWith("hist:")) {
                currentDay = 2;
                folderOpened = false;
            }
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

    // Sequence checks:
    // 1. First sendMessage must be "/start"
    assert.equal(actions[0].type, "sendMessage");
    assert.equal(actions[0].message, "/start");

    // 2. Second action must be selecting the date folder
    assert.equal(actions[1].type, "callback");
    assert.equal(actions[1].data, `folder:${date1}:0`);

    // 3. Third action must be writing the domain query
    assert.equal(actions[2].type, "sendMessage");
    assert.equal(actions[2].message, "netflix.com");

    // 4. Fourth action is clicking hist
    assert.equal(actions[3].type, "callback");
    assert.equal(actions[3].data, `hist:${date1}:0`);

    // Day 2 checks:
    // 5. Day 2 starts with "/start"
    assert.equal(actions[4].type, "sendMessage");
    assert.equal(actions[4].message, "/start");

    // 6. Day 2 selects date 2
    assert.equal(actions[5].type, "callback");
    assert.equal(actions[5].data, `folder:${date2}:0`);

    // 7. Day 2 clicks hist (domain is NOT sent again!)
    assert.equal(actions[6].type, "callback");
    assert.equal(actions[6].data, `hist:${date2}:0`);

    // Domain is ONLY sent once in the whole run
    const domainSends = actions.filter((a) => a.type === "sendMessage" && a.message === "netflix.com");
    assert.equal(domainSends.length, 1, "Domain query should only be sent for the first time");
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

    // Action sequence:
    // 1. sendMessage: "/start"
    // 2. callback: "menu:page:1" (navigated to page 2!)
    // 3. callback: "folder:15.09.2026:0" (selected date on page 2!)
    // 4. sendMessage: "paypal.com" (domain sent after date selected!)
    // 5. callback: "hist:15.09.2026:0"
    assert.equal(actions[0].message, "/start");
    assert.equal(actions[1].data, "menu:page:1");
    assert.equal(actions[2].data, `folder:${targetDate}:0`);
    assert.equal(actions[3].message, "paypal.com");
    assert.equal(actions[4].data, `hist:${targetDate}:0`);
});




