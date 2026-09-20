"use strict";

const { parentPort } = require("node:worker_threads");
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
            const escaped = String(query || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const re = new RegExp(escaped, "i");
            const matches = [];
            let total = 0;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (re.test(line)) {
                    total++;
                    if (matches.length < 50) matches.push(line);
                }
            }

            parentPort.postMessage({
                id,
                result: { total, matches },
            });
        }
    });
}
