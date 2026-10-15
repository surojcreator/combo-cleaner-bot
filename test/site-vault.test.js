"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vault = require("../src/site-vault");

function tmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "site-vault-"));
}

test("normalizeSite collapses a URL to the registrable site", () => {
    assert.equal(vault.normalizeSite("https://login.htzone.co.il/path"), "htzone.co.il");
    assert.equal(vault.normalizeSite("www.netflix.com"), "netflix.com");
    assert.equal(vault.normalizeSite("not a site"), null);
});

test("appendLines keeps one file per site and skips duplicates", async () => {
    const root = tmp();
    const chat = 42;
    const first = await vault.appendLines(chat, "htzone.co.il", [
        "https://htzone.co.il/login:user@mail.com:pass1",
        "user@mail.com:pass1",
        "other.com:user:nope",
    ], root);
    assert.equal(first.added, 1);
    assert.equal(first.site, "htzone.co.il");

    const second = await vault.appendLines(chat, "https://shop.htzone.co.il/x", [
        "https://htzone.co.il/login:user@mail.com:pass1",
        "htzone.co.il:seconduser:pass2",
    ], root);
    assert.equal(second.added, 1);
    assert.equal(second.duplicates, 1);
    assert.equal(second.size, 2);

    const lines = fs.readFileSync(second.file, "utf8").trim().split("\n");
    assert.deepEqual(lines, ["user@mail.com:pass1", "seconduser:pass2"]);
    fs.rmSync(root, { recursive: true, force: true });
});

test("largest site is the one with the most unique lines", async () => {
    const root = tmp();
    const chat = 7;
    await vault.appendLines(chat, "spotify.com", ["https://spotify.com/login:alice:secret"], root);
    await vault.appendLines(chat, "htzone.co.il", [
        "htzone.co.il:adam99:pass1",
        "htzone.co.il:beth88:pass2",
    ], root);
    vault.setActive(chat, "spotify.com", root);

    const top = vault.largest(chat, root);
    assert.equal(top.site, "htzone.co.il");
    assert.equal(top.lines, 2);
    assert.equal(vault.getActive(chat, root), "spotify.com");
    fs.rmSync(root, { recursive: true, force: true });
});
