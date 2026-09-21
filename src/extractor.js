"use strict";

const AdmZip = require("adm-zip");
const { cleanText } = require("./cleaner");
const { detectSite } = require("./sites");

// Cap on raw text kept for website detection (1 MB sample is plenty).
const MAX_SITE_SAMPLE = 1024 * 1024;

// Safety limits so a malicious zip can't exhaust memory / disk on a free host.
const MAX_TOTAL_UNCOMPRESSED = 250 * 1024 * 1024; // 250 MB total extracted
const MAX_ENTRY_SIZE = 50 * 1024 * 1024; // 50 MB per single entry
const MAX_ENTRIES = 5000; // max files walked (including nested)
const MAX_NESTED_DEPTH = 3; // nested zip depth
const TEXT_EXTENSIONS = [
    ".txt",
    ".csv",
    ".tsv",
    ".log",
    ".lst",
    ".list",
    ".dat",
    ".json",
    ".xml",
    ".html",
    ".htm",
    ".md",
];

/**
 * @param {string} name
 * @returns {boolean}
 */
function looksLikeText(name) {
    const lower = name.toLowerCase();
    if (TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
    // Entries with no extension are commonly plain credential dumps.
    return !lower.includes(".");
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function looksLikeZip(name) {
    return name.toLowerCase().endsWith(".zip");
}

/**
 * Detect if a buffer is a zip by magic bytes (PK\x03\x04).
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function isZipBuffer(buffer) {
    return (
        buffer.length >= 4 &&
        buffer[0] === 0x50 &&
        buffer[1] === 0x4b &&
        (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)
    );
}

/**
 * Parse a buffer as a zip, returning entries or null if it isn't a valid zip.
 * @param {Buffer} buffer
 * @returns {import('adm-zip').IZipEntry[]|null}
 */
function readZipEntries(buffer) {
    try {
        const zip = new AdmZip(buffer);
        return zip.getEntries();
    } catch {
        return null;
    }
}

/**
 * Recursively walk a zip buffer and collect raw text from every text entry.
 *
 * @param {Buffer} buffer
 * @param {object} state mutable counters shared across recursion
 * @returns {string[]} array of raw text chunks
 */
function collectTextFromZip(buffer, state) {
    const chunks = [];
    const entries = readZipEntries(buffer);
    if (!entries) return chunks;

    for (const entry of entries) {
        if (state.count >= MAX_ENTRIES) {
            state.truncated = true;
            break;
        }
        if (entry.isDirectory) continue;

        const name = entry.entryName;
        // Skip macOS / metadata junk.
        if (name.startsWith("__MACOSX/") || name.endsWith(".DS_Store")) continue;

        const size = entry.header.size;
        if (size > MAX_ENTRY_SIZE) {
            state.skippedLarge += 1;
            continue;
        }
        if (state.totalBytes + size > MAX_TOTAL_UNCOMPRESSED) {
            state.truncated = true;
            break;
        }
        state.count += 1;

        let data;
        try {
            data = entry.getData();
        } catch {
            continue;
        }
        state.totalBytes += data.length;

        if (looksLikeZip(name) || isZipBuffer(data)) {
            if (state.depth < MAX_NESTED_DEPTH) {
                state.depth += 1;
                const nested = collectTextFromZip(data, state);
                state.depth -= 1;
                chunks.push(...nested);
            }
            continue;
        }

        if (looksLikeText(name)) {
            chunks.push(data.toString("utf8"));
        }
    }

    return chunks;
}

/**
 * Extract cleartext credentials from a zip buffer.
 *
 * @param {Buffer} zipBuffer
 * @param {{ dedupe?: boolean, sourceName?: string }} [options]
 * @returns {{
 *   lines: string[],
 *   site: string|null,
 *   rawSample: string,
 *   stats: {
 *     files: number,
 *     total: number,
 *     kept: number,
 *     dropped: number,
 *     duplicates: number,
 *     truncated: boolean,
 *     skippedLarge: number
 *   }
 * }}
 */
function extractAndCleanZip(zipBuffer, options = {}) {
    const state = {
        count: 0,
        depth: 0,
        totalBytes: 0,
        truncated: false,
        skippedLarge: 0,
    };

    const chunks = collectTextFromZip(zipBuffer, state);
    const combined = chunks.join("\n");
    const rawSample = combined.slice(0, MAX_SITE_SAMPLE);

    const { lines, stats } = cleanText(combined, options);

    return {
        lines,
        site: detectSite(rawSample, options.sourceName || ""),
        rawSample,
        stats: {
            files: state.count,
            total: stats.total,
            kept: stats.kept,
            dropped: stats.dropped,
            duplicates: stats.duplicates,
            truncated: state.truncated,
            skippedLarge: state.skippedLarge,
        },
    };
}

/**
 * Extract plain text from a raw (non-zip) text buffer, e.g. a forwarded .txt.
 * @param {string} text
 * @param {{ dedupe?: boolean, sourceName?: string }} [options]
 * @returns {{ lines: string[], site: string|null, rawSample: string, stats: object }}
 */
function extractAndCleanText(text, options = {}) {
    const { lines, stats } = cleanText(text, options);
    const rawSample = String(text).slice(0, MAX_SITE_SAMPLE);
    return {
        lines,
        site: detectSite(rawSample, options.sourceName || ""),
        rawSample,
        stats: {
            files: 1,
            total: stats.total,
            kept: stats.kept,
            dropped: stats.dropped,
            duplicates: stats.duplicates,
            truncated: false,
            skippedLarge: 0,
        },
    };
}

/**
 * Merges multiple zip and log buffers into one master zip buffer purely in memory
 * without writing any temporary files to disk.
 *
 * @param {Array<{ name: string, buffer: Buffer }>} items
 * @param {object} [options]
 * @returns {{
 *   buffer: Buffer,
 *   entryCount: number,
 *   totalSize: number,
 *   compressedSize: number,
 *   entries: Array<{ name: string, size: number }>,
 *   sourceFiles: Array<{ name: string, size: number, entriesCount: number }>
 * }}
 */
function mergeZipFiles(items, options = {}) {
    const mergedZip = new AdmZip();
    const seenNames = new Set();
    const entriesList = [];
    const sourceFiles = [];
    let totalUncompressedSize = 0;

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const buffer = item.buffer;
        if (!buffer || !Buffer.isBuffer(buffer)) continue;

        const rawName = item.name || `archive_${i + 1}.zip`;
        const baseName = rawName.replace(/\.zip$/i, "").replace(/[^a-zA-Z0-9._-]/g, "_") || `part_${i + 1}`;
        const isZip = isZipBuffer(buffer) || looksLikeZip(rawName);

        let addedEntriesFromThis = 0;

        if (isZip) {
            try {
                const zip = new AdmZip(buffer);
                const entries = zip.getEntries();
                for (const entry of entries) {
                    if (entry.isDirectory) continue;
                    let entryName = entry.entryName;
                    // Skip OS junk
                    if (entryName.startsWith("__MACOSX/") || entryName.endsWith(".DS_Store")) continue;

                    // If duplicate entry name across zips, namespace under the source archive name
                    if (seenNames.has(entryName)) {
                        entryName = `${baseName}/${entryName}`;
                    }
                    seenNames.add(entryName);

                    const data = entry.getData();
                    mergedZip.addFile(entryName, data, entry.comment || "");
                    totalUncompressedSize += data.length;
                    entriesList.push({ name: entryName, size: data.length });
                    addedEntriesFromThis++;
                }
            } catch (err) {
                console.error(`Failed to parse zip entry for ${rawName}:`, err);
                let entryName = rawName;
                if (seenNames.has(entryName)) entryName = `${baseName}/${rawName}`;
                seenNames.add(entryName);
                mergedZip.addFile(entryName, buffer);
                totalUncompressedSize += buffer.length;
                entriesList.push({ name: entryName, size: buffer.length });
                addedEntriesFromThis++;
            }
        } else {
            // Raw text, log, or binary file
            let entryName = rawName;
            if (seenNames.has(entryName)) entryName = `${baseName}/${rawName}`;
            seenNames.add(entryName);
            mergedZip.addFile(entryName, buffer);
            totalUncompressedSize += buffer.length;
            entriesList.push({ name: entryName, size: buffer.length });
            addedEntriesFromThis++;
        }

        sourceFiles.push({
            name: rawName,
            size: buffer.length,
            entriesCount: addedEntriesFromThis,
        });
    }

    const outputBuffer = mergedZip.toBuffer();

    return {
        buffer: outputBuffer,
        entryCount: entriesList.length,
        totalSize: totalUncompressedSize,
        compressedSize: outputBuffer.length,
        entries: entriesList,
        sourceFiles,
    };
}

module.exports = {
    extractAndCleanZip,
    extractAndCleanText,
    mergeZipFiles,
    isZipBuffer,
    looksLikeText,
    looksLikeZip,
};