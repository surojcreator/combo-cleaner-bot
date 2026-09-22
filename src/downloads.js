"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

// Default retention TTL: 7 days
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @typedef {object} DownloadEntry
 * @property {string} token
 * @property {string} filename
 * @property {string} [filePath]
 * @property {Buffer} [buffer]
 * @property {number} size
 * @property {string} mimeType
 * @property {number} createdAt
 * @property {number} expiresAt
 * @property {number|null} chatId
 * @property {object} stats
 */

/** @type {Map<string, DownloadEntry>} */
const registry = new Map();

/**
 * Clean up expired download entries.
 */
function purgeExpired() {
    const now = Date.now();
    for (const [token, entry] of registry.entries()) {
        if (entry.expiresAt && entry.expiresAt <= now) {
            registry.delete(token);
        }
    }
}

/**
 * Auto-discover local/LAN IPv4 address as a fallback when public URL isn't configured.
 * @returns {string|null}
 */
function getLocalNetworkIp() {
    try {
        const interfaces = os.networkInterfaces();
        for (const ifaceName of Object.keys(interfaces)) {
            const iface = interfaces[ifaceName];
            if (!iface) continue;
            for (const alias of iface) {
                if (alias.family === "IPv4" && !alias.internal) {
                    return alias.address;
                }
            }
        }
    } catch {
        // Ignore network enumeration issues
    }
    return null;
}

/**
 * Determine the base URL for public download links.
 * @returns {string}
 */
function resolveBaseUrl() {
    const port = Number(process.env.PORT || 8080);

    // 1. Explicit download base URL
    if (process.env.DOWNLOAD_BASE_URL && process.env.DOWNLOAD_BASE_URL.trim()) {
        return process.env.DOWNLOAD_BASE_URL.trim().replace(/\/+$/, "");
    }

    // 2. Standard public HTTPS webhook URL (e.g. Render, Fly, custom domain)
    if (process.env.PUBLIC_URL && process.env.PUBLIC_URL.trim()) {
        return process.env.PUBLIC_URL.trim().replace(/\/+$/, "");
    }

    // 3. Render injected external URL
    if (process.env.RENDER_EXTERNAL_URL && process.env.RENDER_EXTERNAL_URL.trim()) {
        return process.env.RENDER_EXTERNAL_URL.trim().replace(/\/+$/, "");
    }

    // 4. Webhook URL base if set
    if (process.env.WEBHOOK_URL && process.env.WEBHOOK_URL.trim()) {
        try {
            const u = new URL(process.env.WEBHOOK_URL.trim());
            return `${u.protocol}//${u.host}`.replace(/\/+$/, "");
        } catch {
            return process.env.WEBHOOK_URL.trim().replace(/\/+$/, "");
        }
    }

    // 5. Network interface IP fallback
    const netIp = getLocalNetworkIp();
    if (netIp) {
        return `http://${netIp}:${port}`;
    }

    // 6. Default localhost fallback
    return `http://localhost:${port}`;
}

/**
 * Generate an absolute download URL for a given download token.
 * @param {string} token
 * @returns {string}
 */
function getDownloadUrl(token) {
    const base = resolveBaseUrl();
    return `${base}/download/${encodeURIComponent(token)}`;
}

/**
 * Register a file for direct HTTP download.
 *
 * @param {object} params
 * @param {string} params.filename - User-visible download filename
 * @param {string} [params.filePath] - On-disk path to stream from
 * @param {Buffer} [params.buffer] - In-memory buffer fallback
 * @param {number} [params.size] - File size in bytes
 * @param {string} [params.mimeType] - MIME type (defaults to text/plain or application/zip)
 * @param {number} [params.chatId] - Telegram chat ID owner
 * @param {object} [params.stats] - Metadata/stats
 * @param {number} [params.ttlMs] - Time-to-live in milliseconds
 * @returns {{ token: string, url: string, filename: string, size: number, expiresAt: number }}
 */
function registerDownload(params = {}) {
    params = params || {};
    purgeExpired();

    const token = crypto.randomBytes(16).toString("hex");
    let size = Number(params.size) || 0;

    if (!size) {
        if (params.buffer && Buffer.isBuffer(params.buffer)) {
            size = params.buffer.length;
        } else if (params.filePath && fs.existsSync(params.filePath)) {
            try {
                size = fs.statSync(params.filePath).size;
            } catch {
                size = 0;
            }
        }
    }

    let mimeType = params.mimeType;
    if (!mimeType) {
        const lower = (params.filename || "").toLowerCase();
        if (lower.endsWith(".zip")) {
            mimeType = "application/zip";
        } else if (lower.endsWith(".json")) {
            mimeType = "application/json";
        } else if (lower.endsWith(".csv")) {
            mimeType = "text/csv; charset=utf-8";
        } else {
            mimeType = "text/plain; charset=utf-8";
        }
    }

    const expiresAt = Date.now() + (params.ttlMs || DEFAULT_TTL_MS);

    /** @type {DownloadEntry} */
    const entry = {
        token,
        filename: params.filename || "combined_logs.txt",
        filePath: params.filePath || null,
        buffer: params.buffer || null,
        size,
        mimeType,
        createdAt: Date.now(),
        expiresAt,
        chatId: params.chatId || null,
        stats: params.stats || {},
    };

    registry.set(token, entry);

    return {
        token,
        url: getDownloadUrl(token),
        filename: entry.filename,
        size: entry.size,
        expiresAt: entry.expiresAt,
    };
}

/**
 * Retrieve a download entry by token.
 * @param {string} token
 * @returns {DownloadEntry|null}
 */
function getDownload(token) {
    if (!token || typeof token !== "string") return null;
    const cleanToken = token.trim();
    const entry = registry.get(cleanToken);
    if (!entry) return null;

    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
        registry.delete(cleanToken);
        return null;
    }

    return entry;
}

/**
 * Check if an incoming HTTP request is a download route.
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function isDownloadRequest(req) {
    if (!req || typeof req.url !== "string") return false;
    const pathname = req.url.split("?")[0];
    return pathname.startsWith("/download/") || pathname.startsWith("/dl/");
}

/**
 * Handle incoming HTTP GET/HEAD download requests.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
function handleDownloadRequest(req, res) {
    if (!req || !res || typeof res.writeHead !== "function") return;

    if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Method Not Allowed\n");
        return;
    }

    const pathname = (typeof req.url === "string" ? req.url : "").split("?")[0];
    const match = pathname.match(/^\/(?:download|dl)\/([a-zA-Z0-9_-]+)/);
    const token = match ? match[1] : null;

    const entry = getDownload(token);
    if (!entry) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Download Not Found - Combo Cleaner Bot</title>
  <style>
    body { background-color: #0b0f19; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 40px; max-width: 500px; text-align: center; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
    h1 { color: #f85149; margin-top: 0; font-size: 22px; }
    p { color: #8b949e; line-height: 1.6; }
    .code { font-family: monospace; background: #0d1117; padding: 4px 8px; border-radius: 6px; color: #58a6ff; }
  </style>
</head>
<body>
  <div class="card">
    <h1>⚠️ Download Link Expired or Not Found</h1>
    <p>This combined log file link is either invalid, already expired, or was removed.</p>
    <p>Please forward your log files again or run <span class="code">/combine</span> in Telegram to generate a fresh direct download link.</p>
  </div>
</body>
</html>\n`);
        return;
    }

    // Verify file or buffer is actually accessible
    const fileExists = Boolean(entry.filePath && fs.existsSync(entry.filePath));
    const hasBuffer = Boolean(entry.buffer && Buffer.isBuffer(entry.buffer));

    if (!fileExists && !hasBuffer) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Download Not Found - Combo Cleaner Bot</title>
  <style>
    body { background-color: #0b0f19; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 40px; max-width: 500px; text-align: center; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
    h1 { color: #f85149; margin-top: 0; font-size: 22px; }
    p { color: #8b949e; line-height: 1.6; }
    .code { font-family: monospace; background: #0d1117; padding: 4px 8px; border-radius: 6px; color: #58a6ff; }
  </style>
</head>
<body>
  <div class="card">
    <h1>⚠️ Download Link Expired or Not Found</h1>
    <p>This combined log file link is either invalid, already expired, or was removed from disk.</p>
    <p>Please forward your log files again or run <span class="code">/combine</span> in Telegram to generate a fresh direct download link.</p>
  </div>
</body>
</html>\n`);
        return;
    }

    // Prepare safe Content-Disposition filename
    const filename = (typeof entry.filename === "string" && entry.filename.trim())
        ? entry.filename.trim()
        : "combined_logs.txt";
    const safeName = filename.replace(/["\r\n\0]/g, "_");
    const encodedName = encodeURIComponent(filename);

    const headers = {
        "Content-Type": entry.mimeType,
        "Content-Disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encodedName}`,
        "Cache-Control": "public, max-age=3600",
    };

    if (typeof entry.size === "number" && entry.size >= 0) {
        headers["Content-Length"] = String(entry.size);
    }

    res.writeHead(200, headers);

    if (req.method === "HEAD") {
        res.end();
        return;
    }

    // Stream from disk if available
    if (entry.filePath && fs.existsSync(entry.filePath)) {
        const stream = fs.createReadStream(entry.filePath);
        stream.pipe(res);
        res.on("close", () => {
            if (!stream.destroyed) stream.destroy();
        });
        stream.on("error", (streamErr) => {
            console.error("Stream download error:", streamErr);
            if (!res.headersSent) {
                res.writeHead(500, { "Content-Type": "text/plain" });
            }
            res.end();
        });
        return;
    }

    // Send from in-memory buffer if disk file is missing
    if (entry.buffer && Buffer.isBuffer(entry.buffer)) {
        res.end(entry.buffer);
        return;
    }

    res.end();
}

/**
 * Wipe all registry entries (used in tests or cleanup).
 */
function clearAll() {
    registry.clear();
}

module.exports = {
    DEFAULT_TTL_MS,
    registerDownload,
    getDownload,
    getDownloadUrl,
    resolveBaseUrl,
    isDownloadRequest,
    handleDownloadRequest,
    clearAll,
    purgeExpired,
};
