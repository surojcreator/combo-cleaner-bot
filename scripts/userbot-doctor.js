"use strict";

/**
 * Preflight for the MTProto account transport.
 *
 * Answers one question: "will /ulp actually talk to the searcher bot right now?"
 *
 * Checks, in order:
 *   1. TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION exist and parse
 *   2. the session still logs in (catches revoked / expired keys)
 *   3. the searcher bot username resolves from that account
 *   4. (with --ping) a message reaches the searcher and it answers
 *   5. LOCAL_PROCESS_ROOT / LOCAL_PROCESSED_ROOT are writable on this host
 *
 * Usage:
 *   npm run doctor
 *   npm run doctor -- --ping
 *   npm run doctor -- --api-id 12345 --api-hash abc --session "..." --save
 *   npm run doctor -- --json
 *
 * Exit codes: 0 ready · 2 config · 3 auth · 4 searcher · 5 storage
 */

require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const EXIT = { OK: 0, CONFIG: 2, AUTH: 3, SEARCHER: 4, STORAGE: 5 };

const C = process.stdout.isTTY
    ? {
        r: "\x1b[0m", b: "\x1b[1m", dim: "\x1b[2m",
        red: "\x1b[31m", green: "\x1b[32m",
        yellow: "\x1b[33m", cyan: "\x1b[36m",
    }
    : { r: "", b: "", dim: "", red: "", green: "", yellow: "", cyan: "" };

const ok = (m) => console.log(`${C.green}✓${C.r} ${m}`);
const bad = (m) => console.log(`${C.red}✗${C.r} ${m}`);
const warn = (m) => console.log(`${C.yellow}!${C.r} ${m}`);
const step = (m) => console.log(`\n${C.b}${m}${C.r}`);
const hint = (m) => console.log(`  ${C.dim}${m}${C.r}`);

/** Default storage roots that make sense on this OS. */
function defaultRoots(platform = process.platform) {
    if (platform === "win32") {
        const base = path.join(os.homedir(), "combo-cleaner-data");
        return {
            root: path.join(base, "inbox"),
            processed: path.join(base, "processed"),
        };
    }
    return { root: "/var/data", processed: "/var/data/processed" };
}

/** Mask a session string so it can be printed safely. */
function maskSession(session) {
    const s = String(session || "");
    if (!s) return "(empty)";
    if (s.length <= 24) return `${s.slice(0, 4)}…${s.length} chars`;
    return `${s.slice(0, 8)}…${s.slice(-6)} (${s.length} chars)`;
}

/**
 * Validate credentials without touching the network.
 * @param {Record<string, string|undefined>} env
 */
function checkConfig(env = process.env) {
    const apiId = Number(env.TELEGRAM_API_ID || 0);
    const apiHash = String(env.TELEGRAM_API_HASH || "").trim();
    const session = String(env.TELEGRAM_SESSION || "").trim();
    const problems = [];

    if (!Number.isFinite(apiId) || apiId <= 0) {
        problems.push("TELEGRAM_API_ID is missing or not a number");
    }
    if (!apiHash) {
        problems.push("TELEGRAM_API_HASH is missing");
    } else if (!/^[0-9a-f]{32}$/i.test(apiHash)) {
        // api_hash is always 32 hex chars; a mistyped copy is the #1 failure
        problems.push("TELEGRAM_API_HASH does not look like 32 hex characters");
    }
    if (!session) {
        problems.push("TELEGRAM_SESSION is missing — run: npm run userbot:login:qr");
    } else if (session.length < 100) {
        problems.push("TELEGRAM_SESSION is too short to be a real session string");
    }

    return {
        ready: problems.length === 0,
        problems,
        apiId: Number.isFinite(apiId) ? apiId : 0,
        apiHash,
        session,
        searcher: String(env.SEARCH_BOT_USERNAME || "DumpNews14Bot").replace(/^@+/, ""),
        transport: String(env.SEARCH_TRANSPORT || "auto").trim().toLowerCase(),
    };
}

/** Persist resolved credentials into .env (mode 0600). */
function setEnvValue(filePath, key, value) {
    let text = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    if (pattern.test(text)) text = text.replace(pattern, line);
    else text += `${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
    fs.writeFileSync(filePath, text, { encoding: "utf8", mode: 0o600 });
}

/** Can we write into this directory (creating it if needed)? */
function probeWritable(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, `.doctor-${process.pid}.tmp`);
        fs.writeFileSync(probe, "ok");
        fs.unlinkSync(probe);
        return { ok: true, dir };
    } catch (err) {
        return { ok: false, dir, error: (err && err.message) || String(err) };
    }
}

function parseArgs(argv) {
    const out = { ping: false, json: false, save: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--ping") out.ping = true;
        else if (a === "--json") out.json = true;
        else if (a === "--save") out.save = true;
        else if (a === "--api-id") out.apiId = argv[++i];
        else if (a === "--api-hash") out.apiHash = argv[++i];
        else if (a === "--session") out.session = argv[++i];
        else if (a === "--searcher") out.searcher = argv[++i];
    }
    return out;
}

function withTimeout(promise, ms, label) {
    let timer;
    const guard = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/** Wait for an incoming message from `peerId` after we pinged it. */
async function waitForReply(client, peer, peerId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        try {
            const msgs = await client.getMessages(peer, { limit: 3 });
            for (const m of msgs || []) {
                if (!m || !m.message) continue;
                if (m.out) continue;
                const fromId = m.senderId ? String(m.senderId) : "";
                if (peerId && fromId && fromId !== String(peerId)) continue;
                last = m;
                break;
            }
            if (last) return last;
        } catch {
            /* transient — keep polling until the deadline */
        }
        await new Promise((r) => setTimeout(r, 2500));
    }
    return null;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    // CLI overrides win, and only get persisted when --save is passed.
    if (args.apiId) process.env.TELEGRAM_API_ID = String(args.apiId);
    if (args.apiHash) process.env.TELEGRAM_API_HASH = String(args.apiHash);
    if (args.session) process.env.TELEGRAM_SESSION = String(args.session);
    if (args.searcher) process.env.SEARCH_BOT_USERNAME = String(args.searcher);

    const report = { checks: {}, fixes: [] };
    const cfg = checkConfig();

    step("1. Credentials");
    console.log(`  api_id      ${cfg.apiId || "(missing)"}`);
    console.log(`  api_hash    ${cfg.apiHash ? `${cfg.apiHash.slice(0, 4)}…${cfg.apiHash.slice(-4)} (${cfg.apiHash.length} chars)` : "(missing)"}`);
    console.log(`  session     ${maskSession(cfg.session)}`);
    console.log(`  searcher    @${cfg.searcher}`);
    console.log(`  transport   ${cfg.transport}`);
    report.checks.credentials = cfg.ready;

    if (!cfg.ready) {
        for (const p of cfg.problems) bad(p);
        hint("api_id + api_hash: https://my.telegram.org → API development tools");
        hint("session: npm run userbot:login:qr  (scans a QR, writes .env)");
        report.fixes.push("Set TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION, then re-run.");
        return finish(report, EXIT.CONFIG, args);
    }
    ok("all three secrets present");

    if (args.save) {
        const envPath = path.resolve(".env");
        setEnvValue(envPath, "TELEGRAM_API_ID", String(cfg.apiId));
        setEnvValue(envPath, "TELEGRAM_API_HASH", cfg.apiHash);
        setEnvValue(envPath, "TELEGRAM_SESSION", cfg.session);
        setEnvValue(envPath, "SEARCH_TRANSPORT", cfg.transport === "bot" ? "bot" : "auto");
        ok(`saved to ${envPath}`);
    }

    step("2. Session login");
    let TelegramClient;
    let StringSession;
    try {
        ({ TelegramClient } = require("teleproto"));
        ({ StringSession } = require("teleproto/sessions"));
    } catch (err) {
        bad("teleproto is not installed");
        hint("npm install");
        report.fixes.push("Run npm install so teleproto is available.");
        return finish(report, EXIT.CONFIG, args);
    }

    const client = new TelegramClient(new StringSession(cfg.session), cfg.apiId, cfg.apiHash, {
        connectionRetries: 3,
        autoReconnect: false,
    });

    let exitCode = EXIT.OK;
    try {
        try {
            await withTimeout(client.connect(), 30000, "connect");
        } catch (err) {
            const msg = String((err && (err.errorMessage || err.message)) || err);
            bad(`cannot reach Telegram: ${msg}`);
            if (/ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|timed out/i.test(msg)) {
                hint("No usable route to a Telegram data center — check DNS/proxy/firewall on this host.");
                hint("A wrong api_id can also resolve to a bogus DC, so re-copy it from my.telegram.org first.");
                report.fixes.push("Allow outbound TCP 443 to Telegram, then re-run. If it persists, re-check TELEGRAM_API_ID.");
            } else {
                hint("Most often a wrong api_id/api_hash pair. Re-copy both from my.telegram.org.");
                report.fixes.push("Re-check TELEGRAM_API_ID / TELEGRAM_API_HASH.");
            }
            report.checks.session = false;
            return finish(report, EXIT.AUTH, args);
        }

        let me;
        try {
            me = await withTimeout(client.getMe(), 20000, "getMe");
        } catch (err) {
            const msg = String((err && (err.errorMessage || err.message)) || err);
            bad(`session rejected: ${msg}`);
            hint("The key is dead or was logged out elsewhere. Re-login: npm run userbot:login:qr");
            report.checks.session = false;
            report.fixes.push("Re-login and update TELEGRAM_SESSION.");
            return finish(report, EXIT.AUTH, args);
        }

        report.checks.session = true;
        report.account = { id: me.id, username: me.username || null, name: [me.firstName, me.lastName].filter(Boolean).join(" ") || null };
        ok(`logged in as ${me.username ? `@${me.username}` : `id ${me.id}`}${report.account.name ? ` (${report.account.name})` : ""}`);
        if (me.bot) warn("that session belongs to a BOT account — bot-to-bot stays blocked; use a human account");
        else if (me.restricted) warn("this account is restricted; sends may fail");

        step("3. Searcher reachability");
        let peer = null;
        try {
            peer = await withTimeout(client.getEntity(cfg.searcher), 20000, "getEntity");
            report.checks.searcher = true;
            report.searcherId = peer.id ? String(peer.id) : null;
            ok(`@${cfg.searcher} resolved${peer.bot ? " (bot)" : " (not a bot — check the username)"}`);
        } catch (err) {
            const msg = String((err && (err.errorMessage || err.message)) || err);
            bad(`cannot resolve @${cfg.searcher}: ${msg}`);
            hint("Open @DumpNews14Bot once from this account, then re-run.");
            report.fixes.push(`Resolve @${cfg.searcher} from the account (send /start once).`);
            return finish(report, EXIT.SEARCHER, args);
        }

        if (args.ping) {
            step("4. Live ping (sends /start, waits for an answer)");
            try {
                await withTimeout(client.sendMessage(peer, "/start"), 20000, "sendMessage");
                console.log(`  ${C.dim}sent /start${C.r}`);
                const reply = await waitForReply(client, peer, peer.id, 25000);
                if (reply) {
                    report.checks.ping = true;
                    const snippet = String(reply.message || "").replace(/\s+/g, " ").slice(0, 80);
                    ok(`searcher answered: "${snippet}${snippet.length >= 80 ? "…" : ""}"`);
                } else {
                    report.checks.ping = false;
                    warn("no answer within 25s — the searcher may need a moment, or it ignores /start");
                    hint("Not fatal: /ulp sends real queries. Blocker only if quiet results keep arriving.");
                }
            } catch (err) {
                const msg = String((err && (err.errorMessage || err.message)) || err);
                report.checks.ping = false;
                bad(`ping failed: ${msg}`);
                report.fixes.push("Check whether the searcher bot banned this account.");
                exitCode = EXIT.SEARCHER;
            }
        } else {
            step("4. Live ping");
            console.log(`  ${C.dim}skipped — add --ping to send /start and wait for a reply${C.r}`);
        }
    } finally {
        await client.disconnect().catch(() => {});
    }

    step("5. Storage paths");
    const roots = defaultRoots();
    const rootDir = process.env.LOCAL_PROCESS_ROOT || roots.root;
    const procDir = process.env.LOCAL_PROCESSED_ROOT || roots.processed;
    const r1 = probeWritable(rootDir);
    const r2 = probeWritable(procDir);
    if (r1.ok) ok(`${rootDir} (writable)`);
    else { bad(`${rootDir}: ${r1.error}`); report.fixes.push(`Point LOCAL_PROCESS_ROOT at a writable folder (e.g. ${roots.root}).`); }
    if (r2.ok) ok(`${procDir} (writable)`);
    else { bad(`${procDir}: ${r2.error}`); report.fixes.push(`Point LOCAL_PROCESSED_ROOT at a writable folder (e.g. ${roots.processed}).`); }
    report.checks.storage = r1.ok && r2.ok;
    if (!report.checks.storage && process.platform === "win32") {
        hint(`Recommended on Windows: LOCAL_PROCESS_ROOT=${roots.root}`);
        hint(`                     LOCAL_PROCESSED_ROOT=${roots.processed}`);
        if (exitCode === EXIT.OK) exitCode = EXIT.STORAGE;
    }

    return finish(report, exitCode, args);
}

function finish(report, code, args) {
    const ready = code === EXIT.OK;
    if (args.json) {
        console.log(JSON.stringify({ ...report, ready, exitCode: code }, null, 2));
        process.exitCode = code;
        return;
    }

    console.log(`\n${"─".repeat(46)}`);
    if (ready) {
        console.log(`${C.green}${C.b}READY${C.r} — the account transport is live.`);
        console.log(`${C.dim}Start the bot (npm start), then /ulp in Telegram.${C.r}`);
    } else {
        console.log(`${C.red}${C.b}NOT READY${C.r} (exit ${code})`);
        for (const f of report.fixes) console.log(`  • ${f}`);
    }
    console.log("");
    process.exitCode = code;
}

module.exports = { checkConfig, maskSession, defaultRoots, probeWritable, EXIT };

if (require.main === module) {
    main().catch((err) => {
        console.error(`\n${C.red}doctor crashed:${C.r}`, (err && err.message) || err);
        process.exitCode = 1;
    });
}
