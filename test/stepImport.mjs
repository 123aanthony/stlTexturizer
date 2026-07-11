// STEP pipeline (interop v2, vendored meshStep) — real FreeCAD STEP fixtures
// through the REAL js/stepImport.js. Pins: the in-memory sidecar honours the
// v1 contract, part names survive, selections re-match across re-exports, and
// the STEP pipeline shares the SAME key space as the STL+sidecar pipeline.

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { importStepText, tessOptionsForSize } from '../js/stepImport.js';
import {
  parseFaceSidecar, facesToTriangleSet, selectionToFaceKeys, matchFaceKeys,
} from '../js/faceGroups.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'freecad');

let passed = 0;
function test(name, fn) {
  try { fn(); console.error(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

if (!existsSync(join(FIX, 'interop_A.step'))) {
  console.error('stepImport: STEP fixtures missing — run `npm run test:interop:update`');
  process.exit(1);
}

const A = await importStepText(readFileSync(join(FIX, 'interop_A.step'), 'utf8'));
const C = await importStepText(readFileSync(join(FIX, 'interop_C.step'), 'utf8'));

test('tess options: explicit, sane clamps (autoTessellation is broken upstream)', () => {
  const o = tessOptionsForSize(68);
  assert.ok(o.surfaceDeviation > 0 && o.maxEdge > 0);
  assert.equal(tessOptionsForSize(1e6).maxEdge, 10);       // clamped
  assert.equal(tessOptionsForSize(0.1).surfaceDeviation, 0.005);
});

test('in-memory sidecar honours contract v1 (ranges contiguous, keys present)', () => {
  const parsed = parseFaceSidecar(A.sidecar, (A.positions.length / 9) | 0);
  assert.equal(parsed.faces.length, 244, `${parsed.faces.length} BREP faces`);
  assert.equal(A.diagnostics.ok, true);
});

test('FreeCAD part labels survive into face ids and partOfFace', () => {
  assert.ok(A.sidecar.faces.some(f => /Keystone|Pierre/.test(f.id)), A.sidecar.faces[0].id);
  assert.equal(new Set(A.partOfFace).size, 24, '24 named stones');
});

test('selections re-match across a STEP re-export (A → C, H+1mm)', () => {
  const picked = A.sidecar.faces.map((_, i) => i).filter(i => i % 8 === 0);
  const { keys } = selectionToFaceKeys(facesToTriangleSet(picked, A.sidecar), A.sidecar);
  const { matches, orphans } = matchFaceKeys(keys, C.sidecar);
  assert.equal(orphans.length, 0, `${orphans.length} orphans`);
  assert.equal(matches.length, keys.length);
});

test('cross-pipeline: STL-sidecar keys re-match against STEP faces (same key space)', () => {
  const stlSidecar = parseFaceSidecar(
    JSON.parse(readFileSync(join(FIX, 'interop_A.bumpforge-faces.json'), 'utf8')), undefined);
  const picked = stlSidecar.faces.map((_, i) => i).filter(i => i % 8 === 0);
  const { keys } = selectionToFaceKeys(facesToTriangleSet(picked, stlSidecar), stlSidecar);
  const { matches } = matchFaceKeys(keys, A.sidecar);
  const ratio = matches.length / keys.length;
  assert.ok(ratio >= 0.9, `only ${(ratio * 100).toFixed(0)}% matched across pipelines`);
});

test('mesh quality: no slivers (AR>20), tri count sane', () => {
  const P = A.positions, tris = (P.length / 9) | 0;
  let slivers = 0;
  for (let t = 0; t < tris; t++) {
    const o = t * 9;
    const e = (i, j) => Math.hypot(P[o+i*3]-P[o+j*3], P[o+i*3+1]-P[o+j*3+1], P[o+i*3+2]-P[o+j*3+2]);
    const l = [e(0, 1), e(1, 2), e(2, 0)].sort((x, y) => x - y);
    if (l[2] / Math.max(l[0], 1e-12) > 20) slivers++;
  }
  assert.ok(tris > 1000, `${tris} tris`);
  assert.ok(slivers / tris < 0.005, `${slivers}/${tris} slivers`);
});

console.error(`\nstepImport: ${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
