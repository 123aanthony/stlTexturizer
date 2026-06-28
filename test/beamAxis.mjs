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

console.error(`\nbeamAxis: ${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
