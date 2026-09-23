const { getSharedPool } = require("./src/worker-pool");

const lines = [];
for (let i = 0; i < 500000; i++) {
    const mod = i % 10;
    if (mod === 0) lines.push(`user_${i}@gmail.com:Password_${i}!`);
    else if (mod === 1) lines.push(`admin_${i}@company.org:Secret#${i}`);
    else if (mod === 2) lines.push(`john.doe_${i}@yahoo.com:Winter${i}$`);
    else if (mod === 3) lines.push(`https://site_${i}.com/login:user_${i}@mail.com:pass_${i}`);
    else if (mod === 4) lines.push(`user_${i}@outlook.com:pass_${i} | IP: 1.2.3.4`);
    else if (mod === 5) lines.push(`login_id: user_${i} pass: secret_${i}`);
    else if (mod === 6) lines.push(`username_${i}:some_pass_${i}`);
    else if (mod === 7) lines.push(`site_${i}.com:user_${i}:pass_${i}`);
    else if (mod === 8) lines.push(`https://invalid-url-${i}.com/path`);
    else if (mod === 9) lines.push(`user_${i}:pass_${i} [Google Chrome]`);
}

async function run() {
    const pool = getSharedPool();
    pool.warmup();

    // Warmup
    await pool.cleanLinesParallel(lines.slice(0, 10000));

    const start = Date.now();
    const res = await pool.cleanLinesParallel(lines);
    const duration = Date.now() - start;

    console.log(`Parallel cleaned ${lines.length} lines in ${duration}ms (${Math.round(lines.length / (duration / 1000))} lines/sec)`);
    console.log(`Kept: ${res.stats.kept}, Dropped: ${res.stats.dropped}`);
    pool.close();
}

run();
