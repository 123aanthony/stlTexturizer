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
  computeOverlapFaces,
  countSlotOverlap,
  pickSlotMaterial,
  hasSlotMaterial,
  applySlotMaterial,
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

// ── Slot overlap: what the red tab and the "Show overlaps" highlight share ───
// Both signals read computeOverlapFaces, so a face highlighted red in the
// viewport is by construction a face the badge is complaining about.
const inc = (...faces) => ({ selectionMode: true,  assignedFaces: new Set(faces) });
const exc = (...faces) => ({ selectionMode: false, assignedFaces: new Set(faces) });

test('overlap: only the faces claimed by two Include slots', () => {
  const overlap = computeOverlapFaces([inc(0, 1, 2), inc(2, 3)]);
  assert.deepEqual(set(overlap), [2]);
});

test('overlap: a face claimed by three slots is reported once', () => {
  assert.deepEqual(set(computeOverlapFaces([inc(1), inc(1), inc(1)])), [1]);
});

test('overlap: one slot alone never overlaps itself', () => {
  assert.equal(computeOverlapFaces([inc(0, 1, 2, 3)]).size, 0);
});

test('overlap: Exclude-mode slots are ignored (product decision)', () => {
  // The Exclude slot's material is the whole model minus face 3 — it would
  // contest every face of the Include slot if it took part in the rule.
  const overlap = computeOverlapFaces([inc(0, 1), exc(0, 1, 2)], 4);
  assert.equal(overlap.size, 0, 'no overlap: the Exclude slot does not claim');
});

test('overlap: two Exclude slots claiming the same model are still ignored', () => {
  assert.equal(computeOverlapFaces([exc(0), exc(1)], 4).size, 0);
});

test('overlap: out-of-range faces are filtered by triCount', () => {
  // Stale selection from a bigger model: face 99 must not reach the overlay
  // builder, which would read past the position array.
  assert.deepEqual(set(computeOverlapFaces([inc(1, 99), inc(1, 99)], 4)), [1]);
});

test('overlap: empty / missing input is empty, not a throw', () => {
  assert.equal(computeOverlapFaces(null).size, 0);
  assert.equal(computeOverlapFaces([null, {}, inc()]).size, 0);
});

test('overlap count: per-slot share of the contested faces', () => {
  const a = inc(0, 1, 2);
  const b = inc(2, 3);
  const overlap = computeOverlapFaces([a, b]);
  assert.equal(countSlotOverlap(a, overlap), 1);
  assert.equal(countSlotOverlap(b, overlap), 1);
});

test('overlap count: the bigger-set branch agrees with the smaller-set branch', () => {
  // countSlotOverlap walks whichever set is smaller — both paths must agree.
  const big = inc(...Array.from({ length: 50 }, (_, i) => i));   // 50 faces
  const small = inc(7, 8);
  const overlap = computeOverlapFaces([big, small]);             // {7, 8}
  assert.equal(countSlotOverlap(big, overlap), 2);   // walks overlap (2 < 50)
  assert.equal(countSlotOverlap(small, overlap), 2); // walks assigned (2 <= 2)
});

test('overlap count: an Exclude-mode slot is never flagged', () => {
  const overlap = computeOverlapFaces([inc(0, 1), inc(1)]);
  assert.deepEqual(set(overlap), [1]);
  assert.equal(countSlotOverlap(exc(0, 1), overlap), 0);
});

test('overlap: fed by resolveSlotState, the ACTIVE slot uses its live faces', () => {
  // The user just painted face 5 in the active slot, over slot B's selection:
  // the stored field is stale, only the live globals show the conflict.
  const active = { id: 's1', selectionMode: true, assignedFaces: new Set([0]) };
  const other  = { id: 's2', selectionMode: true, assignedFaces: new Set([5]) };
  const live = { selectionMode: true, assignedFaces: new Set([0, 5]) };
  const states = [resolveSlotState(active, true, live), resolveSlotState(other, false)];
  assert.deepEqual(set(computeOverlapFaces(states)), [5]);
});

// ── Material brush: same material, target keeps its own faces ────────────────
const slotWith = (over = {}) => ({
  id: 'sX', name: 'X',
  activeMapEntry: null, customMapEntry: null,
  excludedFaces: new Set(), assignedFaces: new Set(),
  selectionMode: true, settings: {},
  ...over,
});
const MAP_A = { name: 'stone' };
const MAP_B = { name: 'wood' };

test('brush: the target keeps its faces and its selection mode', () => {
  const src = slotWith({ activeMapEntry: MAP_A, selectionMode: true,
                         excludedFaces: new Set([0]), assignedFaces: new Set([0]),
                         settings: { amplitude: 2, scaleU: 5 } });
  const tgt = slotWith({ id: 'sY', activeMapEntry: MAP_B, selectionMode: false,
                         excludedFaces: new Set([7, 8]), assignedFaces: new Set([9]),
                         settings: { amplitude: 0.1 } });

  applySlotMaterial(tgt, pickSlotMaterial(src));

  assert.equal(tgt.activeMapEntry, MAP_A, 'map copied');
  assert.deepEqual(tgt.settings, { amplitude: 2, scaleU: 5 }, 'settings copied');
  assert.deepEqual(set(tgt.excludedFaces), [7, 8], 'painted faces untouched');
  assert.deepEqual(set(tgt.assignedFaces), [9], 'material faces untouched');
  assert.equal(tgt.selectionMode, false, 'Include/Exclude mode untouched');
  assert.equal(tgt.id, 'sY', 'identity untouched');
  assert.equal(tgt.name, 'X', 'name is not identity here');   // slotWith default
});

test('brush: settings are COPIED, never aliased to the source', () => {
  const src = slotWith({ settings: { amplitude: 2 } });
  const tgt = slotWith({ id: 'sY' });
  applySlotMaterial(tgt, pickSlotMaterial(src));

  src.settings.amplitude = 99;          // keep editing the source afterwards
  assert.equal(tgt.settings.amplitude, 2, 'target keeps the pasted value');
  tgt.settings.scaleU = 3;
  assert.equal(src.settings.scaleU, undefined, 'and does not write back');
});

test('brush: global export-quality keys are not part of a material', () => {
  const src = slotWith({ settings: { amplitude: 2, refineLength: 0.1, maxTriangles: 9 } });
  const mat = pickSlotMaterial(src);
  assert.deepEqual(Object.keys(mat.settings), ['amplitude'], 'quality keys stripped');
  assert.equal(src.settings.refineLength, 0.1, 'the source itself is not mutated');
});

test('brush: pasting twice is idempotent', () => {
  const src = slotWith({ activeMapEntry: MAP_A, settings: { amplitude: 2 } });
  const tgt = slotWith({ id: 'sY', assignedFaces: new Set([4]) });
  applySlotMaterial(tgt, pickSlotMaterial(src));
  const once = { map: tgt.activeMapEntry, settings: { ...tgt.settings }, faces: set(tgt.assignedFaces) };
  applySlotMaterial(tgt, pickSlotMaterial(src));
  assert.equal(tgt.activeMapEntry, once.map);
  assert.deepEqual(tgt.settings, once.settings);
  assert.deepEqual(set(tgt.assignedFaces), once.faces);
});

test('brush: a slot with neither map nor settings has no material to copy', () => {
  assert.equal(hasSlotMaterial(slotWith()), false);
  assert.equal(hasSlotMaterial(slotWith({ assignedFaces: new Set([1, 2]) })), false,
    'faces alone are not a material');
  assert.equal(hasSlotMaterial(slotWith({ activeMapEntry: MAP_A })), true);
  assert.equal(hasSlotMaterial(slotWith({ settings: { amplitude: 1 } })), true);
  assert.equal(hasSlotMaterial(slotWith({ settings: { refineLength: 1 } })), false,
    'global quality alone is not a material');
  assert.equal(hasSlotMaterial(null), false);
});

test('brush: null-safe (missing target or material is a no-op, not a throw)', () => {
  assert.equal(applySlotMaterial(null, pickSlotMaterial(slotWith())), null);
  const tgt = slotWith({ activeMapEntry: MAP_B });
  assert.equal(applySlotMaterial(tgt, null).activeMapEntry, MAP_B);
});

console.error(`\nslotState: ${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
