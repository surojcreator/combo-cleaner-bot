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
    env = env || process.env || {};
    const apiId = Number(env.TELEGRAM_API_ID || 0);
    return {
        apiId: Number.isFinite(apiId) ? apiId : 0,
        apiHash: String(env.TELEGRAM_API_HASH || "").trim(),
        session: String(env.TELEGRAM_SESSION || "").trim(),
        searcher: String(env.SEARCH_BOT_USERNAME || "DumpNews14Bot").replace(/^@+/, ""),
        transport: String(env.SEARCH_TRANSPORT || "auto").trim().toLowerCase(),
        botUsername: String(env.BOT_USERNAME || "").replace(/^@+/, ""),
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
    if (!raw || raw === "undefined" || raw === "null" || raw === "file" || raw === "telegram-undefined.bin") {
        return "telegram-file.bin";
    }
    const base = path.basename(String(raw || "telegram-file.bin"));
    const safe = base
        .replace(/\0/g, "")
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
        .replace(/\s+/g, " ")
        .replace(/^\.+/, "")
        .slice(0, 180);
    return safe || "telegram-file.bin";
}

function isUnnamedName(val) {
    if (!val || typeof val !== "string") return true;
    const s = val.trim().toLowerCase();
    if (!s) return true;
    const baseWithoutExt = s.replace(/\.[a-z0-9_]+$/i, "");
    return (
        s === "file" ||
        s === "undefined" ||
        s === "null" ||
        s === "unknown" ||
        s === "unnamed" ||
        s === "telegram-file.bin" ||
        s === "ulp-result.bin" ||
        s.startsWith("telegram-undefined") ||
        s.startsWith("ulp-result-") ||
        baseWithoutExt === "unnamed" ||
        baseWithoutExt === "file" ||
        baseWithoutExt === "undefined" ||
        baseWithoutExt === "null" ||
        baseWithoutExt === "unknown" ||
        baseWithoutExt.startsWith("unnamed_") ||
        baseWithoutExt.startsWith("unnamed-")
    );
}

/**
 * Bulletproof filename resolution helper:
 * Extracts filename from GramJS message attributes, Telegraf document objects,
 * or inspects MIME types before falling back to a structured timestamped name.
 *
 * @param {any} doc
 * @param {string} [defaultBase]
 * @param {string} [ext]
 * @returns {string}
 */
function resolveSafeFileName(doc, defaultBase = "combolist", ext = ".txt") {
    let name = "";
    if (typeof doc === "string" && doc.trim()) {
        name = doc.trim();
    } else if (doc && typeof doc === "object") {
        name = doc.file_name || doc.fileName || doc.filename || "";

        if (!name && doc.media && doc.media.document && Array.isArray(doc.media.document.attributes)) {
            const attr = doc.media.document.attributes.find((a) => a && (a.fileName || a.file_name));
            if (attr) name = attr.fileName || attr.file_name || "";
        }

        if (!name && doc.document && Array.isArray(doc.document.attributes)) {
            const attr = doc.document.attributes.find((a) => a && (a.fileName || a.file_name));
            if (attr) name = attr.fileName || attr.file_name || "";
        }

        const mime = doc.mime_type || doc.mimeType ||
            (doc.media && doc.media.document && doc.media.document.mimeType) ||
            (doc.document && (doc.document.mime_type || doc.document.mimeType)) || "";
        if (mime) {
            if (mime.includes("zip")) ext = ".zip";
            else if (mime.includes("csv")) ext = ".csv";
            else if (mime.includes("json")) ext = ".json";
            else if (mime.includes("text") || mime.includes("plain")) ext = ".txt";
        }
    }

    if (isUnnamedName(name)) {
        name = "";
    }

    if (!name) {
        const stamp = new Date().toISOString().slice(0, 10);
        const safeBase = (defaultBase && typeof defaultBase === "string" && defaultBase.trim() && !isUnnamedName(defaultBase))
            ? defaultBase.trim()
            : "combolist";
        name = `${safeBase}_${stamp}${ext}`;
    }

    return safeDownloadName(name);
}

/** Build a collision-resistant destination path under the configured root. */
function downloadPath(root, rawName, messageId) {
    const safeRoot = typeof root === "string" && root ? root : ".";
    const name = safeDownloadName(rawName);
    const ext = path.extname(name).slice(0, 16);
    const stem = path.basename(name, ext).slice(0, 140) || "telegram-file";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return path.join(path.resolve(safeRoot), `${stem}_${messageId || Date.now()}_${stamp}${ext}`);
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
    const dObj = (date instanceof Date && !Number.isNaN(date.getTime())) ? date : new Date();
    const d = String(dObj.getDate()).padStart(2, "0");
    const m = String(dObj.getMonth() + 1).padStart(2, "0");
    const y = String(dObj.getFullYear());
    return `${d}.${m}.${y}`;
}

/**
 * Return a new Date representing the previous day.
 * @param {Date} date
 * @returns {Date}
 */
function previousDate(date) {
    const dObj = (date instanceof Date && !Number.isNaN(date.getTime())) ? date : new Date();
    const prev = new Date(dObj.getTime());
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

async function syncCustomEmojis(peer) {
    if (!peer) return 0;
    if (typeof peer.syncCustomEmojis === "function") {
        const res = await peer.syncCustomEmojis();
        return (res && typeof res.synced === "number") ? res.synced : (typeof res === "number" ? res : 0);
    }
    if (typeof peer.getInstalledEmojiPacks === "function") {
        const data = await peer.getInstalledEmojiPacks();
        const { registerCustomEmojis } = require("./messages");
        let count = 0;
        if (data && data.emojiMap) {
            registerCustomEmojis(data.emojiMap);
            count += Object.keys(data.emojiMap).length;
        }
        if (data && Array.isArray(data.packs)) {
            for (const pack of data.packs) {
                if (pack && Array.isArray(pack.documents)) {
                    const mapped = {};
                    for (const doc of pack.documents) {
                        if (doc && doc.id && doc.alt) {
                            mapped[doc.alt] = String(doc.id);
                        }
                    }
                    registerCustomEmojis(mapped);
                    count += Object.keys(mapped).length;
                }
            }
        }
        return count;
    }
    return 0;
}

/**
 * Extract source chat and message id from a Telegram forwarded message.
 * Supports Telegram Bot API 7.0+ (forward_origin) and legacy forward_from_chat.
 *
 * @param {any} msg
 * @returns {{ peer: string|number, messageId: number, title?: string }|null}
 */
function extractForwardOrigin(msg) {
    if (!msg) return null;

    // Telegram Bot API 7.0+ MessageOrigin
    if (msg.forward_origin) {
        const o = msg.forward_origin;
        if (o.type === "channel" && o.chat) {
            const peer = o.chat.username ? `@${o.chat.username.replace(/^@+/, "")}` : o.chat.id;
            return { peer, messageId: o.message_id, title: o.chat.title || o.chat.username || "" };
        }
        if (o.type === "chat" && o.sender_chat) {
            const peer = o.sender_chat.username ? `@${o.sender_chat.username.replace(/^@+/, "")}` : o.sender_chat.id;
            return { peer, messageId: o.message_id, title: o.sender_chat.title || o.sender_chat.username || "" };
        }
    }

    // Legacy Telegram Bot API fields
    if (msg.forward_from_chat) {
        const peer = msg.forward_from_chat.username
            ? `@${msg.forward_from_chat.username.replace(/^@+/, "")}`
            : msg.forward_from_chat.id;
        return {
            peer,
            messageId: msg.forward_from_message_id,
            title: msg.forward_from_chat.title || msg.forward_from_chat.username || "",
        };
    }

    return null;
}

/**
 * Parse channel username and message id from standard channel dump filenames,
 * e.g. "@moonulp - 213.txt", "@channel_123.txt", "moonulp - 213.txt".
 *
 * @param {string} fileName
 * @returns {{ peer: string, messageId: number }|null}
 */
function parseChannelFilename(fileName) {
    if (!fileName || typeof fileName !== "string") return null;
    const m = fileName.trim().match(/^@([a-zA-Z0-9_]{3,32})\s*[-_]\s*(\d+)/);
    if (m) {
        const peer = `@${m[1]}`;
        const messageId = parseInt(m[2], 10);
        if (messageId > 0) {
            return { peer, messageId };
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
    resolveSafeFileName,
    downloadPath,
    markedPeerId,
    formatDateDmy,
    previousDate,
    parseDmyDate,
    detectLatestBatchDate,
    createUserbot,
    syncCustomEmojis,
    extractForwardOrigin,
    parseChannelFilename,
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
    let client = opts.client || null;
    /** @type {any} */
    let searcherEntity = opts.searcherEntity || null;
    let searcherId = opts.searcherId || null;
    let botUsername = cfg.botUsername || (opts && opts.botUsername) || "";
    let ready = Boolean(opts.client || opts.ready);

    /**
     * Whoever cares whether a searcher message should be relayed.
     * @type {((msg: any) => Promise<void>|void)|null}
     */
    let resultSink = null;

    const peerCache = new Map();
    const forwardedMsgKeys = new Set();

    function setPeerCache(key, value) {
        if (!key) return;
        if (peerCache.size >= 500) {
            const first = peerCache.keys().next().value;
            peerCache.delete(first);
        }
        peerCache.set(key, value);
    }

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
            setPeerCache(wanted, ent);
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
                    setPeerCache(wanted, dialog.inputEntity);
                    return dialog.inputEntity;
                }
            }
            const err = new Error(`ACCOUNT_CANNOT_SEE_CHAT:${wanted}`);
            err.cause = firstError;
            throw err;
        }
    }

    async function forwardResult(toChatId, msg, forwardOpts = {}) {
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

        const targetBot = (forwardOpts && forwardOpts.botUsername) || botUsername || cfg.botUsername;
        const isPrivateChat = Number(toChatId) > 0;
        let targetPeer = toChatId;

        // In private 1-on-1 chats with the bot, forward/copy to the bot so it arrives in the bot conversation
        if (isPrivateChat && targetBot) {
            try {
                targetPeer = await client.getInputEntity(targetBot.replace(/^@+/, ""));
            } catch {
                targetPeer = `@${targetBot.replace(/^@+/, "")}`;
            }
        } else {
            try {
                targetPeer = await resolveChatPeer(toChatId);
            } catch (err) {
                log.log(`userbot resolveChatPeer fallback for ${toChatId}: ${err && err.message ? err.message : err}`);
            }
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
                const candidateName = (msg.file && (msg.file.name || msg.file.fileName)) ||
                    resolveSafeFileName(msg, "ulp_result", ".txt");
                const safeName = resolveSafeFileName(candidateName, "ulp_result", ".txt");
                buffer.name = safeName;
                const sendPayload = {
                    file: buffer,
                    caption: `${ULP_MARKER} ${safeName}`,
                    forceDocument: true,
                };
                if (Api && typeof Api.DocumentAttributeFilename === "function") {
                    sendPayload.attributes = [
                        new Api.DocumentAttributeFilename({ fileName: safeName }),
                    ];
                }
                await withTimeout(
                    client.sendFile(targetPeer, sendPayload),
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
    }

    return {
        kind: "userbot",
        get searcherId() {
            return searcherId;
        },
        get botUsername() {
            return botUsername;
        },
        setBotUsername(name) {
            botUsername = String(name || "").replace(/^@+/, "");
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
                        if (pid) setPeerCache(pid, d.inputEntity);
                        if (d.id) setPeerCache(markedPeerId(d.id), d.inputEntity);
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
                            setPeerCache(mid, msg.inputPeer || msg.peerId);
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

            let message = (options && options.message && options.message.media) ? options.message : null;
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

            const actualName = resolveSafeFileName(
                message,
                options.fileName || `dump_${messageId}`,
            );
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

        /**
         * Download media directly from an MTProto message without writing to disk.
         * @param {any} msg
         * @param {any} [options]
         * @returns {Promise<Buffer|null>}
         */
        async downloadMedia(msg, options = {}) {
            if (!ready || !client) throw new Error("USERBOT_NOT_READY");
            const downloadTimeoutMs = options.timeoutMs || 120000;
            return await withTimeout(
                client.downloadMedia(msg, options),
                downloadTimeoutMs,
                "userbot downloadMedia",
            );
        },

        forwardResult,

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
                        const fileName = resolveSafeFileName(msg, `dump_${targetReplyId}`);
                        const size = Number((msg.file && msg.file.size) || (msg.media.document && msg.media.document.size) || 0);
                        return {
                            messageId: targetReplyId,
                            fileName,
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
                        const fileName = resolveSafeFileName(msg, `dump_${msg.id}`);
                        const size = Number((msg.file && msg.file.size) || (msg.media.document && msg.media.document.size) || 0);
                        return {
                            messageId: msg.id,
                            fileName,
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
                        const fileName = resolveSafeFileName(msg, `dump_${msg.id}`);
                        const size = Number((msg.file && msg.file.size) || (msg.media.document && msg.media.document.size) || 0);
                        found.push({
                            messageId: msg.id,
                            fileName,
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
                const emojiMap = {};
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

                        if (Array.isArray(full.documents)) {
                            for (const doc of full.documents) {
                                let alt = "";
                                if (doc.attributes) {
                                    for (const a of doc.attributes) {
                                        if (a && a.alt) {
                                            alt = a.alt;
                                            break;
                                        }
                                    }
                                }
                                if (alt && doc.id) {
                                    emojiMap[alt] = doc.id.toString();
                                }
                            }
                        }

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
                return { packs, totalEmojis, emojiMap };
            } catch (err) {
                log.error("userbot getInstalledEmojiPacks error:", err && err.message ? err.message : err);
                return { packs: [], totalEmojis: 0, emojiMap: {}, error: err.message };
            }
        },

        /**
         * Sync account installed custom animated emojis directly into messages.js registry.
         */
        async syncCustomEmojis() {
            if (!ready || !client) return { synced: 0, error: "USERBOT_NOT_READY" };
            const { emojiMap, totalEmojis } = await this.getInstalledEmojiPacks();
            const { registerCustomEmojis } = require("./messages");
            if (emojiMap && typeof registerCustomEmojis === "function") {
                registerCustomEmojis(emojiMap);
            }
            return { synced: Object.keys(emojiMap || {}).length, totalEmojis };
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
                stepDelayMs = 14000,
                shouldStop = () => false,
                onStatus = () => {},
                sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
            } = options;

            const totalDays = Math.max(1, Math.min(90, Number(daysCount) || 5));
            const searchTarget = searcherEntity || cfg.searcher;
            const seenResultIds = new Set();
            let domainSent = false;
            let currentDate = startDate ? new Date(startDate.getTime()) : null;
            let daysProcessed = 0;
            let consecutiveMisses = 0;

            for (let dayIdx = 0; dayIdx < totalDays; dayIdx++) {
                if (shouldStop()) return { status: "stopped", daysProcessed };

                // =========================================================================
                // STEP 1: First do the /start (with retry loops and response verification)
                // =========================================================================
                let sentStart = null;
                for (let startAttempt = 0; startAttempt < 3; startAttempt++) {
                    if (shouldStop()) return { status: "stopped", daysProcessed };
                    try {
                        onStatus({
                            day: currentDate ? formatDateDmy(currentDate) : "init",
                            attempt: dayIdx + 1,
                            totalDays,
                            step: startAttempt === 0 ? "Sending /start to open menu…" : `Retrying /start (attempt ${startAttempt + 1})…`,
                        });
                        sentStart = await withTimeout(
                            client.sendMessage(searchTarget, { message: "/start" }),
                            timeoutMs,
                            "userbot send /start",
                        );
                        if (sentStart) break;
                    } catch (startErr) {
                        log.error(`userbot send /start attempt ${startAttempt + 1} failed:`, startErr && startErr.message ? startErr.message : startErr);
                        await sleep(1500);
                    }
                }
                await sleep(1000);

                if (shouldStop()) return { status: "stopped", daysProcessed };

                // Polling loop to get the menu message containing button rows
                let menuMsg = null;
                for (let pollTry = 0; pollTry < 6; pollTry++) {
                    if (shouldStop()) return { status: "stopped", daysProcessed };
                    try {
                        const recents = await withTimeout(
                            client.getMessages(searchTarget, { limit: 6 }),
                            timeoutMs,
                            "userbot getMessages menu",
                        );
                        menuMsg =
                            recents.find((m) => !m.out && sentStart && m.id > sentStart.id && m.replyMarkup && m.replyMarkup.rows && m.replyMarkup.rows.length > 0) ||
                            recents.find((m) => !m.out && m.replyMarkup && m.replyMarkup.rows && m.replyMarkup.rows.length > 0);
                        if (menuMsg) break;
                    } catch (fetchErr) {
                        log.error("userbot poll menu error:", fetchErr && fetchErr.message ? fetchErr.message : fetchErr);
                    }
                    await sleep(800);
                }

                // If currentDate is not yet known, detect latest batch date from the buttons
                if (!currentDate) {
                    const detected = detectLatestBatchDate(menuMsg);
                    if (detected) {
                        currentDate = detected;
                        log.log(`userbot detected latest batch date from menu: ${formatDateDmy(currentDate)}`);
                    } else {
                        currentDate = new Date();
                        log.log(`userbot falling back to current date: ${formatDateDmy(currentDate)}`);
                    }
                }

                const dateStr = formatDateDmy(currentDate);

                // =========================================================================
                // STEP 2: Then select the date folder (multi-page traversal loop)
                // =========================================================================
                let folderBtn = null;
                let pageAttempts = 0;
                const maxPages = 10;

                while (pageAttempts < maxPages && !folderBtn && menuMsg) {
                    if (shouldStop()) return { status: "stopped", daysProcessed };

                    if (menuMsg.replyMarkup && Array.isArray(menuMsg.replyMarkup.rows)) {
                        for (const row of menuMsg.replyMarkup.rows) {
                            if (!Array.isArray(row.buttons)) continue;
                            for (const btn of row.buttons) {
                                const dataStr = btn.type && btn.type.data ? btn.type.data.toString() : (btn.data ? btn.data.toString() : "");
                                const textStr = String(btn.text || "");
                                if (
                                    dataStr.startsWith(`folder:${dateStr}:`) ||
                                    dataStr === `folder:${dateStr}` ||
                                    textStr.includes(dateStr) ||
                                    (textStr.includes(dateStr.slice(0, 5)) && textStr.includes(dateStr.slice(-4)))
                                ) {
                                    folderBtn = { text: textStr, data: dataStr };
                                    break;
                                }
                            }
                            if (folderBtn) break;
                        }
                    }

                    // If not found on this page, look for pagination button
                    if (!folderBtn) {
                        let nextPageBtn = null;
                        if (menuMsg.replyMarkup && Array.isArray(menuMsg.replyMarkup.rows)) {
                            for (const row of menuMsg.replyMarkup.rows) {
                                if (!Array.isArray(row.buttons)) continue;
                                for (const btn of row.buttons) {
                                    const dataStr = btn.type && btn.type.data ? btn.type.data.toString() : (btn.data ? btn.data.toString() : "");
                                    const text = String(btn.text || "");
                                    const isNext =
                                        text.includes("➡️") ||
                                        text.includes("Next") ||
                                        text.includes("▶️") ||
                                        text.includes("»") ||
                                        text.includes("След") ||
                                        (dataStr.startsWith("menu:page:") && !text.includes("⬅️") && !text.includes("Prev") && !text.includes("◀️") && dataStr !== "menu:page:0");
                                    if (isNext) {
                                        nextPageBtn = { text, data: dataStr };
                                        break;
                                    }
                                }
                                if (nextPageBtn) break;
                            }
                        }

                        if (nextPageBtn) {
                            onStatus({
                                day: dateStr,
                                attempt: dayIdx + 1,
                                totalDays,
                                step: `Navigating to menu page ${pageAttempts + 2} for ${dateStr}…`,
                            });
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

                            // Refresh message buttons
                            for (let pWait = 0; pWait < 5; pWait++) {
                                try {
                                    const updated = await client.getMessages(searchTarget, { ids: [menuMsg.id] });
                                    if (updated && updated[0] && updated[0].replyMarkup) {
                                        menuMsg = updated[0];
                                        break;
                                    }
                                } catch {}
                                await sleep(500);
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
                    if (consecutiveMisses >= 5) {
                        log.log(`userbot no more date folders available (5 misses), ending day search`);
                        break;
                    }
                    continue;
                }
                consecutiveMisses = 0;

                // Click the folder button to select the date
                onStatus({
                    day: dateStr,
                    attempt: dayIdx + 1,
                    totalDays,
                    step: `Selecting date folder: ${dateStr}`,
                });
                for (let clickTry = 0; clickTry < 3; clickTry++) {
                    try {
                        await withTimeout(
                            client.invoke(new Api.messages.GetBotCallbackAnswer({
                                peer: searchTarget,
                                msgId: Number(menuMsg.id),
                                data: Buffer.from(folderBtn.data),
                            })),
                            timeoutMs,
                            "userbot click folder",
                        );
                        break;
                    } catch (clickErr) {
                        log.error(`userbot click folder error (attempt ${clickTry + 1}):`, clickErr && clickErr.message ? clickErr.message : clickErr);
                        await sleep(1000);
                    }
                }
                await sleep(1200);

                if (shouldStop()) return { status: "stopped", daysProcessed };

                // =========================================================================
                // STEP 3: And then write the domain but only do it for the first time
                // =========================================================================
                if (!domainSent && query) {
                    onStatus({
                        day: dateStr,
                        attempt: dayIdx + 1,
                        totalDays,
                        step: `Setting domain query "${query}" (first time)`,
                    });
                    for (let qTry = 0; qTry < 3; qTry++) {
                        if (shouldStop()) return { status: "stopped", daysProcessed };
                        try {
                            await withTimeout(
                                client.sendMessage(searchTarget, { message: query }),
                                timeoutMs,
                                "userbot send query",
                            );
                            break;
                        } catch (qErr) {
                            log.error(`userbot send query error (attempt ${qTry + 1}):`, qErr && qErr.message ? qErr.message : qErr);
                            await sleep(1500);
                        }
                    }
                    domainSent = true;
                    await sleep(Math.max(1500, Math.min(stepDelayMs, 2500)));

                    // Check for immediate responses from the bot to the domain query
                    for (let qResp = 0; qResp < 4; qResp++) {
                        if (shouldStop()) return { status: "stopped", daysProcessed };
                        try {
                            const recents = await client.getMessages(searchTarget, { limit: 8 });
                            for (const m of recents) {
                                if (!m.out && !seenResultIds.has(m.id)) {
                                    if (m.media || m.document || (m.text && m.text.includes(query))) {
                                        seenResultIds.add(m.id);
                                        if (resultSink) await resultSink(m);
                                        if (options.onResult) await options.onResult(m);
                                        if (chatId && typeof forwardResult === "function") {
                                            await forwardResult(chatId, m, { botUsername: options.botUsername || botUsername || cfg.botUsername }).catch(() => {});
                                        }
                                    }
                                }
                            }
                        } catch {}
                        await sleep(500);
                    }
                }

                if (shouldStop()) return { status: "stopped", daysProcessed };

                // =========================================================================
                // STEP 4: Locate and click hist: button (with polling and retry loops)
                // =========================================================================
                let folderView = null;
                let histBtn = null;

                for (let histScan = 0; histScan < 5; histScan++) {
                    if (shouldStop()) return { status: "stopped", daysProcessed };
                    try {
                        const byId = await client.getMessages(searchTarget, { ids: [menuMsg.id] });
                        if (byId && byId[0] && byId[0].replyMarkup && byId[0].replyMarkup.rows) {
                            folderView = byId[0];
                        }
                    } catch {}
                    if (!folderView) {
                        const folderMsgs = await withTimeout(
                            client.getMessages(searchTarget, { limit: 6 }),
                            timeoutMs,
                            "userbot getMessages folder",
                        );
                        folderView = folderMsgs.find((m) => !m.out && m.replyMarkup && m.replyMarkup.rows) || menuMsg;
                    }

                    if (folderView && folderView.replyMarkup && Array.isArray(folderView.replyMarkup.rows)) {
                        for (const row of folderView.replyMarkup.rows) {
                            if (!Array.isArray(row.buttons)) continue;
                            for (const btn of row.buttons) {
                                const dataStr = btn.type && btn.type.data ? btn.type.data.toString() : (btn.data ? btn.data.toString() : "");
                                const textStr = String(btn.text || "");
                                if (
                                    dataStr.startsWith(`hist:${dateStr}`) ||
                                    dataStr.includes("hist:") ||
                                    textStr.includes("hist") ||
                                    textStr.includes("Full") ||
                                    textStr.includes("History") ||
                                    textStr.includes("Скачать") ||
                                    textStr.includes("Dump")
                                ) {
                                    histBtn = { text: textStr, data: dataStr };
                                    break;
                                }
                            }
                            if (histBtn) break;
                        }
                    }
                    if (histBtn) break;
                    await sleep(800);
                }

                if (histBtn && folderView) {
                    onStatus({
                        day: dateStr,
                        attempt: dayIdx + 1,
                        totalDays,
                        step: `Requesting dump: ${histBtn.text || dateStr}`,
                    });
                    for (let histClickTry = 0; histClickTry < 3; histClickTry++) {
                        try {
                            await withTimeout(
                                client.invoke(new Api.messages.GetBotCallbackAnswer({
                                    peer: searchTarget,
                                    msgId: Number(folderView.id),
                                    data: Buffer.from(histBtn.data),
                                })),
                                timeoutMs,
                                "userbot click hist",
                            );
                            break;
                        } catch (clickErr) {
                            log.error(`userbot click hist error (attempt ${histClickTry + 1}):`, clickErr && clickErr.message ? clickErr.message : clickErr);
                            await sleep(1000);
                        }
                    }
                    daysProcessed++;

                    // =========================================================================
                    // STEP 5: Ingestion and result polling loop (catching documents and text)
                    // =========================================================================
                    let foundDoc = false;
                    let foundAny = false;
                    const maxWaitAttempts = 8;
                    for (let waitAttempt = 0; waitAttempt < maxWaitAttempts; waitAttempt++) {
                        if (shouldStop()) return { status: "stopped", daysProcessed };
                        await sleep(waitAttempt === 0 ? 2000 : 1500);
                        if (chatId) {
                            try {
                                const latest = await client.getMessages(searchTarget, { limit: 12 });
                                for (const m of latest) {
                                    const isTargetMsg =
                                        !m.out &&
                                        !seenResultIds.has(m.id) &&
                                        (m.id > (folderView.id || 0) ||
                                            (sentStart && m.id > sentStart.id) ||
                                            (waitAttempt > 0 && (m.media || m.document)));
                                    if (isTargetMsg) {
                                        seenResultIds.add(m.id);
                                        foundAny = true;
                                        if (m.media || m.document || m.file) {
                                            foundDoc = true;
                                        }
                                        if (resultSink) {
                                            await resultSink(m);
                                        }
                                        if (options.onResult) {
                                            await options.onResult(m);
                                        }
                                        if (chatId && typeof forwardResult === "function") {
                                            await forwardResult(chatId, m, {
                                                botUsername: options.botUsername || botUsername || cfg.botUsername,
                                            }).catch((err) => {
                                                log.log(`userbot forwardResult error: ${err && err.message ? err.message : err}`);
                                            });
                                        }
                                    }
                                }
                            } catch (err) {
                                log.log(`userbot post-hist message fetch error: ${err && err.message ? err.message : err}`);
                            }
                        }
                        if (foundDoc) {
                            await sleep(600);
                            break;
                        }
                        if (foundAny && waitAttempt >= 4) break;
                    }
                } else {
                    log.log(`userbot could not find hist button in folder for ${dateStr}`);
                }

                // =========================================================================
                // STEP 6: Pacing delay between days and date step backward
                // =========================================================================
                if (dayIdx < totalDays - 1) {
                    onStatus({
                        day: dateStr,
                        attempt: dayIdx + 1,
                        totalDays,
                        step: "Pacing before next day…",
                    });
                    await sleep(stepDelayMs);
                }

                currentDate = previousDate(currentDate);
            }

            return { status: "done", daysProcessed };
        },
    };
}

