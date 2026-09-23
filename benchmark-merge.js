const fs = require("fs");
const path = require("path");
const os = require("os");
const { createBot } = require("./src/bot");

async function run() {
    const tmpDir = path.join(os.tmpdir(), `merge_bench_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const f1 = path.join(tmpDir, "f1.txt");
    const f2 = path.join(tmpDir, "f2.txt");

    console.log("Generating test files (100k lines each)...");
    const l1 = [];
    const l2 = [];
    for (let i = 0; i < 100000; i++) {
        l1.push(`user_${i}@example.com:password_${i} | IP: 1.2.3.4`);
        l2.push(`user_${i + 50000}@example.com:password_${i + 50000} [Chrome]`);
    }
    fs.writeFileSync(f1, l1.join("\n"));
    fs.writeFileSync(f2, l2.join("\n"));

    const bot = createBot("fake-token", {
        localProcessedRoot: path.join(tmpDir, "processed"),
        localRawRoot: tmpDir,
    });

    const ctx = {
        chat: { id: 12345 },
        answerCbQuery: async () => {},
    };

    console.log("Starting mergeFilesOnServer benchmark...");
    const t0 = Date.now();
    const stats = await bot.mergeFilesOnServer(ctx, [f1, f2]);
    const duration = Date.now() - t0;

    console.log(`Merged 200,000 lines in ${duration}ms (${Math.round(200000 / (duration / 1000))} lines/sec)`);
    console.log("Stats:", stats);

    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
