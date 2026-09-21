"use strict";

const { test, describe, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");

const downloads = require("../src/downloads");
const store = require("../src/store");
const messages = require("../src/messages");
const botModule = require("../src/bot");
const AdmZip = require("adm-zip");
const { mergeZipFiles } = require("../src/extractor");
const { getSharedPool } = require("../src/worker-pool");
const { createBot, isForwardedDocument, sendCombined, localProcessedRoot } = botModule;

describe("Forwarded Logs Combiner & Direct Download Links Pipeline", () => {
    let tmpDir;
    let oldProcessRoot;
    let oldProcessedRoot;
    let oldDownloadUrl;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-test-"));
        oldProcessRoot = process.env.LOCAL_PROCESS_ROOT;
        oldProcessedRoot = process.env.LOCAL_PROCESSED_ROOT;
        oldDownloadUrl = process.env.DOWNLOAD_BASE_URL;

        process.env.LOCAL_PROCESS_ROOT = path.join(tmpDir, "raw");
        process.env.LOCAL_PROCESSED_ROOT = path.join(tmpDir, "processed");
        process.env.DOWNLOAD_BASE_URL = "http://127.0.0.1:9099";

        fs.mkdirSync(process.env.LOCAL_PROCESS_ROOT, { recursive: true });
        fs.mkdirSync(process.env.LOCAL_PROCESSED_ROOT, { recursive: true });

        downloads.clearAll();
        store.clearAll();
        messages.clearCustomEmojis();
    });

    afterEach(() => {
        downloads.clearAll();
        store.clearAll();
        messages.clearCustomEmojis();

        if (oldProcessRoot !== undefined) process.env.LOCAL_PROCESS_ROOT = oldProcessRoot;
        else delete process.env.LOCAL_PROCESS_ROOT;

        if (oldProcessedRoot !== undefined) process.env.LOCAL_PROCESSED_ROOT = oldProcessedRoot;
        else delete process.env.LOCAL_PROCESSED_ROOT;

        if (oldDownloadUrl !== undefined) process.env.DOWNLOAD_BASE_URL = oldDownloadUrl;
        else delete process.env.DOWNLOAD_BASE_URL;

        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (_) {}
    });

    describe("Subsystem 1: Direct Download Server (src/downloads.js)", () => {
        test("registerDownload generates secure token, calculates size and resolves downloadUrl", () => {
            const sampleContent = Buffer.from("user@netflix.com:Secret123\nuser2@netflix.com:Pass456\n", "utf8");
            const reg = downloads.registerDownload({
                filename: "netflix_combined_2026-09-21.txt",
                buffer: sampleContent,
                chatId: 12345,
            });

            assert.ok(reg.token, "Must produce a unique token");
            assert.equal(reg.filename, "netflix_combined_2026-09-21.txt");
            assert.equal(reg.size, sampleContent.length);
            assert.equal(reg.url, `http://127.0.0.1:9099/download/${reg.token}`);

            const fetched = downloads.getDownload(reg.token);
            assert.ok(fetched);
            assert.equal(fetched.chatId, 12345);
            assert.equal(fetched.buffer.toString(), sampleContent.toString());
        });

        test("handleDownloadRequest serves HTTP GET with streaming and valid headers", async () => {
            const filePath = path.join(process.env.LOCAL_PROCESSED_ROOT, "disk_dump.txt");
            const fileContent = "alice@site.com:PasswordA\nbob@site.com:PasswordB\n";
            fs.writeFileSync(filePath, fileContent, "utf8");

            const reg = downloads.registerDownload({
                filename: "disk_dump.txt",
                filePath,
                chatId: 9999,
            });

            // Start a mock HTTP server using handleDownloadRequest
            const server = http.createServer((req, res) => {
                if (downloads.isDownloadRequest(req)) {
                    downloads.handleDownloadRequest(req, res);
                    return;
                }
                res.writeHead(404);
                res.end();
            });

            await new Promise((resolve) => server.listen(0, resolve));
            const port = server.address().port;

            try {
                // Test GET
                const res = await fetch(`http://127.0.0.1:${port}/download/${reg.token}`);
                assert.equal(res.status, 200);
                assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
                assert.ok(res.headers.get("content-disposition").includes("disk_dump.txt"));
                const text = await res.text();
                assert.equal(text, fileContent);

                // Test HEAD
                const headRes = await fetch(`http://127.0.0.1:${port}/download/${reg.token}`, { method: "HEAD" });
                assert.equal(headRes.status, 200);
                assert.equal(headRes.headers.get("content-length"), String(fileContent.length));
                const headBody = await headRes.text();
                assert.equal(headBody, "");

                // Test invalid token -> 404
                const notFoundRes = await fetch(`http://127.0.0.1:${port}/download/non_existent_token_12345`);
                assert.equal(notFoundRes.status, 404);
            } finally {
                server.close();
            }
        });

        test("purgeExpired drops tokens after TTL", () => {
            const reg = downloads.registerDownload({
                filename: "expired.txt",
                buffer: Buffer.from("test"),
                ttlMs: -1000, // already expired
            });

            assert.equal(downloads.getDownload(reg.token), null, "Expired download must return null");
        });
    });

    describe("Subsystem 2: Forwarded Document Detection", () => {
        test("isForwardedDocument detects forward_date, forward_origin, and media_group_id", () => {
            // Forward with forward_date
            assert.equal(
                isForwardedDocument({ message: { document: { file_name: "log1.txt" }, forward_date: 1700000000 } }),
                true
            );

            // Forward with forward_origin (Telegram 7.0+)
            assert.equal(
                isForwardedDocument({
                    message: {
                        document: { file_name: "log2.txt" },
                        forward_origin: { type: "user", sender_user: { id: 111 } },
                    },
                }),
                true
            );

            // Forward with media_group_id
            assert.equal(
                isForwardedDocument({
                    message: {
                        document: { file_name: "log3.txt" },
                        media_group_id: "mg_999",
                    },
                }),
                true
            );

            // Non-forwarded direct upload
            assert.equal(
                isForwardedDocument({
                    message: {
                        document: { file_name: "normal.txt" },
                    },
                }),
                false
            );

            // Empty message
            assert.equal(isForwardedDocument(null), false);
            assert.equal(isForwardedDocument({ message: {} }), false);
        });
    });

    describe("Subsystem 3: Forwarding 2 Log Files Combines Both with One Direct Download Link", () => {
        test("Debounces 2 forwarded log files, merges & deduplicates, and provides one direct download link", async () => {
            const chatId = 600101;
            const log1Content = [
                "https://netflix.com:user1@netflix.com:Pass111!",
                "https://netflix.com:user2@netflix.com:Pass222!",
            ].join("\n");

            const log2Content = [
                "https://netflix.com:user3@netflix.com:Pass333!",
                "https://netflix.com:user1@netflix.com:Pass111!", // duplicate from log 1
            ].join("\n");

            // Mock Telegram file links & downloads
            const fileStorage = new Map([
                ["file_id_part1", Buffer.from(log1Content, "utf8")],
                ["file_id_part2", Buffer.from(log2Content, "utf8")],
            ]);

            // Mock Telegraf Telegram Bot API server
            const botCalls = [];
            const botApiServer = http.createServer((req, res) => {
                if (req.url.includes("/file/bot")) {
                    const fileId = req.url.split("/").pop();
                    if (fileStorage.has(fileId)) {
                        res.writeHead(200, { "Content-Type": "text/plain" });
                        res.end(fileStorage.get(fileId));
                        return;
                    }
                    res.writeHead(404);
                    res.end();
                    return;
                }

                let body = "";
                req.on("data", (chunk) => { body += chunk; });
                req.on("end", () => {
                    const method = req.url.split("/").pop();
                    let payload = {};
                    try { payload = JSON.parse(body); } catch (_) {}
                    botCalls.push({ method, p: payload });

                    if (method === "getFile") {
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({
                            ok: true,
                            result: {
                                file_id: payload.file_id,
                                file_path: payload.file_id,
                            },
                        }));
                        return;
                    }

                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true, result: { message_id: 8888, text: payload.text || "" } }));
                });
            });

            await new Promise((resolve) => botApiServer.listen(0, resolve));
            const botApiPort = botApiServer.address().port;

            try {
                // Initialize bot with short debounce for test (50ms)
                const bot = createBot("123:MOCK_TOKEN", {
                    forwardDebounceMs: 50,
                    telegram: {
                        telegram: {
                            apiRoot: `http://127.0.0.1:${botApiPort}`,
                        },
                    },
                });

                // 1. User forwards Part 1
                await bot.handleUpdate({
                    update_id: 1,
                    message: {
                        message_id: 101,
                        chat: { id: chatId, type: "private" },
                        from: { id: chatId, is_bot: false, first_name: "Tester" },
                        document: {
                            file_id: "file_id_part1",
                            file_name: "netflix_logs_part1.txt",
                            file_size: log1Content.length,
                        },
                        forward_date: 1700000001,
                    },
                });

                // 2. User forwards Part 2 15ms later (within 50ms debounce window)
                await bot.handleUpdate({
                    update_id: 2,
                    message: {
                        message_id: 102,
                        chat: { id: chatId, type: "private" },
                        from: { id: chatId, is_bot: false, first_name: "Tester" },
                        document: {
                            file_id: "file_id_part2",
                            file_name: "netflix_logs_part2.txt",
                            file_size: log2Content.length,
                        },
                        forward_date: 1700000002,
                    },
                });

                // 3. Wait for debounce timer and async processing to complete
                let finalEdit = null;
                for (let i = 0; i < 40; i++) {
                    finalEdit = botCalls.find(
                        (c) => c.method === "editMessageText" && c.p.text && c.p.text.includes("FORWARDED LOGS UNIFIED PIPELINE")
                    );
                    if (finalEdit) break;
                    await new Promise((r) => setTimeout(r, 50));
                }
                assert.ok(finalEdit, "Must deliver unified forwarded logs report");

                const reportText = finalEdit.p.text;
                assert.ok(reportText.includes("netflix_logs_part1.txt"), "Must include part 1 in report");
                assert.ok(reportText.includes("netflix_logs_part2.txt"), "Must include part 2 in report");
                assert.ok(reportText.includes("Combined Sources (2 forwarded files)"));
                assert.ok(reportText.includes("Direct Download Link:"));
                assert.ok(reportText.includes("http://127.0.0.1:9099/download/"));

                // Verify keyboard has direct download link URL button
                const replyMarkup = finalEdit.p.reply_markup;
                assert.ok(replyMarkup && replyMarkup.inline_keyboard);
                const buttons = replyMarkup.inline_keyboard.flat();
                const dlBtn = buttons.find((b) => b.text.includes("Direct Download Link"));
                assert.ok(dlBtn, "Must include direct download URL button");
                assert.ok(dlBtn.url.startsWith("http://127.0.0.1:9099/download/"));

                // Verify the direct download link token points to the combined file
                const token = dlBtn.url.split("/").pop();
                const dlEntry = downloads.getDownload(token);
                assert.ok(dlEntry, "Download entry must exist in registry");
                assert.equal(dlEntry.stats.kept, 3, "Total unique lines from both files must be 3");

                // Verify file content on disk has all 3 unique lines and dropped the duplicate
                const fileOnDisk = fs.readFileSync(dlEntry.filePath, "utf8");
                assert.ok(fileOnDisk.includes("user1@netflix.com:Pass111!"));
                assert.ok(fileOnDisk.includes("user2@netflix.com:Pass222!"));
                assert.ok(fileOnDisk.includes("user3@netflix.com:Pass333!"));

                // Test Telegram button send_telegram:<token>
                await bot.handleUpdate({
                    update_id: 3,
                    callback_query: {
                        id: "cb_1",
                        from: { id: chatId, is_bot: false, first_name: "Tester" },
                        message: { message_id: 8888, chat: { id: chatId, type: "private" } },
                        data: `send_telegram:${token}`,
                    },
                });

                const docSent = botCalls.find((c) => c.method === "sendDocument");
                assert.ok(docSent, "send_telegram callback should send document to chat");
            } finally {
                botApiServer.close();
            }
        });

        test("Raw non-credential system logs preserve all lines and combine cleanly", async () => {
            const chatId = 600102;
            const log1 = "[2026-09-21 12:00:01] System boot started\n[2026-09-21 12:00:02] Network online\n";
            const log2 = "[2026-09-21 12:00:03] Worker thread started\n[2026-09-21 12:00:01] System boot started\n"; // 1 duplicate

            const fileStorage = new Map([
                ["f_sys1", Buffer.from(log1, "utf8")],
                ["f_sys2", Buffer.from(log2, "utf8")],
            ]);

            const botCalls = [];
            const botApiServer = http.createServer((req, res) => {
                if (req.url.includes("/file/bot")) {
                    const fileId = req.url.split("/").pop();
                    if (fileStorage.has(fileId)) {
                        res.writeHead(200, { "Content-Type": "text/plain" });
                        res.end(fileStorage.get(fileId));
                        return;
                    }
                    res.writeHead(404);
                    res.end();
                    return;
                }

                let body = "";
                req.on("data", (chunk) => { body += chunk; });
                req.on("end", () => {
                    const method = req.url.split("/").pop();
                    let payload = {};
                    try { payload = JSON.parse(body); } catch (_) {}
                    botCalls.push({ method, p: payload });

                    if (method === "getFile") {
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({
                            ok: true,
                            result: {
                                file_id: payload.file_id,
                                file_path: payload.file_id,
                            },
                        }));
                        return;
                    }

                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true, result: { message_id: 7777 } }));
                });
            });
            await new Promise((resolve) => botApiServer.listen(0, resolve));
            const apiPort = botApiServer.address().port;

            try {
                const bot = createBot("123:MOCK_TOKEN", {
                    forwardDebounceMs: 50,
                    telegram: { telegram: { apiRoot: `http://127.0.0.1:${apiPort}` } },
                });

                await bot.handleUpdate({
                    update_id: 10,
                    message: {
                        message_id: 201,
                        chat: { id: chatId, type: "private" },
                        from: { id: chatId, is_bot: false },
                        document: { file_id: "f_sys1", file_name: "syslog_part1.log", file_size: log1.length },
                        forward_date: 1700000010,
                    },
                });

                await bot.handleUpdate({
                    update_id: 11,
                    message: {
                        message_id: 202,
                        chat: { id: chatId, type: "private" },
                        from: { id: chatId, is_bot: false },
                        document: { file_id: "f_sys2", file_name: "syslog_part2.log", file_size: log2.length },
                        forward_date: 1700000011,
                    },
                });

                let edit = null;
                for (let i = 0; i < 40; i++) {
                    edit = botCalls.find(
                        (c) => c.method === "editMessageText" && c.p.text && c.p.text.includes("FORWARDED LOGS UNIFIED PIPELINE")
                    );
                    if (edit) break;
                    await new Promise((r) => setTimeout(r, 50));
                }
                assert.ok(edit, "Should successfully process raw non-credential logs");
                assert.ok(edit.p.text.includes("3"), "Must contain 3 unique lines");
            } finally {
                botApiServer.close();
            }
        });
    });

    describe("Subsystem 4: /link and sendCombined Integration", () => {
        test("/link generates direct download link for existing batch", async () => {
            const chatId = 600103;
            store.clear(chatId);
            store.addLines(chatId, ["admin@target.com:MasterPass1", "mod@target.com:MasterPass2"], "target.com");

            const botCalls = [];
            const botApiServer = http.createServer((req, res) => {
                let body = "";
                req.on("data", (c) => { body += c; });
                req.on("end", () => {
                    botCalls.push({ method: req.url.split("/").pop(), p: JSON.parse(body || "{}") });
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true, result: { message_id: 1111 } }));
                });
            });
            await new Promise((r) => botApiServer.listen(0, r));
            const port = botApiServer.address().port;

            try {
                const bot = createBot("123:MOCK_TOKEN", {
                    telegram: { telegram: { apiRoot: `http://127.0.0.1:${port}` } },
                });

                await bot.handleUpdate({
                    update_id: 20,
                    message: {
                        message_id: 301,
                        chat: { id: chatId, type: "private" },
                        from: { id: chatId, is_bot: false },
                        text: "/link",
                        entities: [{ type: "bot_command", offset: 0, length: 5 }],
                    },
                });

                const reply = botCalls.find((c) => c.method === "sendMessage" && c.p.text && c.p.text.includes("DIRECT DOWNLOAD LINK READY"));
                assert.ok(reply, "Must reply with direct download link card");
                assert.ok(reply.p.text.includes("http://127.0.0.1:9099/download/"));

                const buttons = reply.p.reply_markup.inline_keyboard.flat();
                assert.ok(buttons.some((b) => b.text.includes("Direct Download Link") && b.url));
            } finally {
                botApiServer.close();
            }
        });

        test("sendCombined registers with downloads and includes direct link in caption and keyboard", async () => {
            const chatId = 600104;
            store.clear(chatId);
            store.addLines(chatId, ["alice@site.com:p1", "bob@site.com:p2"], "site.com");

            const deliveredDocs = [];
            const mockCtx = {
                chat: { id: chatId },
                replyWithDocument: async (payload, extra) => {
                    deliveredDocs.push({ payload, extra });
                    return { message_id: 9901 };
                },
                reply: async (text) => ({ message_id: 9902, text }),
            };

            await sendCombined(mockCtx);

            assert.equal(deliveredDocs.length, 1);
            const doc = deliveredDocs[0];
            assert.ok(doc.extra.caption.includes("Direct link:"));
            assert.ok(doc.extra.caption.includes("http://127.0.0.1:9099/download/"));

            const buttons = doc.extra.reply_markup.inline_keyboard.flat();
            assert.ok(buttons.some((b) => b.text.includes("Direct Download Link") && b.url.includes("/download/")));
        });
    });

    describe("Subsystem 5: In-Memory Zip Merging & Direct Download Link (Zero Disk Downloads)", () => {
        test("mergeZipFiles merges entries from multiple archives into one zip and namespaces duplicates", () => {
            const z1 = new AdmZip();
            z1.addFile("server.log", Buffer.from("log data 1"));
            z1.addFile("common.conf", Buffer.from("conf 1"));
            const b1 = z1.toBuffer();

            const z2 = new AdmZip();
            z2.addFile("database.log", Buffer.from("log data 2"));
            z2.addFile("common.conf", Buffer.from("conf 2"));
            const b2 = z2.toBuffer();

            const res = mergeZipFiles([
                { name: "srv1.zip", buffer: b1 },
                { name: "srv2.zip", buffer: b2 },
            ]);

            assert.ok(res.buffer && Buffer.isBuffer(res.buffer));
            assert.equal(res.entryCount, 4, "Should have 4 total files");

            const check = new AdmZip(res.buffer);
            const entryNames = check.getEntries().map((e) => e.entryName);
            assert.ok(entryNames.includes("server.log"));
            assert.ok(entryNames.includes("common.conf"));
            assert.ok(entryNames.includes("database.log"));
            assert.ok(entryNames.includes("srv2/common.conf"), "Duplicate entry should be namespaced");

            assert.equal(check.getEntry("common.conf").getData().toString(), "conf 1");
            assert.equal(check.getEntry("srv2/common.conf").getData().toString(), "conf 2");
        });

        test("Forwarding 2 .zip files merges them into ONE master .zip and returns direct download link", async () => {
            const chatId = 700201;

            const zipA = new AdmZip();
            zipA.addFile("auth.log", Buffer.from("Apr 10 auth success"));
            const bufA = zipA.toBuffer();

            const zipB = new AdmZip();
            zipB.addFile("daemon.log", Buffer.from("Apr 10 daemon started"));
            const bufB = zipB.toBuffer();

            const fileStorage = new Map([
                ["zip_id_1", bufA],
                ["zip_id_2", bufB],
            ]);

            const botCalls = [];
            const botApiServer = http.createServer((req, res) => {
                if (req.url.includes("/file/bot")) {
                    const fileId = req.url.split("/").pop();
                    if (fileStorage.has(fileId)) {
                        res.writeHead(200, { "Content-Type": "application/zip" });
                        res.end(fileStorage.get(fileId));
                        return;
                    }
                    res.writeHead(404);
                    res.end();
                    return;
                }

                let body = "";
                req.on("data", (chunk) => { body += chunk; });
                req.on("end", () => {
                    const method = req.url.split("/").pop();
                    let payload = {};
                    try { payload = JSON.parse(body); } catch (_) {}
                    botCalls.push({ method, p: payload });

                    if (method === "getFile") {
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({
                            ok: true,
                            result: { file_id: payload.file_id, file_path: payload.file_id },
                        }));
                        return;
                    }

                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true, result: { message_id: 6666 } }));
                });
            });

            await new Promise((resolve) => botApiServer.listen(0, resolve));
            const apiPort = botApiServer.address().port;

            try {
                const bot = createBot("123:MOCK_TOKEN", {
                    forwardDebounceMs: 50,
                    telegram: { telegram: { apiRoot: `http://127.0.0.1:${apiPort}` } },
                });

                // Forward Zip 1
                await bot.handleUpdate({
                    update_id: 30,
                    message: {
                        message_id: 301,
                        chat: { id: chatId, type: "private" },
                        from: { id: chatId, is_bot: false },
                        document: { file_id: "zip_id_1", file_name: "cluster_nodeA.zip", file_size: bufA.length },
                        forward_date: 1700000030,
                    },
                });

                // Forward Zip 2 (within 50ms debounce)
                await bot.handleUpdate({
                    update_id: 31,
                    message: {
                        message_id: 302,
                        chat: { id: chatId, type: "private" },
                        from: { id: chatId, is_bot: false },
                        document: { file_id: "zip_id_2", file_name: "cluster_nodeB.zip", file_size: bufB.length },
                        forward_date: 1700000031,
                    },
                });

                // Wait for bot to combine and edit message
                let finalEdit = null;
                for (let i = 0; i < 40; i++) {
                    finalEdit = botCalls.find(
                        (c) => c.method === "editMessageText" && c.p.text && c.p.text.includes("MERGED ZIP PIPELINE")
                    );
                    if (finalEdit) break;
                    await new Promise((r) => setTimeout(r, 50));
                }

                assert.ok(finalEdit, "Must reply with MERGED ZIP PIPELINE report");
                const text = finalEdit.p.text;
                assert.ok(text.includes("cluster_nodeA.zip"));
                assert.ok(text.includes("cluster_nodeB.zip"));
                assert.ok(text.includes(".zip"), "Filename must end in .zip");

                // Check button
                const buttons = finalEdit.p.reply_markup.inline_keyboard.flat();
                const zipDlBtn = buttons.find((b) => b.text.includes("Direct Download") && b.url);
                assert.ok(zipDlBtn, "Must provide direct download link button for merged zip");
                assert.ok(zipDlBtn.url.startsWith("http://127.0.0.1:9099/download/"));

                // Download the merged zip using handleDownloadRequest
                const token = zipDlBtn.url.split("/").pop();
                const entry = downloads.getDownload(token);
                assert.ok(entry, "Entry must exist in download registry");
                assert.equal(entry.mimeType, "application/zip");

                // Validate downloaded zip content directly from buffer
                const downloadedZip = new AdmZip(entry.buffer);
                const downloadedFiles = downloadedZip.getEntries().map((e) => e.entryName);
                assert.ok(downloadedFiles.includes("auth.log"), "Merged zip must contain auth.log");
                assert.ok(downloadedFiles.includes("daemon.log"), "Merged zip must contain daemon.log");
                assert.equal(downloadedZip.getEntry("auth.log").getData().toString(), "Apr 10 auth success");
                assert.equal(downloadedZip.getEntry("daemon.log").getData().toString(), "Apr 10 daemon started");
            } finally {
                botApiServer.close();
            }
        });

        test("/mergezip command shows usage instructions when called without arguments", async () => {
            const chatId = 700202;
            const botCalls = [];
            const botApiServer = http.createServer((req, res) => {
                let body = "";
                req.on("data", (chunk) => { body += chunk; });
                req.on("end", () => {
                    const method = req.url.split("/").pop();
                    let payload = {};
                    try { payload = JSON.parse(body); } catch (_) {}
                    botCalls.push({ method, p: payload });
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: true, result: { message_id: 402 } }));
                });
            });
            await new Promise((resolve) => botApiServer.listen(0, resolve));
            const apiPort = botApiServer.address().port;

            try {
                const bot = createBot("123:MOCK_TOKEN", {
                    botUsername: "testbot",
                    telegram: { telegram: { apiRoot: `http://127.0.0.1:${apiPort}` } },
                });

                await bot.handleUpdate({
                    update_id: 40,
                    message: {
                        message_id: 401,
                        chat: { id: chatId, type: "private" },
                        from: { id: chatId, is_bot: false },
                        text: "/mergezip",
                        entities: [{ type: "bot_command", offset: 0, length: 9 }],
                    },
                });

                const reply = botCalls.find((c) => c.method === "sendMessage");
                assert.ok(reply && reply.p.text.includes("ZIP MERGER PIPELINE"));
                assert.ok(reply.p.text.includes("/mergezip &lt;url1&gt; &lt;url2&gt;") || reply.p.text.includes("/mergezip"));
            } finally {
                botApiServer.close();
            }
        });
    });

    after(() => {
        getSharedPool().close();
    });
});
