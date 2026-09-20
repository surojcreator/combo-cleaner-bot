"use strict";

const { Worker } = require("node:worker_threads");
const os = require("node:os");
const path = require("node:path");

class WorkerPool {
    constructor(workerPath, numWorkers) {
        this.workerPath = workerPath || path.join(__dirname, "clean-worker.js");
        const availableCpus = os.cpus().length || 4;
        this.numWorkers = numWorkers || Math.max(2, Math.min(availableCpus, 16));
        this.workers = [];
        this.freeWorkers = [];
        this.queue = [];
        this.msgId = 0;
        this.pending = new Map();
        this.isClosed = false;
        this.idleTimer = null;
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
        }, 1500);
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
        if (lines.length < 5000 || this.workers.length === 0) {
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
     * @param {number} [chunkSize]
     * @returns {Promise<{ total: number, matches: string[] }>}
     */
    async searchLinesParallel(lines, query, chunkSize = 25000) {
        if (!lines || lines.length === 0 || !query) {
            return { total: 0, matches: [] };
        }

        // Fast path for small queries without worker overhead
        if (lines.length < 5000) {
            const escaped = String(query || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const re = new RegExp(escaped, "i");
            let total = 0;
            const matches = [];
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (re.test(line)) {
                    total++;
                    if (matches.length < 50) matches.push(line);
                }
            }
            return { total, matches };
        }

        const size = Math.max(5000, Math.min(chunkSize, Math.ceil(lines.length / this.numWorkers)));
        const tasks = [];

        for (let i = 0; i < lines.length; i += size) {
            const slice = lines.slice(i, i + size);
            tasks.push(this.exec({ type: "search", lines: slice, query }));
        }

        const results = await Promise.all(tasks);
        let total = 0;
        const matches = [];

        for (const res of results) {
            total += res.total;
            for (const m of res.matches) {
                if (matches.length < 50) matches.push(m);
            }
        }

        return { total, matches };
    }

    close() {
        this.isClosed = true;
        for (const w of this.workers) {
            w.terminate().catch(() => {});
        }
        this.workers = [];
        this.freeWorkers = [];
        this.queue = [];
        this.pending.clear();
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

module.exports = {
    WorkerPool,
    getSharedPool,
};
