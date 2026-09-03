// AUDIT D'IMPRIMABILITE — invariants.
//
// Ce qui est protege ici, dans l'ordre :
//   1. l'audit doit VOIR les defauts qu'il pretend voir (topologie ouverte,
//      non-manifold, paroi trop mince) ;
//   2. il doit rendre DEUX FOIS LE MEME CHIFFRE — un audit non deterministe ne
//      permet pas de dire si un reglage a ameliore quoi que ce soit ;
//   3. il doit se taire quand tout va bien (un avertissement permanent cesse
//      d'etre lu) ;
//   4. la borne d'amincissement doit MAJORER, jamais minorer : un garde
//      d'imprimabilite qui sous-estime laisse passer la piece qu'il devait
//      arreter.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditEdges, minWallThickness, inwardBudget, greyMinOf, auditReport,
  NOZZLE_MM, COMFORT_MM,
} from '../js/printAudit.js';
import { readBinarySTL } from './lib/stl.mjs';
import { runSingle, baseSettings } from './lib/pipeline.mjs';
import { proceduralTexture } from './lib/texture.mjs';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}
async function checkAsync(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

// ── Maillages d'epreuve ──────────────────────────────────────────────────────
// Une boite pleine, faces orientees VERS L'EXTERIEUR : l'audit d'epaisseur tire
// le long de −n, donc dans la matiere. Une boite mal orientee mesurerait le vide.
function box(sx, sy, sz, ox = 0, oy = 0, oz = 0) {
  const x0 = ox, x1 = ox + sx, y0 = oy, y1 = oy + sy, z0 = oz, z1 = oz + sz;
  const P = {
    a: [x0, y0, z0], b: [x1, y0, z0], c: [x1, y1, z0], d: [x0, y1, z0],
    e: [x0, y0, z1], f: [x1, y0, z1], g: [x1, y1, z1], h: [x0, y1, z1],
  };
  const quads = [
    ['e', 'f', 'g', 'h'],   // +Z
    ['d', 'c', 'b', 'a'],   // -Z
    ['a', 'b', 'f', 'e'],   // -Y
    ['c', 'd', 'h', 'g'],   // +Y
    ['b', 'c', 'g', 'f'],   // +X
    ['d', 'a', 'e', 'h'],   // -X
  ];
  const out = [];
  for (const [k0, k1, k2, k3] of quads) {
    out.push(...P[k0], ...P[k1], ...P[k2]);
    out.push(...P[k0], ...P[k2], ...P[k3]);
  }
  return new Float32Array(out);
}
const geo = (arr) => ({ attributes: { position: { array: arr } } });

console.log('\n1. Topologie');

check('une boite fermee est etanche', () => {
  const a = auditEdges(geo(box(10, 10, 10)));
  assert.equal(a.triCount, 12);
  assert.equal(a.open, 0);
  assert.equal(a.nonManifold, 0);
  assert.equal(a.watertight, true);
});

check('un triangle retire ouvre EXACTEMENT trois aretes', () => {
  const b = box(10, 10, 10);
  const troue = b.slice(0, b.length - 9);          // 11 triangles
  const a = auditEdges(geo(troue));
  assert.equal(a.open, 3, `attendu 3 aretes ouvertes, mesure ${a.open}`);
  assert.equal(a.watertight, false);
});

check('un triangle DOUBLE rend trois aretes non-manifold', () => {
  const b = box(10, 10, 10);
  const double = new Float32Array(b.length + 9);
  double.set(b, 0);
  double.set(b.slice(0, 9), b.length);             // le premier triangle, deux fois
  const a = auditEdges(geo(double));
  assert.equal(a.nonManifold, 3, `attendu 3 aretes non-manifold, mesure ${a.nonManifold}`);
  assert.equal(a.open, 0);
  assert.equal(a.watertight, false);
});

check('un sliver degenere est compte a part, pas pris pour un trou', () => {
  // Deux sommets confondus : l'arete degeneree ne doit ni ouvrir ni alarmer.
  const b = box(10, 10, 10);
  const avec = new Float32Array(b.length + 9);
  avec.set(b, 0);
  avec.set([1, 1, 1, 1, 1, 1, 2, 1, 1], b.length);
  const a = auditEdges(geo(avec));
  assert.equal(a.degenerate, 1, `arete degeneree mal comptee (${a.degenerate})`);
  // Et surtout : le sliver ne doit pas faire passer la boite pour percee.
  assert.equal(a.open, 0, 'un sliver a ete pris pour un trou');
  assert.equal(a.watertight, true);
});

console.log('\n2. Epaisseur de paroi');

check('une dalle de 1.2 mm mesure 1.2 mm', () => {
  const t = minWallThickness(geo(box(40, 30, 1.2)));
  assert.ok(Math.abs(t.min - 1.2) < 0.02, `epaisseur mesuree ${t.min}`);
  assert.equal(t.misses, 0, 'des tirs n ont rien touche dans un solide ferme');
  assert.ok(t.hits > 0);
});

check('la plus PETITE dimension gagne', () => {
  // 20 x 3 x 40 : c'est 3 qu'il faut trouver, pas 20 ni 40.
  const t = minWallThickness(geo(box(20, 3, 40)));
  assert.ok(Math.abs(t.min - 3) < 0.05, `epaisseur mesuree ${t.min}`);
});

check('deux appels rendent EXACTEMENT le meme chiffre', () => {
  const b = box(17, 5.5, 23);
  const a1 = minWallThickness(geo(b));
  const a2 = minWallThickness(geo(b));
  assert.equal(a1.min, a2.min, 'audit non deterministe : inutilisable pour comparer');
  assert.equal(a1.samples, a2.samples);
});

check('le pire point est LOCALISE (on doit pouvoir le montrer)', () => {
  const t = minWallThickness(geo(box(20, 3, 40)));
  assert.ok(Array.isArray(t.at) && t.at.length === 3, 'aucune position rendue');
});

check('un maillage OUVERT se dit, il ne rend pas une paroi infinie', () => {
  // Un seul triangle : rien en face. Le compteur de tirs perdus est le signal —
  // sans lui, min = Infinity passerait pour un satisfecit.
  const t = minWallThickness(geo(new Float32Array([0,0,0, 10,0,0, 0,10,0])));
  assert.equal(t.hits, 0);
  assert.ok(t.misses > 0, 'un tir dans le vide doit etre COMPTE');
  assert.equal(t.min, Infinity);
  const r = auditReport({ edges: auditEdges(geo(new Float32Array([0,0,0, 10,0,0, 0,10,0]))), thickness: t, inward: { mm: 0, exact: true } });
  assert.ok(r.findings.some(f => f.code === 'audit.notMeasurable'), 'le cas non mesurable n est pas dit');
});

console.log('\n3. Ce que le deplacement retire');

check('non symetrique : le deplacement est sortant, une paroi ne maigrit pas', () => {
  const b = inwardBudget([{ settings: { amplitude: 2.0, symmetricDisplacement: false } }]);
  assert.equal(b.mm, 0);
});

check('symetrique : la moitie de l amplitude, et c est un MAJORANT', () => {
  const b = inwardBudget([{ settings: { amplitude: 0.6, symmetricDisplacement: true } }]);
  assert.ok(Math.abs(b.mm - 0.3) < 1e-12, `budget ${b.mm}`);
  assert.equal(b.exact, false, 'sans creux de carte, le budget doit se declarer MAJORANT');
});

check('le creux REEL de la carte resserre la borne', () => {
  const b = inwardBudget([{ settings: { amplitude: 0.6, symmetricDisplacement: true }, greyMin: 0.2 }]);
  assert.ok(Math.abs(b.mm - 0.18) < 1e-12, `budget ${b.mm}`);
  assert.equal(b.exact, true);
});

check('le pire slot commande', () => {
  const b = inwardBudget([
    { settings: { amplitude: 0.2, symmetricDisplacement: true } },
    { settings: { amplitude: 1.0, symmetricDisplacement: true } },
    { settings: { amplitude: 5.0, symmetricDisplacement: false } },
  ]);
  assert.ok(Math.abs(b.mm - 0.5) < 1e-12, `budget ${b.mm}`);
});

check('greyMinOf lit le canal rouge, celui que lit le sampler', () => {
  const d = new Uint8ClampedArray([255,0,0,255,  51,9,9,255,  128,0,0,255]);
  assert.ok(Math.abs(greyMinOf({ data: d }) - 51 / 255) < 1e-9);
  assert.equal(greyMinOf(null), null);
});

console.log('\n4. Verdict');

check('tout va bien : AUCUN message', () => {
  const r = auditReport({
    edges: auditEdges(geo(box(20, 20, 5))),
    thickness: { min: 5, p01: 5, hits: 10, samples: 10, misses: 0 },
    inward: { mm: 0.1, exact: true },
  });
  assert.equal(r.level, 'ok');
  assert.deepEqual(r.findings, []);
});

check('sous la buse : avertissement CHIFFRE avec un remede', () => {
  const r = auditReport({
    edges: auditEdges(geo(box(20, 20, 5))),
    thickness: { min: 1.0, p01: 1.0, hits: 10, samples: 10, misses: 0 },
    inward: { mm: 0.4, exact: true },
  });
  assert.equal(r.level, 'warn');
  const f = r.findings.find(x => x.code === 'audit.underNozzle');
  assert.ok(f, 'aucun constat sous la buse');
  // On epingle les CHIFFRES, pas la prose : le texte vit dans les paquets i18n.
  assert.equal(f.params.wall, '1.00', 'la mesure d origine manque');
  assert.equal(f.params.cut, '0.80', 'le creusement des deux cotes manque');
  assert.equal(f.params.after, '0.20', 'le resultat apres creusement manque');
  assert.equal(f.params.amp, '0.60', 'le remede chiffre manque');
  assert.ok(Math.abs(r.thicknessAfter - 0.2) < 1e-9);
});

check('entre buse et confort : INFO, pas avertissement', () => {
  const r = auditReport({
    edges: auditEdges(geo(box(20, 20, 5))),
    thickness: { min: 1.0, p01: 1.0, hits: 10, samples: 10, misses: 0 },
    inward: { mm: 0.15, exact: true },
  });
  assert.equal(r.level, 'info');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].code, 'audit.thin');
});

check('le majorant est ANNONCE comme tel', () => {
  const r = auditReport({
    edges: auditEdges(geo(box(20, 20, 5))),
    thickness: { min: 1.0, p01: 1.0, hits: 10, samples: 10, misses: 0 },
    inward: { mm: 0.4, exact: false },
  });
  assert.equal(r.findings[0].params.bound, 1,
    'une borne non mesuree doit se declarer, sinon elle passe pour un fait');
});

check('non etanche : les COMPTES sont dans le message', () => {
  const b = box(10, 10, 10);
  const a = auditEdges(geo(b.slice(0, b.length - 9)));
  const r = auditReport({ edges: a });
  assert.equal(r.level, 'warn');
  assert.equal(r.findings[0].code, 'audit.notWatertight');
  assert.equal(r.findings[0].params.open, 3, 'le compte d aretes ouvertes manque');
});

console.log('\n5. Le defaut REEL du depot, sur le vrai pipeline');

await checkAsync('cubeWithSmallFillets : sain en entree, NON-MANIFOLD en sortie', async () => {
  // ⚠️ C'est le defaut que le golden enregistre en `watertight=false` et rend
  // donc PERMANENT et MUET. Il est ici MESURE et PUBLIE : l'audit doit le voir.
  // On n'epingle pas le compte exact (il depend legitimement des reglages) — on
  // epingle le FAIT : l'entree est saine, la sortie ne l'est pas.
  const here = dirname(fileURLToPath(import.meta.url));
  const stl = join(here, '..', 'cubeWithSmallFillets.stl');
  const g = readBinarySTL(stl);

  const avant = auditEdges(g);
  assert.equal(avant.open, 0, 'la fixture n est plus saine en entree');
  assert.equal(avant.nonManifold, 0);

  const out = await runSingle(g, {
    refineLength: 0.5, settings: baseSettings,
    texture: proceduralTexture(256, 256, 'checker'),
  });
  const apres = auditEdges(out);
  console.log(`       entree : ${avant.triCount} tris, etanche` +
              ` | sortie : ${apres.triCount} tris, ${apres.open} ouverte(s), ` +
              `${apres.nonManifold} non-manifold`);
  assert.equal(apres.watertight, false, 'le defaut a disparu : retirer ce cas et le KNOWN du golden');
  assert.ok(apres.nonManifold > 0, 'le defaut n est pas du non-manifold : re-decrire');

  const r = auditReport({ edges: apres });
  assert.equal(r.level, 'warn');
  assert.equal(r.findings[0].code, 'audit.notWatertight');
  assert.ok(r.findings[0].params.nm > 0, 'le compte non-manifold manque');
});

await checkAsync('laserPlate : sain en entree ET en sortie (pas d alarme partout)', async () => {
  // Contre-epreuve indispensable : un audit qui crierait sur tout serait ignore.
  const here = dirname(fileURLToPath(import.meta.url));
  const g = readBinarySTL(join(here, '..', 'laserPlate.stl'));
  const out = await runSingle(g, {
    refineLength: 0.5, settings: baseSettings,
    texture: proceduralTexture(256, 256, 'checker'),
  });
  const a = auditEdges(out);
  assert.equal(a.watertight, true, `sortie non etanche : ${a.open} ouvertes, ${a.nonManifold} non-manifold`);
  assert.deepEqual(auditReport({ edges: a }).findings, []);
});

await checkAsync('la plaque reelle : son epaisseur est MESUREE, et le verdict suit', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const g = readBinarySTL(join(here, '..', 'laserPlate.stl'));
  const t = minWallThickness(g);
  console.log(`       minimum strict ${t.min.toFixed(4)} mm (pointe de biseau) | ` +
              `paroi p01 ${t.p01.toFixed(3)} mm | ${t.hits} tirs aboutis, ${t.misses} perdus`);
  assert.ok(Number.isFinite(t.min) && t.min > 0, 'epaisseur non mesuree sur un solide reel');
  // La plaque fait 2.000 mm : c'est CA que l'audit doit annoncer, et non le
  // minimum strict, qui vaut 0.002 mm sur une pointe de biseau de 0.001 mm2.
  assert.ok(Math.abs(t.p01 - 2.0) < 0.05, `p01 attendu ~2.00 mm, mesure ${t.p01}`);
  assert.ok(t.min < 0.1, 'le minimum strict devrait rester domine par les biseaux — sinon re-decrire');
  // La plaque fait 2 mm d'epaisseur : une amplitude symetrique de 1.0 la
  // ramenerait a 1.0 mm, une de 2.0 la percerait.
  const doux = auditReport({ edges: { watertight: true }, thickness: t,
                             inward: inwardBudget([{ settings: { amplitude: 0.2, symmetricDisplacement: true } }]) });
  const brutal = auditReport({ edges: { watertight: true }, thickness: t,
                               inward: inwardBudget([{ settings: { amplitude: 2.0, symmetricDisplacement: true } }]) });
  assert.equal(doux.level, 'ok', 'une amplitude douce ne doit pas alarmer');
  assert.equal(brutal.level, 'warn', 'une amplitude qui perce la plaque doit alarmer');
  assert.ok(brutal.thicknessAfter < NOZZLE_MM);
});

console.log('\n6. Cablage dans main.js');
//
// ⚠️ Controles de CABLAGE : ils lisent le source. Le declenchement REEL passe
// par un export, donc par une boite de dialogue native (saveBlob -> IPC) qu'un
// e2e ne peut pas franchir sans la simuler — il reste a verifier a la main, une
// fois. Ces controles attrapent le defaut MUET : un chemin d'export oublie, ou
// une borne rendue sans etre annoncee comme telle.
{
  const MAIN = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*/g, ' ');

  check('les DEUX chemins d export sont audites', () => {
    const n = (MAIN.match(/auditExportedMesh\s*\(/g) || []).length;
    // 1 definition + 2 appels (mono-slot/3mf, et tous-slots)
    assert.ok(n >= 3, `auditExportedMesh apparait ${n} fois : un chemin d export n est pas audite`);
    assert.match(MAIN, /auditExportedMesh\(finalGeometry,\s*readySlots\)/,
      'le chemin « tous les slots » n est pas audite');
    assert.match(MAIN, /auditExportedMesh\(finalGeometry,\s*\[\{\s*settings\s*\}\]\)/,
      'le chemin mono-slot / 3MF n est pas audite');
  });

  check('l audit ne peut pas empecher l export', () => {
    const i = MAIN.indexOf('function auditExportedMesh(');
    assert.ok(i > 0, 'auditExportedMesh introuvable');
    const corps = MAIN.slice(i, i + 2200);
    assert.match(corps, /catch\s*\(/,
      'sans garde, un audit qui echoue emporterait l export — or le fichier est le livrable');
  });

  check('le majorant est ANNONCE a l utilisateur, pas seulement calcule', () => {
    assert.match(MAIN, /params\.bound\s*\?[^\n]*audit\.upperBound/,
      'la mention de majorant n est jamais ajoutee au message');
  });

  check('l epaisseur est mesuree sur le maillage D ENTREE', () => {
    // Sur la sortie, ce serait des dizaines de millions de triangles pour un
    // chiffre qu'on borne par le calcul.
    assert.match(MAIN, /minWallThickness\(currentGeometry\)/,
      'l epaisseur n est plus mesuree sur le maillage d entree');
    assert.match(MAIN, /auditEdges\(finalGeometry\)/,
      'la topologie n est plus mesuree sur le maillage EXPORTE');
  });
}

console.log(`\nseuils : buse ${NOZZLE_MM} mm, confort ${COMFORT_MM} mm`);
console.log(`VERDICT: ${fail ? 'FAIL' : 'PASS'}  (${pass} ok, ${fail} failed)`);
process.exit(fail ? 1 : 0);
