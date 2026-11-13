"use strict";

/**
 * Export pinned-site saves so they can leave the bot through Telegram.
 *
 * The vault already stores one deduped .txt per site; this module only reads
 * it and packages the result, so nothing here can mutate a save.
 *
 *   buildIndex()  -> the plain-text manifest (lines/size/updated per site)
 *   writeZip()    -> one .zip with every site file + index.txt
 *   siteFileInfo()-> a single site ready to be sent as a document
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const siteVault = require("./site-vault");

const EXPORT_TTL_MS = 60 * 60 * 1000;

function exportDir() {
    return path.join(os.tmpdir(), "combo-site-exports");
}

function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function humanSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function isoDate(ms) {
    const n = Number(ms) || 0;
    if (!n) return "-";
    return new Date(n).toISOString().replace("T", " ").slice(0, 16);
}

/**
 * Everything the export knows about this chat's saves.
 * @param {number|string} chatId
 * @param {string} [root]
 */
function readSaves(chatId, root) {
    const sites = siteVault.listSites(chatId, root);
    const totalLines = sites.reduce((sum, s) => sum + (Number(s.lines) || 0), 0);
    const totalBytes = sites.reduce((sum, s) => sum + (Number(s.bytes) || 0), 0);
    const active = siteVault.getActive(chatId, root);
    return { sites, totalLines, totalBytes, active };
}

/**
 * Plain-text manifest. Fixed-width so it stays readable in Telegram's
 * monospace block and in a plain text editor.
 * @param {{sites: Array, totalLines: number, totalBytes: number, active: string|null}} data
 * @param {{ chatId?: number|string, now?: Date }} [meta]
 */
function buildIndex(data, meta = {}) {
    const sites = (data && data.sites) || [];
    const now = meta.now instanceof Date ? meta.now : new Date();
    const siteW = Math.min(
        40,
        Math.max(8, ...sites.map((s) => String(s.site).length)),
    );
    const head = [
        "# Combo Cleaner - pinned site export",
        `# generated: ${now.toISOString().replace("T", " ").slice(0, 19)}Z`,
        meta.chatId !== undefined ? `# chat: ${meta.chatId}` : null,
        `# sites: ${sites.length}   lines: ${data && data.totalLines ? data.totalLines : 0}   size: ${humanSize(data && data.totalBytes)}`,
        data && data.active ? `# pinned: ${data.active}` : "# pinned: none",
        "",
        `${"site".padEnd(siteW)}  ${"lines".padStart(12)}  ${"size".padStart(10)}  updated`,
        `${"-".repeat(siteW)}  ${"-".repeat(12)}  ${"-".repeat(10)}  ${"-".repeat(16)}`,
    ].filter((line) => line !== null);

    for (const s of sites) {
        head.push(
            `${String(s.site).padEnd(siteW)}  ${String(Number(s.lines) || 0).padStart(12)}  ` +
            `${humanSize(s.bytes).padStart(10)}  ${isoDate(s.updatedAt)}${s.active ? "  <- pinned" : ""}`,
        );
    }
    if (sites.length === 0) head.push("(no saves yet)");
    head.push("");
    head.push("# One .txt per site. Each line is a unique credential pair.");
    return head.join("\n") + "\n";
}

/** Drop export zips older than the TTL so temp does not grow forever. */
function pruneOldExports(now = Date.now()) {
    const dir = exportDir();
    let entries;
    try {
        entries = fs.readdirSync(dir);
    } catch {
        return 0;
    }
    let removed = 0;
    for (const name of entries) {
        const file = path.join(dir, name);
        try {
            const st = fs.statSync(file);
            if (now - st.mtimeMs > EXPORT_TTL_MS) {
                fs.unlinkSync(file);
                removed += 1;
            }
        } catch {
            // racing with another cleanup or a live download - leave it
        }
    }
    return removed;
}

/**
 * Zip every non-empty site save plus the manifest.
 * @returns {{ zipPath: string, filename: string, count: number, totalLines: number, totalBytes: number, skipped: string[] }}
 */
function writeZip(chatId, root, opts = {}) {
    // eslint-disable-next-line global-require
    const AdmZip = require("adm-zip");
    const data = readSaves(chatId, root);
    const usable = data.sites.filter((s) => s.lines > 0 && fs.existsSync(s.file));
    if (usable.length === 0) {
        const err = new Error("NO_SITE_SAVES");
        err.code = "NO_SITE_SAVES";
        throw err;
    }

    pruneOldExports();
    const dir = exportDir();
    fs.mkdirSync(dir, { recursive: true });
    const title = String(opts.name || "pinned-sites").replace(/[^\w.-]+/g, "-");
    const filename = `${title}-${stamp()}.zip`;
    const zipPath = path.join(dir, filename);

    const zip = new AdmZip();
    const used = new Set();
    for (const site of usable) {
        const bag = path.basename(site.file);
        let name = bag;
        let n = 2;
        while (used.has(name)) {
            name = bag.replace(/\.txt$/i, `-${n}.txt`);
            n += 1;
        }
        used.add(name);
        zip.addLocalFile(site.file, "", name);
    }
    zip.addFile("index.txt", Buffer.from(buildIndex(data, { chatId }), "utf8"));
    zip.writeZip(zipPath);

    return {
        zipPath,
        filename,
        count: usable.length,
        totalLines: data.totalLines,
        totalBytes: data.totalBytes,
        skipped: data.sites.filter((s) => !(s.lines > 0 && fs.existsSync(s.file))).map((s) => s.site),
    };
}

/**
 * One site, ready to be sent.
 * @returns {{ file: string, filename: string, site: string, lines: number, bytes: number }|null}
 */
function siteFileInfo(chatId, site, root) {
    const record = siteVault.getSite(chatId, site, root);
    if (!record || !record.file || !fs.existsSync(record.file)) return null;
    return {
        file: record.file,
        filename: `${record.site}.txt`,
        site: record.site,
        lines: Number(record.lines) || 0,
        bytes: Number(record.bytes) || 0,
    };
}

/**
 * The manifest as a standalone .txt, for a quick send without a zip.
 * @returns {{ indexPath: string, filename: string, count: number, totalLines: number, totalBytes: number }}
 */
function writeIndexFile(chatId, root, opts = {}) {
    const data = readSaves(chatId, root);
    if (data.sites.length === 0) {
        const err = new Error("NO_SITE_SAVES");
        err.code = "NO_SITE_SAVES";
        throw err;
    }
    pruneOldExports();
    const dir = exportDir();
    fs.mkdirSync(dir, { recursive: true });
    const title = String(opts.name || "pinned-sites-index").replace(/[^\w.-]+/g, "-");
    const filename = `${title}-${stamp()}.txt`;
    const indexPath = path.join(dir, filename);
    fs.writeFileSync(indexPath, buildIndex(data, { chatId }), "utf8");
    return {
        indexPath,
        filename,
        count: data.sites.length,
        totalLines: data.totalLines,
        totalBytes: data.totalBytes,
    };
}

module.exports = {
    readSaves,
    buildIndex,
    writeZip,
    writeIndexFile,
    siteFileInfo,
    pruneOldExports,
    humanSize,
    isoDate,
};
