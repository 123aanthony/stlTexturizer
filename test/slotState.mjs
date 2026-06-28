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
  GLOBAL_EXPORT_QUALITY_KEYS,
  pickGlobalQuality,
  stripGlobalQuality,
  withGlobalQuality,
  serializeSlotFaces,
  restoreSlotFaces,
  resolveSlotState,
  stateHasContent,
  stateFaceCount,
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

// ── Per-slot vs global settings split ────────────────────────────────────────
// Sample with a per-slot setting + all global-quality keys defined.
const fullSettings = () => ({
  amplitude: 1.5, scaleU: 2,                 // per-slot
  ...Object.fromEntries(GLOBAL_EXPORT_QUALITY_KEYS.map((k, i) => [k, i + 1])),
});

test('split: pick returns exactly the global keys', () => {
  const picked = pickGlobalQuality(fullSettings());
  assert.deepEqual(Object.keys(picked).sort(), [...GLOBAL_EXPORT_QUALITY_KEYS].sort());
});

test('split: strip removes global keys, keeps per-slot keys', () => {
  const stripped = stripGlobalQuality(fullSettings());
  assert.deepEqual(Object.keys(stripped).sort(), ['amplitude', 'scaleU']);
});

test('split: per-slot settings survive a save (strip) -> restore (with) round-trip', () => {
  const full = fullSettings();
  const savedSlot = stripGlobalQuality({ ...full });        // what gets stored per slot
  const restored = withGlobalQuality(savedSlot, full);      // restored under current global
  assert.deepEqual(restored, full);
});

test('split: switching slots keeps the CURRENT global quality, not the saved one', () => {
  // Slot was saved long ago with refineLength 3; the live global is now 5.
  const staleSlot = { amplitude: 1.0, refineLength: 3 };
  const liveGlobal = { ...fullSettings(), refineLength: 5 };
  const restored = withGlobalQuality(staleSlot, liveGlobal);
  assert.equal(restored.refineLength, 5);  // global wins — no stale-quality leak
  assert.equal(restored.amplitude, 1.0);   // per-slot preserved
});

// ── Project save/load: face-selection round-trip ─────────────────────────────
// Automates the manual "save project -> reload -> selections come back" check.
test('project: serialize -> restore preserves selections (same geometry)', () => {
  const slot = { excludedFaces: new Set([0, 2]), assignedFaces: new Set([0, 2]) };
  const saved = serializeSlotFaces(slot, geo());
  const restored = restoreSlotFaces(saved, geo());
  assert.deepEqual(set(restored.excludedFaces), [0, 2]);
  assert.deepEqual(set(restored.assignedFaces), [0, 2]);
});

test('project: assignedFaces survive mesh re-indexing; excludedFaces stay raw indices', () => {
  const slot = { excludedFaces: new Set([0, 2]), assignedFaces: new Set([0, 2]) };
  const saved = serializeSlotFaces(slot, geo());

  const perm = [2, 0, 3, 1];                          // newIdx i holds old TRIS[perm[i]]
  const reindexed = geoFromTris(perm.map(i => TRIS[i]));
  const restored = restoreSlotFaces(saved, reindexed);

  // assignedFaces use signatures -> remap to where T0/T2 now live (new idx 1/0).
  assert.deepEqual(set(restored.assignedFaces), [0, 1]);
  // excludedFaces are index-based (UI faces) -> not remapped.
  assert.deepEqual(set(restored.excludedFaces), [0, 2]);
});

// ── Single source of truth: resolveSlotState (audit #4) ──────────────────────
const MAP = { name: 'preset' };

test('resolve: active slot reads the LIVE globals, not its stale stored fields', () => {
  // User just cleared the painted faces: live global is empty, slot field stale.
  const slot = { id: 's1', excludedFaces: new Set([1, 2, 3]), assignedFaces: new Set([1, 2, 3]) };
  const live = { activeMapEntry: null, excludedFaces: new Set(), assignedFaces: new Set(), selectionMode: false };
  const st = resolveSlotState(slot, true, live);
  assert.equal(st.excludedFaces.size, 0, 'live empty wins over stale stored');
  assert.equal(stateHasContent(st), false);
  assert.equal(stateFaceCount(st), 0);
});

test('resolve: non-active slot reads its stored fields', () => {
  const slot = { id: 's2', activeMapEntry: MAP, excludedFaces: new Set([4]), assignedFaces: new Set([4, 5]) };
  const st = resolveSlotState(slot, false, { excludedFaces: new Set([9, 9, 9]) });
  assert.equal(st.activeMapEntry, MAP);
  assert.deepEqual(set(st.assignedFaces), [4, 5]);  // ignores live globals
  assert.equal(stateFaceCount(st), 2);              // assigned wins over excluded
  assert.equal(stateHasContent(st), true);
});

test('resolve: active slot with a live map but no faces has content', () => {
  const slot = { id: 's1' };
  const live = { activeMapEntry: MAP, excludedFaces: new Set(), assignedFaces: new Set(), selectionMode: true };
  const st = resolveSlotState(slot, true, live);
  assert.equal(stateHasContent(st), true);
  assert.equal(st.selectionMode, true);
});

test('resolve: null slot is empty, not a throw', () => {
  const st = resolveSlotState(null, false, {});
  assert.equal(stateHasContent(st), false);
  assert.equal(stateFaceCount(st), 0);
});

console.error(`\nslotState: ${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
