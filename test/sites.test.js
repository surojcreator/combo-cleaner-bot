"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
    detectSite,
    siteFromFileName,
    domainFromFileName,
    sanitizeSiteSlug,
    isFreemail,
} = require("../src/sites");

test("detects the site from URLs in content", () => {
    const raw = "https://netflix.com/login\nuser@mail.com:pass\nadmin@netflix.com:abc";
    assert.strictEqual(detectSite(raw, "random_dump.txt"), "netflix.com");
});

test("filename brand wins when content only has freemail", () => {
    const raw = "user@gmail.com:pass\nfoo@yahoo.com:bar";
    assert.strictEqual(detectSite(raw, "spotify_combo.zip"), "spotify");
});

test("domain in filename wins over weak content signals", () => {
    assert.strictEqual(detectSite("a@b.com:c", "hulu.com_dumps.txt"), "hulu.com");
});

test("clear content signal beats a brand-word filename", () => {
    const raw = "https://wsj.com|user1:pass1\nhttps://wsj.com|user2:pass2";
    assert.strictEqual(detectSite(raw, "mystery_pack.zip"), "wsj.com");
});

test("freemail domains are never returned as the site", () => {
    assert.strictEqual(detectSite("user@gmail.com:pass", ""), null);
    assert.strictEqual(isFreemail("GMAIL.com"), true);
});

test("AOL family and webmail domains are recognized as freemail and never returned as site", () => {
    assert.strictEqual(isFreemail("aol.com"), true);
    assert.strictEqual(isFreemail("AIM.COM"), true);
    assert.strictEqual(isFreemail("verizon.net"), true);
    assert.strictEqual(isFreemail("netscape.net"), true);
    assert.strictEqual(isFreemail("aol.co.uk"), true);
    assert.strictEqual(isFreemail("compuserve.com"), true);
    assert.strictEqual(detectSite("user@aim.com:pass\nperson@verizon.net:12345", ""), null);
});


test("siteFromFileName prefers domains, falls back to brand", () => {
    assert.strictEqual(siteFromFileName("my.site.org_list.txt"), "my.site.org");
    assert.strictEqual(siteFromFileName("netflix_dump.zip"), "netflix");
    assert.strictEqual(siteFromFileName("combolist.zip"), null);
});

test("domainFromFileName ignores the file extension", () => {
    assert.strictEqual(domainFromFileName("hulu.com_dumps.txt"), "hulu.com");
    assert.strictEqual(domainFromFileName("hulu_dumps.txt"), null);
});

test("sanitizeSiteSlug produces filename-safe slugs", () => {
    assert.strictEqual(sanitizeSiteSlug("My Site!! .com"), "my_site_.com");
    assert.strictEqual(sanitizeSiteSlug("Netflix.com"), "netflix.com");
    assert.strictEqual(sanitizeSiteSlug(""), "");
});

test("detectSite returns null for junk input", () => {
    assert.strictEqual(detectSite("", ""), null);
    assert.strictEqual(detectSite("garbage lines\nwith no domains", ""), null);
});
