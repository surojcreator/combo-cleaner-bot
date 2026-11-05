"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { checkConfig, maskSession, defaultRoots, probeWritable, EXIT } = require("../scripts/userbot-doctor");

const VALID_SESSION = "1".repeat(120);

test("doctor: reports each missing secret separately", () => {
    const r = checkConfig({});
    assert.equal(r.ready, false);
    assert.equal(r.problems.length, 3);
    assert.match(r.problems.join("\n"), /TELEGRAM_API_ID/);
    assert.match(r.problems.join("\n"), /TELEGRAM_API_HASH/);
    assert.match(r.problems.join("\n"), /TELEGRAM_SESSION/);
});

test("doctor: rejects an api_hash that is not 32 hex chars", () => {
    const r = checkConfig({
        TELEGRAM_API_ID: "12345",
        TELEGRAM_API_HASH: "not-a-hash",
        TELEGRAM_SESSION: VALID_SESSION,
    });
    assert.equal(r.ready, false);
    assert.match(r.problems.join("\n"), /32 hex/);
});

test("doctor: accepts a complete credential set and reads the searcher", () => {
    const r = checkConfig({
        TELEGRAM_API_ID: "12345",
        TELEGRAM_API_HASH: "a".repeat(32),
        TELEGRAM_SESSION: VALID_SESSION,
        SEARCH_BOT_USERNAME: "@DumpNews14Bot",
    });
    assert.equal(r.ready, true);
    assert.equal(r.apiId, 12345);
    assert.equal(r.searcher, "DumpNews14Bot");
});

test("doctor: flags a session that is too short to be real", () => {
    const r = checkConfig({
        TELEGRAM_API_ID: "12345",
        TELEGRAM_API_HASH: "a".repeat(32),
        TELEGRAM_SESSION: "abc",
    });
    assert.equal(r.ready, false);
    assert.match(r.problems.join("\n"), /too short/);
});

test("doctor: masks sessions without leaking the secret", () => {
    assert.equal(maskSession(""), "(empty)");
    assert.equal(maskSession("short"), "shor…5 chars");
    const masked = maskSession(VALID_SESSION);
    assert.ok(masked.length < 40);
    assert.ok(!masked.includes(VALID_SESSION));
    assert.match(masked, /120 chars/);
});

test("doctor: storage roots differ per platform", () => {
    assert.deepEqual(defaultRoots("linux"), {
        root: "/var/data",
        processed: "/var/data/processed",
    });
    const win = defaultRoots("win32");
    assert.ok(!win.root.startsWith("/var/data"));
    assert.ok(win.processed.includes("processed"));
});

test("doctor: writable probe creates and cleans its own temp file", () => {
    const os = require("node:os");
    const path = require("node:path");
    const fs = require("node:fs");
    const dir = path.join(os.tmpdir(), `doctor-probe-${process.pid}`);
    const r = probeWritable(dir);
    assert.equal(r.ok, true);
    assert.deepEqual(fs.readdirSync(dir), []);
    fs.rmdirSync(dir);
});

test("doctor: exit codes stay stable for scripting", () => {
    assert.deepEqual(EXIT, { OK: 0, CONFIG: 2, AUTH: 3, SEARCHER: 4, STORAGE: 5 });
});
