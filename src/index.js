"use strict";

require("dotenv").config();

const http = require("http");
const { Telegraf } = require("telegraf");
const { createBot } = require("./bot");

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

const bot = createBot(TOKEN);

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
            { command: "stats", description: "\uD83D\uDCCA Batch dashboard" },
            { command: "sites", description: "\uD83C\uDF10 Per-site breakdown" },
            { command: "preview", description: "\uD83D\uDC41 Peek at sample lines" },
            { command: "name", description: "\uD83C\uDFF7\uFE0F Force a custom filename" },
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

async function main() {
    const me = await bot.telegram.getMe();
    console.log(`Bot started as @${me.username} (id ${me.id})`);
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