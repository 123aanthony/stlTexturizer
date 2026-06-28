// Characterization tests for js/slotMasks.js — the pure multi-slot face-mask
// core extracted from main.js. These pin the CURRENT behavior (including the
// "first slot wins on overlap" rule and the angle-masking math) so the rest of
// the main.js refactor can't silently change it.

import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  buildCombinedFaceWeights,
  buildUnionExcludedFacesForSlots,
  buildExclusiveSlotFaceMasks,
} from '../js/slotMasks.js';

// slotMasks keeps debug console.log lines (behavior-preserving extraction);
// silence them so the test output stays readable.
const _log = console.log;
console.log = () => {};

let passed = 0;
function test(name, fn) {
  try { fn(); console.error(`  ✓ ${name}`); passed++; }
  catch (e) { _log.call(console); console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const geoWithTriCount = (n) => ({ attributes: { position: { count: n * 3 } } });

// ── buildUnionExcludedFacesForSlots ──────────────────────────────────────────
test('union: excluded = complement of owned faces', () => {
  const geo = geoWithTriCount(6);
  const slots = [{ assignedFaces: [0, 1] }, { assignedFaces: [2] }];
  const excluded = buildUnionExcludedFacesForSlots(slots, geo);
  assert.deepEqual([...excluded].sort((a, b) => a - b), [3, 4, 5]);
});

test('union: out-of-range and non-integer faces are ignored', () => {
  const geo = geoWithTriCount(3);
  const slots = [{ assignedFaces: [0, 99, -1, 2.5] }];
  const excluded = buildUnionExcludedFacesForSlots(slots, geo);
  assert.deepEqual([...excluded].sort((a, b) => a - b), [1, 2]); // only face 0 owned
});

test('union: no geometry -> empty (triCount 0)', () => {
  const excluded = buildUnionExcludedFacesForSlots([{ assignedFaces: [0] }], null);
  assert.equal(excluded.size, 0);
});

// ── buildExclusiveSlotFaceMasks ──────────────────────────────────────────────
test('exclusive: parent faces expand to subdivided masks', () => {
  const faceParentId = new Int32Array([0, 0, 1, 2, 2, 2]);
  const slots = [{ assignedFaces: [0] }, { assignedFaces: [1, 2] }];
  const { masks, counts } = buildExclusiveSlotFaceMasks(faceParentId, slots);
  assert.deepEqual([...masks[0]], [1, 1, 0, 0, 0, 0]);
  assert.deepEqual([...masks[1]], [0, 0, 1, 1, 1, 1]);
  assert.deepEqual(counts, [2, 4]);
});

test('exclusive: overlap resolved by slot order (first wins)', () => {
  const faceParentId = new Int32Array([1, 1]);
  const slots = [{ assignedFaces: [1] }, { assignedFaces: [1] }];
  const { masks, counts } = buildExclusiveSlotFaceMasks(faceParentId, slots);
  assert.deepEqual([...masks[0]], [1, 1]);
  assert.deepEqual([...masks[1]], [0, 0]);
  assert.deepEqual(counts, [2, 0]);
});

// ── buildCombinedFaceWeights ─────────────────────────────────────────────────
// 2-triangle non-indexed geometry: tri0 faces +Z (flat top), tri1 faces +X (wall).
function twoTriGeo() {
  const pos = new Float32Array([
    0, 0, 0,  1, 0, 0,  0, 1, 0,   // tri0 normal +Z
    0, 0, 0,  0, 1, 0,  0, 0, 1,   // tri1 normal +X
  ]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return g;
}

test('combined: no angle mask -> passthrough of buildFaceWeights', () => {
  const w = buildCombinedFaceWeights(twoTriGeo(), new Set([1]), false,
    { topAngleLimit: 0, bottomAngleLimit: 0 });
  assert.deepEqual([...w], [0, 0, 0, 1, 1, 1]); // only excluded face 1 weighted
});

test('combined: top-angle mask flags the near-horizontal top face only', () => {
  const w = buildCombinedFaceWeights(twoTriGeo(), new Set(), false,
    { topAngleLimit: 30, bottomAngleLimit: 0 });
  assert.deepEqual([...w], [1, 1, 1, 0, 0, 0]); // +Z face masked, +X wall untouched
});

console.log = _log;
console.error(`\nslotMasks: ${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
