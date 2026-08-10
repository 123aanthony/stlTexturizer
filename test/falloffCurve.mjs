// Courbes de transition du lissage de masque (portage amont v1.2.0 a6ac179) :
// la rampe 0→1 du falloff d'export prend 3 formes — linear (pente constante),
// scurve (smoothstep), ease (t², la plus douce au bord). Vérifie sur le VRAI
// pipeline (subdivide + applyDisplacement, moitié de plaque exclue) que :
//   1. clé absente ≡ 'linear' bit-identique (anciens projets inchangés) ;
//   2. à mi-rampe côté bord, ease < scurve < linear (l'ordre des courbes) ;
//   3. les valeurs collent aux formules (t=0.25 → 0.25 / ~0.156 / 0.0625).

import * as THREE from 'three';
import assert from 'node:assert/strict';
import { runSingle } from './lib/pipeline.mjs';

function whiteTex() {
  const w = 8, h = 8, d = new Uint8ClampedArray(w * h * 4).fill(255);
  return { data: d, width: w, height: h };
}

const FALLOFF = 6;
function plate() {
  return new THREE.BoxGeometry(40, 40, 2, 20, 20, 1).toNonIndexed();
}

// poids d'exclusion par SOMMET : moitié x>0 exclue (frontière à x=0)
function halfWeights(geo) {
  const pos = geo.attributes.position.array;
  const triCount = pos.length / 9;
  const w = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const cx = (pos[t * 9] + pos[t * 9 + 3] + pos[t * 9 + 6]) / 3;
    const v = cx > 0 ? 1 : 0;
    w[t * 3] = w[t * 3 + 1] = w[t * 3 + 2] = v;
  }
  return w;
}

async function displacedTopZ(curveKey) {
  const geo = plate();
  const settings = {
    mappingMode: 5, scaleU: 1, scaleV: 1, offsetU: 0, offsetV: 0, rotation: 0,
    amplitude: 1.0, symmetricDisplacement: false,
    topAngleLimit: 0, bottomAngleLimit: 0,
    mappingBlend: 0, seamBandWidth: 0.35, blendNormalSmoothing: 0,
    boundaryFalloff: FALLOFF, noDownwardZ: false,
  };
  if (curveKey !== undefined) settings.boundaryFalloffCurve = curveKey;
  const d = await runSingle(geo, {
    refineLength: 1.0, settings, texture: whiteTex(), faceWeights: halfWeights(plate()),
  });
  return d.attributes.position.array;
}

// hauteur du dessus (z − 1) au plus près de x cible, côté texturé
function topZAt(arr, xTarget) {
  let best = null, bestDx = Infinity;
  for (let i = 0; i < arr.length; i += 3) {
    const x = arr[i], y = arr[i + 1], z = arr[i + 2];
    if (z < 0.9 || Math.abs(y) > 5) continue;      // dessus seulement, bande centrale
    const dx = Math.abs(x - xTarget);
    if (dx < bestDx) { bestDx = dx; best = z - 1; }
  }
  return best;
}

let passed = 0;
function check(name, fn) {
  try { fn(); console.error(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const [absent, linear, scurve, ease] = await Promise.all([
  displacedTopZ(undefined), displacedTopZ('linear'), displacedTopZ('scurve'), displacedTopZ('ease'),
]);

check('clé absente ≡ linear (bit-identique — anciens projets inchangés)', () => {
  assert.equal(absent.length, linear.length);
  for (let i = 0; i < absent.length; i++) {
    if (absent[i] !== linear[i]) throw new Error(`divergence à l'indice ${i}`);
  }
});

// t = 0.25 → x = −FALLOFF·0.75 ? Non : t = dist/falloff, dist depuis la
// frontière (x=0) côté inclus (x<0) → x = −1.5 donne t = 0.25.
const X = -1.5, T = Math.abs(X) / FALLOFF;
check(`ordre des courbes à t=${T} : ease < scurve < linear`, () => {
  const zl = topZAt(linear, X), zs = topZAt(scurve, X), ze = topZAt(ease, X);
  assert.ok(ze < zs && zs < zl, `ease=${ze}, scurve=${zs}, linear=${zl}`);
});

check('valeurs ≈ formules (tolérance de grille 0.08)', () => {
  const zl = topZAt(linear, X), zs = topZAt(scurve, X), ze = topZAt(ease, X);
  assert.ok(Math.abs(zl - T) < 0.08, `linear ${zl} vs ${T}`);
  assert.ok(Math.abs(zs - T * T * (3 - 2 * T)) < 0.08, `scurve ${zs} vs ${T * T * (3 - 2 * T)}`);
  assert.ok(Math.abs(ze - T * T) < 0.08, `ease ${ze} vs ${T * T}`);
});

check('loin de la frontière, les 3 courbes déplacent à pleine hauteur', () => {
  for (const arr of [linear, scurve, ease]) {
    const z = topZAt(arr, -15);
    assert.ok(Math.abs(z - 1) < 0.05, `z=${z}`);
  }
});

console.error(`\nfalloffCurve: ${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
