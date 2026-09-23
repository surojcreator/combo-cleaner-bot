"use strict";

const AdmZip = require("adm-zip");
const { cleanText, cleanLinesArray, decodeBufferToText } = require("./cleaner");
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
    ".dump",
    ".text",
    ".reg",
    ".ini",
    ".conf",
    ".cfg",
];

/**
 * @param {string} name
 * @returns {boolean}
 */
function looksLikeText(name) {
    if (typeof name !== "string") return false;
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
    if (typeof name !== "string") return false;
    return name.toLowerCase().endsWith(".zip");
}

/**
 * Detect if a buffer is a zip by magic bytes (PK\x03\x04).
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function isZipBuffer(buffer) {
    if (!buffer || !Buffer.isBuffer(buffer)) return false;
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
        if (state.totalBytes > MAX_TOTAL_UNCOMPRESSED) {
            state.truncated = true;
            break;
        }

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
            chunks.push(decodeBufferToText(data));
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
 * Asynchronously extract and clean credentials from a zip buffer using multi-core worker pool.
 *
 * @param {Buffer} zipBuffer
 * @param {{ dedupe?: boolean, sourceName?: string, keepUrl?: boolean }} [options]
 * @returns {Promise<{ lines: string[], site: string|null, rawSample: string, stats: object }>}
 */
async function extractAndCleanZipAsync(zipBuffer, options = {}) {
    const state = {
        count: 0,
        depth: 0,
        totalBytes: 0,
        truncated: false,
        skippedLarge: 0,
    };

    const chunks = collectTextFromZip(zipBuffer, state);
    let sampleLen = 0;
    let rawSample = "";
    for (let i = 0; i < chunks.length && sampleLen < MAX_SITE_SAMPLE; i++) {
        const take = chunks[i].slice(0, MAX_SITE_SAMPLE - sampleLen);
        rawSample += take;
        sampleLen += take.length;
    }
    const site = detectSite(rawSample, options.sourceName || "");

    const rawLines = [];
    for (let i = 0; i < chunks.length; i++) {
        const split = chunks[i].split(/\r?\n/);
        for (let j = 0; j < split.length; j++) {
            rawLines.push(split[j]);
        }
    }

    let lines, stats;
    if (rawLines.length >= 2000) {
        const { getSharedPool } = require("./worker-pool");
        const pool = getSharedPool();
        const res = await pool.cleanLinesParallel(rawLines, options);
        lines = res.lines;
        stats = res.stats;
    } else {
        const res = cleanLinesArray(rawLines, options);
        lines = res.lines;
        stats = res.stats;
    }

    return {
        lines,
        site,
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
 * Asynchronously extract and clean credentials from raw text using multi-core worker pool.
 *
 * @param {string} text
 * @param {{ dedupe?: boolean, sourceName?: string, keepUrl?: boolean }} [options]
 * @returns {Promise<{ lines: string[], site: string|null, rawSample: string, stats: object }>}
 */
async function extractAndCleanTextAsync(text, options = {}) {
    const rawSample = String(text || "").slice(0, MAX_SITE_SAMPLE);
    const site = detectSite(rawSample, options.sourceName || "");

    let lines, stats;
    const str = String(text || "");
    const rawLines = str.split(/\r?\n/);
    if (rawLines.length >= 2000) {
        const { getSharedPool } = require("./worker-pool");
        const pool = getSharedPool();
        const res = await pool.cleanLinesParallel(rawLines, options);
        lines = res.lines;
        stats = res.stats;
    } else {
        const res = cleanLinesArray(rawLines, options);
        lines = res.lines;
        stats = res.stats;
    }

    return {
        lines,
        site,
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
 * Normalizes an entry path: forward slashes, trims leading/trailing slashes, resolves .. safely.
 * @param {string} rawPath
 * @returns {string}
 */
function normalizeZipPath(rawPath) {
    if (!rawPath) return "";
    let p = String(rawPath).replace(/\\/g, "/");
    p = p.replace(/^\/+/, "");
    p = p.replace(/\/{2,}/g, "/");
    const parts = p.split("/").filter((part) => part !== "." && part !== "");
    const safeParts = [];
    for (const part of parts) {
        if (part === "..") {
            if (safeParts.length > 0) safeParts.pop();
        } else {
            safeParts.push(part);
        }
    }
    return safeParts.join("/");
}

/**
 * Check if an entry is OS or filesystem metadata junk.
 * @param {string} name
 * @returns {boolean}
 */
function isJunkZipEntry(name) {
    const lower = name.toLowerCase();
    return (
        lower.startsWith("__macosx/") ||
        lower.includes("/__macosx/") ||
        lower.endsWith(".ds_store") ||
        lower.endsWith("thumbs.db") ||
        lower.endsWith("desktop.ini")
    );
}

/**
 * Recursively extracts entries from a zip buffer, expanding nested zips into folders.
 * @param {Buffer} buffer
 * @param {string} [parentDir]
 * @param {number} [depth]
 * @param {number} [maxDepth]
 * @returns {Array<{ path: string, data: Buffer, comment?: string, isDir?: boolean }>}
 */
function collectEntriesFromZipBuffer(buffer, parentDir = "", depth = 0, maxDepth = 3) {
    const collected = [];
    const entries = readZipEntries(buffer);
    if (!entries) return collected;

    for (const entry of entries) {
        const rawNorm = normalizeZipPath(entry.entryName);
        if (!rawNorm || isJunkZipEntry(rawNorm)) continue;

        const isDir = entry.isDirectory || entry.entryName.endsWith("/") || entry.entryName.endsWith("\\");
        const fullPath = parentDir ? `${parentDir}/${rawNorm}` : rawNorm;

        if (isDir) {
            collected.push({ path: fullPath + "/", data: Buffer.alloc(0), isDir: true });
            continue;
        }

        let data;
        try {
            data = entry.getData();
        } catch {
            continue;
        }

        // If this entry is a nested zip file, expand it recursively into a folder
        if (depth < maxDepth && (isZipBuffer(data) || looksLikeZip(rawNorm))) {
            const lastSlash = rawNorm.lastIndexOf("/");
            const entryDir = lastSlash !== -1 ? rawNorm.slice(0, lastSlash) : "";
            const fileName = lastSlash !== -1 ? rawNorm.slice(lastSlash + 1) : rawNorm;
            const extIdx = fileName.lastIndexOf(".");
            const baseStem = (extIdx > 0 ? fileName.slice(0, extIdx) : fileName)
                .replace(/[^a-zA-Z0-9._-]/g, "_") || "archive";

            let nestedDir = "";
            if (parentDir) {
                nestedDir = entryDir ? `${parentDir}/${entryDir}/${baseStem}` : `${parentDir}/${baseStem}`;
            } else {
                nestedDir = entryDir ? `${entryDir}/${baseStem}` : baseStem;
            }

            const subEntries = collectEntriesFromZipBuffer(data, nestedDir, depth + 1, maxDepth);
            if (subEntries && subEntries.length > 0) {
                for (const sub of subEntries) {
                    collected.push(sub);
                }
                continue;
            }
        }

        collected.push({
            path: fullPath,
            data,
            comment: entry.comment || "",
            isDir: false,
        });
    }

    return collected;
}

/**
 * Resolves a collision for a file entry within the same directory if possible,
 * or namespaces root-level files. Returns null if data is identical (dedupe).
 * @param {string} targetPath
 * @param {Buffer} data
 * @param {Map<string, Buffer>} existingFiles
 * @param {string} baseName
 * @returns {string|null}
 */
function resolveZipEntryCollision(targetPath, data, existingFiles, baseName) {
    const norm = normalizeZipPath(targetPath) || (baseName ? `${baseName}.txt` : "file.txt");
    if (!existingFiles.has(norm)) {
        return norm;
    }

    const existingData = existingFiles.get(norm);
    if (existingData && existingData.length === data.length && existingData.equals(data)) {
        // Exact identical file bytes in the exact same path -> deduplicate
        return null;
    }

    const lastSlash = norm.lastIndexOf("/");
    if (lastSlash === -1) {
        // Root-level file without a folder (e.g. common.conf)
        // Check if namespacing under baseName works first
        const baseCandidate = `${baseName}/${norm}`;
        if (!existingFiles.has(baseCandidate)) {
            return baseCandidate;
        }
        const extIdx = norm.lastIndexOf(".");
        const stem = extIdx > 0 ? norm.slice(0, extIdx) : norm;
        const ext = extIdx > 0 ? norm.slice(extIdx) : "";
        let counter = 2;
        while (true) {
            const cand = `${stem}_${counter}${ext}`;
            if (!existingFiles.has(cand)) return cand;
            counter++;
        }
    } else {
        // File is inside a folder! (e.g. "Logs/US/passwords.txt" or "Victim1/pass.txt")
        // Keep inside the same folder to preserve folder structure
        const dir = norm.slice(0, lastSlash + 1);
        const fileName = norm.slice(lastSlash + 1);
        const extIdx = fileName.lastIndexOf(".");
        const stem = extIdx > 0 ? fileName.slice(0, extIdx) : fileName;
        const ext = extIdx > 0 ? fileName.slice(extIdx) : "";
        let counter = 2;
        while (true) {
            const cand = `${dir}${stem}_${counter}${ext}`;
            if (!existingFiles.has(cand)) return cand;
            counter++;
        }
    }
}

/**
 * Merges multiple zip and log buffers into one master zip buffer purely in memory
 * without writing any temporary files to disk. Unifies and merges folder hierarchies,
 * recursively expands nested zips, deduplicates identical files, and keeps folder trees intact.
 *
 * @param {Array<{ name: string, buffer: Buffer }>} items
 * @param {object} [options]
 * @returns {{
 *   buffer: Buffer,
 *   entryCount: number,
 *   folderCount: number,
 *   totalSize: number,
 *   compressedSize: number,
 *   entries: Array<{ name: string, size: number }>,
 *   sourceFiles: Array<{ name: string, size: number, entriesCount: number }>
 * }}
 */
function mergeZipFiles(items, options = {}) {
    if (!Array.isArray(items)) {
        items = items ? [items] : [];
    }
    const mergedZip = new AdmZip();
    const existingFiles = new Map();
    const uniqueFolders = new Set();
    const entriesList = [];
    const sourceFiles = [];
    let totalUncompressedSize = 0;

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item) continue;
        const buffer = Buffer.isBuffer(item) ? item : item.buffer;
        if (!buffer || !Buffer.isBuffer(buffer)) continue;

        const rawName = (item && item.name) || `archive_${i + 1}.zip`;
        const baseName = rawName.replace(/\.zip$/i, "").replace(/[^a-zA-Z0-9._-]/g, "_") || `part_${i + 1}`;
        const isZip = isZipBuffer(buffer) || looksLikeZip(rawName);

        let addedEntriesFromThis = 0;

        if (typeof options.onProgress === "function") {
            try {
                options.onProgress({
                    currentFileIndex: i + 1,
                    totalFiles: items.length,
                    currentFileName: rawName,
                    currentFileSize: buffer.length,
                    phase: isZip ? "Unpacking & merging zip entries..." : "Packing file into master archive...",
                });
            } catch (_) {}
        }

        if (isZip) {
            let collected = [];
            try {
                collected = collectEntriesFromZipBuffer(buffer, "", 0, 3);
            } catch (err) {
                console.error(`Failed to collect zip entries for ${rawName}:`, err);
            }

            // Fallback if parsing failed or zip had no entries
            if (!collected || collected.length === 0) {
                const fallbackPath = resolveZipEntryCollision(rawName, buffer, existingFiles, baseName);
                if (fallbackPath) {
                    mergedZip.addFile(fallbackPath, buffer);
                    existingFiles.set(fallbackPath, buffer);
                    totalUncompressedSize += buffer.length;
                    entriesList.push({ name: fallbackPath, size: buffer.length });
                    addedEntriesFromThis++;
                }
            } else {
                // If every non-directory entry in this archive is wrapped in a single root folder named
                // after the archive itself and contains nested subdirectories, strip the archive-name wrapper
                // so the actual log folders merge at the root.
                const fileEntries = collected.filter((e) => !e.isDir);
                if (fileEntries.length > 0) {
                    const firstSlash = fileEntries[0].path.indexOf("/");
                    if (firstSlash !== -1) {
                        const rootSegment = fileEntries[0].path.slice(0, firstSlash);
                        const prefix = rootSegment + "/";
                        const allShare = fileEntries.every((e) => e.path.startsWith(prefix));
                        const rootMatchesArchive =
                            rootSegment.toLowerCase() === baseName.toLowerCase() ||
                            rootSegment.toLowerCase() === baseName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
                        const hasNestedSubdirs = fileEntries.some((e) => e.path.slice(prefix.length).includes("/"));

                        if (allShare && rootMatchesArchive && hasNestedSubdirs) {
                            for (const e of collected) {
                                if (e.path.startsWith(prefix)) {
                                    e.path = e.path.slice(prefix.length);
                                }
                            }
                        }
                    }
                }

                for (const entry of collected) {
                    if (entry.isDir) {
                        const norm = normalizeZipPath(entry.path);
                        if (!norm) continue;
                        const normDir = norm + "/";
                        if (!uniqueFolders.has(normDir)) {
                            uniqueFolders.add(normDir);
                            try {
                                mergedZip.addFile(normDir, Buffer.alloc(0));
                            } catch (_) {}
                        }
                        continue;
                    }

                    const targetPath = resolveZipEntryCollision(entry.path, entry.data, existingFiles, baseName);
                    if (!targetPath) {
                        // Deduplicated identical file in the same folder path
                        continue;
                    }

                    mergedZip.addFile(targetPath, entry.data, entry.comment || "");
                    existingFiles.set(targetPath, entry.data);
                    totalUncompressedSize += entry.data.length;
                    entriesList.push({ name: targetPath, size: entry.data.length });
                    addedEntriesFromThis++;

                    // Track ancestor folders
                    const lastSlash = targetPath.lastIndexOf("/");
                    if (lastSlash !== -1) {
                        let currentDir = "";
                        const parts = targetPath.slice(0, lastSlash).split("/");
                        for (const p of parts) {
                            currentDir += (currentDir ? "/" : "") + p;
                            uniqueFolders.add(currentDir + "/");
                        }
                    }
                }
            }
        } else {
            // Raw text, log, or binary file
            const targetPath = resolveZipEntryCollision(rawName, buffer, existingFiles, baseName);
            if (targetPath) {
                mergedZip.addFile(targetPath, buffer);
                existingFiles.set(targetPath, buffer);
                totalUncompressedSize += buffer.length;
                entriesList.push({ name: targetPath, size: buffer.length });
                addedEntriesFromThis++;

                const lastSlash = targetPath.lastIndexOf("/");
                if (lastSlash !== -1) {
                    uniqueFolders.add(targetPath.slice(0, lastSlash + 1));
                }
            }
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
        folderCount: uniqueFolders.size,
        totalSize: totalUncompressedSize,
        compressedSize: outputBuffer.length,
        entries: entriesList,
        sourceFiles,
    };
}

module.exports = {
    extractAndCleanZip,
    extractAndCleanText,
    extractAndCleanZipAsync,
    extractAndCleanTextAsync,
    mergeZipFiles,
    isZipBuffer,
    looksLikeText,
    looksLikeZip,
};