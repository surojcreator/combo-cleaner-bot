"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const AdmZip = require("adm-zip");

const {
    decodeBufferToText,
    searchBufferCI,
    resolveStealerRecordFromLines,
    cleanUserPassOnly,
    createSearchMatcher,
    extractSearchDomain,
} = require("../src/cleaner");
const { searchTextFile } = require("../src/bot");
const { extractAndCleanZipAsync } = require("../src/extractor");

test("decodeBufferToText handles UTF-8, UTF-16LE with BOM, and UTF-16LE without BOM", () => {
    const raw = "URL: https://htzone.co.il/login\nUsername: test@mail.com\nPassword: secret123\n";

    // UTF-8
    const utf8Buf = Buffer.from(raw, "utf8");
    assert.equal(decodeBufferToText(utf8Buf), raw);

    // UTF-16LE with BOM
    const utf16leBomBuf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(raw, "utf16le")]);
    assert.equal(decodeBufferToText(utf16leBomBuf), raw);

    // UTF-16LE without BOM
    const utf16leNoBomBuf = Buffer.from(raw, "utf16le");
    assert.equal(decodeBufferToText(utf16leNoBomBuf), raw);

    // UTF-8 with BOM
    const utf8BomBuf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(raw, "utf8")]);
    assert.equal(decodeBufferToText(utf8BomBuf), raw);
});

test("searchBufferCI finds credentials inside UTF-16LE ULP dumps", () => {
    const text = [
        "==================================================",
        "URL: https://htzone.co.il/login",
        "Username: redline_user@gmail.com",
        "Password: SuperSecretPassword!2026",
        "==================================================",
    ].join("\n");

    const utf16Buf = Buffer.from(text, "utf16le");
    const res = searchBufferCI(utf16Buf, "htzone.co.il");
    assert.equal(res.total, 1);
    assert.equal(res.matches.length, 1);
    assert.equal(res.matches[0], "https://htzone.co.il/login:redline_user@gmail.com:SuperSecretPassword!2026");

    const clean = cleanUserPassOnly(res.matches[0]);
    assert.equal(clean, "redline_user@gmail.com:SuperSecretPassword!2026");
});

test("resolveStealerRecordFromLines enforces block boundaries and prevents cross-block bleeding", () => {
    const lines = [
        "URL: https://first-site.com/auth",
        "Username: first_user@test.com",
        "Password: first_password",
        "",
        "URL: https://second-site.com/login",
        "Username: second_user@test.com",
        "Password: second_password",
        "==================================================",
        "URL: https://third-site.com/signin",
        "Username: third_user@test.com",
        "Password: third_password",
    ];

    // Hit on second site (index 4) must NOT return first site's credentials
    const hit2 = resolveStealerRecordFromLines(lines, 4);
    assert.equal(hit2, "https://second-site.com/login:second_user@test.com:second_password");

    // Hit on first site (index 0)
    const hit1 = resolveStealerRecordFromLines(lines, 0);
    assert.equal(hit1, "https://first-site.com/auth:first_user@test.com:first_password");

    // Hit on third site (index 8)
    const hit3 = resolveStealerRecordFromLines(lines, 8);
    assert.equal(hit3, "https://third-site.com/signin:third_user@test.com:third_password");
});

test("searchTextFile finds credentials in zip files without .zip extension (e.g. ULP dumps)", async () => {
    const tmpDir = path.join(os.tmpdir(), `ulp-zip-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
        const zip = new AdmZip();
        const stealerLog = [
            "Application: Chrome",
            "URL: https://htzone.co.il/account",
            "Username: user@htzone.co.il",
            "Password: TargetPass999",
        ].join("\n");
        zip.addFile("Passwords.txt", Buffer.from(stealerLog, "utf8"));

        // File named without .zip extension
        const rawFilePath = path.join(tmpDir, "ulp_dump_result_88492");
        zip.writeZip(rawFilePath);

        const res = await searchTextFile(rawFilePath, "htzone.co.il", 20);
        assert.ok(res.total >= 1);
        assert.equal(res.isZip, true);
        assert.equal(res.matches.length, 1);
        assert.equal(res.matches[0], "https://htzone.co.il/account:user@htzone.co.il:TargetPass999");
        assert.equal(cleanUserPassOnly(res.matches[0]), "user@htzone.co.il:TargetPass999");
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("extractAndCleanZipAsync handles UTF-16LE text files inside zip archives", async () => {
    const zip = new AdmZip();
    const utf16Content = Buffer.from(
        "URL: https://netflix.com/login\nUsername: netflix_fan@mail.com\nPassword: netflix_pass\n",
        "utf16le"
    );
    zip.addFile("passwords.txt", utf16Content);
    const zipBuffer = zip.toBuffer();

    const res = await extractAndCleanZipAsync(zipBuffer, { keepUrl: true });
    assert.equal(res.lines.length, 1);
    assert.match(res.lines[0], /netflix\.com.*netflix_fan@mail\.com:netflix_pass/);
});
