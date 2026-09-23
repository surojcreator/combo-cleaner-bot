const assert = require('assert');
const { ensureAnimatedEmojis } = require('../src/messages');

const t1 = ensureAnimatedEmojis('📥 <b>SAVE MODE ACTIVE</b> ⚡️');
console.log('Test 1:', t1);
assert.ok(t1.includes('<tg-emoji'), 'Expected tg-emoji in t1');

const t2 = ensureAnimatedEmojis('Already animated: <tg-emoji emoji-id="123">🚀</tg-emoji> and bare: 💎');
console.log('Test 2:', t2);
assert.ok(t2.includes('<tg-emoji emoji-id="123">🚀</tg-emoji>'), 'Expected existing tg-emoji preserved in t2');
assert.ok(t2.includes('emoji-id="5368324170671202286"'), 'Expected diamond converted to animated emoji in t2');

const t3 = ensureAnimatedEmojis('Text with 🫥 unsupported');
console.log('Test 3 (unsupported emoji):', t3);
assert.ok(!t3.includes('🫥'), 'Expected unsupported emoji removed from t3');

const t4 = ensureAnimatedEmojis('⏳ Merging ⏱️ 5s 1️⃣ Step Next ▶️');
console.log('Test 4 (symbols and keycaps):', t4);
assert.ok(t4.includes('emoji-id="5371077759080598822"'), 'Expected hourglass converted in t4');
assert.ok(t4.includes('emoji-id="5371077759080598848"'), 'Expected stopwatch converted in t4');
assert.ok(t4.includes('emoji-id="5371077759080598856"'), 'Expected keycap 1 converted in t4');
assert.ok(t4.includes('emoji-id="5371077759080598874"'), 'Expected next arrow converted in t4');

