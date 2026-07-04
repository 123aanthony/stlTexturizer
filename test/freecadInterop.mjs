// Cross-project integration test: REAL FreeCAD exports (FW Diorama
// fw_export_bumpforge, gothic arch, 244 BREP faces) through the REAL BumpForge
// matcher (js/faceGroups.js). This pins the anti-reselection contract:
//   A = reference export ; B = same arch retessellated ; C = param changed (H+1mm)
// Selections anchored on A must re-match on both B and C.
//
// Fixtures are COMMITTED (test/fixtures/freecad/, sidecar JSON only) so this
// runs without FreeCAD. Regenerate after changing the exporter:
//   npm run test:interop:update   (drives FreeCADCmd, needs FreeCAD installed)

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseFaceSidecar, facesToTriangleSet, selectionToFaceKeys, matchFaceKeys,
} from '../js/faceGroups.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'freecad');

let passed = 0;
function test(name, fn) {
  try { fn(); console.error(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

if (!existsSync(join(FIX, 'interop_A.bumpforge-faces.json'))) {
  console.error('freecadInterop: fixtures missing — run `npm run test:interop:update` (needs FreeCAD)');
  process.exit(1);
}

const load = (tag) =>
  parseFaceSidecar(JSON.parse(readFileSync(join(FIX, `interop_${tag}.bumpforge-faces.json`), 'utf8')), undefined);
const A = load('A'), B = load('B'), C = load('C');

// User-style selection: every 8th BREP face across the arch (~30 faces).
const picked = A.faces.map((_, i) => i).filter(i => i % 8 === 0);
const { keys } = selectionToFaceKeys(facesToTriangleSet(picked, A), A);

test('fixtures parse (contract v1) and carry a real arch', () => {
  assert.ok(A.faces.length > 100, `A has ${A.faces.length} faces`);
  assert.equal(keys.length, picked.length, 'selection snapped to all picked faces');
});

test('re-export retessellated (B): every selection re-matches, no orphans', () => {
  const { matches, orphans } = matchFaceKeys(keys, B);
  assert.equal(orphans.length, 0, `${orphans.length} orphans`);
  assert.equal(matches.length, keys.length);
  assert.ok(facesToTriangleSet(matches.map(m => m.faceIndex), B).size > 0);
});

test('re-export with changed parameter (C, H+1mm): selections still re-match', () => {
  const { matches, orphans } = matchFaceKeys(keys, C);
  const ratio = matches.length / keys.length;
  assert.ok(ratio >= 0.85, `only ${(ratio * 100).toFixed(0)}% re-matched (${orphans.length} orphans)`);
});

test('a foreign key (nowhere near the arch) stays an orphan', () => {
  const { matches, orphans } = matchFaceKeys(
    [{ c: [500, 500, 500], n: [0, 0, 1], area: 42 }], B);
  assert.equal(matches.length, 0);
  assert.equal(orphans.length, 1);
});

console.error(`\nfreecadInterop: ${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
