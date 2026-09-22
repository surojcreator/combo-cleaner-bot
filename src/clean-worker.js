"use strict";

const { parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const { cleanLinesArray } = require("./cleaner");

if (parentPort) {
    parentPort.on("message", (msg) => {
        const { id, type, lines, options, query } = msg || {};
        try {
            if (type === "clean") {
                const result = cleanLinesArray(Array.isArray(lines) ? lines : [], options);
                parentPort.postMessage({
                    id,
                    result,
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
                    const prevBuf = Buffer.alloc(1);
                    const bytesRead = fs.readSync(fd, prevBuf, 0, 1, start - 1);
                    if (bytesRead === 1 && prevBuf[0] !== 0x0a) {
                        // start is in the middle of a line, seek to next \n
                        let cur = start;
                        let found = false;
                        const searchBuf = Buffer.allocUnsafe(8192);
                        while (!found) {
                            const n = fs.readSync(fd, searchBuf, 0, 8192, cur);
                            if (n === 0) break;
                            const idx = searchBuf.subarray(0, n).indexOf(0x0a);
                            if (idx !== -1) {
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
                let remainder = Buffer.alloc(0);
                let active = lineStartPos < end;

                while (active) {
                    const bytesRead = fs.readSync(fd, buf, 0, CHUNK, curFilePos);
                    if (bytesRead === 0) {
                        if (remainder.length > 0 && lineStartPos < end) {
                            let line = remainder.toString("utf8");
                            if (line.endsWith("\r")) line = line.slice(0, -1);
                            if (line.toLowerCase().includes(qLower)) {
                                total++;
                                if (matches.length < maxMatches) matches.push(line);
                            }
                        }
                        break;
                    }

                    let chunkOffset = 0;

                    while (chunkOffset < bytesRead) {
                        const nlIdx = buf.indexOf(0x0a, chunkOffset);
                        if (nlIdx === -1 || nlIdx >= bytesRead) {
                            const unread = buf.subarray(chunkOffset, bytesRead);
                            remainder = remainder.length > 0 ? Buffer.concat([remainder, unread]) : Buffer.from(unread);
                            curFilePos += bytesRead;
                            break;
                        }

                        const lineSegment = buf.subarray(chunkOffset, nlIdx);
                        const fullLineBuf = remainder.length > 0 ? Buffer.concat([remainder, lineSegment]) : lineSegment;
                        remainder = Buffer.alloc(0);

                        if (lineStartPos < end) {
                            let line = fullLineBuf.toString("utf8");
                            if (line.endsWith("\r")) line = line.slice(0, -1);
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
                parentPort.postMessage({
                    id,
                    error: err && err.message ? err.message : String(err),
                    result: null,
                });
                return;
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
        } else {
            parentPort.postMessage({
                id,
                error: `UNKNOWN_TASK_TYPE_${type}`,
                result: null,
            });
        }
    } catch (workerErr) {
        console.error("Worker unhandled error:", workerErr);
        parentPort.postMessage({
            id,
            error: workerErr && workerErr.message ? workerErr.message : String(workerErr),
            result: null,
        });
    }
});
}
