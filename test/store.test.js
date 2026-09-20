"use strict";

const test = require("node:test");
const assert = require("node:assert");
const store = require("../src/store");

test("addLines dedupes and tracks sites", () => {
    const chatId = -12345; // unique test chat
    store.clear(chatId);

    const first = store.addLines(chatId, ["a@x.com:pw", "b@x.com:pw"], "netflix.com");
    assert.strictEqual(first.added, 2);
    assert.strictEqual(first.duplicates, 0);

    const second = store.addLines(chatId, ["a@x.com:pw", "c@x.com:pw"], "netflix.com");
    assert.strictEqual(second.added, 1);
    assert.strictEqual(second.duplicates, 1);

    assert.deepStrictEqual(store.getSites(chatId), ["netflix.com"]);
    assert.strictEqual(store.getStats(chatId).size, 3);
    assert.strictEqual(store.getStats(chatId).sites, 1);
    store.clear(chatId);
});

test("mixed sites are all tracked in order", () => {
    const chatId = -12346;
    store.clear(chatId);
    store.addLines(chatId, ["a@x.com:pw"], "netflix.com");
    store.addLines(chatId, ["b@x.com:pw"], "spotify");
    store.addLines(chatId, ["c@x.com:pw"], "netflix.com");
    assert.deepStrictEqual(store.getSites(chatId), ["netflix.com", "spotify"]);
    assert.strictEqual(store.getStats(chatId).sites, 2);
    store.clear(chatId);
});

test("same-site name variants collapse to one site", () => {
    const chatId = -12348;
    store.clear(chatId);
    store.addLines(chatId, ["a@x.com:pw"], "netflix.com");
    store.addLines(chatId, ["b@x.com:pw"], "netflix");
    assert.deepStrictEqual(store.getSites(chatId), ["netflix.com"]);
    assert.strictEqual(store.getStats(chatId).sites, 1);
    store.clear(chatId);
});

test("clear wipes lines and sites", () => {
    const chatId = -12347;
    store.addLines(chatId, ["a@x.com:pw"], "netflix.com");
    assert.strictEqual(store.clear(chatId), true);
    assert.deepStrictEqual(store.getLines(chatId), []);
    assert.deepStrictEqual(store.getSites(chatId), []);
    assert.strictEqual(store.getStats(chatId), null);
});

test("store allows configuring MAX_LINES_PER_CHAT and supports >2M lines without capping", () => {
    const orig = process.env.MAX_LINES_PER_CHAT;
    try {
        process.env.MAX_LINES_PER_CHAT = "5000000";
        assert.equal(store.getMaxLinesPerChat(), 5_000_000);
        assert.equal(store.MAX_LINES_PER_CHAT, 5_000_000);

        // Unlimited when 0
        process.env.MAX_LINES_PER_CHAT = "0";
        assert.equal(store.getMaxLinesPerChat(), Infinity);

        // Custom cap
        process.env.MAX_LINES_PER_CHAT = "10";
        const chatId = -99999;
        store.clear(chatId);
        const lines = [];
        for (let i = 0; i < 15; i++) lines.push(`user${i}@mail.com:pw${i}`);
        const res = store.addLines(chatId, lines, "testsite");
        assert.equal(res.added, 10);
        assert.equal(res.capped, true);
        assert.equal(res.size, 10);
        store.clear(chatId);
    } finally {
        if (orig !== undefined) process.env.MAX_LINES_PER_CHAT = orig;
        else delete process.env.MAX_LINES_PER_CHAT;
    }
});

test("store tracks memory stats across chats", () => {
    const chatId1 = -88881;
    const chatId2 = -88882;
    store.clear(chatId1);
    store.clear(chatId2);

    store.addLines(chatId1, ["u1@x.com:pw", "u2@x.com:pw"], "site1");
    store.addLines(chatId2, ["u3@x.com:pw"], "site2");

    const mem = store.getMemoryStats();
    assert.ok(mem.activeChats >= 2);
    assert.ok(mem.totalLines >= 3);
    assert.ok(mem.maxLinesPerChat > 0);

    store.clear(chatId1);
    store.clear(chatId2);
});

