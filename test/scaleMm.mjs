// Échelle ABSOLUE en mm (portage amont 4437135) : settings.scaleU/scaleV sont
// la taille physique d'une répétition de texture. Vérifie les longueurs de
// référence par mode et la sémantique bout-en-bout de computeUV : une tuile de
// T mm couvre EXACTEMENT T mm de surface, quel que soit le mode et le modèle.

import assert from 'node:assert/strict';
import { computeUV, getScaleReferenceLengths, scaleMmToRelative,
         MODE_PLANAR_XY, MODE_TRIPLANAR, MODE_CYLINDRICAL, MODE_SPHERICAL } from '../js/mapping.js';

let passed = 0;
function test(name, fn) {
  try { fn(); console.error(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const mkBounds = (sx, sy, sz) => ({
  min: { x: 0, y: 0, z: 0 }, max: { x: sx, y: sy, z: sz },
  size: { x: sx, y: sy, z: sz }, center: { x: sx / 2, y: sy / 2, z: sz / 2 },
});

test('références : planaire/triplanaire = plus grande arête bbox', () => {
  const r = getScaleReferenceLengths(MODE_TRIPLANAR, {}, mkBounds(80, 40, 20));
  assert.equal(r.refU, 80); assert.equal(r.refV, 80);
});

test('références : cylindrique = circonférence (rayon réglé ou AABB)', () => {
  const b = mkBounds(40, 40, 100);
  const auto = getScaleReferenceLengths(MODE_CYLINDRICAL, {}, b);
  assert.ok(Math.abs(auto.refU - 2 * Math.PI * 20) < 1e-9, `auto=${auto.refU}`);
  const fixed = getScaleReferenceLengths(MODE_CYLINDRICAL, { cylinderRadius: 10 }, b);
  assert.ok(Math.abs(fixed.refU - 2 * Math.PI * 10) < 1e-9, `fixed=${fixed.refU}`);
});

test('références : sphérique = arc équateur (U) et méridien (V)', () => {
  const r = getScaleReferenceLengths(MODE_SPHERICAL, {}, mkBounds(60, 60, 60));
  assert.ok(Math.abs(r.refU - 2 * Math.PI * 30) < 1e-9);
  assert.ok(Math.abs(r.refV - Math.PI * 30) < 1e-9);
});

test('scaleMmToRelative : mm / référence, plancher anti-zéro', () => {
  const rel = scaleMmToRelative(MODE_TRIPLANAR, { scaleU: 20, scaleV: 40 }, mkBounds(80, 10, 10));
  assert.equal(rel.u, 0.25); assert.equal(rel.v, 0.5);
  const z = scaleMmToRelative(MODE_TRIPLANAR, { scaleU: 0, scaleV: -3 }, mkBounds(80, 10, 10));
  assert.ok(z.u > 0 && z.v > 0);
});

test('computeUV bout-en-bout : une tuile de T mm couvre T mm (2 modèles ≠)', () => {
  const st = { scaleU: 25.4, scaleV: 25.4, offsetU: 0, offsetV: 0 };
  const n = { x: 0, y: 0, z: 1 };
  for (const b of [mkBounds(100, 100, 10), mkBounds(37, 240, 15)]) {
    const a = computeUV({ x: 0, y: 0, z: 10 }, n, MODE_PLANAR_XY, st, b);
    const c = computeUV({ x: 25.4, y: 0, z: 10 }, n, MODE_PLANAR_XY, st, b);
    const du = c.u - a.u + (c.u < a.u ? 1 : 0);          // fract wrap
    assert.ok(Math.abs(du - 1) < 1e-6 || Math.abs(du) < 1e-6,
      `25,4 mm doivent couvrir exactement 1 tuile : Δu=${du} (modèle ${b.size.x}×${b.size.y})`);
  }
});

test('computeUV : la même valeur mm rend PAREIL sur deux modèles différents', () => {
  const st = { scaleU: 10, scaleV: 10, offsetU: 0, offsetV: 0 };
  const n = { x: 0, y: 0, z: 1 };
  const uv1 = computeUV({ x: 7, y: 3, z: 10 }, n, MODE_PLANAR_XY, st, mkBounds(50, 50, 10));
  const uv2 = computeUV({ x: 7, y: 3, z: 10 }, n, MODE_PLANAR_XY, st, mkBounds(300, 300, 30));
  assert.ok(Math.abs(uv1.u - uv2.u) < 1e-9 && Math.abs(uv1.v - uv2.v) < 1e-9,
    `ancrage monde attendu : ${JSON.stringify(uv1)} vs ${JSON.stringify(uv2)}`);
});

console.error(`\nscaleMm: ${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
