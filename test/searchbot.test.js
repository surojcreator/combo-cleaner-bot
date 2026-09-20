"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const searchbot = require("../src/searchbot");
const { parseUlpArg, isSearcherMessage } = require("../src/bot");

/**
 * Sleep stub that records the requested delays instead of waiting.
 */
function fakeClock() {
    const delays = [];
    return {
        delays,
        sleep: async (ms) => {
            delays.push(ms);
            return undefined;
        },
    };
}

function okSend(recorder) {
    return async (step) => {
        recorder.push(step.text);
        return { message_id: recorder.length, chat: { id: 8844520471 } };
    };
}

test("normalizeQuery cleans input and rejects junk", () => {
    assert.equal(searchbot.normalizeQuery("  htzone.co.il "), "htzone.co.il");
    assert.equal(searchbot.normalizeQuery("@htzone.co.il"), "htzone.co.il");
    assert.equal(searchbot.normalizeQuery("  my   site.com "), "my site.com");
    assert.equal(searchbot.normalizeQuery(""), null);
    assert.equal(searchbot.normalizeQuery("a"), null);
    assert.equal(searchbot.normalizeQuery("line\nbreak"), null);
    assert.equal(searchbot.normalizeQuery("x".repeat(121)), null);
});

test("normalizeScope understands day|month|year and aliases", () => {
    assert.equal(searchbot.normalizeScope("day"), "day");
    assert.equal(searchbot.normalizeScope("MONTH"), "month");
    assert.equal(searchbot.normalizeScope("year"), "year");
    assert.equal(searchbot.normalizeScope("m"), "month");
    assert.equal(searchbot.normalizeScope("yearly"), "year");
    assert.equal(searchbot.normalizeScope("hist:full:day"), "day");
    assert.equal(searchbot.normalizeScope("", "day"), "day");
    assert.equal(searchbot.normalizeScope("nonsense", "day"), "day");
    assert.equal(searchbot.normalizeScope("nonsense", null), null);
});

test("loadOptions defaults to @DumpNews14Bot with 12s pacing", () => {
    const defaults = searchbot.loadOptions({});
    assert.equal(defaults.botUsername, searchbot.DEFAULT_SEARCH_BOT);
    assert.equal(defaults.botUsername, "DumpNews14Bot");
    assert.equal(defaults.stepDelayMs, 12000);
    assert.equal(defaults.histTemplate, "hist:full:{scope}");
    assert.equal(defaults.maxTries, 3);

    const custom = searchbot.loadOptions({
        SEARCH_BOT_USERNAME: "@SomeSearcherBot",
        SEARCH_STEP_DELAY_MS: "9000",
        SEARCH_MAX_TRIES: "5",
        SEARCH_HIST_TEMPLATE: "hist:full {scope}",
        SEARCH_WINDOW_MS: "60000",
    });
    assert.equal(custom.botUsername, "SomeSearcherBot");
    assert.equal(custom.stepDelayMs, 9000);
    assert.equal(custom.maxTries, 5);
    assert.equal(custom.histTemplate, "hist:full {scope}");
    assert.equal(custom.windowMs, 60000);

    // Garbage values fall back to the defaults instead of breaking pacing.
    assert.equal(searchbot.loadOptions({ SEARCH_STEP_DELAY_MS: "-5" }).stepDelayMs, 12000);
    assert.equal(searchbot.loadOptions({ SEARCH_MAX_TRIES: "abc" }).maxTries, 3);
});

test("buildSteps sends the query first, then the history request", () => {
    assert.deepEqual(searchbot.buildSteps("htzone.co.il", "day"), [
        { id: "query", text: "htzone.co.il" },
        { id: "hist", text: "hist:full:day" },
    ]);
    assert.equal(searchbot.buildSteps("htzone.co.il", "year")[1].text, "hist:full:year");
    assert.equal(searchbot.buildSteps("htzone.co.il", "month", "hist:full {scope}")[1].text, "hist:full month");
    // A template without the placeholder still gets the scope appended.
    assert.equal(searchbot.buildSteps("x.co", "day", "hist:full")[1].text, "hist:full day");
});

test("classifySendError spots the bot-to-bot switch", () => {
    assert.equal(searchbot.classifySendError({ description: "Bad Request: USER_BOT_TO_BOT_DISABLED" }), "bot_to_bot_disabled");
    assert.equal(searchbot.classifySendError({ description: "Forbidden: bot can't send messages to bots" }), "bot_to_bot_disabled");
    assert.equal(searchbot.classifySendError({ description: "Forbidden: bot can't initiate conversation with a user" }), "not_started");
    assert.equal(searchbot.classifySendError({ description: "Bad Request: chat not found" }), "not_found");
    assert.equal(searchbot.classifySendError({ description: "Too Many Requests: retry after 30" }), "flood_wait");
    assert.equal(searchbot.classifySendError(new Error("socket hang up")), "other");
});

test("runSearch waits 7s before every try and sends query then hist", async () => {
    const clock = fakeClock();
    const sent = [];
    const result = await searchbot.runSearch({
        steps: searchbot.buildSteps("htzone.co.il", "day"),
        sleep: clock.sleep,
        send: okSend(sent),
        maxTries: 1,
        stepDelayMs: 7000,
        resultWaitMs: 20000,
    });

    assert.equal(result.status, "exhausted");
    assert.equal(result.attempts, 1);
    assert.deepEqual(sent, ["htzone.co.il", "hist:full:day"]);
    // One 7s pause per try, then the wait-for-results pause.
    assert.deepEqual(clock.delays, [7000, 7000, 20000]);
    assert.deepEqual(result.messageIds, [1, 2]);
});

test("runSearch sends hist after a quick answer, then stops retrying", async () => {
    const clock = fakeClock();
    const sent = [];
    let answered = false;
    const result = await searchbot.runSearch({
        steps: searchbot.buildSteps("htzone.co.il", "day"),
        sleep: clock.sleep,
        send: async (step) => {
            sent.push(step.text);
            answered = true; // the searcher answers the query straight away
            return { message_id: sent.length };
        },
        hasResults: () => answered,
        maxTries: 3,
    });

    assert.equal(result.status, "results");
    // Both steps of the pair go out (a prompt answer must not swallow hist)...
    assert.deepEqual(sent, ["htzone.co.il", "hist:full:day"]);
    // ...and because an answer is in, the pair is not repeated.
    assert.equal(result.attempts, 1);
    assert.deepEqual(clock.delays, [12000, 12000]);
});

test("runSearch retries the whole pair up to maxTries, still 7s apart", async () => {
    const clock = fakeClock();
    const sent = [];
    const result = await searchbot.runSearch({
        steps: searchbot.buildSteps("htzone.co.il", "month"),
        sleep: clock.sleep,
        send: okSend(sent),
        maxTries: 2,
        stepDelayMs: 7000,
        resultWaitMs: 15000,
    });

    assert.equal(result.status, "exhausted");
    assert.equal(result.attempts, 2);
    assert.deepEqual(sent, ["htzone.co.il", "hist:full:month", "htzone.co.il", "hist:full:month"]);
    assert.deepEqual(clock.delays, [7000, 7000, 15000, 7000, 7000, 15000]);
});

test("runSearch stops immediately when Telegram blocks the bot-to-bot send", async () => {
    const clock = fakeClock();
    const result = await searchbot.runSearch({
        steps: searchbot.buildSteps("htzone.co.il", "day"),
        sleep: clock.sleep,
        send: async () => {
            throw { description: "Bad Request: USER_BOT_TO_BOT_DISABLED" };
        },
        maxTries: 3,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.kind, "bot_to_bot_disabled");
    assert.deepEqual(result.sends, []);
    assert.deepEqual(clock.delays, [12000]); // only the first try was attempted
});

test("runSearch honours shouldStop()", async () => {
    const clock = fakeClock();
    const sent = [];
    const result = await searchbot.runSearch({
        steps: searchbot.buildSteps("htzone.co.il", "day"),
        sleep: clock.sleep,
        send: okSend(sent),
        shouldStop: () => true,
    });

    assert.equal(result.status, "stopped");
    assert.deepEqual(sent, []);
    assert.deepEqual(clock.delays, []);
});

test("runs track results per chat and de-duplicate message ids", () => {
    searchbot.resetRuns();
    const run = searchbot.startRun(1001, { query: "htzone.co.il", scope: "day", windowMs: 60000 });
    assert.equal(searchbot.isRunning(1001), true);
    assert.equal(run.query, "htzone.co.il");

    assert.deepEqual(searchbot.noteResult(8844520471, { messageId: 10 }), [1001]);
    assert.deepEqual(searchbot.noteResult(8844520471, { messageId: 10 }), []); // same message again
    assert.deepEqual(searchbot.noteResult(8844520471, { messageId: 11 }), [1001]);
    assert.equal(searchbot.getRun(1001).results.length, 2);

    // A stopped run keeps no longer accepting new results.
    searchbot.finishRun(1001, "done");
    assert.equal(searchbot.isRunning(1001), false);
    searchbot.resetRuns();
});

test("runs stop collecting after the result cap (loop protection)", () => {
    searchbot.resetRuns();
    searchbot.startRun(3003, { query: "x.co", scope: "day", windowMs: 600000 });
    for (let i = 0; i < searchbot.MAX_RESULTS_PER_RUN + 5; i += 1) {
        searchbot.noteResult(8844520471, { messageId: 500 + i });
    }
    assert.equal(searchbot.getRun(3003).results.length, searchbot.MAX_RESULTS_PER_RUN);
    searchbot.resetRuns();
});

test("finished runs still route late results to the last requester", () => {
    searchbot.resetRuns();
    searchbot.startRun(2002, { query: "x.co", scope: "year", windowMs: 1000 });
    searchbot.finishRun(2002, "done");

    // Late answer: no running run, so it lands with the previous requester.
    assert.deepEqual(searchbot.noteResult(8844520471, { messageId: 99 }), [2002]);

    // After the TTL it is forgotten instead of leaking into a random chat.
    const late = Date.now() + searchbot.LAST_OWNER_TTL_MS + 1;
    assert.deepEqual(searchbot.noteResult(8844520471, { messageId: 100, now: late }), []);
    searchbot.resetRuns();
});

test("expired runs stop counting results, late answers still get relayed", () => {
    searchbot.resetRuns();
    const started = Date.now();
    searchbot.startRun(4004, { query: "x.co", scope: "day", windowMs: 1000, now: started });
    assert.equal(searchbot.isRunning(4004, started + 500), true);
    assert.equal(searchbot.isRunning(4004, started + 2000), false);

    // Counted against the run, but relayed to the same chat as a late answer.
    assert.deepEqual(searchbot.noteResult(8844520471, { messageId: 1, now: started + 2000 }), [4004]);
    assert.equal(searchbot.getRun(4004).results.length, 0);
    searchbot.resetRuns();
});

test("late answers are dropped after the user stops a search", () => {
    searchbot.resetRuns();
    searchbot.startRun(5005, { query: "x.co", scope: "day", windowMs: 600000 });
    searchbot.rememberOwner(8844520471, 5005);
    searchbot.finishRun(5005, "stopped");
    assert.deepEqual(searchbot.noteResult(8844520471, { messageId: 1 }), []);
    searchbot.resetRuns();
});

test("parseUlpArg reads the query and optional scope", () => {
    assert.deepEqual(parseUlpArg("htzone.co.il"), { query: "htzone.co.il", scope: "day" });
    assert.deepEqual(parseUlpArg("htzone.co.il month"), { query: "htzone.co.il", scope: "month" });
    assert.deepEqual(parseUlpArg("htzone.co.il YEAR"), { query: "htzone.co.il", scope: "year" });
    assert.deepEqual(parseUlpArg("  example.org   day "), { query: "example.org", scope: "day" });
    assert.deepEqual(parseUlpArg(""), { query: null, scope: "day" });
    assert.deepEqual(parseUlpArg("month"), { query: null, scope: "month" });
    assert.deepEqual(parseUlpArg("a"), { query: null, scope: "day" }); // too short

    const withDate = parseUlpArg("htzone.co.il 20.09.2026");
    assert.equal(withDate.query, "htzone.co.il");
    assert.equal(withDate.scope, "day");
    assert.equal(withDate.startDate instanceof Date, true);
    assert.equal(withDate.startDate.getDate(), 20);
    assert.equal(withDate.startDate.getMonth(), 8);

    const withShortDate = parseUlpArg("htzone.co.il 20.9.2026");
    assert.equal(withShortDate.query, "htzone.co.il");
    assert.equal(withShortDate.startDate.getDate(), 20);
});

test("isSearcherMessage only matches the configured searcher bot", () => {
    const options = { botUsername: "DumpNews14Bot" };
    const meta = { searcherBotId: 8844520471 };

    const fromSearcher = { from: { is_bot: true, username: "DumpNews14Bot", id: 8844520471 }, message: { message_id: 1 } };
    assert.equal(isSearcherMessage(fromSearcher, meta, options), true);

    const byId = { from: { is_bot: true, username: "", id: 8844520471 }, message: { message_id: 2 } };
    assert.equal(isSearcherMessage(byId, meta, options), true);

    const human = { from: { is_bot: false, username: "someone", id: 42 }, message: { message_id: 3 } };
    assert.equal(isSearcherMessage(human, meta, options), false);

    const otherBot = { from: { is_bot: true, username: "OtherBot", id: 7 }, message: { message_id: 4 } };
    assert.equal(isSearcherMessage(otherBot, meta, options), false);

    const noMessage = { from: { is_bot: true, username: "DumpNews14Bot", id: 8844520471 } };
    assert.equal(isSearcherMessage(noMessage, meta, options), false);
});

