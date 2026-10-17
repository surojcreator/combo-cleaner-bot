"use strict";

// Minimal client for B00H0O/cloudflare-solver.
// Solver must run on Linux (Docker/WSL2) — Windows Chrome leaks fingerprint.
// API: POST {SOLVER_URL}/turnstile {url, sitekey, cdata?, action?, proxy?}
//      POST {SOLVER_URL}/iuam {url, proxy?}
//      GET  {SOLVER_URL}/health

function baseUrl() {
    return (process.env.SOLVER_URL || "http://localhost:407").replace(/\/+$/, "");
}

async function postJson(path, body, timeoutMs = 60000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(baseUrl() + path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* raw */ }
        if (!res.ok) {
            const msg = (json && (json.error || json.message)) || text.slice(0, 500);
            throw new Error(`solver ${path} HTTP ${res.status}: ${msg}`);
        }
        return json !== null ? json : { raw: text };
    } finally {
        clearTimeout(t);
    }
}

async function health(timeoutMs = 10000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(baseUrl() + "/health", { signal: ctrl.signal });
        return { status: res.status, body: await res.text() };
    } finally {
        clearTimeout(t);
    }
}

/** Solve a Turnstile widget. Returns {token, elapsed, status, ...}. */
async function solveTurnstile({ url, sitekey, cdata, action, proxy } = {}) {
    const u = url || process.env.TURNSTILE_URL || "";
    const k = sitekey || process.env.TURNSTILE_SITEKEY || "";
    if (!u) throw new Error("Missing page URL: pass {url} or set TURNSTILE_URL in .env");
    if (!k) throw new Error("Missing sitekey: pass {sitekey} or set TURNSTILE_SITEKEY in .env");
    const body = { url: u, sitekey: k };
    if (cdata !== undefined) body.cdata = cdata;
    if (action !== undefined) body.action = action;
    if (proxy || process.env.SOLVER_PROXY) body.proxy = proxy || process.env.SOLVER_PROXY;
    const timeoutMs = Number(process.env.SOLVER_TIMEOUT_MS || 60000);
    return postJson("/turnstile", body, timeoutMs);
}

/** Solve an IUAM (I'm Under Attack) page. Returns {headers, ip, ...}. */
async function solveIuam({ url, proxy } = {}) {
    const u = url || process.env.TURNSTILE_URL || "";
    if (!u) throw new Error("Missing page URL: pass {url} or set TURNSTILE_URL in .env");
    const body = { url: u };
    if (proxy || process.env.SOLVER_PROXY) body.proxy = proxy || process.env.SOLVER_PROXY;
    const timeoutMs = Number(process.env.SOLVER_TIMEOUT_MS || 60000);
    return postJson("/iuam", body, timeoutMs);
}

module.exports = { baseUrl, health, solveTurnstile, solveIuam };
