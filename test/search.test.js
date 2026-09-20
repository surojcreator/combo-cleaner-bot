"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../src/store");
const { renderSearch } = require("../src/messages");

test("searchLines finds case-insensitive substring matches", () => {
    store.clear(111);
    store.addLines(111, ["User@Example.com:pass1", "other@mail.com:pass2", "4111111111111111|08|27|123"]);
    const r = store.searchLines(111, "example.com");
    assert.equal(r.total, 1);
    assert.deepEqual(r.matches, ["User@Example.com:pass1"]);
    store.clear(111);
});

test("searchLines caps matches but reports the full total", () => {
    store.clear(222);
    const lines = Array.from({ length: 30 }, (_, i) => `user${i}@gmail.com:pass${i}`);
    store.addLines(222, lines);
    const r = store.searchLines(222, "gmail.com", 20);
    assert.equal(r.total, 30);
    assert.equal(r.matches.length, 20);
    store.clear(222);
});

test("searchLines returns empty for no match or empty query", () => {
    store.clear(333);
    store.addLines(333, ["a@b.com:x"]);
    assert.deepEqual(store.searchLines(333, "zzz"), { total: 0, matches: [] });
    assert.deepEqual(store.searchLines(333, ""), { total: 0, matches: [] });
    store.clear(333);
});

test("renderSearch shows hits, empty state and truncation note", () => {
    const hit = renderSearch("gmail", { total: 1, matches: ["a@gmail.com:x"] });
    assert.match(hit, /1.*hit/);
    assert.match(hit, /a@gmail\.com:x/);
    assert.match(renderSearch("zzz", { total: 0, matches: [] }), /No matches/);
    const many = renderSearch("gmail", { total: 30, matches: Array(20).fill("a@gmail.com:x") });
    assert.match(many, /first 20 of 30/);
});
