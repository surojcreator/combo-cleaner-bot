"use strict";

/**
 * Print the local .env as a single base64 blob, for:
 *
 *   $f="$env:TEMP\bootstrap.ps1"; irm '<raw url>/scripts/bootstrap-rdp.ps1' -OutFile $f; & $f -Start -EnvBase64 "<paste>"
 *
 * Base64 keeps the session string (spaces, newlines, quotes) intact through
 * the clipboard. It is encoding, not encryption — treat the output as the
 * secret it is.
 *
 *   npm run env:blob
 *   npm run env:blob -- --verify <base64>
 */

const fs = require("node:fs");
const path = require("node:path");

function main() {
    const args = process.argv.slice(2);
    const verifyAt = args.indexOf("--verify");

    if (verifyAt !== -1) {
        const blob = args[verifyAt + 1] || "";
        const text = Buffer.from(blob, "base64").toString("utf8");
        const keys = text
            .split(/\r?\n/)
            .filter((l) => l && !l.trimStart().startsWith("#"))
            .map((l) => l.split("=")[0]);
        console.log(`decoded ${text.length} chars, ${keys.length} keys:`);
        for (const k of keys) console.log(`  ${k}`);
        return;
    }

    const envPath = path.resolve(".env");
    if (!fs.existsSync(envPath)) {
        console.error(`no .env at ${envPath}`);
        process.exitCode = 1;
        return;
    }
    const raw = fs.readFileSync(envPath);
    const b64 = raw.toString("base64");
    console.log(b64);
    console.error(`\n(${raw.length} bytes from ${envPath} -> ${b64.length} base64 chars)`);
}

main();
