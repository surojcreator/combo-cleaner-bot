"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const AdmZip = require("adm-zip");
const {
    extractAndCleanZip,
    extractAndCleanText,
    isZipBuffer,
} = require("../src/extractor");

function makeZip(files) {
    const zip = new AdmZip();
    for (const [name, content] of Object.entries(files)) {
        zip.addFile(name, Buffer.from(content, "utf8"));
    }
    return zip.toBuffer();
}

test("isZipBuffer detects zip magic bytes", () => {
    const buf = makeZip({ "a.txt": "x" });
    assert.equal(isZipBuffer(buf), true);
    assert.equal(isZipBuffer(Buffer.from("hello")), false);
});

test("extracts and cleans a simple zip", () => {
    const zip = makeZip({
        "combo.txt": [
            "user@example.com:pass1",
            "15551234567:pass2",
            "https://example.com:443",
            "example.com:80",
        ].join("\n"),
    });

    const { lines, stats } = extractAndCleanZip(zip);
    assert.deepEqual(lines, ["user@example.com:pass1", "15551234567:pass2"]);
    assert.equal(stats.kept, 2);
    assert.equal(stats.dropped, 2);
    assert.equal(stats.files, 1);
});

test("walks nested zips", () => {
    const inner = makeZip({
        "inner.txt": "nested@example.com:nestedpass",
    });
    const outer = new AdmZip();
    outer.addFile("inner.zip", inner);
    outer.addFile("top.txt", "top@example.com:toppass");
    const outerBuf = outer.toBuffer();

    const { lines } = extractAndCleanZip(outerBuf);
    assert.ok(lines.includes("nested@example.com:nestedpass"));
    assert.ok(lines.includes("top@example.com:toppass"));
});

test("dedupes across multiple files in a zip", () => {
    const zip = makeZip({
        "a.txt": "user@example.com:pass1",
        "b.txt": "user@example.com:pass1\nother@example.com:pass2",
    });
    const { lines } = extractAndCleanZip(zip);
    assert.equal(lines.length, 2);
});

test("ignores non-text entries", () => {
    const zip = new AdmZip();
    zip.addFile("image.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    zip.addFile("combo.txt", Buffer.from("user@example.com:pass1", "utf8"));
    const { lines } = extractAndCleanZip(zip.toBuffer());
    assert.deepEqual(lines, ["user@example.com:pass1"]);
});

test("extractAndCleanText handles raw text", () => {
    const { lines, stats } = extractAndCleanText(
        "user@example.com:pass1\nhttps://x.com:443",
    );
    assert.deepEqual(lines, ["user@example.com:pass1"]);
    assert.equal(stats.files, 1);
});