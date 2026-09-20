"use strict";

/**
 * One-time QR login for the MTProto account transport.
 *
 * Run: npm run userbot:login:qr
 * Scan: Telegram mobile -> Settings -> Devices -> Link Desktop Device
 *
 * TELEGRAM_API_ID and TELEGRAM_API_HASH are loaded from .env. After a
 * successful scan, TELEGRAM_SESSION is saved back to the gitignored .env and
 * printed once for copying into the Render dashboard secret.
 */

require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline/promises");
const qrcode = require("qrcode-terminal");
const { TelegramClient } = require("teleproto");
const { StringSession } = require("teleproto/sessions");

function setEnvValue(filePath, key, value) {
    let text = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    if (pattern.test(text)) text = text.replace(pattern, line);
    else text += `${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
    fs.writeFileSync(filePath, text, { encoding: "utf8", mode: 0o600 });
}

async function main() {
    const apiId = Number(process.env.TELEGRAM_API_ID || 0);
    const apiHash = String(process.env.TELEGRAM_API_HASH || "").trim();
    if (!Number.isFinite(apiId) || apiId <= 0 || !apiHash) {
        throw new Error(
            "Set TELEGRAM_API_ID and TELEGRAM_API_HASH in the local .env first.",
        );
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
        connectionRetries: 5,
    });

    try {
        console.log("Connecting to Telegram for QR login...");
        console.log("Open Telegram mobile -> Settings -> Devices -> Link Desktop Device.");

        const me = await client.signInUserWithQrCode(
            { apiId, apiHash },
            {
                qrCode: async ({ token, expires }) => {
                    const url = `tg://login?token=${token.toString("base64url")}`;
                    console.clear();
                    console.log("Scan this QR with Telegram mobile:");
                    console.log("Settings -> Devices -> Link Desktop Device\n");
                    qrcode.generate(url, { small: true });
                    console.log(`\nQR expires in about ${expires}s. It refreshes automatically.`);
                },
                password: async (hint) => {
                    const label = hint
                        ? `Telegram 2FA password (${hint}): `
                        : "Telegram 2FA password: ";
                    return (await rl.question(label)).trim();
                },
                onError: (err) => {
                    console.error("QR login error:", err && err.message ? err.message : err);
                    return false;
                },
            },
        );

        const session = client.session.save();
        const envPath = path.resolve(".env");
        setEnvValue(envPath, "TELEGRAM_SESSION", session);
        setEnvValue(envPath, "SEARCH_TRANSPORT", "auto");
        setEnvValue(envPath, "LOCAL_PROCESS_ROOT", "/var/data");
        setEnvValue(envPath, "LOCAL_PROCESSED_ROOT", "/var/data/processed");

        console.clear();
        console.log("QR login successful.");
        console.log(
            "Logged in as:",
            me.username ? `@${me.username} (id ${me.id})` : `id ${me.id}`,
        );
        console.log(`Saved TELEGRAM_SESSION securely to ${envPath} (gitignored).`);
        console.log("\nCopy ONLY the value below into Render -> TELEGRAM_SESSION:");
        console.log(session);
        console.log("\nDo not send this session string in chat or commit it to Git.");
    } finally {
        rl.close();
        await client.disconnect().catch(() => {});
    }
}

main().catch((err) => {
    console.error("QR login failed:", err && err.message ? err.message : err);
    process.exitCode = 1;
});