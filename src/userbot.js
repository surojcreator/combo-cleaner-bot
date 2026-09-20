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
    const { TelegramClient, Api } = require("teleproto");
    // eslint-disable-next-line global-require
    const { StringSession } = require("teleproto/sessions");
    // eslint-disable-next-line global-require
    const { NewMessage } = require("teleproto/events");
    // eslint-disable-next-line global-require
    const { getPeerId } = require("teleproto/Utils");
    return { TelegramClient, Api, StringSession, NewMessage, getPeerId };
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

/** Normalize Telegram's marked peer ids (including -100... supergroups). */
function markedPeerId(value) {
    return String(value == null ? "" : value).trim();
}

/**
 * Format a Date object to "DD.MM.YYYY" (e.g. "20.09.2026").
 * @param {Date} [date]
 * @returns {string}
 */
function formatDateDmy(date = new Date()) {
    const d = String(date.getDate()).padStart(2, "0");
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const y = String(date.getFullYear());
    return `${d}.${m}.${y}`;
}

/**
 * Return a new Date representing the previous day.
 * @param {Date} date
 * @returns {Date}
 */
function previousDate(date) {
    const prev = new Date(date.getTime());
    prev.setDate(prev.getDate() - 1);
    return prev;
}

/**
 * Parse "DD.MM.YYYY" or "DD/MM/YYYY" to Date.
 * @param {string} str
 * @returns {Date|null}
 */
function parseDmyDate(str) {
    const m = String(str || "").trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (!m) return null;
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10) - 1;
    const year = parseInt(m[3], 10);
    const d = new Date(year, month, day);
    if (Number.isNaN(d.getTime())) return null;
    return d;
}

/**
 * Extract the newest batch date from the DumpNews14Bot menu message.
 * Inspects all buttons and returns the first date matching "DD.MM.YYYY".
 * @param {any} menuMsg
 * @returns {Date|null}
 */
function detectLatestBatchDate(menuMsg) {
    if (!menuMsg || !menuMsg.replyMarkup || !Array.isArray(menuMsg.replyMarkup.rows)) {
        return null;
    }
    for (const row of menuMsg.replyMarkup.rows) {
        if (!Array.isArray(row.buttons)) continue;
        for (const btn of row.buttons) {
            const dataStr = btn.type && btn.type.data ? btn.type.data.toString() : (btn.data ? btn.data.toString() : "");
            const textStr = String(btn.text || "");
            const m = dataStr.match(/folder:(\d{1,2}\.\d{1,2}\.\d{4}):/) || textStr.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
            if (m) {
                const parsed = parseDmyDate(m[1]);
                if (parsed) return parsed;
            }
        }
    }
    return null;
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
    markedPeerId,
    formatDateDmy,
    previousDate,
    parseDmyDate,
    detectLatestBatchDate,
    createUserbot,
};

/**
 * Create the userbot transport.
 *
 * @param {ReturnType<typeof loadConfig>} cfg
 * @param {{ log?: Console, timeoutMs?: number }} [opts]
 */
function createUserbot(cfg = loadConfig(), opts = {}) {
    const log = opts.log || console;
    const timeoutMs = opts.timeoutMs || CALL_TIMEOUT_MS;
    const { TelegramClient, Api, StringSession, getPeerId } = loadLibs();

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

    const peerCache = new Map();
    const forwardedMsgKeys = new Set();

    /**
     * Resolve a Bot API chat id to the account-specific InputPeer/access hash.
     * Numeric -100... ids often aren't resolvable until dialogs warm the cache.
     * @param {number|string} chatId
     */
    async function resolveChatPeer(chatId) {
        const wanted = markedPeerId(chatId);
        if (peerCache.has(wanted)) {
            return peerCache.get(wanted);
        }
        try {
            const ent = await client.getInputEntity(chatId);
            peerCache.set(wanted, ent);
            return ent;
        } catch (firstError) {
            log.log(`userbot peer cache miss for ${wanted}; loading dialogs`);
            const dialogs = await withTimeout(
                client.getDialogs({ limit: 40 }),
                Math.max(timeoutMs, 30_000),
                "userbot getDialogs",
            );
            for (const dialog of dialogs) {
                let candidate = "";
                try {
                    candidate = markedPeerId(getPeerId(dialog.inputEntity, true));
                } catch {
                    candidate = dialog.id ? markedPeerId(dialog.id) : "";
                }
                if (candidate === wanted || (dialog.id && markedPeerId(dialog.id) === wanted)) {
                    peerCache.set(wanted, dialog.inputEntity);
                    return dialog.inputEntity;
                }
            }
            const err = new Error(`ACCOUNT_CANNOT_SEE_CHAT:${wanted}`);
            err.cause = firstError;
            throw err;
        }
    }

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
                maxSessions: 8,
                sessions: 4,
                download: {
                    maxSessions: 8,
                    startSessions: 4,
                },
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
            log.log(`Userbot connected · searcher @${cfg.searcher} (id ${searcherId})`);

            // Pre-warm active dialogs in background so resolveChatPeer is instant for /save
            void client.getDialogs({ limit: 40 }).then((dialogs) => {
                for (const d of dialogs || []) {
                    try {
                        const pid = markedPeerId(getPeerId(d.inputEntity, true));
                        if (pid) peerCache.set(pid, d.inputEntity);
                        if (d.id) peerCache.set(markedPeerId(d.id), d.inputEntity);
                    } catch {}
                }
            }).catch(() => {});

            const libs = loadLibs();
            client.addEventHandler(async (event) => {
                const msg = event.message;
                if (!msg) return;
                if (msg.peerId) {
                    try {
                        const mid = markedPeerId(getPeerId(msg.peerId, true));
                        if (mid && !peerCache.has(mid)) {
                            peerCache.set(mid, msg.inputPeer || msg.peerId);
                        }
                    } catch {}
                }
                if (!resultSink) return;
                const sender = Number(msg.senderId || (msg.peerId && msg.peerId.userId) || 0);
                if (searcherId && sender && sender !== searcherId) return;
                try {
                    await resultSink(msg);
                } catch (err) {
                    log.error("userbot result sink failed:", err && err.message ? err.message : err);
                }
            }, new libs.NewMessage({}));

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

            let message = options.message || null;
            if (!message) {
                const inputPeer = await resolveChatPeer(chatId);
                const messages = await withTimeout(
                    client.getMessages(inputPeer, { ids: Number(messageId) }),
                    timeoutMs,
                    "userbot getMessages",
                );
                message = messages && messages[0];
            }
            if (!message) {
                throw new Error(`MESSAGE_NOT_VISIBLE:${messageId}`);
            }
            if (!message.media) {
                throw new Error(`REPLIED_MESSAGE_HAS_NO_MEDIA:${messageId}`);
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
                    partSizeKb: 1024,
                    progressCallback: (done, total) => {
                        if (options.onProgress) options.onProgress(Number(done), Number(total));
                    },
                    requestTimeout: 180_000,
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
            if (!msg || !msg.id) return "skipped";
            const fwdKey = `${toChatId}:${msg.id}`;
            if (forwardedMsgKeys.has(fwdKey)) {
                return "already_forwarded";
            }
            forwardedMsgKeys.add(fwdKey);
            if (forwardedMsgKeys.size > 2000) {
                const first = forwardedMsgKeys.values().next().value;
                forwardedMsgKeys.delete(first);
            }
            let targetPeer = toChatId;
            try {
                targetPeer = await resolveChatPeer(toChatId);
            } catch (err) {
                log.log(`userbot resolveChatPeer fallback for ${toChatId}: ${err && err.message ? err.message : err}`);
            }

            try {
                await withTimeout(
                    client.forwardMessages(targetPeer, { messages: [msg.id], fromPeer: searcherEntity }),
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
                        client.sendFile(targetPeer, {
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
                    client.sendMessage(targetPeer, { message: `${ULP_MARKER} ${text}` }),
                    timeoutMs,
                    "userbot copy",
                );
                return "copy";
            }
            return "skipped";
        },

        /**
         * Find a document from the replied message or the most recent message in the chat.
         * Resolves the Telegram Privacy Mode issue where Bot API strips reply_to_message.
         *
         * @param {number|string} chatId
         * @param {number} commandMessageId
         * @param {number} [preferredReplyId]
         * @returns {Promise<{ messageId: number, fileName: string, size: number, document: any } | null>}
         */
        async findRepliedOrRecentDocument(chatId, commandMessageId, preferredReplyId) {
            if (!ready || !client) throw new Error("USERBOT_NOT_READY");
            const inputPeer = await resolveChatPeer(chatId);

            let targetReplyId = preferredReplyId ? Number(preferredReplyId) : null;

            if (!targetReplyId && commandMessageId) {
                try {
                    const messages = await withTimeout(
                        client.getMessages(inputPeer, { ids: Number(commandMessageId) }),
                        timeoutMs,
                        "userbot getMessages cmd",
                    );
                    const cmdMsg = messages && messages[0];
                    if (cmdMsg && cmdMsg.replyTo && cmdMsg.replyTo.replyToMsgId) {
                        targetReplyId = cmdMsg.replyTo.replyToMsgId;
                    }
                } catch (err) {
                    log.error("userbot failed to fetch command message:", err && err.message ? err.message : err);
                }
            }

            if (targetReplyId) {
                try {
                    const messages = await withTimeout(
                        client.getMessages(inputPeer, { ids: targetReplyId }),
                        timeoutMs,
                        "userbot getMessages reply",
                    );
                    const msg = messages && messages[0];
                    if (msg && msg.media) {
                        const fileName =
                            (msg.file && msg.file.name) ||
                            (msg.media.document && msg.media.document.attributes &&
                                msg.media.document.attributes.find((a) => a && a.fileName) &&
                                msg.media.document.attributes.find((a) => a && a.fileName).fileName) ||
                            `telegram-${targetReplyId}.bin`;
                        const size = Number((msg.file && msg.file.size) || (msg.media.document && msg.media.document.size) || 0);
                        return {
                            messageId: targetReplyId,
                            fileName: safeDownloadName(fileName),
                            size,
                            document: msg.media.document || msg.file,
                            message: msg,
                        };
                    }
                } catch (err) {
                    log.error("userbot failed to fetch replied message:", err && err.message ? err.message : err);
                }
            }

            // Fallback: Scan recent messages in chat for the newest document
            try {
                const recent = await withTimeout(
                    client.getMessages(inputPeer, { limit: 15 }),
                    timeoutMs,
                    "userbot getRecentMessages",
                );
                for (const msg of recent || []) {
                    if (msg.id === Number(commandMessageId)) continue;
                    if (msg.media && (msg.media.document || msg.file)) {
                        const fileName =
                            (msg.file && msg.file.name) ||
                            (msg.media.document && msg.media.document.attributes &&
                                msg.media.document.attributes.find((a) => a && a.fileName) &&
                                msg.media.document.attributes.find((a) => a && a.fileName).fileName) ||
                            `telegram-${msg.id}.bin`;
                        const size = Number((msg.file && msg.file.size) || (msg.media.document && msg.media.document.size) || 0);
                        return {
                            messageId: msg.id,
                            fileName: safeDownloadName(fileName),
                            size,
                            document: msg.media.document || msg.file,
                            message: msg,
                        };
                    }
                }
            } catch (err) {
                log.error("userbot failed to scan recent messages:", err && err.message ? err.message : err);
            }

            return null;
        },

        /**
         * Find multiple recent documents in a chat for batch saving.
         *
         * @param {number|string} chatId
         * @param {number} [limit] max documents to return (default 10)
         * @param {number} [commandMessageId] optional command message id to exclude
         * @returns {Promise<Array<{ messageId: number, fileName: string, size: number, document: any }>>}
         */
        async findRecentDocuments(chatId, limit = 10, commandMessageId = null) {
            if (!ready || !client) return [];
            let inputPeer = chatId;
            try {
                inputPeer = await resolveChatPeer(chatId);
            } catch {
                inputPeer = chatId;
            }
            try {
                const recent = await withTimeout(
                    client.getMessages(inputPeer, { limit: 80 }),
                    timeoutMs,
                    "userbot getRecentMessagesBatch",
                );
                const found = [];
                for (const msg of recent || []) {
                    if (commandMessageId && msg.id === Number(commandMessageId)) continue;
                    if (found.length >= limit) break;
                    if (msg.media && (msg.media.document || msg.file)) {
                        const fileName =
                            (msg.file && msg.file.name) ||
                            (msg.media.document && msg.media.document.attributes &&
                                msg.media.document.attributes.find((a) => a && a.fileName) &&
                                msg.media.document.attributes.find((a) => a && a.fileName).fileName) ||
                            `telegram-${msg.id}.bin`;
                        const size = Number((msg.file && msg.file.size) || (msg.media.document && msg.media.document.size) || 0);
                        found.push({
                            messageId: msg.id,
                            fileName: safeDownloadName(fileName),
                            size,
                            document: msg.media.document || msg.file,
                            message: msg,
                        });
                    }
                }
                // Return in chronological order so files process sequentially (e.g. part 1, part 2...)
                return found.reverse();
            } catch (err) {
                log.error("userbot failed to scan recent batch documents:", err && err.message ? err.message : err);
                return [];
            }
        },

        /**
         * Query all installed custom emoji sticker sets and animated emojis on the user account.
         * @returns {Promise<{ packs: Array<{ title: string, shortName: string, id: string, count: number, sample: string[] }>, totalEmojis: number }>}
         */
        async getInstalledEmojiPacks() {
            if (!ready || !client) {
                return { packs: [], totalEmojis: 0, error: "USERBOT_NOT_READY" };
            }
            try {
                const res = await withTimeout(
                    client.invoke(new Api.messages.GetEmojiStickers({ hash: BigInt(0) })),
                    timeoutMs,
                    "userbot GetEmojiStickers",
                );
                const packs = [];
                let totalEmojis = 0;
                for (const s of (res && res.sets) || []) {
                    try {
                        const full = await withTimeout(
                            client.invoke(new Api.messages.GetStickerSet({
                                stickerset: new Api.InputStickerSetID({ id: s.id, accessHash: s.accessHash }),
                                hash: 0,
                            })),
                            timeoutMs,
                            `userbot GetStickerSet ${s.shortName}`,
                        );
                        const sample = (full.packs || []).slice(0, 10).map((p) => p.emoticon);
                        const count = full.documents ? full.documents.length : (s.count || 0);
                        totalEmojis += count;
                        packs.push({
                            title: s.title || s.shortName,
                            shortName: s.shortName,
                            id: s.id.toString(),
                            count,
                            sample,
                        });
                    } catch (e) {
                        packs.push({
                            title: s.title || s.shortName,
                            shortName: s.shortName,
                            id: s.id.toString(),
                            count: s.count || 0,
                            sample: [],
                        });
                        totalEmojis += s.count || 0;
                    }
                }
                return { packs, totalEmojis };
            } catch (err) {
                log.error("userbot getInstalledEmojiPacks error:", err && err.message ? err.message : err);
                return { packs: [], totalEmojis: 0, error: err.message };
            }
        },

        /**
         * Click an inline callback button on a message from the searcher bot.
         * @param {number} messageId
         * @param {string|Buffer} callbackData
         */
        async clickButton(messageId, callbackData) {
            if (!ready || !client) throw new Error("USERBOT_NOT_READY");
            const dataBuf = Buffer.isBuffer(callbackData) ? callbackData : Buffer.from(String(callbackData));
            return await withTimeout(
                client.invoke(new Api.messages.GetBotCallbackAnswer({
                    peer: searcherEntity || cfg.searcher,
                    msgId: Number(messageId),
                    data: dataBuf,
                })),
                timeoutMs,
                "userbot clickButton",
            );
        },

        /**
         * Perform automated day-by-day search on @DumpNews14Bot via inline buttons.
         * Starts with startDate (formatted as DD.MM.YYYY, e.g. 20.09.2026) and steps backward.
         * Clicks folder:DD.MM.YYYY:P then hist:DD.MM.YYYY.
         *
         * @param {{
         *   query: string,
         *   daysCount?: number,
         *   startDate?: Date,
         *   chatId?: number|string,
         *   stepDelayMs?: number,
         *   shouldStop?: () => boolean,
         *   onStatus?: (status: { day: string, attempt: number, totalDays: number, step: string }) => void,
         *   sleep?: (ms: number) => Promise<void>,
         * }} options
         */
        async searchDayByDay(options) {
            if (!ready || !client) throw new Error("USERBOT_NOT_READY");
            const {
                query,
                daysCount = 5,
                startDate = null,
                chatId = null,
                stepDelayMs = 7000,
                shouldStop = () => false,
                onStatus = () => {},
                sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
            } = options;

            const searchTarget = searcherEntity || cfg.searcher;

            // Step 0: Ensure the query is active in the searcher bot
            if (shouldStop()) return { status: "stopped", daysProcessed: 0 };
            onStatus({
                day: startDate ? formatDateDmy(startDate) : "latest",
                attempt: 1,
                totalDays: daysCount,
                step: `Setting query "${query}"`,
            });
            await withTimeout(
                client.sendMessage(searchTarget, { message: query }),
                timeoutMs,
                "userbot send query",
            );
            await sleep(Math.min(stepDelayMs, 1000));

            let currentDate = startDate ? new Date(startDate.getTime()) : null;

            // Step 1: Auto-discover the latest batch date if no explicit startDate was given
            if (!currentDate) {
                onStatus({
                    day: "latest",
                    attempt: 1,
                    totalDays: daysCount,
                    step: "Detecting latest batch date…",
                });
                const sentStart = await withTimeout(
                    client.sendMessage(searchTarget, { message: "/start" }),
                    timeoutMs,
                    "userbot send /start for latest batch",
                );
                await sleep(1000);
                const recentMsgs = await withTimeout(
                    client.getMessages(searchTarget, { limit: 5 }),
                    timeoutMs,
                    "userbot getMessages for latest batch",
                );
                const initialMenu =
                    recentMsgs.find((m) => !m.out && m.id > (sentStart.id || 0) && m.replyMarkup && m.replyMarkup.rows) ||
                    recentMsgs.find((m) => !m.out && m.replyMarkup && m.replyMarkup.rows);
                const detected = detectLatestBatchDate(initialMenu);
                if (detected) {
                    currentDate = detected;
                    log.log(`userbot detected latest batch date: ${formatDateDmy(currentDate)}`);
                } else {
                    currentDate = new Date();
                    log.log(`userbot could not detect batch date from menu, falling back to ${formatDateDmy(currentDate)}`);
                }
            }

            let daysProcessed = 0;
            let consecutiveMisses = 0;

            for (let dayIdx = 0; dayIdx < daysCount; dayIdx++) {
                if (shouldStop()) return { status: "stopped", daysProcessed };

                const dateStr = formatDateDmy(currentDate);
                onStatus({
                    day: dateStr,
                    attempt: dayIdx + 1,
                    totalDays: daysCount,
                    step: `Opening folder for ${dateStr}`,
                });

                // Send /start to get the fresh date folder menu
                const sentStart = await withTimeout(
                    client.sendMessage(searchTarget, { message: "/start" }),
                    timeoutMs,
                    "userbot send /start",
                );
                await sleep(1000);

                if (shouldStop()) return { status: "stopped", daysProcessed };

                // Get the menu message with buttons
                let menuMsg = null;
                let folderBtn = null;
                let pageAttempts = 0;

                while (pageAttempts < 5 && !folderBtn) {
                    const recentMsgs = await withTimeout(
                        client.getMessages(searchTarget, { limit: 5 }),
                        timeoutMs,
                        "userbot getMessages menu",
                    );
                    menuMsg =
                        recentMsgs.find((m) => !m.out && m.id > (sentStart.id || 0) && m.replyMarkup && m.replyMarkup.rows) ||
                        recentMsgs.find((m) => !m.out && m.replyMarkup && m.replyMarkup.rows);
                    if (!menuMsg) break;

                    // Search for folder button with dateStr
                    for (const row of menuMsg.replyMarkup.rows) {
                        for (const btn of row.buttons) {
                            const dataStr = btn.type && btn.type.data ? btn.type.data.toString() : (btn.data ? btn.data.toString() : "");
                            if (dataStr.startsWith(`folder:${dateStr}:`) || (btn.text && btn.text.includes(dateStr))) {
                                folderBtn = { text: btn.text, data: dataStr };
                                break;
                            }
                        }
                        if (folderBtn) break;
                    }

                    // If not found on this page, try clicking next page "➡️"
                    if (!folderBtn) {
                        let nextPageBtn = null;
                        for (const row of menuMsg.replyMarkup.rows) {
                            for (const btn of row.buttons) {
                                const dataStr = btn.type && btn.type.data ? btn.type.data.toString() : (btn.data ? btn.data.toString() : "");
                                if (dataStr.startsWith("menu:page:") && (btn.text === "➡️" || dataStr !== "menu:page:0")) {
                                    nextPageBtn = { text: btn.text, data: dataStr };
                                    break;
                                }
                            }
                            if (nextPageBtn) break;
                        }
                        if (nextPageBtn) {
                            await withTimeout(
                                client.invoke(new Api.messages.GetBotCallbackAnswer({
                                    peer: searchTarget,
                                    msgId: Number(menuMsg.id),
                                    data: Buffer.from(nextPageBtn.data),
                                })),
                                timeoutMs,
                                "userbot nextPage",
                            );
                            await sleep(1000);
                            // Refresh menuMsg by ID to inspect updated buttons on edited message
                            try {
                                const updated = await client.getMessages(searchTarget, { ids: [menuMsg.id] });
                                if (updated && updated[0] && updated[0].replyMarkup) {
                                    menuMsg = updated[0];
                                }
                            } catch {
                                // ignore
                            }
                            pageAttempts++;
                        } else {
                            break;
                        }
                    }
                }

                if (!folderBtn || !menuMsg) {
                    log.log(`userbot could not find date folder for ${dateStr}`);
                    currentDate = previousDate(currentDate);
                    consecutiveMisses++;
                    if (consecutiveMisses >= 3) {
                        log.log(`userbot no more date folders available, stopping day search`);
                        break;
                    }
                    continue;
                }
                consecutiveMisses = 0;

                // Click folder button
                onStatus({
                    day: dateStr,
                    attempt: dayIdx + 1,
                    totalDays: daysCount,
                    step: `Clicking folder:${dateStr}`,
                });
                await withTimeout(
                    client.invoke(new Api.messages.GetBotCallbackAnswer({
                        peer: searchTarget,
                        msgId: Number(menuMsg.id),
                        data: Buffer.from(folderBtn.data),
                    })),
                    timeoutMs,
                    "userbot click folder",
                );
                await sleep(1200);

                if (shouldStop()) return { status: "stopped", daysProcessed };

                // Get the updated folder view and find hist button
                let folderView = null;
                try {
                    const byId = await client.getMessages(searchTarget, { ids: [menuMsg.id] });
                    if (byId && byId[0] && byId[0].replyMarkup && byId[0].replyMarkup.rows) {
                        folderView = byId[0];
                    }
                } catch {
                    // ignore
                }
                if (!folderView) {
                    const folderMsgs = await withTimeout(
                        client.getMessages(searchTarget, { limit: 5 }),
                        timeoutMs,
                        "userbot getMessages folder",
                    );
                    folderView = folderMsgs.find((m) => !m.out && m.replyMarkup && m.replyMarkup.rows) || menuMsg;
                }

                let histBtn = null;
                if (folderView && folderView.replyMarkup && folderView.replyMarkup.rows) {
                    for (const row of folderView.replyMarkup.rows) {
                        for (const btn of row.buttons) {
                            const dataStr = btn.type && btn.type.data ? btn.type.data.toString() : (btn.data ? btn.data.toString() : "");
                            if (dataStr.startsWith(`hist:${dateStr}`) || dataStr.includes("hist:")) {
                                histBtn = { text: btn.text, data: dataStr };
                                break;
                            }
                        }
                        if (histBtn) break;
                    }
                }

                if (histBtn) {
                    onStatus({
                        day: dateStr,
                        attempt: dayIdx + 1,
                        totalDays: daysCount,
                        step: `Clicking hist:${dateStr}`,
                    });
                    await withTimeout(
                        client.invoke(new Api.messages.GetBotCallbackAnswer({
                            peer: searchTarget,
                            msgId: Number(folderView.id),
                            data: Buffer.from(histBtn.data),
                        })),
                        timeoutMs,
                        "userbot click hist",
                    );
                    daysProcessed++;

                    // Wait for result message from DumpNews14Bot and forward
                    await sleep(1800);
                    if (chatId) {
                        try {
                            const latest = await client.getMessages(searchTarget, { limit: 4 });
                            for (const m of latest) {
                                if (!m.out && (m.id > (folderView.id || 0) || m.media || m.document)) {
                                    if (resultSink) {
                                        await resultSink(m);
                                    } else {
                                        await forwardResult(chatId, m);
                                    }
                                }
                            }
                        } catch (err) {
                            log.log(`userbot post-hist message fetch error: ${err && err.message ? err.message : err}`);
                        }
                    }
                } else {
                    log.log(`userbot could not find hist button in folder for ${dateStr}`);
                }

                // Wait before moving to previous day to comply with DumpNews14Bot rate limiter
                if (dayIdx < daysCount - 1) {
                    onStatus({
                        day: dateStr,
                        attempt: dayIdx + 1,
                        totalDays: daysCount,
                        step: `Pacing before next day…`,
                    });
                    await sleep(Math.max(1200, Math.min(stepDelayMs, 3000) - 1800));
                }

                // Go down one day at a time
                currentDate = previousDate(currentDate);
            }

            return { status: "done", daysProcessed };
        },
    };
}

