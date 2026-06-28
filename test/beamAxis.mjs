// Validates the PCA beam-axis detection (js/beamAxis.js): the long axis must be
// found regardless of world orientation — that's the whole point vs Wood Auto.

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { computeBeamFrame, orientedRawUV } from '../js/beamAxis.js';

let passed = 0;
function test(name, fn) {
  try { fn(); console.error(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

function beamPositions(angleDeg = 0, axis = 'y') {
  const g = new THREE.BoxGeometry(90, 14, 14, 18, 3, 3);
  if (angleDeg) (axis === 'y' ? g.rotateY : g.rotateZ).call(g, angleDeg * Math.PI / 180);
  return g.toNonIndexed().attributes.position.array;
}
const adot = (a, b) => Math.abs(a[0]*b[0] + a[1]*b[1] + a[2]*b[2]);

test('PCA: straight beam → long axis ≈ world X', () => {
  const f = computeBeamFrame(beamPositions(0));
  assert.ok(adot(f.U, [1, 0, 0]) > 0.99, `U=${f.U}`);
});

test('PCA: beam tilted 35° about Y → long axis follows the tilt', () => {
  const a = 35 * Math.PI / 180;
  const f = computeBeamFrame(beamPositions(35, 'y'));
  assert.ok(adot(f.U, [Math.cos(a), 0, -Math.sin(a)]) > 0.99, `U=${f.U}`);
});

test('PCA: beam tilted 50° about Z → long axis follows the tilt', () => {
  const a = 50 * Math.PI / 180;
  const f = computeBeamFrame(beamPositions(50, 'z'));
  assert.ok(adot(f.U, [Math.cos(a), Math.sin(a), 0]) > 0.99, `U=${f.U}`);
});

test('oriented: rawU increases along the beam axis (any orientation)', () => {
  const f = computeBeamFrame(beamPositions(35, 'y'));
  const c = f.center;
  const p0 = { x: c[0], y: c[1], z: c[2] };
  const p1 = { x: c[0] + f.U[0]*10, y: c[1] + f.U[1]*10, z: c[2] + f.U[2]*10 };
  const n = { x: f.W[0], y: f.W[1], z: f.W[2] }; // a side normal
  assert.ok(orientedRawUV(p1, n, f).rawU > orientedRawUV(p0, n, f).rawU);
});

test('oriented: face normal selects the cross-axis (top face vs side face)', () => {
  // Classification is by the FACE normal. On the export mesh normals are split
  // per-face at sharp edges, so a top-face point (normal ∥ W) and a side-face
  // point (normal ∥ V) map V to DIFFERENT cross-coordinates — that's what makes
  // the grain run lengthwise on every face. (The earlier "normal-independent"
  // guard was wrong: it assumed a fan that was actually a smooth-normal test
  // artefact; the real subdivided mesh has per-face normals.)
  const f = computeBeamFrame(beamPositions(0));
  const c = f.center;
  const p = { // off-axis: distinct V (3) and W (2) offsets so the two branches differ
    x: c[0] + f.V[0]*3 + f.W[0]*2, y: c[1] + f.V[1]*3 + f.W[1]*2, z: c[2] + f.V[2]*3 + f.W[2]*2,
  };
  const nW = { x: f.W[0], y: f.W[1], z: f.W[2] }; // top face  → V follows the V-offset
  const nV = { x: f.V[0], y: f.V[1], z: f.V[2] }; // side face → V follows the W-offset
  assert.notEqual(orientedRawUV(p, nW, f).rawV, orientedRawUV(p, nV, f).rawV);
  // W-normal (top): rawV tracks lvc≈3/md ; V-normal (side): rawV tracks lwc≈2/md
  assert.ok(orientedRawUV(p, nW, f).rawV > orientedRawUV(p, nV, f).rawV);
});

test('PCA masked to a beam inside a larger model → beam axis, not model axis', () => {
  const slab = new THREE.BoxGeometry(40, 146, 8, 1, 1, 1).toNonIndexed();   // model long in Y
  const beam = new THREE.BoxGeometry(60, 10, 10, 1, 1, 1).toNonIndexed();   // beam long in X
  beam.translate(0, 0, 20);
  const sp = slab.attributes.position.array, bp = beam.attributes.position.array;
  const all = new Float32Array(sp.length + bp.length);
  all.set(sp, 0); all.set(bp, sp.length);
  const slabTris = sp.length / 9, beamTris = bp.length / 9;
  const mask = new Uint8Array(slabTris + beamTris);
  for (let t = slabTris; t < slabTris + beamTris; t++) mask[t] = 1; // only the beam

  assert.ok(adot(computeBeamFrame(all).U, [0, 1, 0]) > 0.9, 'whole-model axis should be ~Y');
  assert.ok(adot(computeBeamFrame(all, mask).U, [1, 0, 0]) > 0.9, 'masked axis should be ~X (the beam)');
});

console.error(`\nbeamAxis: ${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
