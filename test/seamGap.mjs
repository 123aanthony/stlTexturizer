// La couture du relief a une arete vive : ce qui la cause, et ce qui n'y peut rien.
//
// UNE HYPOTHESE REFUTEE, GARDEE PARCE QU'ELLE EST INSTRUCTIVE
// -----------------------------------------------------------
// La subdivision ne fusionne deux sommets coincidents que si leurs normales de
// face sont a moins de 30 degres (SHARP_COS, js/subdivision.js). J'en avais
// deduit qu'a un coin a 90 degres les deux cotes, pousses chacun le long de SA
// normale, devaient s'ecarter de h*racine(2) — donc une couture OUVERTE, et une
// explication toute faite des « coques deconnectees ».
//
// MESURE : faux. 12 290 positions du cube subdivise portent 2 sommets ou plus,
// et AUCUNE ne s'ecarte (0.0000 mm) alors que le relief a bien ete applique
// (deplacement max 0.608 mm). Le pipeline soude deja correctement. C'est le
// controle de vitalite qui rend cette conclusion utilisable : sans lui, un
// « 0 ecartement » pourrait n'etre qu'un moteur qui n'a jamais tourne.
//
// LA VRAIE CAUSE, ET POURQUOI AUCUN CURSEUR NE LA CORRIGE
// --------------------------------------------------------
// La couture n'est pas un TROU mais une DISCONTINUITE DE MOTIF : de part et
// d'autre de l'arete, la projection change d'axe, donc le champ de hauteurs
// saute.
//
// Or le choix de l'axe — cubique comme triplanaire — se fait sur la NORMALE :
//     cubique      getCubicBlendWeights : (primary - secondary) / seamBandWidth
//     triplanaire  poids proportionnels a normale^4
// A une arete VIVE, la normale saute de 90 degres d'un coup, sans valeur
// intermediaire. Aucun melange fonde sur la normale n'a donc de quoi
// travailler, et « Seam Blend » est INERTE sur des murs plats — ce fichier le
// chiffre.
//
// ⚠️ PIEGE DE MONTAGE, paye ici : un CUBE ne permet PAS de comparer cubique et
// triplanaire. Toutes ses normales sont exactement alignees sur un axe, donc la
// ponderation en normale^4 degenere en choix franc et les deux modes rendent
// des chiffres IDENTIQUES a la quatrieme decimale. Cette egalite parfaite est
// le signal que le montage, et non le code, etait en cause.

import * as THREE from 'three';
import { baseSettings, computeBounds, legacyRelToMm } from './lib/pipeline.mjs';
import { proceduralTexture } from './lib/texture.mjs';
import { subdivide } from '../js/subdivision.js';
import { applyDisplacement } from '../js/displacement.js';
import { getCubicBlendWeights } from '../js/mapping.js';

let pass = 0, fail = 0;
const ok = (m) => { console.log('  ok   ' + m); pass++; };
const ko = (m) => { console.log('  FAIL ' + m); fail++; };

const TAILLE = 40, AMP = 2.0;

async function main() {
  console.log('\n1. Une arete vive s\'ouvre-t-elle sous le relief ?');

  const cube = new THREE.BoxGeometry(TAILLE, TAILLE, TAILLE, 1, 1, 1).toNonIndexed();
  cube.computeVertexNormals();
  const settings = { ...baseSettings, mappingMode: 6, amplitude: AMP, scaleU: 0.25, scaleV: 0.25 };
  const { geometry: sub } = await subdivide(cube, 1.5, null, null);
  const avant = sub.clone();
  const bounds = computeBounds(cube);
  const texture = proceduralTexture(128, 128, 'checker');
  const apres = applyDisplacement(sub, texture, texture.width, texture.height,
                                  legacyRelToMm(settings, bounds), bounds, null);

  const a = avant.attributes.position, b = apres.attributes.position;
  let bouge = 0;
  for (let i = 0; i < a.count; i++) {
    const d = Math.hypot(a.getX(i) - b.getX(i), a.getY(i) - b.getY(i), a.getZ(i) - b.getZ(i));
    if (d > bouge) bouge = d;
  }
  console.log(`       CONTROLE de vitalite : deplacement max ${bouge.toFixed(3)} mm`);
  if (bouge < 1e-6) {
    ko('le maillage n\'a pas bouge : la mesure serait VIDE');
  } else {
    const q = 1e-4, m = new Map();
    for (let i = 0; i < a.count; i++) {
      const k = [Math.round(a.getX(i) / q), Math.round(a.getY(i) / q), Math.round(a.getZ(i) / q)].join(',');
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(i);
    }
    let ecart = 0, groupes = 0;
    for (const g of m.values()) {
      if (g.length < 2) continue;
      groupes++;
      for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
        const d = Math.hypot(b.getX(g[i]) - b.getX(g[j]),
                             b.getY(g[i]) - b.getY(g[j]),
                             b.getZ(g[i]) - b.getZ(g[j]));
        if (d > ecart) ecart = d;
      }
    }
    console.log(`       ${groupes} positions portees par 2+ sommets | ecart max ${ecart.toFixed(4)} mm`);
    if (groupes < 100) ko(`trop peu de positions partagees (${groupes}) : la mesure ne prouve rien`);
    else if (ecart < 1e-3) ok('les aretes vives restent SOUDEES — la couture n\'est pas un trou');
    else ko(`les aretes vives s'ouvrent de ${ecart.toFixed(3)} mm`);
  }

  console.log('\n2. Le melange de couture agit-il sur un mur plat ?');
  console.log('       (Seam Blend au MAXIMUM, Transition Smoothing 0.5)');

  const cas = [
    ['mur plat',            { x: 1, y: 0, z: 0 },                                          0],
    ['10 deg du plat',      { x: Math.cos(0.1745), y: Math.sin(0.1745), z: 0 },            0],
    ['30 deg',              { x: Math.cos(0.5236), y: Math.sin(0.5236), z: 0 },            0],
    ['chanfrein a 45 deg',  { x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 },                    0.5],
  ];
  let plat = null, chanfrein = null;
  for (const [nom, n, attendu] of cas) {
    const w = getCubicBlendWeights(n, 1, 0.5);
    const melange = 1 - Math.max(w.x, w.y, w.z);
    console.log(`       ${nom.padEnd(20)} melange ${(melange * 100).toFixed(1)} %`);
    if (nom === 'mur plat') plat = melange;
    if (nom.startsWith('chanfrein')) chanfrein = melange;
    if (Math.abs(melange - attendu) > 0.02) {
      ko(`${nom} : melange ${melange.toFixed(3)}, attendu ${attendu}`);
    }
  }
  if (plat !== null && chanfrein !== null) {
    if (plat < 0.01 && chanfrein > 0.4) {
      ok('mesure : INERTE sur un mur plat, actif seulement pres de 45 degres');
      console.log('       => sur un coin de batiment a 90 degres, le curseur ne peut rien ;');
      console.log('          un chanfrein, meme petit, lui donne prise.');
    } else {
      ko(`comportement inattendu : plat ${plat.toFixed(3)}, chanfrein ${chanfrein.toFixed(3)}`);
    }
  }

  console.log(`\nVERDICT: ${fail ? 'FAIL' : 'PASS'}  (${pass} ok, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
