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
