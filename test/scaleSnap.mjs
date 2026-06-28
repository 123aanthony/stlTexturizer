// Headless validation of the scale-resolution logic (js/scaleSnap.js), incl. the
// AUDIT #3 fix: a restored scaleU must be kept verbatim, never re-snapped.

import assert from 'node:assert/strict';
import { resolveScaleU, snapScaleUForSeamlessWrap, MODE_CYLINDRICAL } from '../js/scaleSnap.js';

let passed = 0;
function test(name, fn) {
  try { fn(); console.error(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const MODE_TRIPLANAR = 5;
const cyl = (over) => ({ mappingMode: MODE_CYLINDRICAL, snapSeamlessWrap: true, suppressSnap: false, aspectU: 1, ...over });

// ── snap math ────────────────────────────────────────────────────────────────
test('snap: rounds to aspectU / nearest-integer-tile-count', () => {
  // aspectU 1, scaleU 0.4 -> tiles = round(1/0.4)=round(2.5)=3 -> 1/3
  assert.equal(snapScaleUForSeamlessWrap(0.4, 1), 0.3333);
});

// ── resolveScaleU: clamp ─────────────────────────────────────────────────────
test('resolve: clamps to [0.01, 10]', () => {
  assert.equal(resolveScaleU(99, cyl({ snapSeamlessWrap: false })), 10);
  assert.equal(resolveScaleU(0, cyl({ snapSeamlessWrap: false })), 0.01);
});

// ── resolveScaleU: when does it snap? ────────────────────────────────────────
test('resolve: cylindrical + snap on + not restoring -> SNAPPED', () => {
  assert.equal(resolveScaleU(0.4, cyl()), 0.3333);
});

test('resolve: cylindrical but RESTORING -> verbatim (AUDIT #3 fix)', () => {
  assert.equal(resolveScaleU(0.4, cyl({ suppressSnap: true })), 0.4);
});

test('resolve: triplanar -> verbatim (snap is cylindrical-only)', () => {
  assert.equal(resolveScaleU(0.4, cyl({ mappingMode: MODE_TRIPLANAR })), 0.4);
});

test('resolve: snap disabled -> verbatim', () => {
  assert.equal(resolveScaleU(0.4, cyl({ snapSeamlessWrap: false })), 0.4);
});

console.error(`\nscaleSnap: ${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
