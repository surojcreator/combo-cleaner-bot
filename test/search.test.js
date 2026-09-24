"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../src/store");
const { renderSearch, renderFileSearchProgress, fileSearchProgressKeyboard, renderLocalSearch } = require("../src/messages");

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

test("renderSearch returns cleaned user:password only, stripping URLs and domain prefixes", () => {
    const rawMatches = [
        "https://rewards.example.com/login:user1@test.com:pass123",
        "service.com:john_doe:SecretPass",
        "plain_user:simplepass",
    ];
    const rendered = renderSearch("test", { total: 3, matches: rawMatches });
    assert.match(rendered, /<code>user1@test\.com:pass123<\/code>/);
    assert.match(rendered, /<code>john_doe:SecretPass<\/code>/);
    assert.match(rendered, /<code>plain_user:simplepass<\/code>/);
    assert.doesNotMatch(rendered, /https:\/\/rewards\.example\.com/);
    assert.doesNotMatch(rendered, /service\.com:john_doe/);
});

test("search export cleans and deduplicates credentials into user:password format", () => {
    const rawMatches = [
        "https://rewards.example.com/login:user1@test.com:pass123",
        "https://rewards.example.com/account:user1@test.com:pass123", // duplicate user:pass from diff url
        "service.com:john_doe:SecretPass",
        "plain_user:simplepass",
    ];
    const { cleanUserPassOnly } = require("../src/cleaner");
    const cleanedLines = [];
    const seen = new Set();
    for (const m of rawMatches) {
        const clean = cleanUserPassOnly(m) || m;
        if (!seen.has(clean)) {
            seen.add(clean);
            cleanedLines.push(clean);
        }
    }
    assert.deepEqual(cleanedLines, [
        "user1@test.com:pass123",
        "john_doe:SecretPass",
        "plain_user:simplepass",
    ]);
});

test("renderFileSearchProgress formats dynamic visual progress bar and file metrics", () => {
    const singleCard = renderFileSearchProgress({
        query: "gmail.com",
        fileName: "combo.txt",
        fileSize: 1048576,
        current: 0,
        total: 1,
        matchesCount: 15,
        isAll: false,
    });
    assert.match(singleCard, /FILE SEARCH IN PROGRESS/);
    assert.match(singleCard, /Query:.*gmail\.com/);
    assert.match(singleCard, /Target:.*combo\.txt/);
    assert.match(singleCard, /Search Progress:/);
    assert.match(singleCard, /\[.*\]/);
    assert.match(singleCard, /Matches Found:.*15.*hit/);

    const vaultCard = renderFileSearchProgress({
        query: "root@domain.com",
        fileName: "db_dump.sql",
        current: 5,
        total: 10,
        matchesCount: 42,
        isAll: true,
    });
    assert.match(vaultCard, /SEARCHING ALL VAULT FILES/);
    assert.match(vaultCard, /50%/);
    assert.match(vaultCard, /5\/10 files/);
    assert.match(vaultCard, /42.*hit/);
});

test("fileSearchProgressKeyboard creates dynamic progress status button and cancel button", () => {
    const singleKb = fileSearchProgressKeyboard({ current: 0, total: 1 });
    const singleBtns = singleKb.reply_markup.inline_keyboard.flat();
    assert.ok(singleBtns.some((b) => b.text.includes("Searching…") && b.callback_data === "search:status_bar"));
    assert.ok(singleBtns.some((b) => b.text.includes("Cancel Search") && b.callback_data === "search:cancel"));

    const multiKb = fileSearchProgressKeyboard({ current: 3, total: 10 });
    const multiBtns = multiKb.reply_markup.inline_keyboard.flat();
    assert.ok(multiBtns.some((b) => b.text.includes("File 3/10") && b.text.includes("30%")));
});

test("renderSearch and renderLocalSearch include 100% completed search progress bar", () => {
    const searchRes = renderSearch("test", { total: 2, matches: ["a:b", "c:d"] });
    assert.match(searchRes, /Search Progress:.*100% Scanned/);

    const localRes = renderLocalSearch({ query: "test", total: 1, matches: ["a:b"], fileName: "test.txt" });
    assert.match(localRes, /Search Progress:.*100% Scanned/);
});


