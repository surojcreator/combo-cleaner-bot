"use strict";

// CLI: node scripts/solve-turnstile.js [page-url]
// Reads TURNSTILE_URL / TURNSTILE_SITEKEY from .env when args are omitted.
require("dotenv").config();
const { solveTurnstile, health, baseUrl } = require("../src/solver");

async function main() {
    const url = process.argv[2] || process.env.TURNSTILE_URL || "";
    console.log(`Solver: ${baseUrl()}`);
    try {
        const h = await health();
        console.log(`Health: HTTP ${h.status} ${String(h.body).slice(0, 200)}`);
    } catch (err) {
        console.error(`Solver not reachable at ${baseUrl()}: ${err.message}`);
        console.error("Start it on Linux e.g.: cd solver-upstream && docker build -t turnstile-solver . && docker run -d -p 407:407 turnstile-solver");
        if (!url) process.exit(2);
    }
    if (!url) {
        console.error("Usage: node scripts/solve-turnstile.js <page-url>");
        console.error("   or set TURNSTILE_URL in .env (TURNSTILE_SITEKEY is already set).");
        process.exit(2);
    }
    const started = Date.now();
    const out = await solveTurnstile({ url });
    console.log(JSON.stringify({ ...out, tookMs: Date.now() - started }, null, 2));
}

main().catch((err) => { console.error("solve failed:", err.message); process.exit(1); });
