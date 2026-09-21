"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { cleanLine, cleanText, normalizeLine, isCcLine, isCreditCardLine, cleanCcLine } = require("../src/cleaner");
const { WorkerPool } = require("../src/worker-pool");
const {
    registerCustomEmojis,
    getCustomEmojis,
    clearCustomEmojis,
    tgEmoji,
    emojisKeyboard,
    renderHelp,
    renderEmojiPacks,
} = require("../src/messages");
const userbot = require("../src/userbot");
const { createBot } = require("../src/bot");
const store = require("../src/store");

async function startFakeApi() {
    const calls = [];
    let customEmojiErrorThrown = false;
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            const method = String(req.url || "").split("/").pop();
            let payload = {};
            try {
                payload = JSON.parse(body || "{}");
            } catch {
                payload = {};
            }
            calls.push({ method, payload });
            const now = Math.floor(Date.now() / 1000);
            const chat = { id: payload.chat_id, type: "private" };

            // Mock Telegram Bot API rejecting custom emoji entities on first try
            if (method === "sendMessage" && payload.text && payload.text.includes("<tg-emoji") && !customEmojiErrorThrown) {
                customEmojiErrorThrown = true;
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: custom_emoji entity not allowed" }));
                return;
            }

            const reply = (json) => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(json));
            };

            if (method === "getMe") {
                reply({ ok: true, result: { id: 1, is_bot: true, username: "ulpsorter69bot" } });
            } else if (method === "sendMessage") {
                reply({ ok: true, result: { message_id: calls.length, date: now, chat, text: payload.text } });
            } else if (method === "editMessageText") {
                reply({ ok: true, result: { message_id: payload.message_id, date: now, chat, text: payload.text } });
            } else if (method === "answerCallbackQuery") {
                reply({ ok: true, result: true });
            } else {
                reply({ ok: true, result: true });
            }
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    return {
        apiRoot: `http://127.0.0.1:${port}`,
        calls,
        close: () =>
            new Promise((resolve) => {
                if (typeof server.closeAllConnections === "function") {
                    server.closeAllConnections();
                }
                server.close(resolve);
            }),
    };
}

test("cleaner: normalizes zero-width and non-breaking whitespace combinations", () => {
    const dirtyLine = "\uFEFFuser\u200Bname\u200C:\u200Dpass\u00A0word\u200B";
    const normalized = normalizeLine(dirtyLine);
    assert.equal(normalized, "username:pass word");

    const cleaned = cleanLine(dirtyLine);
    assert.equal(cleaned, "username:pass");
});

test("cleaner: card dumps support both 4-field and 3-field mm/yy slash formats", () => {
    // 4-field format: number|month|year|cvv
    const cc4 = "4111111111111111|12|2028|123";
    assert.equal(isCcLine(cc4), true);
    assert.equal(isCreditCardLine(cc4), true);
    assert.equal(cleanCcLine(cc4), "4111111111111111|12|28|123");

    // 3-field format with 2-digit year: number|mm/yy|cvv
    const cc3short = "4111111111111111|12/28|123";
    assert.equal(isCcLine(cc3short), true);
    assert.equal(cleanCcLine(cc3short), "4111111111111111|12|28|123");

    // 3-field format with 4-digit year: number|mm/yyyy|cvv
    const cc3long = "5500000000000004|05/2029|999";
    assert.equal(isCcLine(cc3long), true);
    assert.equal(cleanCcLine(cc3long), "5500000000000004|05|29|999");

    // With extra prefix or suffix
    const ccPrefixed = "CARD: 4111111111111111|11/27|456 extra info";
    assert.equal(isCcLine(ccPrefixed), true);
    assert.equal(cleanCcLine(ccPrefixed), "4111111111111111|11|27|456");

    // Slash format with colons: number:mm/yy:cvv
    const ccColonSlash = "4111111111111111:08/26:789";
    assert.equal(isCcLine(ccColonSlash), true);
    assert.equal(cleanCcLine(ccColonSlash), "4111111111111111|08|26|789");
});

test("cleaner: edge case credential combinations", () => {
    // Mixed colon, spaces, quotes, email with sub-address
    assert.equal(cleanLine("  user+tag@gmail.com : my:pass:with:colons  "), "user+tag@gmail.com:my:pass:with:colons");
    // URL with path and port
    assert.equal(cleanLine("https://vault.internal.net:8443/login/:root:secret123"), "root:secret123");
    // Pipe separator normalized to colon
    assert.equal(cleanLine("alpha|secret123"), "alpha:secret123");
    // Phone with + prefix
    assert.equal(cleanLine("+12025550199:secureP@ss1"), "+12025550199:secureP@ss1");
    // 11-digit phone number
    assert.equal(cleanLine("12025550199:pass123"), "12025550199:pass123");
});

test("clean-worker: raw buffer slicing handles UTF-8 multibyte characters across chunk boundaries", async () => {
    const tmpDir = path.join(__dirname, "fixtures");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, "multibyte-test.txt");

    const lines = [];
    for (let i = 0; i < 500; i++) {
        lines.push(`user${i}@пример.рф:пароль${i}`);
        lines.push(`user${i}@測試.com:密碼${i}`);
        lines.push(`target${i}@domain.com:💎🚀⚡️${i}`);
    }
    fs.writeFileSync(tmpFile, lines.join("\n"), "utf8");

    const pool = new WorkerPool(2);
    try {
        const query = "пример.рф";
        const result = await pool.searchFileParallel(tmpFile, query, 50);
        assert.equal(result.total, 500);
        assert.equal(result.matches.length, 50);
        assert.ok(result.matches[0].includes("пример.рф"));

        const emojiRes = await pool.searchFileParallel(tmpFile, "⚡️", 20);
        assert.equal(emojiRes.total, 500);
        assert.equal(emojiRes.matches.length, 20);
    } finally {
        pool.close();
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
});

test("worker-pool: handles close() and rejects queued/pending tasks cleanly without hanging", async () => {
    const pool = new WorkerPool(1);
    pool.warmup();

    // 10,000 lines forces parallel worker dispatch
    const heavyLines = Array(10000).fill("testuser@gmail.com:StrongPassword123!");
    const promise = pool.cleanLinesParallel(heavyLines);
    pool.close();

    await assert.rejects(promise, (err) => {
        return /WORKER_POOL_CLOSED/i.test(err.message);
    });
});

test("custom animated emojis: registry, tgEmoji formatting, and sync fallback", () => {
    clearCustomEmojis();
    assert.deepEqual(getCustomEmojis(), {});

    // Unregistered: returns plain symbol
    assert.equal(tgEmoji("🚀"), "🚀");
    assert.equal(tgEmoji("💎", "diamond"), "💎");

    // Register custom emoji document IDs
    registerCustomEmojis({
        diamond: "5368324170671202286",
        rocket: "5368324170671202287",
    });

    // Registered: returns <tg-emoji> HTML tag
    assert.equal(
        tgEmoji("💎", "diamond"),
        '<tg-emoji emoji-id="5368324170671202286">💎</tg-emoji>'
    );
    assert.equal(
        tgEmoji("🚀", "rocket"),
        '<tg-emoji emoji-id="5368324170671202287">🚀</tg-emoji>'
    );

    // Auto-maps recognized symbols if nameKey omitted
    assert.equal(
        tgEmoji("💎"),
        '<tg-emoji emoji-id="5368324170671202286">💎</tg-emoji>'
    );

    // Keyboard check
    const kb = emojisKeyboard();
    assert.ok(Array.isArray(kb.reply_markup.inline_keyboard));
    const btnSync = kb.reply_markup.inline_keyboard[0][0];
    assert.equal(btnSync.callback_data, "emojis:sync");

    // renderEmojiPacks includes active custom animated count
    const rendered = renderEmojiPacks({ packs: [{ title: "VIP Animated", shortName: "vip", count: 20, sample: ["💎", "🚀"] }], totalEmojis: 20 });
    assert.ok(rendered.includes("Active Custom Animated Icons"));
    assert.ok(rendered.includes("VIP Animated"));

    clearCustomEmojis();
});

test("userbot: syncCustomEmojis extracts and registers document IDs from account sticker packs", async () => {
    clearCustomEmojis();

    const mockPacks = [
        {
            title: "Animated Gems",
            shortName: "gems",
            count: 2,
            sample: ["💎", "✨"],
            documents: [
                { id: "98765432101", alt: "💎" },
                { id: "98765432102", alt: "✨" },
            ],
        },
    ];

    const count = await userbot.syncCustomEmojis({
        isReady: () => true,
        getInstalledEmojiPacks: async () => ({ packs: mockPacks, totalEmojis: 2 }),
    });

    assert.equal(count, 2);
    const registered = getCustomEmojis();
    assert.equal(registered["💎"], "98765432101");
    assert.equal(registered["✨"], "98765432102");

    assert.equal(tgEmoji("💎"), '<tg-emoji emoji-id="98765432101">💎</tg-emoji>');
    clearCustomEmojis();
});

test("bot safeReply & safeEdit: auto-fallback strips <tg-emoji> if Telegram Bot API rejects custom emoji tags", async () => {
    const api = await startFakeApi();
    try {
        const bot = createBot("123456:fake-token", {
            botUsername: "TestBot",
            telegram: { telegram: { apiRoot: api.apiRoot } },
        });

        // Register custom emoji so renderHelp produces <tg-emoji>
        registerCustomEmojis({ diamond: "99999999" });

        // Dispatch /help command
        await bot.handleUpdate({
            update_id: 1,
            message: {
                message_id: 10,
                chat: { id: 777, type: "private" },
                from: { id: 777, is_bot: false, first_name: "Test" },
                text: "/help",
                entities: [{ type: "bot_command", offset: 0, length: 5 }],
                date: Math.floor(Date.now() / 1000),
            },
        });

        // Verify fallback occurred: first attempt had <tg-emoji>, second attempt stripped it and succeeded
        const sendCalls = api.calls.filter((c) => c.method === "sendMessage");
        assert.ok(sendCalls.length >= 2, "expected at least 2 sendMessage calls (initial + fallback)");
        assert.ok(sendCalls[0].payload.text.includes("<tg-emoji"), "first call should contain <tg-emoji>");
        assert.ok(!sendCalls[1].payload.text.includes("<tg-emoji"), "fallback call should strip <tg-emoji>");
        assert.ok(sendCalls[1].payload.text.includes("💎"), "fallback call should preserve native symbol");
    } finally {
        clearCustomEmojis();
        await api.close();
    }
});

test("bot: command navigation clears interactive prompt states", async () => {
    const api = await startFakeApi();
    try {
        const bot = createBot("123456:fake-token", {
            botUsername: "TestBot",
            telegram: { telegram: { apiRoot: api.apiRoot } },
        });

        // Step 1: Open interactive prompt: ulp:custom:prompt
        await bot.handleUpdate({
            update_id: 2,
            callback_query: {
                id: "cb1",
                from: { id: 888 },
                message: { message_id: 200, chat: { id: 888, type: "private" } },
                data: "ulp:custom:prompt",
            },
        });

        // Step 2: Now send a top-level command (/stats). This MUST clear userPromptState.
        await bot.handleUpdate({
            update_id: 3,
            message: {
                message_id: 201,
                chat: { id: 888, type: "private" },
                from: { id: 888, is_bot: false },
                text: "/stats",
                entities: [{ type: "bot_command", offset: 0, length: 6 }],
                date: Math.floor(Date.now() / 1000),
            },
        });

        // Step 3: Now send non-command text (e.g. "hello bot").
        const beforeChatterCount = api.calls.length;
        await bot.handleUpdate({
            update_id: 4,
            message: {
                message_id: 202,
                chat: { id: 888, type: "private" },
                from: { id: 888, is_bot: false },
                text: "hello bot",
                date: Math.floor(Date.now() / 1000),
            },
        });

        const newCalls = api.calls.slice(beforeChatterCount);
        const triggeredUlp = newCalls.some(
            (c) => c.payload && c.payload.text && c.payload.text.includes("Starting search for")
        );
        assert.equal(triggeredUlp, false, "casual chatter should not trigger ULP search after command navigation");
    } finally {
        await api.close();
    }
});

test.after(() => {
    const { getSharedPool } = require("../src/worker-pool");
    getSharedPool().close();
});

