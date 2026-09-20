"use strict";

const { Worker } = require("node:worker_threads");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

class WorkerPool {
    constructor(workerPath, numWorkers) {
        this.workerPath = workerPath || path.join(__dirname, "clean-worker.js");
        const availableCpus = os.cpus().length || 4;
        // Default to all available CPU cores (saturates 100% of available cores)
        this.numWorkers = numWorkers || Math.max(4, Math.min(availableCpus, 32));
        this.workers = [];
        this.freeWorkers = [];
        this.queue = [];
        this.msgId = 0;
        this.pending = new Map();
        this.isClosed = false;
        this.idleTimer = null;
        const isTest = process.env.NODE_ENV === "test" || process.execArgv.includes("--test") || process.argv.some((a) => a.includes("--test") || a.includes(".test.js"));
        this.idleTimeoutMs = isTest ? 150 : 120000;
    }

    warmup() {
        this._ensureWorkers();
    }

    _ensureWorkers() {
        if (this.isClosed) return;
        while (this.workers.length < this.numWorkers) {
            this._spawnWorker();
        }
    }

    _spawnWorker() {
        if (this.isClosed) return;
        try {
            const worker = new Worker(this.workerPath);
            worker.unref();
            worker.on("message", (msg) => {
                const { id, result } = msg;
                const task = this.pending.get(id);
                if (task) {
                    this.pending.delete(id);
                    task.resolve(result);
                }
                if (!this.isClosed) {
                    this.freeWorkers.push(worker);
                    this._drainQueue();
                    if (this.pending.size === 0 && this.queue.length === 0) {
                        this._scheduleIdleCleanup();
                    }
                }
            });

            worker.on("error", (err) => {
                console.error("Worker error in pool:", err && err.message ? err.message : err);
                const idx = this.workers.indexOf(worker);
                if (idx !== -1) this.workers.splice(idx, 1);
                const fIdx = this.freeWorkers.indexOf(worker);
                if (fIdx !== -1) this.freeWorkers.splice(fIdx, 1);
                worker.terminate().catch(() => {});
                if (!this.isClosed && this.queue.length > 0) this._spawnWorker();
            });

            worker.on("exit", (code) => {
                if (!this.isClosed && code !== 0) {
                    const idx = this.workers.indexOf(worker);
                    if (idx !== -1) this.workers.splice(idx, 1);
                    const fIdx = this.freeWorkers.indexOf(worker);
                    if (fIdx !== -1) this.freeWorkers.splice(fIdx, 1);
                    if (this.queue.length > 0) this._spawnWorker();
                }
            });

            this.workers.push(worker);
            this.freeWorkers.push(worker);
            this._drainQueue();
        } catch (err) {
            console.error("Failed to spawn worker:", err && err.message ? err.message : err);
        }
    }

    _scheduleIdleCleanup() {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            if (this.pending.size === 0 && this.queue.length === 0) {
                for (const w of this.workers) {
                    w.terminate().catch(() => {});
                }
                this.workers = [];
                this.freeWorkers = [];
            }
        }, this.idleTimeoutMs);
        if (this.idleTimer.unref) this.idleTimer.unref();
    }

    _drainQueue() {
        while (this.freeWorkers.length > 0 && this.queue.length > 0) {
            const worker = this.freeWorkers.pop();
            const task = this.queue.shift();
            const id = ++this.msgId;
            this.pending.set(id, task);
            worker.postMessage({ id, ...task.payload });
        }
    }

    exec(payload) {
        if (this.isClosed) {
            return Promise.reject(new Error("WORKER_POOL_CLOSED"));
        }
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        this._ensureWorkers();
        return new Promise((resolve, reject) => {
            this.queue.push({ payload, resolve, reject });
            this._drainQueue();
        });
    }

    /**
     * Clean an array of lines in parallel across all CPU worker threads.
     * @param {string[]} lines
     * @param {object} [options]
     * @param {number} [chunkSize]
     * @returns {Promise<{ lines: string[], stats: { total: number, kept: number, dropped: number, duplicates: number } }>}
     */
    async cleanLinesParallel(lines, options = {}, chunkSize = 25000) {
        if (!lines || lines.length === 0) {
            return { lines: [], stats: { total: 0, kept: 0, dropped: 0, duplicates: 0 } };
        }

        // For small batches (< 5000 lines), worker thread overhead is not worth it
        if (lines.length < 5000) {
            const { cleanText } = require("./cleaner");
            return cleanText(lines.join("\n"), options);
        }

        const size = Math.max(5000, Math.min(chunkSize, Math.ceil(lines.length / this.numWorkers)));
        const tasks = [];

        for (let i = 0; i < lines.length; i += size) {
            const slice = lines.slice(i, i + size);
            tasks.push(this.exec({ type: "clean", lines: slice, options }));
        }

        const results = await Promise.all(tasks);
        const combinedLines = [];
        let total = 0;
        let kept = 0;
        let dropped = 0;
        let duplicates = 0;

        for (const res of results) {
            combinedLines.push(...res.lines);
            total += res.stats.total;
            kept += res.stats.kept;
            dropped += res.stats.dropped;
            duplicates += res.stats.duplicates;
        }

        if (options && options.dedupe !== false) {
            const finalLines = [];
            const seen = new Set();
            for (const line of combinedLines) {
                if (seen.has(line)) {
                    duplicates++;
                    kept--;
                } else {
                    seen.add(line);
                    finalLines.push(line);
                }
            }
            return {
                lines: finalLines,
                stats: { total, kept, dropped, duplicates },
            };
        }

        return {
            lines: combinedLines,
            stats: { total, kept, dropped, duplicates },
        };
    }

    /**
     * Search an array of lines in parallel across all CPU worker threads.
     * @param {string[]} lines
     * @param {string} query
     * @param {number|object} [limitOrOptions]
     * @param {number} [chunkSize]
     * @returns {Promise<{ total: number, matches: string[] }>}
     */
    async searchLinesParallel(lines, query, limitOrOptions = 50, chunkSize = 25000) {
        if (!lines || lines.length === 0 || !query) {
            return { total: 0, matches: [] };
        }

        let limit = 50;
        let actualChunkSize = chunkSize;
        if (typeof limitOrOptions === "number") {
            limit = limitOrOptions;
        } else if (limitOrOptions && typeof limitOrOptions === "object") {
            if (typeof limitOrOptions.limit === "number") limit = limitOrOptions.limit;
            if (typeof limitOrOptions.chunkSize === "number") actualChunkSize = limitOrOptions.chunkSize;
        }

        const qLower = String(query).trim().toLowerCase();
        if (!qLower) return { total: 0, matches: [] };

        // Fast path for small queries without worker overhead
        if (lines.length < 5000) {
            let total = 0;
            const matches = [];
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (typeof line === "string" && line.toLowerCase().includes(qLower)) {
                    total++;
                    if (matches.length < limit) matches.push(line);
                }
            }
            return { total, matches };
        }

        const size = Math.max(5000, Math.min(actualChunkSize, Math.ceil(lines.length / this.numWorkers)));
        const tasks = [];

        for (let i = 0; i < lines.length; i += size) {
            const slice = lines.slice(i, i + size);
            tasks.push(this.exec({ type: "search", lines: slice, query: qLower, limit }));
        }

        const results = await Promise.all(tasks);
        let total = 0;
        const matches = [];

        for (const res of results) {
            total += res.total;
            for (const m of res.matches) {
                if (matches.length < limit) matches.push(m);
            }
        }

        return { total, matches };
    }

    /**
     * Search a huge text file on disk across all CPU cores in parallel by partitioning byte ranges.
     * @param {string} filePath
     * @param {string} query
     * @param {number} [limit]
     * @returns {Promise<{ total: number, matches: string[] }>}
     */
    async searchFileParallel(filePath, query, limit = 20) {
        const q = String(query || "").trim();
        if (!q || !filePath) return { total: 0, matches: [] };
        if (!fs.existsSync(filePath)) return { total: 0, matches: [] };

        let stat;
        try {
            stat = fs.statSync(filePath);
        } catch (_) {
            return { total: 0, matches: [] };
        }

        const fileSize = stat.size;
        if (fileSize === 0) return { total: 0, matches: [] };

        const qLower = q.toLowerCase();

        // For small files (< 256KB), avoid worker dispatch overhead and do fast direct scan
        if (fileSize < 256 * 1024) {
            const matches = [];
            let total = 0;
            const content = fs.readFileSync(filePath, "utf8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
                const raw = lines[i];
                const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
                if (line.toLowerCase().includes(qLower)) {
                    total++;
                    if (matches.length < limit) matches.push(line);
                }
            }
            return { total, matches };
        }

        this._ensureWorkers();
        const numSlices = Math.max(1, Math.min(this.numWorkers, Math.ceil(fileSize / (1024 * 1024))));
        const sliceSize = Math.ceil(fileSize / numSlices);
        const tasks = [];

        for (let i = 0; i < numSlices; i++) {
            const start = i * sliceSize;
            const end = Math.min(fileSize, (i + 1) * sliceSize);
            tasks.push(
                this.exec({
                    type: "searchFileSlice",
                    filePath: path.resolve(filePath),
                    start,
                    end,
                    query: q,
                    limit,
                }),
            );
        }

        const results = await Promise.all(tasks);
        let total = 0;
        const matches = [];

        for (const res of results) {
            if (res) {
                total += res.total || 0;
                if (Array.isArray(res.matches)) {
                    for (const m of res.matches) {
                        if (matches.length < limit) matches.push(m);
                    }
                }
            }
        }

        return { total, matches };
    }

    close() {
        this.isClosed = true;
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        for (const w of this.workers) {
            w.terminate().catch(() => {});
        }
        this.workers = [];
        this.freeWorkers = [];
        this.queue = [];
        this.pending.clear();
    }

    destroy() {
        this.close();
    }
}

// Global shared singleton pool for maximum multi-core saturation
let sharedPool = null;

function getSharedPool() {
    if (!sharedPool || sharedPool.isClosed) {
        sharedPool = new WorkerPool();
    }
    return sharedPool;
}

function closeSharedPool() {
    if (sharedPool) {
        sharedPool.close();
        sharedPool = null;
    }
}

module.exports = {
    WorkerPool,
    getSharedPool,
    closeSharedPool,
};
