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
