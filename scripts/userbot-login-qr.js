"use strict";

/**
 * One-time QR login for the MTProto account transport.
 *
 * Run: npm run userbot:login:qr
 * Scan: Telegram mobile -> Settings -> Devices -> Link Desktop Device
 *
 * Designed to work in agent/IDE terminals that don't keep an interactive TTY:
 * - readline is only opened if Telegram asks for a 2FA password
 * - QR is printed + written to files under .tmp/ so you can open/scan it
 * - onError no longer loops forever on a closed stdin
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

function formatExpires(expires) {
    const n = Number(expires);
    if (!Number.isFinite(n) || n <= 0) return "a short while";
    // teleproto may pass remaining seconds OR a unix timestamp
    const remaining = n > 1e9 ? Math.max(0, Math.floor(n - Date.now() / 1000)) : Math.floor(n);
    if (remaining <= 0) return "soon (refreshing)";
    if (remaining < 60) return `${remaining}s`;
    return `${Math.floor(remaining / 60)}m ${remaining % 60}s`;
}

async function main() {
    const apiId = Number(process.env.TELEGRAM_API_ID || 0);
    const apiHash = String(process.env.TELEGRAM_API_HASH || "").trim();
    if (!Number.isFinite(apiId) || apiId <= 0 || !apiHash) {
        throw new Error(
            "Set TELEGRAM_API_ID and TELEGRAM_API_HASH in the local .env first.",
        );
    }

    const tmpDir = path.resolve(".tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    const urlPath = path.join(tmpDir, "telegram-qr-login.url");
    const txtPath = path.join(tmpDir, "telegram-qr-login.txt");

    let rl = null;
    let fatalError = null;
    let lastTokenKey = "";
    let qrShows = 0;

    const ensureRl = () => {
        if (!rl) {
            rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        }
        return rl;
    };

    const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
        connectionRetries: 5,
    });

    try {
        console.log("Connecting to Telegram for QR login...");
        console.log("On your phone: Telegram → Settings → Devices → Link Desktop Device");
        console.log(`QR will also be written to:\n  ${txtPath}\n  ${urlPath}\n`);

        await client.connect();

        const me = await client.signInUserWithQrCode(
            { apiId, apiHash },
            {
                qrCode: async ({ token, expires }) => {
                    const url = `tg://login?token=${token.toString("base64url")}`;
                    const tokenKey = token.toString("base64url");
                    // Avoid spamming identical frames when the library re-emits the same token
                    if (tokenKey === lastTokenKey) return;
                    lastTokenKey = tokenKey;
                    qrShows += 1;

                    fs.writeFileSync(urlPath, `${url}\n`, { encoding: "utf8", mode: 0o600 });
                    // Capture terminal QR into a text file for IDE viewing
                    let ascii = "";
                    try {
                        qrcode.generate(url, { small: true }, (out) => {
                            ascii = String(out || "");
                        });
                    } catch {
                        ascii = "";
                    }
                    // qrcode-terminal sometimes prints instead of returning — also print live
                    console.log("\n──────────────── QR LOGIN ────────────────");
                    console.log(`Show #${qrShows} · expires in about ${formatExpires(expires)}`);
                    console.log("Scan with: Settings → Devices → Link Desktop Device\n");
                    qrcode.generate(url, { small: true });
                    console.log(`\nDeep link (if QR is hard to scan):\n${url}`);
                    console.log(`Also saved: ${urlPath}`);
                    console.log("──────────────────────────────────────────\n");
                    if (ascii) fs.writeFileSync(txtPath, `${ascii}\n${url}\n`, { encoding: "utf8", mode: 0o600 });
                    else fs.writeFileSync(txtPath, `${url}\n`, { encoding: "utf8", mode: 0o600 });
                },
                password: async (hint) => {
                    const label = hint
                        ? `Telegram 2FA password (${hint}): `
                        : "Telegram 2FA password: ";
                    // Only open readline when 2FA is actually required
                    try {
                        return (await ensureRl().question(label)).trim();
                    } catch (err) {
                        fatalError = new Error(
                            "Need your 2FA password, but this terminal can't read input. " +
                                "Re-run in a real terminal: npm run userbot:login:qr",
                        );
                        throw fatalError;
                    }
                },
                onError: (err) => {
                    const msg = String((err && err.message) || err || "");
                    // Closed stdin / killed process → stop retrying forever
                    if (
                        /readline was closed|readline|EINTR|EIO|aborted|canceled|cancelled/i.test(msg) ||
                        fatalError
                    ) {
                        fatalError = fatalError || new Error(msg);
                        return true; // stop
                    }
                    console.error("QR login transient error:", msg);
                    return false; // allow library retry / new QR
                },
            },
        );

        const session = client.session.save();
        const envPath = path.resolve(".env");
        setEnvValue(envPath, "TELEGRAM_SESSION", session);
        setEnvValue(envPath, "SEARCH_TRANSPORT", "auto");
        setEnvValue(envPath, "LOCAL_PROCESS_ROOT", "/var/data");
        setEnvValue(envPath, "LOCAL_PROCESSED_ROOT", "/var/data/processed");

        console.log("\n✅ QR login successful.");
        console.log(
            "Logged in as:",
            me.username ? `@${me.username} (id ${me.id})` : `id ${me.id}`,
        );
        console.log(`Saved TELEGRAM_SESSION securely to ${envPath} (gitignored).`);
        console.log("\nSession is ready for Railway. Do not commit it to Git.");
        // Print a short prefix only — full session is in .env
        console.log(`TELEGRAM_SESSION length: ${session.length} chars (stored in .env)`);
    } finally {
        if (rl) {
            try {
                rl.close();
            } catch {
                // ignore
            }
        }
        await client.disconnect().catch(() => {});
    }

    if (fatalError) throw fatalError;
}

main().catch((err) => {
    console.error("\n❌ QR login failed:", err && err.message ? err.message : err);
    console.error("\nAlternatives:");
    console.error("  1) Run in your own Mac terminal (not the agent):");
    console.error("       cd combo-cleaner-bot && npm run userbot:login:qr");
    console.error("  2) SMS login instead:");
    console.error("       TELEGRAM_PHONE=+YourNumber npm run userbot:login");
    process.exitCode = 1;
});
