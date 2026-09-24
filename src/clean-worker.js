"use strict";

const { parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const { cleanLinesArray, createSearchMatcher, resolveStealerRecordFromLines, searchBufferCI } = require("./cleaner");

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
                const matcher = createSearchMatcher(query);
                const maxMatches = typeof msg.limit === "number" && msg.limit > 0 ? msg.limit : 50;
                const matches = [];
                let total = 0;

                if (matcher && Array.isArray(lines)) {
                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        if (matcher(line)) {
                            total++;
                            if (matches.length < maxMatches) {
                                let matchResult = line;
                                const stealerRec = resolveStealerRecordFromLines(lines, i);
                                if (stealerRec) matchResult = stealerRec;
                                matches.push(matchResult);
                            }
                        }
                    }
                }

                parentPort.postMessage({
                    id,
                    result: { total, matches },
                });
            } else if (type === "searchFileSlice") {
                const { filePath, start = 0, end = 0, limit } = msg;
                const maxMatches = typeof limit === "number" && limit > 0 ? limit : 50;
                const matches = [];
                let total = 0;

                if (!query || !filePath || end <= start) {
                    parentPort.postMessage({
                        id,
                        result: { total: 0, matches: [] },
                    });
                    return;
                }

                let fd = null;
                try {
                    fd = fs.openSync(filePath, "r");
                    const stat = fs.fstatSync(fd);
                    const fileSize = stat.size;

                    // Determine initial line start (seek to next newline if start is mid-line)
                    let lineStartPos = start;
                    if (start > 0) {
                        const prevBuf = Buffer.alloc(1);
                        const bytesRead = fs.readSync(fd, prevBuf, 0, 1, start - 1);
                        if (bytesRead === 1 && prevBuf[0] !== 0x0a) {
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

                    // Determine slice end boundary (snap to newline after end)
                    let lineEndPos = Math.min(fileSize, end);
                    if (end < fileSize) {
                        let cur = end;
                        let found = false;
                        const searchBuf = Buffer.allocUnsafe(8192);
                        while (!found) {
                            const n = fs.readSync(fd, searchBuf, 0, 8192, cur);
                            if (n === 0) break;
                            const idx = searchBuf.subarray(0, n).indexOf(0x0a);
                            if (idx !== -1) {
                                lineEndPos = cur + idx + 1;
                                found = true;
                            } else {
                                cur += n;
                            }
                        }
                        if (!found) lineEndPos = cur;
                    }

                    const sliceLen = lineEndPos - lineStartPos;
                    if (sliceLen > 0) {
                        const CHUNK_MAX = 32 * 1024 * 1024;
                        if (sliceLen <= CHUNK_MAX) {
                            const sliceBuf = Buffer.allocUnsafe(sliceLen);
                            const bytesRead = fs.readSync(fd, sliceBuf, 0, sliceLen, lineStartPos);
                            const res = searchBufferCI(sliceBuf.subarray(0, bytesRead), query, maxMatches);
                            total = res.total;
                            matches.push(...res.matches);
                        } else {
                            // Stream large slices in 16MB chunks with boundary preservation
                            let curFilePos = lineStartPos;
                            let remainder = Buffer.alloc(0);
                            const readBuf = Buffer.allocUnsafe(16 * 1024 * 1024);

                            while (curFilePos < lineEndPos) {
                                const toRead = Math.min(readBuf.length, lineEndPos - curFilePos);
                                const bytesRead = fs.readSync(fd, readBuf, 0, toRead, curFilePos);
                                if (bytesRead === 0) break;

                                const combined = remainder.length > 0
                                    ? Buffer.concat([remainder, readBuf.subarray(0, bytesRead)])
                                    : readBuf.subarray(0, bytesRead);

                                const lastNl = combined.lastIndexOf(0x0a);
                                if (lastNl !== -1 && curFilePos + bytesRead < lineEndPos) {
                                    const chunk = combined.subarray(0, lastNl + 1);
                                    remainder = Buffer.from(combined.subarray(lastNl + 1));
                                    const res = searchBufferCI(chunk, query, Math.max(0, maxMatches - matches.length));
                                    total += res.total;
                                    for (const m of res.matches) {
                                        if (matches.length < maxMatches) matches.push(m);
                                    }
                                } else {
                                    remainder = Buffer.alloc(0);
                                    const res = searchBufferCI(combined, query, Math.max(0, maxMatches - matches.length));
                                    total += res.total;
                                    for (const m of res.matches) {
                                        if (matches.length < maxMatches) matches.push(m);
                                    }
                                }
                                curFilePos += bytesRead;
                            }
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
