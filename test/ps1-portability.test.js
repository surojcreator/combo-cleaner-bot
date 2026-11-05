"use strict";

/**
 * Windows PowerShell 5.1 reads .ps1 files as ANSI unless they carry a BOM.
 * A single em-dash then decodes into bytes containing a quote character and
 * silently breaks the parse (verified: bootstrap-rdp.ps1 stopped at line 83
 * with "Cannot bind argument to parameter 'Path' because it is null").
 *
 * Keep every script ASCII-only so the deploy path works on a stock RDP.
 */

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const scriptsDir = path.join(__dirname, "..", "scripts");

function ps1Files() {
    return fs
        .readdirSync(scriptsDir)
        .filter((f) => f.toLowerCase().endsWith(".ps1"))
        .map((f) => path.join(scriptsDir, f));
}

test("every .ps1 script is ASCII-only (PS 5.1 ANSI parse safety)", () => {
    const files = ps1Files();
    assert.ok(files.length >= 2, "expected the deploy scripts to exist");
    const offenders = [];
    for (const file of files) {
        const text = fs.readFileSync(file, "utf8");
        text.split(/\r?\n/).forEach((line, i) => {
            const nonAscii = [...line].filter((ch) => ch.codePointAt(0) > 0x7e);
            if (nonAscii.length) {
                offenders.push(
                    `${path.basename(file)}:${i + 1} has ${nonAscii
                        .map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase()}`)
                        .join(",")}`,
                );
            }
        });
    }
    assert.deepEqual(offenders, []);
});

test("every .ps1 script starts with a UTF-8 BOM or pure ASCII", () => {
    for (const file of ps1Files()) {
        const buf = fs.readFileSync(file);
        const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
        const isAscii = buf.every((b) => b < 0x80);
        assert.ok(hasBom || isAscii, `${path.basename(file)} is neither BOM-prefixed nor ASCII`);
    }
});

test("deploy scripts avoid the POSIX /var/data default on Windows", () => {
    const deploy = fs.readFileSync(path.join(scriptsDir, "deploy-rdp.ps1"), "utf8");
    assert.match(deploy, /function Resolve-StorageRoot/);
    assert.match(deploy, /StartsWith\("\/"\)/);
});
