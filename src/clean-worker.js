"use strict";

const { parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const { cleanLine } = require("./cleaner");

if (parentPort) {
    parentPort.on("message", (msg) => {
        const { id, type, lines, options, query } = msg;

        if (type === "clean") {
            const keepUrl = Boolean(options && options.keepUrl);
            const dedupe = options && options.dedupe !== false;
            const cleaned = [];
            const seen = dedupe ? new Set() : null;
            let kept = 0;
            let dropped = 0;
            let duplicates = 0;

            for (let i = 0; i < lines.length; i++) {
                const raw = lines[i];
                const res = cleanLine(raw, { keepUrl });
                if (res === null) {
                    if (raw && raw.trim() !== "") dropped++;
                    continue;
                }
                if (seen) {
                    if (seen.has(res)) {
                        duplicates++;
                        continue;
                    }
                    seen.add(res);
                }
                cleaned.push(res);
                kept++;
            }

            parentPort.postMessage({
                id,
                result: {
                    lines: cleaned,
                    stats: {
                        total: lines.length,
                        kept,
                        dropped,
                        duplicates,
                    },
                },
            });
        } else if (type === "search") {
            const q = String(query || "").trim();
            const qLower = q.toLowerCase();
            const maxMatches = typeof msg.limit === "number" && msg.limit > 0 ? msg.limit : 50;
            const matches = [];
            let total = 0;

            if (qLower && Array.isArray(lines)) {
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (typeof line === "string" && line.toLowerCase().includes(qLower)) {
                        total++;
                        if (matches.length < maxMatches) matches.push(line);
                    }
                }
            }

            parentPort.postMessage({
                id,
                result: { total, matches },
            });
        } else if (type === "searchFileSlice") {
            const { filePath, start = 0, end = 0, limit } = msg;
            const q = String(query || "").trim();
            const qLower = q.toLowerCase();
            const maxMatches = typeof limit === "number" && limit > 0 ? limit : 50;
            const matches = [];
            let total = 0;

            if (!qLower || !filePath || end <= start) {
                parentPort.postMessage({
                    id,
                    result: { total: 0, matches: [] },
                });
                return;
            }

            let fd = null;
            try {
                fd = fs.openSync(filePath, "r");

                // Determine initial line start
                let lineStartPos = start;
                if (start > 0) {
                    // Check byte immediately preceding start
                    const prevBuf = Buffer.allocUnsafe(1);
                    fs.readSync(fd, prevBuf, 0, 1, start - 1);
                    if (prevBuf[0] !== 0x0a) {
                        // start is in the middle of a line, seek to next \n
                        let cur = start;
                        let found = false;
                        const searchBuf = Buffer.allocUnsafe(8192);
                        while (!found) {
                            const n = fs.readSync(fd, searchBuf, 0, 8192, cur);
                            if (n === 0) break;
                            const idx = searchBuf.indexOf(0x0a);
                            if (idx !== -1 && idx < n) {
                                lineStartPos = cur + idx + 1;
                                found = true;
                            } else {
                                cur += n;
                            }
                        }
                        if (!found) lineStartPos = cur;
                    }
                }

                const CHUNK = 4 * 1024 * 1024; // 4MB buffer for maximum I/O throughput
                const buf = Buffer.allocUnsafe(CHUNK);
                let curFilePos = lineStartPos;
                let remainder = "";
                let active = lineStartPos < end;

                while (active) {
                    const bytesRead = fs.readSync(fd, buf, 0, CHUNK, curFilePos);
                    if (bytesRead === 0) {
                        if (remainder.length > 0 && lineStartPos < end) {
                            const line = remainder.endsWith("\r") ? remainder.slice(0, -1) : remainder;
                            if (line.toLowerCase().includes(qLower)) {
                                total++;
                                if (matches.length < maxMatches) matches.push(line);
                            }
                        }
                        break;
                    }

                    const chunkStr = buf.toString("utf8", 0, bytesRead);
                    let chunkOffset = 0;

                    while (chunkOffset < bytesRead) {
                        const nlIdx = chunkStr.indexOf("\n", chunkOffset);
                        if (nlIdx === -1) {
                            remainder += chunkStr.slice(chunkOffset);
                            curFilePos += bytesRead;
                            break;
                        }

                        const lineSegment = chunkStr.slice(chunkOffset, nlIdx);
                        const fullLine = remainder + lineSegment;
                        remainder = "";

                        if (lineStartPos < end) {
                            const line = fullLine.endsWith("\r") ? fullLine.slice(0, -1) : fullLine;
                            if (line.toLowerCase().includes(qLower)) {
                                total++;
                                if (matches.length < maxMatches) matches.push(line);
                            }
                        }

                        lineStartPos = curFilePos + nlIdx + 1;
                        chunkOffset = nlIdx + 1;

                        if (lineStartPos >= end) {
                            active = false;
                            break;
                        }
                    }

                    if (active && chunkOffset >= bytesRead) {
                        curFilePos += bytesRead;
                    }
                }
            } catch (err) {
                console.error("Worker searchFileSlice error:", err && err.message ? err.message : err);
            } finally {
                if (fd !== null) {
                    try {
                        fs.closeSync(fd);
                    } catch (_) {}
                }
            }

            parentPort.postMessage({
                id,
                result: { total, matches },
            });
        }
    });
}
