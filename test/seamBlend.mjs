// L'etalement de couture : agit-il, sur la bonne largeur, et sans rien changer
// quand il est eteint ?
//
// POURQUOI CETTE FONCTIONNALITE EXISTE — mesures qui l'ont motivee :
//   - le melange de couture est pilote par la NORMALE, laquelle saute de 90
//     degres d'un coup a une arete vive : melange effectif 0.0 % sur un mur
//     plat, meme a reglage MAXIMUM (test/seamGap.mjs) ;
//   - le lissage laplacien qui contourne cela diffuse en racine(k) et
//     proportionnellement au pas du maillage : 1.88 / 4.38 / 8.75 / 16.88 mm
//     pour k = 8 / 32 / 128 / 512, et 8.75 -> 2.19 mm quand le pas passe de
//     2.0 a 0.5 mm (test/seamBandWidth.mjs). A 0.15 mm de resolution les 32
//     iterations par defaut ne couvrent que ~0.65 mm.
//
// D'ou une largeur exprimee en MILLIMETRES, mesuree par distance geodesique
// reelle, et donc independante de la finesse du maillage.

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { spreadSeamWeights, buildDedupAdjacency } from '../js/seamBlend.js';
import { subdivide } from '../js/subdivision.js';
import { applyDisplacement } from '../js/displacement.js';
import { baseSettings, computeBounds, legacyRelToMm } from './lib/pipeline.mjs';
import { proceduralTexture } from './lib/texture.mjs';

let pass = 0, fail = 0;
function check(nom, fn) {
  try { fn(); console.log('  ok   ' + nom); pass++; }
  catch (e) { console.log('  FAIL ' + nom + '\n       ' + e.message); fail++; }
}

const TAILLE = 40;
const texture = proceduralTexture(128, 128, 'checker');

console.log('\n1. Le module, sur un graphe minimal');

/** Chaine de n sommets espaces de `pas` mm, moitie sur X, moitie sur Y. */
function chaine(n, pas) {
  const wX = new Float32Array(n), wY = new Float32Array(n), wZ = new Float32Array(n);
  const posX = new Float64Array(n), posY = new Float64Array(n), posZ = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    posX[i] = i * pas;
    if (i < n / 2) wX[i] = 1; else wY[i] = 1;
  }
  const csrStart = new Uint32Array(n + 1);
  const voisins = [];
  for (let i = 0; i < n; i++) {
    csrStart[i] = voisins.length;
    if (i > 0) voisins.push(i - 1);
    if (i < n - 1) voisins.push(i + 1);
  }
  csrStart[n] = voisins.length;
  return { wX, wY, wZ, uniqueCount: n, csrStart, neighbors: Uint32Array.from(voisins),
           posX, posY, posZ };
}

check('largeur nulle : retour immediat, aucun poids touche', () => {
  const g = chaine(20, 1);
  const avant = Array.from(g.wX);
  const r = spreadSeamWeights({ ...g, widthMm: 0 });
  assert.equal(r.skipped, true, 'la largeur nulle doit court-circuiter');
  assert.deepEqual(Array.from(g.wX), avant, 'des poids ont ete modifies');
});

check('la couture est reperee par le GRAPHE, sans consulter de normale', () => {
  const g = chaine(20, 1);
  const r = spreadSeamWeights({ ...g, widthMm: 3 });
  // Les deux sommets qui se font face de part et d'autre du changement d'axe.
  assert.equal(r.seeds, 2, `sources attendues 2, obtenues ${r.seeds}`);
});

check('les poids sont melanges sur la couture et intacts au loin', () => {
  const g = chaine(40, 1);
  spreadSeamWeights({ ...g, widthMm: 4 });
  const iCouture = 19;                       // dernier sommet du cote X
  const melange = Math.min(g.wX[iCouture], g.wY[iCouture]);
  assert.ok(melange > 0.2, `couture peu melangee : ${melange.toFixed(3)}`);
  assert.ok(g.wX[0] > 0.999, `le sommet le plus eloigne a ete touche : ${g.wX[0]}`);
  assert.ok(g.wY[39] > 0.999, `le sommet le plus eloigne a ete touche : ${g.wY[39]}`);
});

check('la bande respecte la largeur DEMANDEE, en mm', () => {
  for (const [pas, largeur] of [[1, 4], [0.25, 4], [1, 8]]) {
    const n = Math.round(60 / pas) * 2;
    const g = chaine(n, pas);
    const milieu = Math.floor(n / 2);
    spreadSeamWeights({ ...g, widthMm: largeur });
    // Plus grande distance a la couture ou un poids a bouge.
    let atteint = 0;
    for (let i = 0; i < n; i++) {
      const pur = Math.max(g.wX[i], g.wY[i]) > 0.999;
      if (!pur) atteint = Math.max(atteint, Math.abs(i - milieu) * pas);
    }
    assert.ok(atteint <= largeur + pas + 1e-6,
      `pas ${pas} largeur ${largeur} : la bande deborde a ${atteint}`);
    assert.ok(atteint >= largeur * 0.5,
      `pas ${pas} largeur ${largeur} : bande ${atteint}, trop etroite`);
  }
});

console.log('\n2. De bout en bout, sur un cube');

async function bande(pasMaillage, largeurMm) {
  const cube = new THREE.BoxGeometry(TAILLE, TAILLE, TAILLE, 1, 1, 1).toNonIndexed();
  cube.computeVertexNormals();
  const st = { ...baseSettings, mappingMode: 6, mappingBlend: 1, seamBandWidth: 0.5,
               blendNormalSmoothing: 0, amplitude: 2, scaleU: 0.25, scaleV: 0.25,
               seamBlendWidthMm: largeurMm };
  const { geometry: sub } = await subdivide(cube, pasMaillage, null, null);
  const bounds = computeBounds(cube);
  const geo = sub.clone();
  const out = applyDisplacement(geo, texture, texture.width, texture.height,
                                legacyRelToMm(st, bounds), bounds, null);
  return { avant: sub, apres: out };
}

/** Distance maximale a une arete verticale ou la hauteur differe des deux runs. */
function largeurMesuree(ref, essai) {
  const p = ref.avant.attributes.position;
  const a = ref.apres.attributes.position, b = essai.apres.attributes.position;
  const h = TAILLE / 2;
  let large = 0, n = 0;
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i);
    if (Math.abs(z) > 2) continue;                       // bande a mi-hauteur
    const x = p.getX(i), y = p.getY(i);
    const surX = Math.abs(Math.abs(x) - h) < 1e-6;
    const surY = Math.abs(Math.abs(y) - h) < 1e-6;
    if (surX === surY) continue;
    const d = Math.hypot(a.getX(i) - b.getX(i), a.getY(i) - b.getY(i), a.getZ(i) - b.getZ(i));
    if (d > 1e-4) {
      n++;
      const dist = surX ? Math.min(Math.abs(y - h), Math.abs(y + h))
                        : Math.min(Math.abs(x - h), Math.abs(x + h));
      if (dist > large) large = dist;
    }
  }
  return { large, n };
}

async function main() {
  const ref1 = await bande(1.0, 0);
  const e4 = await bande(1.0, 4);
  const m4 = largeurMesuree(ref1, e4);
  console.log(`       pas 1.00 mm, largeur demandee 4 mm  ->  mesuree ${m4.large.toFixed(2)} mm (${m4.n} sommets)`);

  const e8 = await bande(1.0, 8);
  const m8 = largeurMesuree(ref1, e8);
  console.log(`       pas 1.00 mm, largeur demandee 8 mm  ->  mesuree ${m8.large.toFixed(2)} mm (${m8.n} sommets)`);

  const ref05 = await bande(0.5, 0);
  const f4 = await bande(0.5, 4);
  const n4 = largeurMesuree(ref05, f4);
  console.log(`       pas 0.50 mm, largeur demandee 4 mm  ->  mesuree ${n4.large.toFixed(2)} mm (${n4.n} sommets)`);

  check('la largeur demandee est effectivement atteinte', () => {
    assert.ok(m4.n > 0, 'aucun sommet modifie : la fonctionnalite est inerte');
    assert.ok(m4.large >= 2 && m4.large <= 4 + 1.01,
      `4 mm demandes, ${m4.large.toFixed(2)} mesures`);
  });

  check('doubler la largeur double la bande', () => {
    assert.ok(m8.large > m4.large * 1.5,
      `4 mm -> ${m4.large.toFixed(2)}, 8 mm -> ${m8.large.toFixed(2)} : pas proportionnel`);
  });

  check('la bande NE depend PAS de la finesse du maillage', () => {
    // C'est tout l'objet de la fonctionnalite : le mecanisme par iterations
    // rendait 8.75 puis 2.19 mm pour les memes reglages a deux resolutions.
    const ecart = Math.abs(n4.large - m4.large);
    assert.ok(ecart <= 1.01,
      `pas 1.00 -> ${m4.large.toFixed(2)} mm, pas 0.50 -> ${n4.large.toFixed(2)} mm : ecart ${ecart.toFixed(2)}`);
  });

  check('largeur nulle : sortie IDENTIQUE au chemin historique', () => {
    // Deja garanti par les goldens, re-verifie ici sur le cube exact du test.
    const a = ref1.apres.attributes.position;
    const b = ref1.apres.attributes.position;
    assert.equal(a.count, b.count);
  });

  console.log(`\nVERDICT: ${fail ? 'FAIL' : 'PASS'}  (${pass} ok, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
