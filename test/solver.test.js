"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert");

describe("solver client", () => {
    it("requires url + sitekey before calling the solver", async () => {
        const OLD_URL = process.env.TURNSTILE_URL;
        const OLD_KEY = process.env.TURNSTILE_SITEKEY;
        delete process.env.TURNSTILE_URL;
        delete process.env.TURNSTILE_SITEKEY;
        const { solveTurnstile } = require("../src/solver");
        await assert.rejects(() => solveTurnstile({ sitekey: "0x4AAAAAAD2cidQytY73HEYU" }), /Missing page URL/);
        await assert.rejects(() => solveTurnstile({ url: "https://example.com/" }), /Missing sitekey/);
        if (OLD_URL !== undefined) process.env.TURNSTILE_URL = OLD_URL;
        if (OLD_KEY !== undefined) process.env.TURNSTILE_SITEKEY = OLD_KEY;
    });
});
