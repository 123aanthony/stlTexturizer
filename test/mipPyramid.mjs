// Préfiltre d'antialiasing du sampler de déplacement (js/mipPyramid.js).
//
// Le défaut corrigé : `applyDisplacement` déplace un sommet par TAP bilinéaire.
// Le bilinéaire est un filtre de RECONSTRUCTION, pas un PRÉFILTRE — il ne voit
// que les 4 texels voisins. Le taux d'échantillonnage est donc l'espacement des
// sommets, et tout ce qui est plus fin que 2 arêtes ne s'atténue pas : il se
// REPLIE en bruit structuré. D'où l'observation de départ : les textures plates
// et peu détaillées « passent » mieux — elles sont déjà bande-limitées sous le
// Nyquist de la maille.
//
// Ce que ce fichier prouve :
//   1. structure de la pyramide (niveaux, tuilage, image constante préservée) ;
//   2. un damier — le pire cas d'aliasing — s'effondre sur sa MOYENNE dès le
//      niveau 1, au lieu de rester bimodal ;
//   3. lod <= 0 délègue au sampler d'origine, à l'identique EXACT ;
//   4. sur le VRAI pipeline, une maille qui résout la texture rend une
//      géométrie bit-identique avec ou sans préfiltre (non-régression par
//      CONSTRUCTION, mesurée et pas seulement plaidée) ;
//   5. sur le VRAI pipeline, une maille qui NE la résout pas voit son bruit de
//      repliement s'effondrer — l'oracle du défaut, prouvé VIVANT en
//      neutralisant le correctif (textureAntialias: false).

import * as THREE from 'three';
import assert from 'node:assert/strict';
import {
  getMipPyramid, sampleLevel, sampleBilinear, sampleFiltered, lodForFootprint,
  texPerMm, recommendedSmoothing,
} from '../js/mipPyramid.js';
import { proceduralTexture } from './lib/texture.mjs';
import { runSingle } from './lib/pipeline.mjs';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

const grey = (v) => {
  const w = 8, h = 8, d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i*4] = d[i*4+1] = d[i*4+2] = v; d[i*4+3] = 255; }
  return { data: d, width: w, height: h };
};

// Damier 1 texel : la fréquence la plus haute qu'une image puisse porter, donc
// le pire cas de repliement.
function checker1px(w = 8, h = 8) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const g = ((x + y) % 2) ? 255 : 0;
    const i = (y * w + x) * 4;
    d[i] = d[i+1] = d[i+2] = g; d[i+3] = 255;
  }
  return { data: d, width: w, height: h };
}

console.log('\n1. Structure de la pyramide');

check('les niveaux descendent jusqu\'a 1x1', () => {
  const p = getMipPyramid(checker1px(8, 8));
  assert.deepEqual(p.levels.map(l => `${l.w}x${l.h}`), ['8x8', '4x4', '2x2', '1x1']);
  assert.equal(p.maxLevel, 3);
});

check('non carre : chaque axe descend a son rythme puis se bloque a 1', () => {
  const p = getMipPyramid(checker1px(8, 2));
  assert.deepEqual(p.levels.map(l => `${l.w}x${l.h}`), ['8x2', '4x1', '2x1', '1x1']);
});

check('memoisation sur l\'identite de l\'ImageData', () => {
  const img = checker1px();
  assert.equal(getMipPyramid(img), getMipPyramid(img));
  assert.notEqual(getMipPyramid(img), getMipPyramid(checker1px()));
});

check('image constante : aucune derive sur toute la pyramide', () => {
  const p = getMipPyramid(grey(200));
  const exp = 200 / 255;
  for (const lvl of p.levels) {
    for (const v of lvl.data) assert.ok(Math.abs(v - exp) < 1e-6, `niveau ${lvl.w}x${lvl.h}: ${v} != ${exp}`);
  }
});

console.log('\n2. Bande-limitation (le coeur du correctif)');

check('un damier 1 texel s\'effondre sur sa MOYENNE des le niveau 1', () => {
  const p = getMipPyramid(checker1px(8, 8));
  // Niveau 0 : bimodal, extremes 0 et 1.
  const l0 = p.levels[0].data;
  assert.ok(Math.min(...l0) === 0 && Math.max(...l0) === 1, 'niveau 0 doit rester bimodal');
  // Niveau 1 : chaque texel est la moyenne d'un bloc 2x2 du damier = 0.5 pile.
  for (const v of p.levels[1].data) assert.ok(Math.abs(v - 0.5) < 1e-6, `niveau 1 = ${v}, attendu 0.5`);
});

check('le sous-echantillonnage BOUCLE (la carte se tuile, pas de couture)', () => {
  // Sur une largeur IMPAIRE, un filtre 2x2 qui CLAMPERAIT au bord dupliquerait
  // la derniere colonne ; le wrap la marie a la premiere. Damier de periode 2
  // sur 3 colonnes : la colonne repliee doit valoir la moyenne des deux.
  const w = 3, h = 2, d = new Uint8ClampedArray(w * h * 4);
  const col = [0, 255, 0];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4; d[i] = d[i+1] = d[i+2] = col[x]; d[i+3] = 255;
  }
  const p = getMipPyramid({ data: d, width: w, height: h });
  // niveau 1 : w=1 -> moyenne des colonnes 0 et 1 = (0 + 1) / 2
  assert.ok(Math.abs(p.levels[1].data[0] - 0.5) < 1e-6, `${p.levels[1].data[0]} != 0.5`);
});

check('lodForFootprint suit la convention mip usuelle', () => {
  assert.equal(lodForFootprint(1), 0);
  assert.equal(lodForFootprint(0.4), 0, 'magnification -> chemin legacy');
  assert.equal(lodForFootprint(2), 1);
  assert.equal(lodForFootprint(16), 4);
  assert.ok(Math.abs(lodForFootprint(24) - 4.585) < 1e-3, 'defauts de l\'app : 24 texels/arete');
});

console.log('\n3. lod <= 0 : delegation EXACTE au sampler d\'origine');

check('sampleFiltered(lod<=0) === sampleBilinear, au bit pres, sur 400 UV', () => {
  const img = proceduralTexture(64, 64, 'sine');
  const p = getMipPyramid(img);
  let n = 0;
  for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) {
    const u = i / 19.7 - 0.3, v = j / 19.3 + 0.11;   // hors [0,1) aussi : tuilage
    const ref = sampleBilinear(img.data, img.width, img.height, u, v);
    for (const lod of [0, -1, -0.0001]) {
      assert.equal(sampleFiltered(p, img.data, img.width, img.height, u, v, lod), ref);
    }
    assert.equal(sampleFiltered(null, img.data, img.width, img.height, u, v, 9), ref, 'pyramide absente');
    n++;
  }
  assert.equal(n, 400);
});

check('lod fractionnaire : melange monotone entre les deux niveaux', () => {
  const img = proceduralTexture(64, 64, 'sine');
  const p = getMipPyramid(img);
  const u = 0.37, v = 0.62;
  const a = sampleFiltered(p, img.data, img.width, img.height, u, v, 1);
  const b = sampleFiltered(p, img.data, img.width, img.height, u, v, 2);
  const mid = sampleFiltered(p, img.data, img.width, img.height, u, v, 1.5);
  assert.ok(Math.abs(mid - (a + b) / 2) < 1e-9, `${mid} n'est pas a mi-chemin de ${a} et ${b}`);
});

check('lod >= maxLevel sature sur le dernier niveau', () => {
  const img = proceduralTexture(64, 64, 'checker');
  const p = getMipPyramid(img);
  const top = sampleLevel(p.levels[p.maxLevel], 0.3, 0.8);
  assert.equal(sampleFiltered(p, img.data, img.width, img.height, 0.3, 0.8, 99), top);
});

// ── 4-5. Le VRAI pipeline ────────────────────────────────────────────────────
// Une plaque, texturee par le haut en triplanaire. On lit les Z deplaces de la
// face superieure : ce sont les valeurs echantillonnees, une par sommet.

const plate = () => new THREE.BoxGeometry(40, 40, 2, 20, 20, 1).toNonIndexed();

async function topZ({ refineLength, scaleMm, texture, antialias }) {
  const geo = await runSingle(plate(), {
    refineLength,
    texture,
    settings: {
      mappingMode: 5, scaleUnit: 'mm', scaleU: scaleMm, scaleV: scaleMm,
      offsetU: 0, offsetV: 0, rotation: 0,
      amplitude: 2.0, symmetricDisplacement: false,
      topAngleLimit: 0, bottomAngleLimit: 0,
      mappingBlend: 0, seamBandWidth: 0.35, blendNormalSmoothing: 0,
      boundaryFalloff: 0, noDownwardZ: false,
      textureAntialias: antialias,
    },
  });
  const pos = geo.attributes.position.array;
  const out = [];
  // INTERIEUR de la face du dessus uniquement. Un simple `z > 0.5` attrape
  // aussi l'ARETE superieure de la plaque, dont la normale lissee est a 45 :
  // ces sommets-la voient leur z varier par pure GEOMETRIE (le cosinus de leur
  // normale), ce qui noie le signal mesure. On restreint a la zone dont la
  // normale vaut exactement +Z — mesurer la forme reelle, pas la boite
  // englobante.
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i + 2] > 0.5 && Math.abs(pos[i]) < 18 && Math.abs(pos[i + 1]) < 18) out.push(pos[i + 2]);
  }
  return out;
}

const sd = (a) => {
  const m = a.reduce((s, v) => s + v, 0) / a.length;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length);
};

const fine = proceduralTexture(128, 128, 'checker');

console.log('\n4. Pipeline reel — maille qui RESOUT la texture');

// Tuile de 400 mm pour 128 px = 0.32 texel/mm ; arete 1 mm -> 0.32 texel/arete,
// donc lod 0 partout : il n'y a RIEN a corriger, et le preflitre doit etre un
// no-op EXACT. C'est la non-regression par construction, mesuree.
{
  const [on, off] = await Promise.all([
    topZ({ refineLength: 1, scaleMm: 400, texture: fine, antialias: true }),
    topZ({ refineLength: 1, scaleMm: 400, texture: fine, antialias: false }),
  ]);
  check('sur-echantillonnee : AA on/off donnent la MEME geometrie, bit a bit', () => {
    assert.ok(on.length > 400, `echantillon trop maigre (${on.length})`);
    assert.deepEqual(on, off);
  });
}

console.log('\n5. Pipeline reel — maille qui NE resout PAS la texture (le defaut)');

// Tuile de 4 mm pour 128 px = 32 texels/mm ; la subdivision rend des aretes
// MESUREES a 1.633 mm -> 52 texels/arete, soit lod 5.71, la ou la pyramide du
// damier est rigoureusement plate a sa moyenne (0.510 mesure). Les carreaux
// font 0.5 mm, trois fois sous le pas d'echantillonnage : rien n'en est
// recuperable, et la seule reponse juste est une surface LISSE a hauteur
// constante. Sans prefiltre on obtient a la place du bruit.
{
  const [on, off] = await Promise.all([
    topZ({ refineLength: 2, scaleMm: 4, texture: fine, antialias: true }),
    topZ({ refineLength: 2, scaleMm: 4, texture: fine, antialias: false }),
  ]);
  const range = (a) => Math.max(...a) - Math.min(...a);
  const rOn = range(on), rOff = range(off);
  // Contraste PLEIN du damier une fois converti en hauteur : les deux plateaux
  // valent 55 et 205 sur 255, l'amplitude vaut 2 mm.
  const fullContrast = 2.0 * (205 - 55) / 255;
  console.log(`       etendue des Z : sans AA ${rOff.toFixed(4)} mm  ->  avec AA ${rOn.toFixed(4)} mm`
            + `   (contraste plein du damier : ${fullContrast.toFixed(4)} mm)`);
  console.log(`       ecart-type    : sans AA ${sd(off).toFixed(4)} mm  ->  avec AA ${sd(on).toFixed(4)} mm`);

  check('ORACLE VIVANT : sans prefiltre, le repliement rend le contraste PLEIN', () => {
    // Critere DERIVE, pas un seuil devine : la surface ne doit rien pouvoir
    // reproduire du damier, et pourtant son etendue crete-a-crete vaut
    // EXACTEMENT le contraste complet de la texture. Tout le signal ressort,
    // mais comme bruit — c'est la signature du repliement.
    // (L'ecart-type, lui, ne vaut que 0.26 et non la demi-difference 0.59 :
    //  82 % des sommets tombent sur un bord de carreau, pas sur un plateau.
    //  Un oracle base sur l'ecart-type aurait donc eu un seuil injustifiable.)
    assert.ok(Math.abs(rOff - fullContrast) < 0.01 * fullContrast,
      `sans AA l'etendue vaut ${rOff.toFixed(4)} et non ${fullContrast.toFixed(4)} : le defaut ne se reproduit plus`);
  });

  check('avec prefiltre, la surface s\'effondre sur la moyenne locale', () => {
    // Seuil ABSOLU, pas un ratio : a lod 5.71 la theorie dit PLAT, et c'est
    // cela qu'on verifie. Un ratio se contenterait d'une amelioration partielle
    // et laisserait passer un prefiltre qui ne filtre qu'a moitie.
    assert.ok(rOn < 0.01, `${rOn.toFixed(4)} mm d'etendue residuelle : la surface n'est pas plate`);
  });

  check('le prefiltre ne DEPLACE pas la surface, il la lisse', () => {
    const mOn = on.reduce((s, v) => s + v, 0) / on.length;
    const mOff = off.reduce((s, v) => s + v, 0) / off.length;
    assert.ok(Math.abs(mOn - mOff) < 0.05, `moyenne ${mOn.toFixed(4)} vs ${mOff.toFixed(4)} : le filtre biaise`);
  });
}

console.log('\n6. Recommandation de lissage (le bouton Auto)');

// Flou global et prefiltre mip repondent a la MEME contrainte de Nyquist. Les
// empiler filtrerait deux fois ; `recommendedSmoothing` arbitre entre les deux.

const APP = { scaleU: 25, scaleV: 25 };   // defauts de l'app : tuile de 25 mm
const rec = (o) => recommendedSmoothing({
  settings: APP, texW: 600, texH: 600, refineLength: 1, antialias: false, ...o,
});

check('empreinte = arete_mm x texels/mm (defauts de l\'app : 24 px/arete)', () => {
  // (1 mm / 25 mm) x 600 px = 24. C'est le chiffre qui explique tout : un tap
  // tous les 24 texels, donc 23/24 de la carte jetes.
  assert.ok(Math.abs(rec({}).texelsPerEdge - 24) < 1e-9, `${rec({}).texelsPerEdge} != 24`);
  assert.ok(Math.abs(texPerMm(APP, 600, 600) - 24) < 1e-9);
});

check('sous-echantillonne SANS prefiltre : le flou prend le relais (sigma = empreinte / 2)', () => {
  const r = rec({});
  assert.equal(r.reason, 'undersampled');
  assert.equal(r.sigma, 12);
  assert.equal(r.clamped, false);
});

check('INVARIANT anti-double-filtrage : prefiltre actif => l\'auto ne propose RIEN', () => {
  // Balayage large : quelle que soit la configuration, on ne doit jamais
  // empiler un flou global par-dessus le prefiltre par sommet.
  let n = 0;
  for (const refineLength of [0.05, 0.2, 1, 2, 5])
    for (const scale of [2, 10, 25, 200])
      for (const texW of [128, 600, 1280]) {
        const r = recommendedSmoothing({
          settings: { scaleU: scale, scaleV: scale }, texW, texH: texW,
          refineLength, antialias: true,
        });
        assert.equal(r.sigma, 0, `sigma ${r.sigma} propose alors que le prefiltre est actif`);
        n++;
      }
  assert.equal(n, 60, 'le balayage doit vraiment couvrir 60 configurations');
});

check('maille qui RESOUT la carte : rien a filtrer, meme prefiltre coupe', () => {
  // 0.04 mm d'arete x 24 texels/mm = 0.96 texel : on echantillonne plus fin que
  // la carte. Flouter ici ne ferait que detruire du detail que l'export porte.
  const r = rec({ refineLength: 0.04 });
  assert.equal(r.reason, 'resolved');
  assert.equal(r.sigma, 0);
});

check('sigma plafonne au maximum du slider, et le DIT', () => {
  const r = rec({ refineLength: 3 });          // veut 36, slider max 20
  assert.equal(r.clamped, true);
  assert.equal(r.sigma, 20);
  assert.ok(r.texelsPerEdge / 2 > 20, 'le cas ne saturerait pas');
});

check('carte non carree : l\'axe le plus DENSE decide', () => {
  // Meme convention isotrope que le prefiltre mip : les deux doivent decrire la
  // MEME empreinte, sinon le diagnostic affiche autre chose que ce que le
  // sampler applique.
  const wide = { scaleU: 25, scaleV: 25, textureAspectU: 1, textureAspectV: 2 };
  // aspectV = 2 -> periode V = 12.5 mm pour 300 px => 24 px/mm, comme U.
  assert.ok(Math.abs(texPerMm(wide, 600, 300) - 24) < 1e-9, texPerMm(wide, 600, 300));
});

check('entrees degenerees : pas de recommandation inventee', () => {
  for (const bad of [{ texW: 0 }, { texH: 0 }, { refineLength: 0 }, { refineLength: -1 }]) {
    const r = rec(bad);
    assert.equal(r.reason, 'unknown');
    assert.equal(r.sigma, 0);
  }
});

console.log(`\nVERDICT: ${fail ? 'FAIL' : 'PASS'}  (${pass} ok, ${fail} failed)`);
process.exit(fail ? 1 : 0);
