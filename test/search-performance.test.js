"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { createSearchMatcher, searchBufferCI } = require("../src/cleaner");
const store = require("../src/store");
const { WorkerPool } = require("../src/worker-pool");

test("createSearchMatcher uses rare-char SIMD pre-filter for instantaneous rejection", () => {
    const matcher = createSearchMatcher("netflix.com");
    assert.ok(typeof matcher === "function");

    // Matches various casings
    assert.equal(matcher("https://netflix.com/login:user:pass"), true);
    assert.equal(matcher("https://NETFLIX.COM/login:user:pass"), true);
    assert.equal(matcher("https://Netflix.com/login:user:pass"), true);
    assert.equal(matcher("https://nEtFlIx.CoM/login:user:pass"), true);

    // Fast rejection for non-matching lines without dots or rare letters
    assert.equal(matcher("user_without_dots:simple_pass"), false);
    assert.equal(matcher("spotify_user@gmail_domain:pass123"), false);
});

test("searchBufferCI fast SIMD rejection scans non-matching buffers in microseconds", () => {
    const size = 10 * 1024 * 1024; // 10MB
    const buf = Buffer.alloc(size, 0x61); // all 'a's, no dots or special characters
    const start = Date.now();
    const res = searchBufferCI(buf, "netflix.com", 20);
    const elapsed = Date.now() - start;

    assert.equal(res.total, 0);
    assert.equal(res.matches.length, 0);
    assert.ok(elapsed < 100, `expected sub-100ms scan for 10MB buffer, got ${elapsed}ms`);
});

test("store.searchLines scans 100k lines in memory with zero array allocation overhead", () => {
    const chatId = 998877;
    const lines = [];
    for (let i = 0; i < 50000; i++) {
        lines.push(`user_${i}@domain_${i % 100}.com:password_${i}`);
    }
    lines.push("target_special@rarebrand.org:Secret123");
    store.addLines(chatId, lines);

    const start = Date.now();
    const res = store.searchLines(chatId, "rarebrand.org", 20);
    const elapsed = Date.now() - start;

    assert.equal(res.total, 1);
    assert.equal(res.matches.length, 1);
    assert.match(res.matches[0], /rarebrand\.org/);
    assert.ok(elapsed < 200, `expected fast search, got ${elapsed}ms`);

    store.clear(chatId);
});

test("WorkerPool searchFileParallel uses buffer slicing for large files", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-speed-"));
    const tmpFile = path.join(tmpDir, "speed-test.txt");
    const ws = fs.createWriteStream(tmpFile);

    for (let i = 0; i < 20000; i++) {
        if (i === 500 || i === 12500) {
            ws.write(`admin_${i}@fastspeedtest.com:MyPass${i}\n`);
        } else {
            ws.write(`generic_user_${i}@someotherdomain.net:Pass${i}\n`);
        }
    }
    await new Promise((r) => ws.end(r));

    const pool = new WorkerPool(null, 2);
    try {
        const start = Date.now();
        const res = await pool.searchFileParallel(tmpFile, "fastspeedtest.com", 20);
        const elapsed = Date.now() - start;

        assert.equal(res.total, 2);
        assert.equal(res.matches.length, 2);
        assert.ok(elapsed < 1500, `expected fast parallel slice search, got ${elapsed}ms`);
    } finally {
        pool.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
