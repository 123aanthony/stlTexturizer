// Characterization tests for js/slotState.js — the pure slot-state data core.
// The headline case is the save/load ROUND-TRIP: a face selection must survive
// being serialized to signatures and restored, even when the mesh is re-indexed
// (triangle order changes) on reload. That round-trip is the whole reason
// signatures exist, and pinning it is what makes the main.js extraction safe.

import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  normalizeFaceIndexArray,
  computeAssignedFaces,
  buildFaceSignatures,
  restoreFacesFromSignatures,
} from '../js/slotState.js';

let passed = 0;
function test(name, fn) {
  try { fn(); console.error(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const set = (s) => [...s].sort((a, b) => a - b);

// 4 well-separated triangles with distinct centroids → nearest-match is unambiguous.
const TRIS = [
  [[10, 0, 0], [10, 1, 0], [10, 0, 1]],   // T0 near +X
  [[0, 10, 0], [1, 10, 0], [0, 10, 1]],   // T1 near +Y
  [[0, 0, 10], [1, 0, 10], [0, 1, 10]],   // T2 near +Z
  [[-10, 0, 0], [-10, 1, 0], [-10, 0, 1]], // T3 near -X
];
function geoFromTris(tris) {
  const pos = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => {
    for (let v = 0; v < 3; v++) {
      pos[i * 9 + v * 3]     = t[v][0];
      pos[i * 9 + v * 3 + 1] = t[v][1];
      pos[i * 9 + v * 3 + 2] = t[v][2];
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return g;
}
const geo = () => geoFromTris(TRIS);

// ── normalizeFaceIndexArray ──────────────────────────────────────────────────
test('normalize: drops non-integer and out-of-range', () => {
  assert.deepEqual(normalizeFaceIndexArray([0, 2.5, 3, -1, 99, 'x'], 4), [0, 3]);
});
test('normalize: non-array -> empty', () => {
  assert.deepEqual(normalizeFaceIndexArray(null, 4), []);
});

// ── computeAssignedFaces ─────────────────────────────────────────────────────
test('assigned: include mode = painted set (range-filtered)', () => {
  assert.deepEqual(set(computeAssignedFaces(geo(), [1, 3, 99], true)), [1, 3]);
});
test('assigned: exclude mode = complement of painted', () => {
  assert.deepEqual(set(computeAssignedFaces(geo(), [1], false)), [0, 2, 3]);
});
test('assigned: no geometry = painted passthrough', () => {
  assert.deepEqual(set(computeAssignedFaces(null, [2, 0], true)), [0, 2]);
});

// ── ROUND-TRIP (the safety-critical one) ─────────────────────────────────────
test('round-trip: signatures restore to the same faces (same geometry)', () => {
  const faces = new Set([0, 2]);
  const sigs = buildFaceSignatures(faces, geo());
  const restored = restoreFacesFromSignatures(sigs, [], geo());
  assert.deepEqual(set(restored), [0, 2]);
});

test('round-trip: survives mesh re-indexing (triangle reorder)', () => {
  const faces = new Set([0, 2]);                 // physical T0 and T2
  const sigs = buildFaceSignatures(faces, geo());

  // Reload with triangles in a different order: new index -> old triangle.
  const perm = [2, 0, 3, 1];                     // newIdx i holds old TRIS[perm[i]]
  const reindexed = geoFromTris(perm.map(i => TRIS[i]));
  const restored = restoreFacesFromSignatures(sigs, [], reindexed);

  // T0 now sits at new index 1, T2 at new index 0.
  assert.deepEqual(set(restored), [0, 1]);
});

test('round-trip: empty signatures fall back to provided indices', () => {
  const restored = restoreFacesFromSignatures([], [1, 3], geo());
  assert.deepEqual(set(restored), [1, 3]);
});

console.error(`\nslotState: ${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
