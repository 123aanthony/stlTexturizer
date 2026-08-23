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
  groupFacesByColor,
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

// GUI-exported STEP with real FreeCAD material colors (FW chain arch+frame+door;
// headless exports can't carry colors, so this fixture is a real GUI export).
const COL = await importStepText(readFileSync(join(FIX, 'interop_colored.step'), 'utf8'));

test('GUI colors: palette extracted, faces grouped per color', () => {
  assert.ok(COL.palette && COL.palette.length >= 3, `palette: ${COL.palette?.length}`);
  const groups = groupFacesByColor(COL.colorGroupOfFace, COL.sidecar, COL.partOfFace, 6);
  assert.ok(groups.length >= 3, `${groups.length} groups`);
  // Largest group is the stone arch; groups are named after their dominant part.
  assert.ok(/FW_/.test(groups[0].name), groups[0].name);
  const total = groups.reduce((s, g) => s + g.faceIndices.length, 0);
  assert.ok(total > 200, `${total} faces grouped`);
});

// FW Diorama sentinel: faces painted pure magenta must yield NO colour group,
// so they never get a slot and never get textured. Built by repainting one of
// the fixture's real colours — no new binary fixture needed.
// ⚠ `test()` is SYNCHRONOUS: an async callback would have its failures swallowed
// and print a ✓ regardless, so the import happens here (top-level await, as
// everywhere else in this file) and the assertions stay synchronous.
const COL_RAW = readFileSync(join(FIX, 'interop_colored.step'), 'utf8');
const SENT_SRC = '0.379999991191,0.28999998818,0.209999992975';  // dark-brown frame
const SENT = COL_RAW.includes(SENT_SRC)
  ? await importStepText(COL_RAW.replaceAll(SENT_SRC, '1.,0.,1.'))
  : null;

test('sentinel colour (pure magenta) yields no group and no slot', () => {
  assert.ok(SENT, 'fixture colour present (repaint applied)');
  const idx = COL.palette.findIndex(
    (c) => Math.abs(c[0] - 0.38) < 0.01 && Math.abs(c[2] - 0.21) < 0.01);
  assert.ok(idx >= 0, 'colour is in the palette');
  const nPainted = COL.colorGroupOfFace.filter((g) => g === idx).length;
  assert.ok(nPainted > 0, `${nPainted} faces carry it`);

  const nSentinel = SENT.colorGroupOfFace.filter((g) => g === -1).length;
  assert.strictEqual(nSentinel, nPainted,
    `${nSentinel} sentinel faces vs ${nPainted} repainted`);
  const before = groupFacesByColor(COL.colorGroupOfFace, COL.sidecar,
                                   COL.partOfFace, 16);
  const after = groupFacesByColor(SENT.colorGroupOfFace, SENT.sidecar,
                                  SENT.partOfFace, 16);
  assert.strictEqual(after.length, before.length - 1,
    `${after.length} groups after vs ${before.length} before`);
});


// ── Identite de PIECE : les solides BREP ────────────────────────────────────
// `solidOfTri` etait deja calcule par meshStep puis reduit a un NOM au retour.
// Les trois sources possibles ne se valent pas, et l'ecart est enorme — mesure
// sur interop_colored.step (7546 triangles, 34 solides reels) :
//   composantes connexes ... 557  (sur-segmente 16x : des solides jointifs a
//                                  sommets coincidents se fragmentent)
//   noms de piece .......... 4    (sous-segmente 8.5x : plusieurs solides
//                                  partagent le meme nom dans un compound)
//   solides BREP ........... 34   exact
// D'ou la regle : preferer `solidOfFace`, ne jamais se rabattre sur le nom.
// (COL est deja charge plus haut dans ce fichier — on le reutilise.)

test('solidOfFace est expose et aligne sur les faces', () => {
  assert.ok(Array.isArray(COL.solidOfFace), 'solidOfFace absent du retour');
  assert.equal(COL.solidOfFace.length, COL.sidecar.faces.length,
    'il faut un identifiant de solide par face BREP');
});

test('il distingue PLUS finement que le nom de piece', () => {
  const solides = new Set(COL.solidOfFace).size;
  const noms = new Set(COL.partOfFace).size;
  assert.ok(solides > noms,
    `${solides} solides pour ${noms} noms : le nom ne peut pas servir d'identite`);
});

test("le sidecar PORTE l'identite, donc elle survit a la sauvegarde", () => {
  // Sans ce champ, l'identite serait perdue a la reouverture du projet, et la
  // variation par piece changerait toute seule d'un jour a l'autre.
  for (const f of COL.sidecar.faces) {
    assert.ok(Number.isInteger(f.solid), 'face sans champ `solid` entier');
  }
});

test('les plages de triangles couvrent tout le maillage, sans trou', () => {
  // C'est ce qui permet d'en deduire un identifiant PAR TRIANGLE : une plage
  // manquante laisserait des triangles sans piece.
  let cursor = 0;
  for (const f of COL.sidecar.faces) {
    assert.equal(f.range[0], cursor, 'plage non contigue');
    cursor += f.range[1];
  }
  assert.equal(cursor, COL.sidecar.triCount, 'les plages ne couvrent pas tous les triangles');
});


console.error(`\nstepImport: ${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
