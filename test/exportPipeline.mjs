// Tests for the decimation watertight/exception guard (js/exportPipeline.js).
// Uses an injectable decimateFn so we can exercise the failure paths without a
// 16M+ triangle mesh: the real-world trigger is the QEM edge-Map exceeding V8's
// ~16.7M entry cap ("Map maximum size exceeded") on huge multi-slot exports.

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { isWatertight, decimateWithGuard } from '../js/exportPipeline.js';

const cases = [];
function test(name, fn) { cases.push([name, fn]); }
let passed = 0;

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

const A = [0, 0, 0], B = [1, 0, 0], C = [0, 1, 0], D = [0, 0, 1];
// Closed tetrahedron — every edge shared by exactly 2 faces.
const tetra = () => geoFromTris([[A, B, C], [A, C, D], [A, D, B], [B, D, C]]);
// Single triangle — all edges open.
const openTri = () => geoFromTris([[A, B, C]]);

// ── isWatertight ─────────────────────────────────────────────────────────────
test('isWatertight: closed tetrahedron -> true', () => {
  assert.equal(isWatertight(tetra()), true);
});
test('isWatertight: single triangle -> false', () => {
  assert.equal(isWatertight(openTri()), false);
});

// ── decimateWithGuard ────────────────────────────────────────────────────────
test('guard: no-op when triCount <= target (decimateFn not called)', async () => {
  const g = tetra();
  let called = false;
  const out = await decimateWithGuard(g, 999, null, () => { called = true; });
  assert.equal(out, g);
  assert.equal(called, false);
});

test('guard: decimation THROWS -> keep original mesh', async () => {
  const g = tetra();
  const out = await decimateWithGuard(g, 2, null, () => {
    throw new Error('Map maximum size exceeded');
  });
  assert.equal(out, g);
});

test('guard: decimation breaks watertightness -> keep original mesh', async () => {
  const g = tetra();                       // watertight input
  const broken = openTri();                // non-watertight result
  const out = await decimateWithGuard(g, 2, null, () => broken);
  assert.equal(out, g);
});

test('guard: successful watertight decimation -> return decimated', async () => {
  const g = tetra();
  const smaller = tetra();                 // still watertight
  const out = await decimateWithGuard(g, 2, null, () => smaller);
  assert.equal(out, smaller);
});

for (const [name, fn] of cases) {
  try { await fn(); console.error(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
console.error(`\nexportPipeline: ${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
