// Tests for js/faceGroups.js — the FreeCAD BREP-face interop core.
// Headline scenario: FreeCAD re-export (retessellated mesh, nudged geometry) →
// stored face keys re-match the new sidecar and rebuild the selection.

import assert from 'node:assert/strict';
import {
  parseFaceSidecar, facesToTriangleSet, selectionToFaceKeys, matchFaceKeys,
} from '../js/faceGroups.js';

let passed = 0;
function test(name, fn) {
  try { fn(); console.error(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

// A toy "box side" sidecar: 4 faces, contiguous ranges, distinct keys.
const face = (start, count, c, n, area, id) => ({ id, range: [start, count], key: { c, n, area } });
const SIDE = {
  version: 1, units: 'mm', triCount: 20,
  faces: [
    face(0,  4, [0, 0, 5],   [0, 0, 1],  100, 'A.Face1'),   // top
    face(4,  8, [5, 0, 2.5], [1, 0, 0],  50,  'A.Face2'),   // side +X
    face(12, 4, [0, 5, 2.5], [0, 1, 0],  50,  'A.Face3'),   // side +Y
    face(16, 4, [0, 0, 0],   [0, 0, -1], 100, 'A.Face4'),   // bottom
  ],
};

test('parse: valid sidecar passes, wrong triCount rejects', () => {
  assert.equal(parseFaceSidecar(SIDE, 20), SIDE);
  assert.throws(() => parseFaceSidecar(SIDE, 24), /mismatch/);
  assert.throws(() => parseFaceSidecar({ version: 2 }, 20), /unsupported/);
});

test('parse: non-contiguous ranges reject', () => {
  const bad = { ...SIDE, faces: [face(0, 4, [0,0,0], [0,0,1], 1, 'x'), face(6, 14, [1,1,1], [0,0,1], 1, 'y')] };
  assert.throws(() => parseFaceSidecar(bad, 20), /contiguous/);
});

test('facesToTriangleSet: expands ranges', () => {
  const s = facesToTriangleSet([0, 2], SIDE);
  assert.deepEqual([...s].sort((a, b) => a - b), [0, 1, 2, 3, 12, 13, 14, 15]);
});

test('selectionToFaceKeys: majority of a face → its key; strays ignored', () => {
  // Full top face + one stray triangle of side +X (bucket-fill overflow).
  const sel = new Set([0, 1, 2, 3, 4]);
  const { keys, faceIndices } = selectionToFaceKeys(sel, SIDE);
  assert.deepEqual(faceIndices, [0]);
  assert.equal(keys[0].id, 'A.Face1');
});

test('match: identical sidecar → all keys match their own face', () => {
  const { keys } = selectionToFaceKeys(facesToTriangleSet([0, 1], SIDE), SIDE);
  const { matches, orphans } = matchFaceKeys(keys, SIDE);
  assert.equal(orphans.length, 0);
  assert.deepEqual(matches.map(m => m.faceIndex).sort(), [0, 1]);
});

test('match: re-export (retessellated ranges + nudged keys) still matches', () => {
  // Same box after a FreeCAD tweak: finer mesh (ranges differ), keys nudged.
  const SIDE2 = {
    version: 1, triCount: 46,
    faces: [
      face(0, 10,  [0.1, 0, 5.2],   [0, 0, 1],  103, 'A.Face1'),
      face(10, 18, [5.2, 0, 2.6],   [1, 0, 0],  52,  'A.Face2'),
      face(28, 10, [0, 5.1, 2.6],   [0, 1, 0],  51,  'A.Face3'),
      face(38, 8,  [0.1, 0, 0],     [0, 0, -1], 103, 'A.Face4'),
    ],
  };
  const { keys } = selectionToFaceKeys(facesToTriangleSet([0, 2], SIDE), SIDE);
  const { matches, orphans } = matchFaceKeys(keys, SIDE2);
  assert.equal(orphans.length, 0);
  assert.deepEqual(matches.map(m => m.faceIndex).sort(), [0, 2]); // top + side Y again
  // and the new triangle set is the new ranges
  const tris = facesToTriangleSet(matches.map(m => m.faceIndex), SIDE2);
  assert.equal(tris.size, 20); // 10 + 10
});

test('match: a removed face becomes an orphan, not a wrong match', () => {
  const SIDE3 = { version: 1, triCount: 8, faces: [
    face(0, 4, [0, 0, 5],   [0, 0, 1],  100, 'A.Face1'),
    face(4, 4, [0, 0, 0],   [0, 0, -1], 100, 'A.Face4'),
  ] };
  const keys = [
    { c: [0, 0, 5], n: [0, 0, 1], area: 100 },   // still exists
    { c: [5, 0, 2.5], n: [1, 0, 0], area: 50 },  // side face was removed
  ];
  const { matches, orphans } = matchFaceKeys(keys, SIDE3);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].faceIndex, 0);
  assert.equal(orphans.length, 1);
});

test('match: greedy unique — two close keys cannot claim the same face', () => {
  const twin = { version: 1, triCount: 4, faces: [face(0, 4, [0, 0, 5], [0, 0, 1], 100, 'A.Face1')] };
  const keys = [
    { c: [0, 0, 5],   n: [0, 0, 1], area: 100 }, // exact
    { c: [0.2, 0, 5], n: [0, 0, 1], area: 98 },  // near-duplicate
  ];
  const { matches, orphans } = matchFaceKeys(keys, twin);
  assert.equal(matches.length, 1);
  assert.equal(orphans.length, 1);
  assert.deepEqual(matches[0].key.c, [0, 0, 5]); // the better score won
});

test('match: zero mean normal (closed face) matches on centroid+area alone', () => {
  const cyl = { version: 1, triCount: 4, faces: [face(0, 4, [10, 0, 5], [0, 0, 0], 314, 'Cyl.Face1')] };
  const { matches } = matchFaceKeys([{ c: [10, 0, 5.1], n: [0, 0, 0], area: 316 }], cyl);
  assert.equal(matches.length, 1);
});

console.error(`\nfaceGroups: ${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
