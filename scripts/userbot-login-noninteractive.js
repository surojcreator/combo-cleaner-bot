// Non-interactive login script: everything comes from env vars or CLI args.
// Fails fast when values are missing — no hanging on prompts in CI/headless.
//
// Usage examples:
//   env vars:
//     TELEGRAM_API_ID=123
//     TELEGRAM_API_HASH=abc
//     TELEGRAM_PHONE=+15551234567
//     TELEGRAM_CODE=14352
//     TELEGRAM_2FA=mypassword        (optional; leave unset if no 2FA)
//     TELEGRAM_ON_NO_2FA=empty       (default when 2FA unset -> send "")
//     npm run userbot:login:noninteractive
//   or CLI args in order: api_id api_hash phone code 2fa
//     node scripts/userbot-login:noninteractive.js 123 abc +15551234567 14352
//
// TELEGRAM_ON_NO_2FA controls what happens when 2FA isn't set:
//   "empty" (default) -> send "" (most accounts have no 2FA)
//   "skip"            -> send undefined (let Telegram decide)
//   "password:XYZ"    -> use XYZ as the 2FA password

"use strict";

const { execSync } = require("node:child_process");

function numOrZero(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n : 0;
}

// Pull a value from env, then argv, then fail fast (no interactive prompt).
function requireValue(label, envKey, argvIdx) {
    const fromEnv = process.env[envKey];
    const fromArgv = process.argv[argvIdx];
    const value = (fromEnv || fromArgv || "").trim();
    if (value) return value;
    throw new Error(`Missing ${label} — set ${envKey} or pass argument ${argvIdx}`);
}

function get2faPassword() {
    const raw = process.env.TELEGRAM_2FA || process.argv[6] || "";
    const onNo2fa = (process.env.TELEGRAM_ON_NO_2FA || "empty").trim().toLowerCase();

    if (raw) return raw.trim();

    if (onNo2fa === "empty") return "";
    if (onNo2fa === "skip") return undefined;
    throw new Error(
        `2FA not set — set TELEGRAM_2FA or TELEGRAM_ON_NO_2FA (empty|skip|password:XYZ)`,
    );
}

async function main() {
    const apiId = numOrZero(
        process.env.TELEGRAM_API_ID || process.argv[2] || 0,
    );
    const askApiId = apiId === 0;
    const apiHash = String(process.env.TELEGRAM_API_HASH || process.argv[3] || "").trim();
    const askApiHash = !apiHash;

    const phone = String(process.env.TELEGRAM_PHONE || process.argv[4] || "").trim();
    const askPhone = !phone;

    const code = String(process.env.TELEGRAM_CODE || process.argv[5] || "").trim();
    const askCode = !code;

    const twofa = get2faPassword();

    console.log("[INFO] Resolving credentials from env/args...");
    let resolvedApiId = apiId;
    let resolvedApiHash = apiHash;

    if (askApiId) resolvedApiId = numOrZero(requireValue("api_id", "TELEGRAM_API_ID", 2));
    if (askApiHash) resolvedApiHash = requireValue("api_hash", "TELEGRAM_API_HASH", 3);
    if (askPhone) { /* keep empty string so client.start prompts */ }
    if (askCode) { /* keep empty string so client.start prompts */ }

    if (!resolvedApiId || !resolvedApiHash) {
        console.error("Need both api_id and api_hash — create them at https://my.telegram.org first.");
        process.exitCode = 1;
        return;
    }

    const step = (msg) => console.log(`[STEP] ${msg}`);

    step("Importing teleproto...");
    const { TelegramClient } = await import("teleproto");
    const { StringSession } = await import("teleproto/sessions");

    const session = new StringSession("");
    const client = new TelegramClient(session, resolvedApiId, resolvedApiHash, {
        connectionRetries: 5,
    });

    step("Connecting to Telegram...");
    try {
        await client.start({
            phoneNumber: phone || undefined,
            phoneCode: code || undefined,
            password: twofa !== undefined ? (twofa === "" ? "" : twofa) : undefined,
            emailAddress: (process.env.TELEGRAM_EMAIL || "").trim() || undefined,
            emailVerification: (process.env.TELEGRAM_EMAIL_CODE || "").trim() ? { code: (process.env.TELEGRAM_EMAIL_CODE || "").trim() } : undefined,
            onError: (err) => {
                const msg = err && err.message ? err.message : String(err);
                console.error("[ERROR] login error:", msg);
            },
            onTimeout: (info) => {
                console.error("[TIMEOUT] step timed out:", JSON.stringify(info));
            },
        });
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.error("[FATAL] login failed:", msg);
        process.exitCode = 1;
        return;
    }

    const saved = client.session.save();
    const me = await client.getMe();
    await client.disconnect();

    console.log("");
    console.log("✓ Logged in as:", me.username ? `@${me.username} (id ${me.id})` : `id ${me.id}`);
    console.log("");
    console.log("=== COPY EVERYTHING BELOW THIS LINE ===");
    console.log(`TELEGRAM_SESSION=${saved}`);
    console.log("=== END ===");
    console.log("");
    console.log("Add these to your .env (local) or hosting platform Secrets:");
    console.log(`  TELEGRAM_API_ID=${resolvedApiId}`);
    console.log(`  TELEGRAM_API_HASH=${resolvedApiHash}`);
    console.log(`  TELEGRAM_SESSION=${saved}`);
    console.log(`  (phone number used: ${phone || "not provided"})`);
}

main().catch((err) => {
    console.error("Unexpected error:", err && err.message ? err.message : String(err));
    process.exitCode = 1;
});
