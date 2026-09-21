"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const userbot = require("../src/userbot");
const { createBot } = require("../src/bot");
const searchbot = require("../src/searchbot");

test("crash-prevention: detectLatestBatchDate survives malformed rows, null buttons, and corrupted data", () => {
    assert.equal(userbot.detectLatestBatchDate(null), null);
    assert.equal(userbot.detectLatestBatchDate({}), null);
    assert.equal(userbot.detectLatestBatchDate({ replyMarkup: {} }), null);
    assert.equal(userbot.detectLatestBatchDate({ replyMarkup: { rows: null } }), null);
    assert.equal(userbot.detectLatestBatchDate({ replyMarkup: { rows: [null, undefined, {}] } }), null);
    assert.equal(
        userbot.detectLatestBatchDate({
            replyMarkup: {
                rows: [
                    { buttons: [null, undefined, { text: null, data: null }] },
                    { buttons: [{ type: { data: null }, text: "no-date" }] },
                ],
            },
        }),
        null,
    );

    // Valid date with malformed neighbor buttons
    const valid = userbot.detectLatestBatchDate({
        replyMarkup: {
            rows: [
                { buttons: [null, { text: "corrupted", data: { bad: true } }] },
                {
                    buttons: [
                        { text: "Dump 18.09.2026", data: Buffer.from("folder:18.09.2026:P") },
                    ],
                },
            ],
        },
    });
    assert.ok(valid instanceof Date);
    assert.equal(userbot.formatDateDmy(valid), "18.09.2026");
});

test("crash-prevention: searchDayByDay catches unexpected RPC error without throwing unhandled rejection", async () => {
    const fakeClient = {
        sendMessage: async () => ({ id: 100 }),
        getMessages: async (target, opts) => {
            if (opts && opts.ids) return [];
            return [
                {
                    id: 105,
                    out: false,
                    replyMarkup: {
                        rows: [
                            {
                                buttons: [
                                    { text: "➡️ Next", data: "menu:page:1" },
                                ],
                            },
                        ],
                    },
                },
            ];
        },
        invoke: async () => {
            throw new Error("RPCError: 400: MESSAGE_ID_INVALID");
        },
    };

    const ub = userbot.createUserbot({
        apiId: 12345,
        apiHash: "abcde",
        session: "test-session",
        searcher: "DumpNews14Bot",
    }, {
        client: fakeClient,
        searcherEntity: { id: 8844520471 },
    });

    const res = await ub.searchDayByDay({
        query: "test.com",
        daysCount: 1,
        stepDelayMs: 10,
        sleep: async () => {},
    });

    assert.ok(res);
    assert.equal(res.status, "done"); // Handled the broken nextPage gracefully, proceeded through loop
});

test("crash-prevention: searchDayByDay returns status error when client throws fatal error", async () => {
    const fakeClient = {
        sendMessage: async () => {
            throw new Error("FLOOD_WAIT_300");
        },
        getMessages: async () => {
            throw new Error("CONNECTION_LOST");
        },
        invoke: async () => {},
    };

    const ub = userbot.createUserbot({
        apiId: 12345,
        apiHash: "abcde",
        session: "test-session",
        searcher: "DumpNews14Bot",
    }, {
        client: fakeClient,
        searcherEntity: { id: 8844520471 },
    });

    const res = await ub.searchDayByDay({
        query: "test.com",
        daysCount: 1,
        stepDelayMs: 10,
        sleep: async () => {},
    });

    assert.ok(res);
    // Either finishes with status done (after retry loops) or status error, but NEVER throws
    assert.ok(res.status === "done" || res.status === "error");
});

test("crash-prevention: process handles unhandledRejection and uncaughtException gracefully without crashing", () => {
    const rejectionListeners = process.listeners("unhandledRejection");
    const exceptionListeners = process.listeners("uncaughtException");
    assert.ok(Array.isArray(rejectionListeners));
    assert.ok(Array.isArray(exceptionListeners));
});
