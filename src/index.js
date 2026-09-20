"use strict";

require("dotenv").config();

const http = require("http");
const { Telegraf } = require("telegraf");
const { createBot, ingestUserbotMessage, trackIngestion } = require("./bot");
const searchbot = require("./searchbot");
const userbot = require("./userbot");

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
    console.error(
        "Missing BOT_TOKEN. Create a bot with @BotFather and set BOT_TOKEN in your environment (see .env.example).",
    );
    process.exit(1);
}

// Optional shared secret so only your Telegram account can use the bot.
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID
    ? Number(process.env.ALLOWED_USER_ID)
    : null;

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_URL = (process.env.PUBLIC_URL ||
    process.env.WEBHOOK_URL ||
    // Render injects RENDER_EXTERNAL_URL into every web service — use it to
    // switch to webhook mode automatically (avoids long-polling 409 conflicts
    // when two instances briefly overlap during a deploy).
    process.env.RENDER_EXTERNAL_URL ||
    "").replace(/\/+$/, "");
const WEBHOOK_PATH = `/telegraf/${encodeURIComponent(TOKEN)}`;

// ULP search relay settings: which searcher bot to drive, how long to wait
// before every try (7s by default) and how many retries are allowed.
// botMeta is mutated after getMe() so renderers can mention this bot.
const botMeta = { search: searchbot.loadOptions() };

// Account bypass for sealed search bots: logged in once via MTProto and then
// handed to the relay (see `npm run userbot:login` + README). Missing or dead
// credentials never stop the bot itself - the /ulp command falls back to the
// plain Bot API and says exactly what to fix.
const userbotConfig = userbot.loadConfig();
botMeta.search.transport = userbotConfig.transport;

const bot = createBot(TOKEN, botMeta);

// Optional access control.
if (ALLOWED_USER_ID) {
    bot.use(async (ctx, next) => {
        const fromId = ctx.from && ctx.from.id;
        if (fromId !== ALLOWED_USER_ID) {
            if (ctx.chat && ctx.chat.type === "private") {
                await ctx.reply(" This bot is private.").catch(() => { });
            }
            return;
        }
        await next();
    });
}

/**
 * Register the command list so it shows up in Telegram's UI.
 */
async function registerCommands() {
    try {
        await bot.telegram.setMyCommands([
            { command: "combine", description: "\uD83D\uDCE6 Download the combined file" },
            { command: "storage", description: "💾 Manage server storage & delete files" },
            { command: "files", description: "📂 Browse server vault files" },
            { command: "stats", description: "\uD83D\uDCCA Batch dashboard" },
            { command: "sites", description: "\uD83C\uDF10 Per-site breakdown" },
            { command: "preview", description: "\uD83D\uDC41 Peek at sample lines" },
            { command: "name", description: "\uD83C\uDFF7\uFE0F Force a custom filename" },
            { command: "search", description: "\uD83D\uDD0E Search your batch" },
            { command: "lsearch", description: "\uD83D\uDCBE Search newest disk output" },
            { command: "save", description: "\uD83D\uDCE5 Save replied Telegram file to disk" },
            { command: "ulp", description: "\uD83D\uDD0E ULP search relay (query + hist:full)" },
            { command: "process", description: "\uD83D\uDCC2 Clean a local file on the server" },
            { command: "clear", description: "\uD83E\uDDF9 Start a fresh batch" },
            { command: "ping", description: "\uD83C\uDFD3 Latency & uptime" },
            { command: "help", description: "\u2753 How to use the bot" },
        ]);
    } catch (err) {
        console.error("setMyCommands failed:", err.message);
    }
}

/**
 * Start a single HTTP server that serves both the health check and (in webhook
 * mode) the Telegram webhook. Using one server avoids port conflicts.
 *
 * @param {((req: import('http').IncomingMessage, res: import('http').ServerResponse) => void)|null} webhookHandler
 */
function startServer(webhookHandler) {
    const server = http.createServer((req, res) => {
        if (webhookHandler && req.url === WEBHOOK_PATH) {
            webhookHandler(req, res);
            return;
        }
        if (req.url === "/" || req.url === "/healthz") {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("ok\n");
            return;
        }
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found\n");
    });
    server.listen(PORT, () => {
        console.log(`HTTP server listening on port ${PORT}`);
    });
    return server;
}

// Fallback routing key when the searcher id is not resolved yet. It is only
// ever replaced by the real one (peer.start returns it), and a chat id here
// is purely for the internal run registry - never a hard-coded target.
const SEARCHER_FALLBACK_ID = 8844520471; // @DumpNews14Bot as last seen

/**
 * Connect the MTProto userbot when it is configured. Never fatal: without it
 * the relay runs over the Bot API and explains itself in the chat.
 */
async function connectUserbot() {
    if (!userbot.isConfigured(userbotConfig)) {
        console.log("Userbot: not configured (set TELEGRAM_API_ID + TELEGRAM_API_HASH + TELEGRAM_SESSION for the bypass).");
        return;
    }
    try {
        const peer = userbot.createUserbot(userbotConfig);
        if (botMeta.botUsername && typeof peer.setBotUsername === "function") {
            peer.setBotUsername(botMeta.botUsername);
        }
        const { id, username } = await peer.start();
        if (id) botMeta.searcherBotId = id;
        peer.onResult((msg) => relayUserbotResult(peer, msg));
        botMeta.userbot = peer;
        console.log(`Userbot: connected as your account, listening to @${username} (id ${id}).`);
        if (typeof peer.syncCustomEmojis === "function") {
            try {
                const syncRes = await peer.syncCustomEmojis();
                console.log(`Userbot: synchronized ${syncRes.synced || 0} custom animated emojis from your account.`);
            } catch (syncErr) {
                console.warn("Userbot: emoji auto-sync warning:", syncErr && syncErr.message ? syncErr.message : syncErr);
            }
        }
    } catch (err) {
        console.error("Userbot: failed to start — relay falls back to the Bot API.", err && err.message ? err.message : err);
    }
}

/**
 * Totally optional knock-on: when the account gets an answer from the searcher
 * bot, decide who is waiting and share it with them.
 * @param {any} peer
 * @param {any} msg
 */
async function relayUserbotResult(peer, msg) {
    const searcherChatId = peer.searcherId || SEARCHER_FALLBACK_ID;
    const messageId = Number(msg && msg.id) || null;
    const kind = msg && (msg.media || msg.document) ? "document" : "text";
    const targets = searchbot.noteResult(searcherChatId, { messageId, kind });
    if (targets.length === 0) return; // nobody asked — leave the user's dialog alone
    for (const chatId of targets) {
        try {
            const run = searchbot.getRun(chatId);
            const query = run ? run.query : "";
            const p = ingestUserbotMessage(chatId, msg, peer, query);
            if (p) trackIngestion(chatId, p);
            await peer.forwardResult(chatId, msg, { botUsername: botMeta.botUsername });
        } catch (err) {
            console.error(`Userbot: could not share result with ${chatId}.`, err && err.message ? err.message : err);
        }
    }
}

async function main() {
    const me = await bot.telegram.getMe();
    botMeta.botUsername = me.username;
    console.log(`Bot started as @${me.username} (id ${me.id})`);
    await connectUserbot();
    if (botMeta.userbot && typeof botMeta.userbot.setBotUsername === "function") {
        botMeta.userbot.setBotUsername(me.username);
    }
    console.log(
        `ULP relay -> @${botMeta.search.botUsername} · ${botMeta.search.stepDelayMs}ms before every try · ` +
            `${botMeta.search.maxTries} tries · hist template "${botMeta.search.histTemplate}" · ` +
            `transport ${botMeta.search.transport} (${botMeta.userbot ? "account bypass ON" : "Bot API only"})`,
    );
    await registerCommands();

    let launched = false;
    if (PUBLIC_URL) {
        // Webhook mode: best when the host gives you a public HTTPS URL.
        // Keep queued updates (drop_pending_updates: false) so messages sent
        // while the machine was stopped/suspended are delivered on wake-up.
        const webhookUrl = `${PUBLIC_URL}${WEBHOOK_PATH}`;
        const webhookHandler = bot.webhookCallback(WEBHOOK_PATH);
        startServer(webhookHandler);
        await bot.telegram.setWebhook(webhookUrl, { drop_pending_updates: false });
        console.log(`Webhook set to ${webhookUrl}`);
    } else {
        // Long-polling mode: works anywhere, no public URL needed.
        await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => { });
        startServer(null);
        await bot.launch();
        launched = true;
        console.log("Running in long-polling mode.");
    }

    // Graceful shutdown. bot.stop() is only valid after bot.launch() (polling
    // mode); in webhook mode it throws "Bot is not running!", so guard it.
    const shutdown = (signal) => {
        try {
            if (launched) {
                bot.stop(signal);
                return;
            }
        } catch (err) {
            console.error("shutdown error:", err.message);
        }
        process.exit(0);
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
});