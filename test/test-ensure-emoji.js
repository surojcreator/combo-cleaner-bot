const assert = require('assert');
const {
    ensureAnimatedEmojis,
    registerCustomEmojis,
    clearCustomEmojis,
    DEFAULT_CUSTOM_ANIMATED_EMOJIS,
} = require('../src/messages');

// Register real-looking IDs the same way a userbot /emojis sync would.
clearCustomEmojis();
registerCustomEmojis(DEFAULT_CUSTOM_ANIMATED_EMOJIS);

const t1 = ensureAnimatedEmojis('📥 <b>SAVE MODE ACTIVE</b> ⚡️');
console.log('Test 1:', t1);
assert.ok(t1.includes('<tg-emoji'), 'Expected tg-emoji in t1');

const t2 = ensureAnimatedEmojis('Already animated: <tg-emoji emoji-id="123">🚀</tg-emoji> and bare: 💎');
console.log('Test 2:', t2);
assert.ok(t2.includes('<tg-emoji emoji-id="123">🚀</tg-emoji>'), 'Expected existing tg-emoji preserved in t2');
assert.ok(t2.includes('emoji-id="5368324170671202286"'), 'Expected diamond converted to animated emoji in t2');

// Unsupported emoji stays as unicode (no longer stripped — looks broken otherwise).
const t3 = ensureAnimatedEmojis('Text with 🫥 unsupported');
console.log('Test 3 (unsupported emoji kept as unicode):', t3);
assert.ok(t3.includes('🫥'), 'Expected unsupported emoji kept as unicode in t3');
assert.ok(!t3.includes('tg-emoji') || !/<tg-emoji[^>]*>🫥<\/tg-emoji>/.test(t3), 'Expected unsupported emoji not wrapped');

const t4 = ensureAnimatedEmojis('⏳ Merging ⏱️ 5s 1️⃣ Step Next ▶️');
console.log('Test 4 (symbols and keycaps):', t4);
assert.ok(t4.includes('emoji-id="5371077759080598822"'), 'Expected hourglass converted in t4');
assert.ok(t4.includes('emoji-id="5371077759080598848"'), 'Expected stopwatch converted in t4');
assert.ok(t4.includes('emoji-id="5371077759080598856"'), 'Expected keycap 1 converted in t4');
assert.ok(t4.includes('emoji-id="5371077759080598874"'), 'Expected next arrow converted in t4');

const t5 = ensureAnimatedEmojis('<code>[▰▰▰▰▱▱▱▱▱▱] 40%</code>\n├── [████░░░░] 50%\n└── ◀ Back ▶ Next ↩ Return');
console.log('Test 5 (gauges, trees, arrows):', t5);
assert.ok(t5.includes('[▰▰▰▰▱▱▱▱▱▱]'), 'Expected progress bar [▰▰▰▰▱▱▱▱▱▱] preserved');
assert.ok(t5.includes('├── [████░░░░]'), 'Expected tree characters and block gauge preserved');
assert.ok(t5.includes('└──'), 'Expected corner tree character preserved');
assert.ok(t5.includes('emoji-id="5371077759080598874"'), 'Expected arrow converted');

// Empty registry: bare unicode is preserved, no fake IDs injected.
clearCustomEmojis();
const t6 = ensureAnimatedEmojis('🚀 launch 💎');
assert.equal(t6, '🚀 launch 💎');
console.log('Test 6 (empty registry keeps unicode):', t6);


