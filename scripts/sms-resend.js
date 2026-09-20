"use strict";

// SMS resend helper for Telegram login.
// 1. Sends the login code to the phone.
// 2. Waits, then resends the code.
// 3. Tells you to run the full login with the code you received.
//
// Usage:
//   $env:TELEGRAM_API_ID=YOUR_API_ID
//   $env:TELEGRAM_API_HASH=YOUR_API_HASH
//   $env:TELEGRAM_PHONE=YOUR_PHONE_IN_INTERNATIONAL_FORMAT
//   node scripts/sms-resend.js

const { TelegramClient } = require("teleproto");
const { StringSession } = require("teleproto/sessions");
const { Api } = require("teleproto/tl");

const apiId = Number(process.env.TELEGRAM_API_ID || process.argv[2] || 0);
const apiHash = String(process.env.TELEGRAM_API_HASH || process.argv[3] || "").trim();
const phone = String(process.env.TELEGRAM_PHONE || process.argv[4] || "").trim();
const resendDelayMs = Number(process.env.TELEGRAM_RESEND_DELAY_MS || 12000);

if (!Number.isFinite(apiId) || apiId <= 0) {
    console.error("[FATAL] TELEGRAM_API_ID must be a positive number");
    process.exit(1);
}
if (!apiHash) {
    console.error("[FATAL] TELEGRAM_API_HASH is required");
    process.exit(1);
}
if (!phone) {
    console.error("[FATAL] TELEGRAM_PHONE is required (e.g. +15551234567)");
    process.exit(1);
}

const session = new StringSession("");
const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
});

async function main() {
    console.log("[STEP 1] Connecting to Telegram...");
    await client.connect();

    console.log("[STEP 2] Sending login code to " + phone + "...");
    const sent = await client.invoke(new Api.auth.SendCode({
        phoneNumber: phone,
        currentParam: "login",
    }));
    console.log("[OK] SMS sent. phone_code_hash =", sent.phone_code_hash);
    if (sent.timeout) console.log("[INFO] Code expires in ~", sent.timeout, "seconds.");
    if (sent.next_type) console.log("[INFO] next_type:", sent.next_type);
    console.log("[NOTE] If you have Telegram Desktop or any Telegram app open,",
        "close it first — the code may arrive there instead of as SMS.");

    console.log("");
    console.log("[STEP 3] Waiting " + resendDelayMs + " ms, then resending SMS...");
    await new Promise((r) => setTimeout(r, resendDelayMs));

    const rc = await client.invoke(new Api.auth.ResendCode({
        phoneNumber: phone,
        phone_code_hash: sent.phone_code_hash,
    }));
    console.log("[OK] Resent. new phone_code_hash =", rc.phone_code_hash);
    if (rc.timeout) console.log("[INFO] New code expires in ~", rc.timeout, "seconds.");

    console.log("");
    console.log("=== NOW DO THIS ===");
    console.log("Wait for the SMS to arrive at " + phone + " (check SMS spam folder too),");
    console.log("then run:");
    console.log("");
    console.log("  $env:TELEGRAM_CODE=<the 5-digit code from SMS>");
    console.log("  npm run userbot:login:noninteractive");
    console.log("");
    console.log("Or set TELEGRAM_CODE inline:");
    console.log("  $env:TELEGRAM_CODE=\"12345\"");
    console.log("  npm run userbot:login:noninteractive");
    console.log("");
    console.log("That will complete the login and print TELEGRAM_SESSION=...");
}

main().catch((err) => {
    console.error("[FATAL]", err.message || String(err));
    process.exit(1);
});
