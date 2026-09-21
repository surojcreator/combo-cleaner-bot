"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const cleaner = require("../src/cleaner");
const extractor = require("../src/extractor");
const sites = require("../src/sites");
const downloads = require("../src/downloads");
const store = require("../src/store");
const searchbot = require("../src/searchbot");
const userbot = require("../src/userbot");
const messages = require("../src/messages");
const bot = require("../src/bot");

const sampleInputs = [
    undefined,
    null,
    "",
    "   ",
    "test",
    "some/path/file.txt",
    123,
    -1,
    0,
    NaN,
    Infinity,
    true,
    false,
    [],
    [1, 2, 3],
    ["line1", "line2"],
    {},
    { lines: 10, sites: 2, files: 1, bytes: 1000 },
    { name: "test.txt", size: 500, date: new Date() },
    new Date(),
    () => {},
    Symbol("sym"),
    Buffer.from("abc"),
];

test("fuzz: cleaner exports survive arbitrary inputs with zero unhandled crashes", () => {
    const fns = ["cleanLinesArray", "stripLabelPrefixes", "isUrlOrDomain", "isEmail", "isPhone", "cleanLine", "cleanText", "normalizeLine"];
    for (const name of fns) {
        const fn = cleaner[name];
        if (typeof fn !== "function") continue;
        for (const input of sampleInputs) {
            assert.doesNotThrow(() => fn(input), `cleaner.${name} should not throw on ${typeof input}`);
        }
    }
});

test("fuzz: extractor exports survive arbitrary inputs with zero unhandled crashes", () => {
    const fns = ["looksLikeText", "looksLikeZip", "isZipBuffer", "mergeZipFiles"];
    for (const name of fns) {
        const fn = extractor[name];
        if (typeof fn !== "function") continue;
        for (const input of sampleInputs) {
            assert.doesNotThrow(() => fn(input), `extractor.${name} should not throw on ${typeof input}`);
        }
    }
});

test("fuzz: sites exports survive arbitrary inputs with zero unhandled crashes", () => {
    const fns = ["isFreemail", "sanitizeSiteSlug", "detectSite"];
    for (const name of fns) {
        const fn = sites[name];
        if (typeof fn !== "function") continue;
        for (const input of sampleInputs) {
            assert.doesNotThrow(() => fn(input), `sites.${name} should not throw on ${typeof input}`);
        }
    }
});

test("fuzz: downloads exports survive arbitrary inputs with zero unhandled crashes", () => {
    assert.doesNotThrow(() => downloads.registerDownload(null));
    assert.doesNotThrow(() => downloads.registerDownload(undefined));
    assert.doesNotThrow(() => downloads.isDownloadRequest(null));
    assert.doesNotThrow(() => downloads.handleDownloadRequest(null, null));
    assert.doesNotThrow(() => downloads.handleDownloadRequest({}, {}));
    assert.doesNotThrow(() => downloads.purgeExpired());
});

test("fuzz: store exports survive arbitrary inputs with zero unhandled crashes", () => {
    const testChatId = 999999999;
    try {
        for (const input of sampleInputs) {
            assert.doesNotThrow(() => store.addLines(testChatId, input));
        }
    } finally {
        store.clear(testChatId);
    }
});

test("fuzz: searchbot exports survive arbitrary inputs with zero unhandled crashes", () => {
    assert.doesNotThrow(() => searchbot.loadOptions(null));
    assert.doesNotThrow(() => searchbot.loadOptions({}));
    assert.doesNotThrow(() => searchbot.startRun(null, null, null));
    assert.doesNotThrow(() => searchbot.noteResult(null, null));
    assert.doesNotThrow(() => searchbot.mostRecentRun(null, null));
});

test("fuzz: userbot exports survive arbitrary inputs with zero unhandled crashes", () => {
    assert.doesNotThrow(() => userbot.loadConfig(null));
    assert.doesNotThrow(() => userbot.downloadPath(null, null));
    assert.doesNotThrow(() => userbot.formatDateDmy(null));
    assert.doesNotThrow(() => userbot.previousDate(null));
});

test("fuzz: messages exports survive arbitrary inputs with zero unhandled crashes", () => {
    for (const [name, fn] of Object.entries(messages)) {
        if (typeof fn !== "function") continue;
        for (const input of sampleInputs) {
            assert.doesNotThrow(() => fn(input), `messages.${name} should not throw on ${typeof input}`);
        }
    }
});

test("fuzz: bot sync exports survive arbitrary inputs with zero unhandled crashes", () => {
    const syncFns = [
        "buildOutput",
        "humanSize",
        "escapeHtml",
        "parseUlpArg",
        "isSearcherMessage",
        "isSearcherForward",
        "isForwardedDocument",
        "pickTransport",
        "processedOutputPath",
        "renderSaveError",
        "stripButtonEmojis",
    ];
    for (const name of syncFns) {
        const fn = bot[name];
        if (typeof fn !== "function") continue;
        for (const input of sampleInputs) {
            assert.doesNotThrow(() => fn(input), `bot.${name} should not throw on ${typeof input}`);
        }
    }
});

test("fuzz: date parsing rejects invalid days/months and prevents date rollover", () => {
    assert.equal(userbot.parseDmyDate("31.02.2025"), null);
    assert.equal(userbot.parseDmyDate("35.13.2025"), null);
    assert.equal(userbot.parseDmyDate("00.01.2025"), null);
    assert.equal(userbot.parseDmyDate("31.04.2025"), null); // April has 30 days
    const valid = userbot.parseDmyDate("15.08.2025");
    assert.ok(valid instanceof Date);
    assert.equal(valid.getFullYear(), 2025);
    assert.equal(valid.getMonth(), 7);
    assert.equal(valid.getDate(), 15);
});

test("fuzz: parseChannelFilename validates integer messageId", () => {
    assert.deepEqual(userbot.parseChannelFilename("@channel - 123.txt"), { peer: "@channel", messageId: 123 });
    assert.equal(userbot.parseChannelFilename("@channel - 0.txt"), null);
    assert.equal(userbot.parseChannelFilename("@channel - -5.txt"), null);
    assert.equal(userbot.parseChannelFilename(""), null);
    assert.equal(userbot.parseChannelFilename(null), null);
});

test("regression: callback_data limits and payload registration guarantee <= 64 bytes", () => {
    const longDomain = "super-long-subdomain-that-normally-breaks-telegram.enterprise-telecom-cluster.co.uk";
    const reg = messages.registerCallbackPayload("site:del:ask:", longDomain);
    assert.ok(Buffer.byteLength(reg, "utf8") <= 64, `Expected <= 64 bytes, got ${Buffer.byteLength(reg, "utf8")}`);
    assert.ok(reg.startsWith("site:del:ask:ref:"));
    const resolved = messages.resolveCallbackPayload(reg.slice("site:del:ask:".length));
    assert.equal(resolved, longDomain);

    // Short strings remain untouched
    const short = messages.registerCallbackPayload("site:del:ask:", "netflix.com");
    assert.equal(short, "site:del:ask:netflix.com");
    assert.equal(messages.resolveCallbackPayload("netflix.com"), "netflix.com");

    // Universal inline keyboard guard shortens any oversized button callback
    const kb = messages.createInlineKeyboard([
        [{ text: "Test", callback_data: `custom:action:${"a".repeat(100)}` }]
    ]);
    const btn = kb.reply_markup.inline_keyboard[0][0];
    assert.ok(Buffer.byteLength(btn.callback_data, "utf8") <= 64);
});

test("regression: handleDownloadRequest handles missing or non-string entry.filename without throwing", () => {
    let statusCode = null;
    let headers = null;
    const req = { method: "GET", url: "/download/fake-token" };
    const res = {
        writeHead: (code, h) => {
            statusCode = code;
            headers = h;
        },
        end: () => {},
        on: () => {},
    };

    // Test with invalid token (404)
    assert.doesNotThrow(() => downloads.handleDownloadRequest(req, res));
    assert.equal(statusCode, 404);

    // Test with valid token whose file was deleted from disk and no buffer
    const reg = downloads.registerDownload({
        filename: "missing.txt",
        filePath: "c:/nonexistent_file_path_12345.txt",
        size: 500,
    });
    const reqMissing = { method: "GET", url: `/download/${reg.token}` };
    downloads.handleDownloadRequest(reqMissing, res);
    assert.equal(statusCode, 404);
});

test("regression: mergeZipFiles handles Buffer items, avoids root '/' directory, and produces valid output", () => {
    const AdmZip = require("adm-zip");
    const zip1 = new AdmZip();
    zip1.addFile("test1.txt", Buffer.from("test1 content"));
    const buf1 = zip1.toBuffer();

    const zip2 = new AdmZip();
    zip2.addFile("test2.txt", Buffer.from("test2 content"));
    const buf2 = zip2.toBuffer();

    // Passing array of raw Buffers
    const resRaw = extractor.mergeZipFiles([buf1, buf2]);
    assert.ok(Buffer.isBuffer(resRaw.buffer));
    assert.equal(resRaw.entryCount, 2);

    // Passing array of { name, buffer }
    const resObj = extractor.mergeZipFiles([
        { name: "archive1.zip", buffer: buf1 },
        { name: "archive2.zip", buffer: buf2 },
    ]);
    assert.ok(Buffer.isBuffer(resObj.buffer));
    assert.equal(resObj.entryCount, 2);

    // Verify parsed merged entries have no "/" root directory
    const parsed = new AdmZip(resObj.buffer);
    const entryNames = parsed.getEntries().map((e) => e.entryName);
    assert.ok(!entryNames.includes("/"), "Archive must not contain an invalid '/' entry");
    assert.ok(entryNames.includes("test1.txt"));
    assert.ok(entryNames.includes("test2.txt"));
});

test("regression: cleaner multi-line stealer record captures trailing URL when keepUrl is true", () => {
    const stealerBlock = [
        "Username: testuser",
        "Password: testpassword123",
        "URL: https://accounts.google.com/signin",
    ];

    const cleanedWithUrl = cleaner.cleanLinesArray(stealerBlock, { keepUrl: true });
    assert.equal(cleanedWithUrl.lines.length, 1);
    assert.equal(cleanedWithUrl.lines[0], "https://accounts.google.com/signin:testuser:testpassword123");

    const cleanedWithoutUrl = cleaner.cleanLinesArray(stealerBlock, { keepUrl: false });
    assert.equal(cleanedWithoutUrl.lines.length, 1);
    assert.equal(cleanedWithoutUrl.lines[0], "testuser:testpassword123");
});


