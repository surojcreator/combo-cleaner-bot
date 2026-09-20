"use strict";

require("dotenv").config();

/**
 * One-time setup for the MTProto userbot bypass.
 *
 *   1. Create an API app at https://my.telegram.org -> api_id + api_hash
 *   2. Run:  npm run userbot:login
 *      (optionally: TELEGRAM_API_ID=123 TELEGRAM_API_HASH=abc npm run userbot:login)
 *   3. Enter the phone number, the login code Telegram sends you, and the
 *      2FA password if your account has one.
 *   4. Copy the printed string into the TELEGRAM_SESSION env var
 *      (local .env, or the Render dashboard as a secret).
 *
 * The session string is a full login as your account — treat it like a
 * password. Never commit it, never paste it anywhere except your own env.
 */

const readline = require("node:readline/promises");

async function ask(rl, label) {
    return (await rl.question(label)).trim();
}

async function main() {
    const { TelegramClient } = require("teleproto");
    const { StringSession } = require("teleproto/sessions");

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    let apiId = Number(process.env.TELEGRAM_API_ID || process.argv[2] || 0);
    let apiHash = String(process.env.TELEGRAM_API_HASH || process.argv[3] || "").trim();

    try {
        if (!apiId) apiId = Number(await ask(rl, "api_id (from https://my.telegram.org): "));
        if (!apiHash) apiHash = await ask(rl, "api_hash: ");
        if (!apiId || !apiHash) {
            console.error("Need both api_id and api_hash - create them at https://my.telegram.org first.");
            process.exitCode = 1;
            return;
        }

        const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
            connectionRetries: 5,
        });

        console.log("Connecting to Telegram...");
        await client.start({
            phoneNumber: async () => ask(rl, "phone (international format, e.g. +15551234567): "),
            phoneCode: async () => ask(rl, "login code Telegram just sent you: "),
            password: async () => ask(rl, "2FA password (empty if your account has none): "),
            emailAddress: async () => ask(rl, "email (only if Telegram asks for one): "),
            emailVerification: async () => ({ code: await ask(rl, "email code: ") }),
            onError: (err) => console.error("login error:", err && err.message ? err.message : err),
        });

        const session = client.session.save();
        const me = await client.getMe();

        console.log("");
        console.log("Logged in as:", me.username ? `@${me.username} (id ${me.id})` : `id ${me.id}`);
        console.log("");
        console.log("Your TELEGRAM_SESSION (copy the whole line into your env):");
        console.log(`TELEGRAM_SESSION=${session}`);
        await client.disconnect();
    } finally {
        rl.close();
    }
}

main().catch((err) => {
    console.error("login failed:", err && err.message ? err.message : err);
    process.exitCode = 1;
});
