const assert = require('assert');
const L = require('../js/layout.js');

function noOverlap(slots) {
  for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) {
    const a = slots[i], b = slots[j];
    const sep = a.x + a.w <= b.x + 1e-6 || b.x + b.w <= a.x + 1e-6 || a.y + a.h <= b.y + 1e-6 || b.y + b.h <= a.y + 1e-6;
    if (!sep) return false;
  }
  return true;
}
function inside(slots, m) {
  return slots.every((s) => s.x >= m - 1e-6 && s.y >= m - 1e-6 && s.x + s.w <= 210 - m + 1e-6 && s.y + s.h <= 297 - m + 1e-6);
}

const cases = [[50, 75], [60, 90], [65, 90], [70, 100], [90, 130], [100, 150], [54, 86]];
for (const [w, h] of cases) for (const mixed of [false, true]) for (const [m, g] of [[5, 2], [0, 0], [8, 3]]) {
  const r = L.pack({ margin: m, gap: g, slotW: w, slotH: h, allowMixed: mixed });
  assert.ok(r.capacity > 0, `capacity ${w}x${h}`);
  assert.ok(noOverlap(r.slots), `overlap ${w}x${h} mixed=${mixed}`);
  assert.ok(inside(r.slots, m), `outside ${w}x${h} mixed=${mixed}`);
  if (mixed) {
    const plain = L.pack({ margin: m, gap: g, slotW: w, slotH: h, allowMixed: false });
    assert.ok(r.capacity >= plain.capacity);
  }
}
// Known values
assert.strictEqual(L.pack({ margin: 5, gap: 2, slotW: 65, slotH: 90, allowMixed: true }).capacity, 9);
const small = L.pack({ margin: 5, gap: 2, slotW: 50, slotH: 75, allowMixed: true });
assert.ok(small.capacity >= 11, 'mixed packing should beat 10 for 5x7.5: ' + small.capacity);

for (const n of L.COUNT_OPTIONS) {
  const s = L.sizeForCount(n, 1.4, 5, 2, true);
  const r = L.pack({ margin: 5, gap: 2, slotW: s.w, slotH: s.h, allowMixed: true });
  assert.ok(r.capacity >= n, `count ${n} -> ${r.capacity}`);
}
console.log('layout tests passed');
