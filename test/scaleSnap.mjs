// Headless validation of the scale-resolution logic (js/scaleSnap.js), incl. the
// AUDIT #3 fix: a restored scaleU must be kept verbatim, never re-snapped.
//
// ÉCHELLE ABSOLUE (portage 4437135) : scaleU est une taille de tuile en MM ;
// le snap cylindrique raisonne en longueur d'arc (aspectU × C) / mm = entier.

import assert from 'node:assert/strict';
import { resolveScaleU, snapScaleUForSeamlessWrap, MODE_CYLINDRICAL,
         SCALE_MM_INPUT_MIN, SCALE_MM_INPUT_MAX } from '../js/scaleSnap.js';

let passed = 0;
function test(name, fn) {
  try { fn(); console.error(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const MODE_TRIPLANAR = 5;
const C = 100; // circonférence de test (mm)
const cyl = (over) => ({
  mappingMode: MODE_CYLINDRICAL, snapSeamlessWrap: true, suppressSnap: false,
  aspectU: 1, circumferenceMm: C, ...over,
});

// ── snap math (en mm d'arc) ──────────────────────────────────────────────────
test('snap: arrondit à (aspectU·C) / nombre-entier-de-tuiles', () => {
  // C=100, mm=40 → tuiles = round(100/40) = round(2.5) = 3 → 100/3 = 33.3333
  assert.equal(snapScaleUForSeamlessWrap(40, 1, C), 33.3333);
});

test('snap: aspect non carré entre dans la longueur d\'arc', () => {
  // aspectU 2 → arc utile 200 ; mm=40 → tuiles = 5 → 200/5 = 40 (déjà seamless)
  assert.equal(snapScaleUForSeamlessWrap(40, 2, C), 40);
});

test('snap: plafonné à maxTiles', () => {
  // mm minuscule → n explose → clamp 20 tuiles → 100/20 = 5
  assert.equal(snapScaleUForSeamlessWrap(0.5, 1, C), 5);
});

// ── resolveScaleU: clamp (bornes de saisie mm) ───────────────────────────────
test(`resolve: clamps to [${SCALE_MM_INPUT_MIN}, ${SCALE_MM_INPUT_MAX}] mm`, () => {
  assert.equal(resolveScaleU(99999, cyl({ snapSeamlessWrap: false })), SCALE_MM_INPUT_MAX);
  assert.equal(resolveScaleU(0, cyl({ snapSeamlessWrap: false })), SCALE_MM_INPUT_MIN);
});

// ── resolveScaleU: when does it snap? ────────────────────────────────────────
test('resolve: cylindrical + snap on + not restoring -> SNAPPED', () => {
  assert.equal(resolveScaleU(40, cyl()), 33.3333);
});

test('resolve: cylindrical but RESTORING -> verbatim (AUDIT #3 fix)', () => {
  assert.equal(resolveScaleU(40, cyl({ suppressSnap: true })), 40);
});

test('resolve: triplanar -> verbatim (snap is cylindrical-only)', () => {
  assert.equal(resolveScaleU(40, cyl({ mappingMode: MODE_TRIPLANAR })), 40);
});

test('resolve: snap disabled -> verbatim', () => {
  assert.equal(resolveScaleU(40, cyl({ snapSeamlessWrap: false })), 40);
});

console.error(`\nscaleSnap: ${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
