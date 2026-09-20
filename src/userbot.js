"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * MTProto "userbot" transport — the bypass for sealed search bots.
 *
 * Bot-to-bot private chats require the *other* bot's owner to enable
 * "Bot-to-Bot Communication" in @BotFather. When that is impossible, this
 * transport instead talks to the searcher bot from a **user account**: exactly
 * what the operator would do by hand, only paced and relayed automatically.
 *
 *   /ulp htzone.co.il  ->  userbot sends "htzone.co.il", then "hist:full:day"
 *                          (7s apart, capped retries)
 *                       ->  every answer from the searcher bot is forwarded into
 *                          the chat that asked, so it can be cleaned into the batch
 *
 * Requires TELEGRAM_API_ID, TELEGRAM_API_HASH and TELEGRAM_SESSION
 * (`npm run userbot:login` prints the session string).
 *
 * The library is loaded lazily so the bot still boots without it installed.
 */

/** Marker put in front of copied (non-forwardable) results. */
const ULP_MARKER = "#ulp";

/** Default timeout for a single MTProto call. */
const CALL_TIMEOUT_MS = 25000;

/**
 * Read userbot settings from the environment.
 * @param {NodeJS.ProcessEnv} [env]
 */
function loadConfig(env = process.env) {
    const apiId = Number(env.TELEGRAM_API_ID || 0);
    return {
        apiId: Number.isFinite(apiId) ? apiId : 0,
        apiHash: String(env.TELEGRAM_API_HASH || "").trim(),
        session: String(env.TELEGRAM_SESSION || "").trim(),
        searcher: String(env.SEARCH_BOT_USERNAME || "DumpNews14Bot").replace(/^@+/, ""),
        transport: String(env.SEARCH_TRANSPORT || "auto").trim().toLowerCase(),
    };
}

/**
 * Is the userbot fully configured?
 * @param {ReturnType<typeof loadConfig>} cfg
 */
function isConfigured(cfg) {
    return Boolean(cfg && cfg.apiId > 0 && cfg.apiHash && cfg.session);
}

/**
 * Map an MTProto error to the relay's error kinds.
 * @param {any} err
 * @returns {"userbot_auth"|"not_found"|"flood_wait"|"blocked"|"other"}
 */
function classifyUserbotError(err) {
    const text = String((err && (err.errorMessage || err.message)) || "");
    if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|SESSION_PASSWORD_NEEDED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED|AUTH_KEY_INVALID|SESSION_INVALID|USERBOT_NOT_READY|API_ID_INVALID/i.test(text)) {
        return "userbot_auth";
    }
    if (/USERNAME_NOT_OCCUPIED|USERNAME_INVALID|PEER_ID_INVALID|USER_NOT_FOUND|CHANNEL_INVALID/i.test(text)) {
        return "not_found";
    }
    if (/FLOOD_WAIT|SLOW_MODE_WAIT|FROZEN_METHOD_INVALID/i.test(text)) {
        return "flood_wait";
    }
    if (/PRIVACY_RESTRICTED|YOU_BLOCKED_USER|CHAT_WRITE_FORBIDDEN|USER_IS_BLOCKED/i.test(text)) {
        return "blocked";
    }
    return "other";
}

/**
 * Load the MTProto library lazily.
 */
function loadLibs() {
    // eslint-disable-next-line global-require
    const { TelegramClient } = require("teleproto");
    // eslint-disable-next-line global-require
    const { StringSession } = require("teleproto/sessions");
    // eslint-disable-next-line global-require
    const { NewMessage } = require("teleproto/events");
    return { TelegramClient, StringSession, NewMessage };
}

/**
 * Reject after `ms` so a stuck MTProto call can't block a run forever.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, label) {
    let timer;
    const guard = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        if (timer && typeof timer.unref === "function") timer.unref();
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * Turn a Telegram document name into a safe local filename.
 * @param {string} raw
 */
function safeDownloadName(raw) {
    const base = path.basename(String(raw || "telegram-file.bin"));
    const safe = base
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
        .replace(/\s+/g, " ")
        .replace(/^\.+/, "")
        .slice(0, 180);
    return safe || "telegram-file.bin";
}

/** Build a collision-resistant destination path under the configured root. */
function downloadPath(root, rawName, messageId) {
    const name = safeDownloadName(rawName);
    const ext = path.extname(name).slice(0, 16);
    const stem = path.basename(name, ext).slice(0, 140) || "telegram-file";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return path.join(path.resolve(root), `${stem}_${messageId}_${stamp}${ext}`);
}

module.exports = {
    ULP_MARKER,
    CALL_TIMEOUT_MS,
    loadConfig,
    isConfigured,
    classifyUserbotError,
    loadLibs,
    withTimeout,
    safeDownloadName,
    downloadPath,
    createUserbot,
};

/**
 * Create the userbot transport.
 *
 * @param {ReturnType<typeof loadConfig>} cfg
 * @param {{ log?: Console, timeoutMs?: number }} [opts]
 */
function createUserbot(cfg, opts = {}) {
    const log = opts.log || console;
    const timeoutMs = opts.timeoutMs || CALL_TIMEOUT_MS;
    const { TelegramClient, StringSession } = loadLibs();

    /** @type {any} */
    let client = null;
    /** @type {any} */
    let searcherEntity = null;
    let searcherId = null;
    let ready = false;

    /**
     * Whoever cares whether a searcher message should be relayed.
     * @type {((msg: any) => Promise<void>|void)|null}
     */
    let resultSink = null;

    return {
        kind: "userbot",
        get searcherId() {
            return searcherId;
        },
        /** @param {(msg: any) => Promise<void>|void} sink */
        onResult(sink) {
            resultSink = sink;
        },
        isReady() {
            return ready;
        },
        classify: classifyUserbotError,

        async start() {
            if (ready) return { id: searcherId, username: cfg.searcher };
            client = new TelegramClient(new StringSession(cfg.session), cfg.apiId, cfg.apiHash, {
                connectionRetries: 5,
                autoReconnect: true,
            });

            const noInput = () => {
                throw new Error("SESSION_INVALID: run `npm run userbot:login` and update TELEGRAM_SESSION");
            };
            await withTimeout(
                client.start({
                    phoneNumber: noInput,
                    password: noInput,
                    phoneCode: noInput,
                    emailAddress: noInput,
                    emailVerification: noInput,
                    onError: (err) => log.error("userbot auth error:", err && err.message ? err.message : err),
                }),
                timeoutMs,
                "userbot start",
            );

            searcherEntity = await withTimeout(client.getEntity(cfg.searcher), timeoutMs, "userbot getEntity");
            searcherId = Number(searcherEntity && searcherEntity.id) || null;
            ready = true;
            log.log(`Userbot connected \u00B7 searcher @${cfg.searcher} (id ${searcherId})`);

            const libs = loadLibs();
            client.addEventHandler(async (event) => {
                const msg = event.message;
                if (!msg || !resultSink) return;
                try {
                    await resultSink(msg);
                } catch (err) {
                    log.error("userbot result sink failed:", err && err.message ? err.message : err);
                }
            }, new libs.NewMessage({ fromUsers: [searcherId] }));

            return { id: searcherId, username: cfg.searcher };
        },

        async stop() {
            ready = false;
            if (client) {
                try {
                    await client.disconnect();
                } catch {
                    // ignore
                }
            }
        },

        async send(text) {
            if (!ready || !client) throw new Error("USERBOT_NOT_READY");
            const sent = await withTimeout(
                client.sendMessage(searcherEntity || cfg.searcher, { message: text }),
                timeoutMs,
                "userbot sendMessage",
            );
            return { message_id: Number(sent && sent.id) || 0, chat: { id: searcherId } };
        },

        /**
         * Fetch a message visible to the account and stream its media to disk.
         * The account must be a member of the source group/chat.
         *
         * @param {number|string} chatId
         * @param {number} messageId
         * @param {{ root: string, fileName?: string, onProgress?: (done: number, total: number) => void }} options
         */
        async downloadMessageToDisk(chatId, messageId, options) {
            if (!ready || !client) throw new Error("USERBOT_NOT_READY");
            const root = path.resolve(options.root);
            fs.mkdirSync(root, { recursive: true });

            const messages = await withTimeout(
                client.getMessages(chatId, { ids: Number(messageId) }),
                timeoutMs,
                "userbot getMessages",
            );
            const message = messages && messages[0];
            if (!message || !message.media) {
                throw new Error("REPLIED_MESSAGE_HAS_NO_MEDIA");
            }

            const actualName =
                (message.file && message.file.name) ||
                options.fileName ||
                `telegram-${messageId}.bin`;
            const finalPath = downloadPath(root, actualName, messageId);
            const partialPath = `${finalPath}.partial`;

            try {
                const result = await client.downloadMedia(message, {
                    outputFile: partialPath,
                    progressCallback: (done, total) => {
                        if (options.onProgress) options.onProgress(Number(done), Number(total));
                    },
                    requestTimeout: 60_000,
                });
                if (!result || !fs.existsSync(partialPath)) {
                    throw new Error("TELEGRAM_MEDIA_DOWNLOAD_FAILED");
                }
                fs.renameSync(partialPath, finalPath);
                const stat = fs.statSync(finalPath);
                return {
                    path: finalPath,
                    name: path.basename(finalPath),
                    originalName: safeDownloadName(actualName),
                    size: stat.size,
                };
            } catch (err) {
                fs.rmSync(partialPath, { force: true });
                throw err;
            }
        },

        async forwardResult(toChatId, msg) {
            if (!ready || !client) return "skipped";
            try {
                await withTimeout(
                    client.forwardMessages(toChatId, { messages: [msg.id], fromPeer: searcherEntity }),
                    timeoutMs,
                    "userbot forwardMessages",
                );
                return "forward";
            } catch (err) {
                log.log(`forward blocked (${err && err.message ? err.message : err}) - copying instead`);
            }

            const text = msg.message || "";
            const media = msg.media;
            if (media) {
                const buffer = await withTimeout(client.downloadMedia(msg, {}), timeoutMs, "userbot downloadMedia").catch(() => null);
                if (buffer) {
                    const name = (msg.file && msg.file.name) || "ulp-result.bin";
                    await withTimeout(
                        client.sendFile(toChatId, {
                            file: buffer,
                            caption: `${ULP_MARKER} ${name}`,
                            forceDocument: true,
                        }),
                        timeoutMs,
                        "userbot sendFile",
                    );
                    return "copy";
                }
            }
            if (text) {
                await withTimeout(
                    client.sendMessage(toChatId, { message: `${ULP_MARKER} ${text}` }),
                    timeoutMs,
                    "userbot copy",
                );
                return "copy";
            }
            return "skipped";
        },
    };
}

