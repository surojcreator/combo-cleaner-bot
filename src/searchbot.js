"use strict";

/**
 * ULP search relay — drives an external "ulpsearcher" Telegram bot.
 *
 * Flow (as requested):
 *   1. send the raw query          -> e.g. "htzone.co.il"
 *   2. send the history request    -> e.g. "hist:full:day" (scope: day | month | year)
 *   3. wait 7s before every try    -> every send (and every retry) is paced
 *   4. forward the results         -> whatever the searcher bot answers is forwarded
 *                                     to the chat that asked for the search
 *
 * Telegram only delivers private bot <-> bot messages when *both* bots enabled
 * "Bot-to-Bot Communication" in @BotFather — otherwise the send fails with
 * USER_BOT_TO_BOT_DISABLED (see classifySendError()).
 *
 * Loop prevention (Telegram recommends this for bot-to-bot features):
 *   - every send is paced (default 7s) and retries are capped (maxTries)
 *   - a run accepts a capped number of result messages
 *   - results are de-duplicated by message id
 *   - runs expire after a hard window so nothing runs away
 */

/** Date scopes the history request understands. */
const SEARCH_SCOPES = ["day", "month", "year"];

/** Short forms people type instead of the full scope word. */
const SCOPE_ALIASES = {
    d: "day",
    daily: "day",
    days: "day",
    m: "month",
    monthly: "month",
    months: "month",
    y: "year",
    yearly: "year",
    years: "year",
};

const DEFAULT_SEARCH_BOT = "DumpNews14Bot";
const DEFAULT_HIST_TEMPLATE = "hist:full:{scope}";

/** "wait 12 seconds before each try". */
const DEFAULT_STEP_DELAY_MS = 12000;

/** How long to wait for the searcher bot to answer before retrying. */
const DEFAULT_RESULT_WAIT_MS = 20000;

/** How many times the query + history pair may be repeated. */
const DEFAULT_MAX_TRIES = 3;

/** Hard window after which a run stops accepting/forwarding results. */
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

/** Cap on result messages relayed for a single run. */
const MAX_RESULTS_PER_RUN = 40;

/** Finished runs are forgotten after this long. */
const RUN_TTL_MS = 20 * 60 * 1000;

/** How long unsolicited results are still routed to the last requester. */
const LAST_OWNER_TTL_MS = 30 * 60 * 1000;

const MAX_TRACKED_RUNS = 200;

/**
 * Clean up a raw query (e.g. "htzone.co.il", "@htzone.co.il").
 * @param {string} raw
 * @returns {string|null} normalized query, or null when unusable
 */
function normalizeQuery(raw) {
    let input = String(raw || "").trim();
    if (!input) return null;
    // One step = one Telegram message, so no line breaks / tabs allowed.
    if (/[\r\n\t]/.test(input)) return null;
    input = input.replace(/^@+/, "").trim();

    // Strip URL scheme, path, query, hash if user passed a URL
    if (/^https?:\/\//i.test(input)) {
        try {
            const parsed = new URL(input);
            input = parsed.hostname.replace(/^www\./i, "");
        } catch {
            input = input.replace(/^https?:\/\//i, "").split(/[\/?#]/)[0];
        }
    } else if (input.includes("/") && !input.includes(" ")) {
        input = input.split(/[\/?#]/)[0];
    }
    input = input.replace(/^www\./i, "");
    const query = input.trim().replace(/\s+/g, " ");
    if (query.length < 2 || query.length > 120) return null;
    return query;
}

/**
 * Normalize a scope argument ("day", "YEAR", "m", "hist:full:day").
 * @param {string} raw
 * @param {string|null} [fallback]
 * @returns {string|null}
 */
function normalizeScope(raw, fallback = null) {
    const value = String(raw || "").trim().toLowerCase();
    if (!value) return fallback;
    if (SEARCH_SCOPES.includes(value)) return value;
    if (SCOPE_ALIASES[value]) return SCOPE_ALIASES[value];
    const tail = value.split(/[:\s]+/).filter(Boolean).pop();
    if (tail && SEARCH_SCOPES.includes(tail)) return tail;
    if (tail && SCOPE_ALIASES[tail]) return SCOPE_ALIASES[tail];
    return fallback;
}

/**
 * @param {string|undefined} raw
 * @param {number} fallback
 */
function positiveInt(raw, fallback) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.floor(n);
}

/**
 * Read the relay configuration from the environment.
 * @param {NodeJS.ProcessEnv} [env]
 */
function loadOptions(env = process.env) {
    return {
        botUsername: String(env.SEARCH_BOT_USERNAME || DEFAULT_SEARCH_BOT).replace(/^@+/, ""),
        histTemplate: env.SEARCH_HIST_TEMPLATE || DEFAULT_HIST_TEMPLATE,
        stepDelayMs: positiveInt(env.SEARCH_STEP_DELAY_MS, DEFAULT_STEP_DELAY_MS),
        resultWaitMs: positiveInt(env.SEARCH_RESULT_WAIT_MS, DEFAULT_RESULT_WAIT_MS),
        maxTries: positiveInt(env.SEARCH_MAX_TRIES, DEFAULT_MAX_TRIES),
        windowMs: positiveInt(env.SEARCH_WINDOW_MS, DEFAULT_WINDOW_MS),
        daysCount: positiveInt(env.SEARCH_DAYS_COUNT, 5),
    };
}

/**
 * The exact messages that get sent to the searcher bot, in order.
 * @param {string} query
 * @param {string} scope day | month | year
 * @param {string} [template]
 * @returns {Array<{ id: string, text: string }>}
 */
function buildSteps(query, scope, template = DEFAULT_HIST_TEMPLATE) {
    const hist = String(template).includes("{scope}")
        ? String(template).replace(/\{scope\}/g, scope)
        : `${String(template)} ${scope}`;
    return [
        { id: "query", text: query },
        { id: "hist", text: hist },
    ];
}

/**
 * Map a Telegram error to an actionable kind.
 * @param {any} err
 * @returns {"bot_to_bot_disabled"|"not_started"|"not_found"|"flood_wait"|"blocked"|"other"}
 */
function classifySendError(err) {
    const description = String((err && (err.description || err.message)) || "");
    if (/USER_BOT_TO_BOT_DISABLED/i.test(description)) return "bot_to_bot_disabled";
    if (/can't send messages to bots/i.test(description)) return "bot_to_bot_disabled";
    if (/bot was blocked/i.test(description)) return "blocked";
    if (/can't initiate conversation/i.test(description)) return "not_started";
    if (/chat not found|user not found/i.test(description)) return "not_found";
    if (/retry after|flood/i.test(description)) return "flood_wait";
    return "other";
}

/**
 * Send the query + history steps to the searcher bot, pacing every try.
 *
 * Every single send happens only after `stepDelayMs` (12s by default) — that is
 * the "wait 12 seconds before each try" rule — and each retry of the pair waits
 * the same delay again.
 *
 * The pair is always sent in order (query, then history) and results only decide
 * whether the pair is *repeated*: searcher bots often answer the query with a
 * prompt ("day | month | year?"), so the history request must still go out.
 * Retries stop as soon as the searcher answers, so nobody gets spammed.
 *
 * @param {{
 *   steps: Array<{ id: string, text: string }>,
 *   send: (step: { id: string, text: string }) => Promise<any>,
 *   sleep: (ms: number) => Promise<void>,
 *   hasResults?: () => boolean,
 *   shouldStop?: () => boolean,
 *   onEvent?: (event: object) => void,
 *   classify?: (err: any) => string,
 *   stepDelayMs?: number,
 *   resultWaitMs?: number,
 *   maxTries?: number,
 * }} opts
 * @returns {Promise<{ status: "results"|"exhausted"|"blocked"|"error"|"stopped", kind?: string, attempts: number, sends: string[], messageIds: number[], error?: any }>}
 */
async function runSearch(opts) {
    const {
        steps,
        send,
        sleep,
        hasResults = () => false,
        shouldStop = () => false,
        onEvent = () => { },
        classify = classifySendError,
        stepDelayMs = DEFAULT_STEP_DELAY_MS,
        resultWaitMs = DEFAULT_RESULT_WAIT_MS,
        maxTries = DEFAULT_MAX_TRIES,
    } = opts;

    const sends = [];
    const messageIds = [];
    let attempts = 0;

    for (let attempt = 1; attempt <= maxTries; attempt += 1) {
        attempts = attempt;
        onEvent({ type: "attempt", attempt, maxTries });

        for (const step of steps) {
            if (shouldStop()) return { status: "stopped", attempts, sends, messageIds };

            // Pace *before every try* — including the very first one.
            await sleep(stepDelayMs);

            if (shouldStop()) return { status: "stopped", attempts, sends, messageIds };

            let sent;
            try {
                sent = await send(step);
            } catch (err) {
                const kind = classify(err);
                onEvent({ type: "error", attempt, step, kind, error: err });
                if (BLOCKING_KINDS.has(kind)) {
                    return { status: "blocked", kind, attempts, sends, messageIds, error: err };
                }
                return { status: "error", kind, attempts, sends, messageIds, error: err };
            }

            sends.push(step.text);
            if (sent && sent.message_id) messageIds.push(sent.message_id);
            onEvent({ type: "sent", attempt, step, sends: sends.length });
        }

        if (shouldStop()) return { status: "stopped", attempts, sends, messageIds };
        if (hasResults()) return { status: "results", attempts, sends, messageIds };

        onEvent({ type: "waiting", attempt, resultWaitMs });
        await sleep(resultWaitMs);
        if (shouldStop()) return { status: "stopped", attempts, sends, messageIds };
        if (hasResults()) return { status: "results", attempts, sends, messageIds };
    }

    return { status: "exhausted", attempts, sends, messageIds };
}

/**
 * Failure kinds that stop a run immediately (with an actionable card),
 * shared by the Bot API and MTProto transports.
 */
const BLOCKING_KINDS = new Set([
    "bot_to_bot_disabled",
    "not_started",
    "not_found",
    "blocked",
    "userbot_auth",
]);

/**
 * @typedef {{
 *   chatId: number,
 *   query: string,
 *   scope: string,
 *   status: "running"|"done"|"stopped"|"expired",
 *   startedAt: number,
 *   updatedAt: number,
 *   deadline: number,
 *   results: Array<{ messageId: number|null, kind: string, at: number }>,
 *   seen: Set<number>,
 *   attempts: number,
 * }} UlpRun
 */

/** @type {Map<number, UlpRun>} active/finished runs, keyed by owner chat id */
const runs = new Map();

/** searcherBotChatId -> { chatId, at } — lets late results find the last requester. */
const lastOwnerBySearcher = new Map();

/**
 * Remember which chat asked for the current search, so results that arrive
 * after the run window (or without one) still land in the right place.
 * @param {number} searcherChatId private chat id of the searcher bot
 * @param {number} ownerChatId    chat that asked for the search
 * @param {number} [now]
 */
function rememberOwner(searcherChatId, ownerChatId, now = Date.now()) {
    if (!searcherChatId || !ownerChatId) return;
    lastOwnerBySearcher.set(Number(searcherChatId), { chatId: Number(ownerChatId), at: now });
}

/**
 * @param {number} searcherChatId
 * @param {number} [now]
 * @returns {number|null}
 */
function lastOwner(searcherChatId, now = Date.now()) {
    const entry = lastOwnerBySearcher.get(Number(searcherChatId));
    if (!entry) return null;
    if (now - entry.at > LAST_OWNER_TTL_MS) return null;
    return entry.chatId;
}

/**
 * Forget finished/expired runs so long-lived processes stay small.
 * @param {number} [now]
 */
function pruneRuns(now = Date.now()) {
    for (const [chatId, run] of runs) {
        if (run.status === "running" && now >= run.deadline) run.status = "expired";
        if (now - run.updatedAt > RUN_TTL_MS) runs.delete(chatId);
    }
    if (runs.size > MAX_TRACKED_RUNS) {
        const oldest = [...runs.values()].sort((a, b) => a.updatedAt - b.updatedAt);
        const drop = runs.size - MAX_TRACKED_RUNS;
        for (let i = 0; i < drop; i += 1) runs.delete(oldest[i].chatId);
    }
}

/**
 * Open a new run for a chat (replaces any previous one for that chat).
 * @param {number} chatId
 * @param {{ query: string, scope: string, windowMs?: number, now?: number }} opts
 * @returns {UlpRun}
 */
function startRun(chatId, opts) {
    const now = opts.now || Date.now();
    pruneRuns(now);
    /** @type {UlpRun} */
    const run = {
        chatId: Number(chatId),
        query: opts.query,
        scope: opts.scope,
        status: "running",
        startedAt: now,
        updatedAt: now,
        deadline: now + (opts.windowMs || DEFAULT_WINDOW_MS),
        results: [],
        seen: new Set(),
        attempts: 0,
    };
    runs.set(run.chatId, run);
    return run;
}

/**
 * @param {number} chatId
 * @returns {UlpRun|null}
 */
function getRun(chatId) {
    return runs.get(Number(chatId)) || null;
}

/**
 * @param {number} chatId
 * @param {number} [now]
 */
function isRunning(chatId, now = Date.now()) {
    const run = runs.get(Number(chatId));
    return Boolean(run) && run.status === "running" && now < run.deadline;
}

/**
 * @param {number} chatId
 * @param {"done"|"stopped"|"expired"} [status]
 * @param {number} [now]
 * @returns {UlpRun|null}
 */
function finishRun(chatId, status = "done", now = Date.now()) {
    const run = runs.get(Number(chatId));
    if (!run) return null;
    run.status = status;
    run.updatedAt = now;
    return run;
}

/**
 * Register a message that arrived from the searcher bot and return every owner
 * chat it should be relayed to. Duplicate deliveries are ignored, and a run
 * stops collecting once it hits MAX_RESULTS_PER_RUN.
 *
 * @param {number} searcherChatId private chat id the result arrived in
 * @param {{ messageId?: number|null, kind?: string, now?: number }} [opts]
 * @returns {number[]} owner chat ids to forward the message to
 */
function noteResult(searcherChatId, opts = {}) {
    const now = opts.now || Date.now();
    const messageId = opts.messageId == null ? null : Number(opts.messageId);
    const kind = opts.kind || "text";
    pruneRuns(now);

    const live = [...runs.values()].filter((run) => run.status === "running" && now < run.deadline);
    const targets = [];
    for (const run of live) {
        if (run.results.length >= MAX_RESULTS_PER_RUN) continue;
        if (messageId != null && run.seen.has(messageId)) continue;
        if (messageId != null) run.seen.add(messageId);
        run.results.push({ messageId, kind, at: now });
        run.updatedAt = now;
        targets.push(run.chatId);
    }

    if (live.length === 0) {
        // Nobody is waiting: hand late answers to the last requester so nothing
        // is dropped — unless they explicitly stopped that search.
        const recent = mostRecentRun(now);
        if (recent) {
            if (recent.status !== "stopped") targets.push(recent.chatId);
        } else {
            const owner = lastOwner(searcherChatId, now);
            if (owner != null) targets.push(owner);
        }
    } else if (targets.length > 0) {
        rememberOwner(searcherChatId, targets[0], now);
    }
    return targets;
}

/**
 * The most recently updated run, if it is fresh enough to receive late answers.
 * @param {number} now
 * @returns {UlpRun|null}
 */
function mostRecentRun(now) {
    let best = null;
    for (const run of runs.values()) {
        if (now - run.updatedAt > LAST_OWNER_TTL_MS) continue;
        if (!best || run.updatedAt > best.updatedAt) best = run;
    }
    return best;
}

/** Test helper — wipe all run state. */
function resetRuns() {
    runs.clear();
    lastOwnerBySearcher.clear();
}

module.exports = {
    SEARCH_SCOPES,
    DEFAULT_SEARCH_BOT,
    DEFAULT_HIST_TEMPLATE,
    DEFAULT_STEP_DELAY_MS,
    DEFAULT_RESULT_WAIT_MS,
    DEFAULT_MAX_TRIES,
    DEFAULT_WINDOW_MS,
    MAX_RESULTS_PER_RUN,
    LAST_OWNER_TTL_MS,
    BLOCKING_KINDS,
    normalizeQuery,
    normalizeScope,
    loadOptions,
    buildSteps,
    classifySendError,
    runSearch,
    startRun,
    getRun,
    isRunning,
    finishRun,
    noteResult,
    rememberOwner,
    lastOwner,
    mostRecentRun,
    pruneRuns,
    resetRuns,
};

