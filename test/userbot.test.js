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


