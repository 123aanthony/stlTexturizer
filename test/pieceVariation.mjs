// Variation du motif par PIÈCE (js/pieceVariation.js + son câblage moteur).
//
// Le defaut vise : une projection est GLOBALE, donc le veinage du bois traverse
// d'un trait continu toutes les lattes d'une porte. Chaque latte devrait avoir
// son propre veinage — decalage different, et une sur deux retournee.
//
// Ce que ce fichier prouve :
//   1. aux valeurs neutres, le moteur rend une geometrie BIT-IDENTIQUE a celle
//      obtenue sans variation du tout (l'engagement pris : ramener les reglages
//      a zero redonne exactement l'etat d'origine) ;
//   2. active, elle DECORRELE reellement deux pieces voisines ;
//   3. la cle est le CENTROIDE : renumeroter les pieces ne change RIEN
//      (sinon le veinage sauterait a chaque re-import) ;
//   4. deux pieces qui se TOUCHENT ne se fissurent pas — un seul proprietaire
//      par sommet unique, donc toutes ses copies bougent ensemble ;
//   5. le mode CUBIQUE, qui court-circuite computeUV, applique la variation lui
//      aussi (sinon il l'ignorerait en silence a l'export) ;
//   6. determinisme : meme graine => meme resultat.

import * as THREE from 'three';
import assert from 'node:assert/strict';
import { subdivide } from '../js/subdivision.js';
import { applyDisplacement } from '../js/displacement.js';
import {
  isPieceVariationActive,
  pieceKey,
  pieceTransform,
  PIECE_VARIATION_DEFAULTS,
  buildPieceXforms,
} from '../js/pieceVariation.js';
import { proceduralTexture } from './lib/texture.mjs';
import { computeBounds } from './lib/pipeline.mjs';
import { fingerprintGeometry } from './lib/fingerprint.mjs';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

const BASE = {
  mappingMode: 5, scaleUnit: 'mm', scaleU: 12, scaleV: 12,
  offsetU: 0, offsetV: 0, rotation: 0,
  amplitude: 1.5, symmetricDisplacement: false,
  topAngleLimit: 0, bottomAngleLimit: 0,
  mappingBlend: 0, seamBandWidth: 0.35, blendNormalSmoothing: 0,
  boundaryFalloff: 0, noDownwardZ: false,
  // ⚠️ PREFILTRE COUPE ICI, et c'est un choix d'ISOLATION de variable, pas un
  // contournement. Ce fichier mesure une DECORRELATION D'UV ; l'antialiasing,
  // lui, comprime le contraste quand la maille ne resout pas la carte — ce qui
  // est son travail. Sur ce fixture volontairement serre (tuile 8.3 mm, carte
  // 128 px, aretes ~2 mm) l'empreinte vaut ~31 texels, soit lod ~5 : MESURE, la
  // plage de deplacement tombait a 0.45 mm au lieu de 1.18, et l'effet a
  // mesurer se noyait dedans. Le prefiltre a sa propre batterie (mipPyramid).
  textureAntialias: false,
};

/**
 * Une « porte » : NB lattes de 8 mm, separees par une rainure de 0.3 mm — la
 * geometrie exacte que produit FW Diorama (fw_espacement = 0.3), donc des
 * pieces DISJOINTES qui ne partagent aucun sommet.
 */
function planks(nb = 4, w = 8, gap = 0.3) {
  const geos = [];
  for (let i = 0; i < nb; i++) {
    const g = new THREE.BoxGeometry(w, 30, 3, 4, 12, 1).toNonIndexed();
    g.translate(i * (w + gap), 0, 0);
    geos.push(g);
  }
  const total = geos.reduce((n, g) => n + g.attributes.position.count, 0);
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  let o = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, o);
    nrm.set(g.attributes.normal.array, o);
    o += g.attributes.position.count * 3;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return { geo: out, nb, pitch: w + gap };
}

/** Id de piece par triangle SUBDIVISE, deduit de l'abscisse (comme le ferait un solidOfTri). */
function pieceOfTriFrom(geo, pitch, label = (k) => k) {
  const p = geo.attributes.position.array;
  const n = (p.length / 9) | 0;
  const out = new Int32Array(n);
  for (let t = 0; t < n; t++) {
    const cx = (p[t * 9] + p[t * 9 + 3] + p[t * 9 + 6]) / 3;
    out[t] = label(Math.max(0, Math.round(cx / pitch)));
  }
  return out;
}

async function build(over, { label, texture } = {}) {
  const { geo, pitch } = planks();
  const { geometry: sub } = await subdivide(geo, 2.5, null, null);
  const bounds = computeBounds(geo);
  const settings = { ...BASE, ...over };
  if (over.pieceOfTri !== null) settings.pieceOfTri = pieceOfTriFrom(sub, pitch, label);
  const tex = texture || proceduralTexture(128, 128, 'sine');
  return applyDisplacement(sub, tex, tex.width, tex.height, settings, bounds, null);
}

const topZ = (g) => {
  const p = g.attributes.position.array, out = [];
  for (let i = 0; i < p.length; i += 3) if (p[i + 2] > 1.0) out.push([p[i], p[i + 2]]);
  return out;
};

console.log('\n1. Neutralite');

check('isPieceVariationActive est faux sur les defauts', () => {
  assert.equal(isPieceVariationActive({}), false);
  assert.equal(isPieceVariationActive({ ...PIECE_VARIATION_DEFAULTS }), false);
  // La graine seule ne declenche rien : sans ampleur, il n'y a rien a tirer.
  assert.equal(isPieceVariationActive({ pieceSeed: 1234 }), false);
});

check('chaque reglage non neutre le declenche', () => {
  assert.equal(isPieceVariationActive({ pieceOffset: 0.5 }), true);
  assert.equal(isPieceVariationActive({ pieceRotate: 2 }), true);
  assert.equal(isPieceVariationActive({ pieceFlip: true }), true);
});

check('transformation NEUTRE aux valeurs par defaut', () => {
  const x = pieceTransform(pieceKey(1, 2, 3, 42), {});
  assert.equal(x.du, 0); assert.equal(x.dv, 0);
  assert.equal(x.rotDeg, 0); assert.equal(x.mirrorU, false);
});

{
  const [neutre, sans] = await Promise.all([
    build({ pieceOffset: 0, pieceRotate: 0, pieceFlip: false }),
    build({ pieceOfTri: null }),
  ]);
  check('PIPELINE : reglages a zero == aucune variation, BIT A BIT', () => {
    // C'est l'engagement pris a l'utilisateur : « si avec les reglages
    // j'arrive a retrouver l'etat d'origine ». On le mesure, on ne le plaide pas.
    assert.deepEqual(
      Array.from(neutre.attributes.position.array),
      Array.from(sans.attributes.position.array));
  });
}

console.log('\n2. Decorrelation reelle');

{
  // ⚠️ CRITERE DERIVABLE, pas une statistique choisie au hasard.
  //
  // Premier jet : comparer la hauteur MOYENNE de chaque latte. C'etait la seule
  // statistique incapable de voir l'effet — la moyenne d'un motif periodique
  // est insensible a son DECALAGE DE PHASE, et un decalage de phase est
  // exactement ce que la variation produit. Mesure : 0.2203 sans variation
  // contre 0.1976 avec, soit un resultat qui semblait dire l'inverse du vrai.
  //
  // Ici on cale la TUILE sur le PAS DES LATTES (scaleU = pitch). Sans
  // variation, chaque latte tombe donc sur la meme phase et montre EXACTEMENT
  // le meme profil que sa voisine : c'est la definition du defaut decrit par
  // l'utilisateur, et ca se mesure a zero. Avec variation, les profils divergent.
  const PITCH = 8.3;

  /** Profil de hauteur echantillonne par ABSCISSE LOCALE dans chaque latte. */
  const profils = (g) => {
    const p = g.attributes.position.array;
    const BINS = 16;
    const acc = new Map();
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      if (z <= 1.0) continue;                       // face du dessus seulement
      // ⚠️ TRANCHE ETROITE EN Y, et c'est le coeur de la mesure.
      // En triplanaire, la face du dessus tire U de x et V de y. La latte fait
      // 30 mm en y pour une tuile de 8.3, soit 3.6 periodes du motif : moyenner
      // toute la hauteur reviendrait a moyenner un cosinus sur plusieurs
      // periodes, donc a rendre ~0.5 dans CHAQUE bin quel que soit le decalage.
      // C'est exactement l'erreur qui faisait lire 0.0071 puis 0.1061 mm : on
      // moyennait sur l'axe qui PORTE le signal. On fige donc V.
      if (Math.abs(y) > 1.5) continue;
      const k = Math.round(x / PITCH);              // numero de latte
      const local = x - k * PITCH;                  // position DANS la latte
      const b = Math.min(BINS - 1, Math.max(0, Math.floor((local / PITCH + 0.5) * BINS)));
      // Les faces LATERALES sont deplacees en X et debordent sur des indices de
      // latte fantomes (mesure : L-1 et L4 sur 4 lattes). On reste au coeur.
      if (Math.abs(local) > 3.2) continue;
      if (!acc.has(k)) acc.set(k, Array.from({ length: BINS }, () => []));
      acc.get(k)[b].push(z);
    }
    return [...acc.entries()].filter(([, bins]) => bins.some(v => v.length))
      .sort((a, b) => a[0] - b[0]).map(([, bins]) =>
      bins.map(v => v.length ? v.reduce((s2, z) => s2 + z, 0) / v.length : NaN));
  };

  /** Ecart maximal entre les profils de deux lattes, bin par bin. */
  const divergence = (ps) => {
    let mx = 0;
    for (let a = 0; a < ps.length; a++) for (let b = a + 1; b < ps.length; b++) {
      for (let i = 0; i < ps[a].length; i++) {
        const d = Math.abs(ps[a][i] - ps[b][i]);
        if (Number.isFinite(d) && d > mx) mx = d;
      }
    }
    return mx;
  };

  const [plat, varie] = await Promise.all([
    build({ pieceOfTri: null, scaleU: PITCH, scaleV: PITCH }),
    build({ pieceOffset: 1, pieceSeed: 7, scaleU: PITCH, scaleV: PITCH }),
  ]);
  const dPlat = divergence(profils(plat));
  const dVar  = divergence(profils(varie));
  console.log(`       divergence entre lattes : continu ${dPlat.toFixed(4)} mm`
            + `  ->  varie ${dVar.toFixed(4)} mm`);

  check('ORACLE VIVANT : sans variation, toutes les lattes sont IDENTIQUES', () => {
    // C'est litteralement le defaut decrit : « le motif est continu sur toutes
    // les planches ». A tuile calee sur le pas, ca donne des jumelles parfaites.
    assert.ok(dPlat < 0.02, `${dPlat.toFixed(4)} mm d'ecart : les lattes ne sont deja pas identiques`);
  });

  check('avec variation, chaque latte prend son propre motif', () => {
    // Amplitude 1.5 mm : une decorrelation reelle doit produire un ecart de
    // l'ordre de l'amplitude, pas quelques centiemes.
    assert.ok(dVar > 0.5, `${dVar.toFixed(4)} mm : les lattes se ressemblent encore`);
  });
}

console.log('\n3. La cle est le CENTROIDE, pas le numero de piece');

{
  const [a, b] = await Promise.all([
    build({ pieceOffset: 1, pieceSeed: 3 }),
    // MEME partition, etiquettes renumerotees dans le desordre.
    build({ pieceOffset: 1, pieceSeed: 3 }, { label: (k) => [17, 4, 99, 42][k % 4] }),
  ]);
  check('renumeroter les pieces ne change RIEN', () => {
    // Sans cette propriete, un re-import ou un changement de version de FreeCAD
    // redistribuerait tout le veinage sans que rien de visible n'ait bouge.
    assert.deepEqual(
      Array.from(a.attributes.position.array),
      Array.from(b.attributes.position.array));
  });
}

console.log('\n4. Determinisme');

{
  const [g1, g2, g3] = await Promise.all([
    build({ pieceOffset: 1, pieceSeed: 11 }),
    build({ pieceOffset: 1, pieceSeed: 11 }),
    build({ pieceOffset: 1, pieceSeed: 12 }),
  ]);
  check('meme graine => meme geometrie', () => {
    assert.deepEqual(Array.from(g1.attributes.position.array),
                     Array.from(g2.attributes.position.array));
  });
  check('graine differente => geometrie differente', () => {
    assert.notDeepEqual(Array.from(g1.attributes.position.array),
                        Array.from(g3.attributes.position.array));
  });
}

console.log('\n5. Pieces JOINTIVES : pas de fissure');

{
  // Ici les lattes se TOUCHENT (rainure nulle) : elles partagent des sommets.
  // C'est le cas dangereux — deux UV differentes sur une meme position
  // ouvriraient une fente. Le moteur choisit UN proprietaire par sommet unique,
  // donc toutes les copies bougent ensemble.
  const { geo } = planks(3, 8, 0);
  const { geometry: sub } = await subdivide(geo, 2.5, null, null);
  const bounds = computeBounds(geo);
  const tex = proceduralTexture(128, 128, 'sine');
  const pot = pieceOfTriFrom(sub, 8);
  const g = applyDisplacement(sub, tex, tex.width, tex.height,
    { ...BASE, pieceOfTri: pot, pieceOffset: 1, pieceFlip: true, pieceSeed: 5 }, bounds, null);

  const sansVar = applyDisplacement(sub, tex, tex.width, tex.height, { ...BASE }, bounds, null);
  const fp = fingerprintGeometry(g);
  const fp0 = fingerprintGeometry(sansVar);
  console.log(`       aretes ouvertes ${fp0.openEdges} -> ${fp.openEdges}`
            + ` | non-manifold ${fp0.nonManifold} -> ${fp.nonManifold}`);

  check('aucune arete ouverte introduite par la variation', () => {
    assert.equal(fp.openEdges, 0, `${fp.openEdges} aretes ouvertes : la variation a fissure le maillage`);
  });

  check('le non-manifold n\'AUGMENTE pas', () => {
    // Le fixture en compte deja (deux boites collees partagent une face, donc
    // 4 triangles par arete). Ce qui compte n'est pas sa valeur absolue mais
    // que la variation n'en ajoute AUCUN — comparaison, pas seuil.
    assert.ok(fp.nonManifold <= fp0.nonManifold,
      `${fp0.nonManifold} -> ${fp.nonManifold} : la variation a degrade la topologie`);
  });

  check('la variation agit quand meme sur des pieces jointives', () => {
    assert.notDeepEqual(Array.from(g.attributes.position.array),
                        Array.from(sansVar.attributes.position.array));
  });
}

console.log('\n6. Le mode CUBIQUE ne l\'ignore pas en silence');

{
  // Ce mode court-circuite computeUV par un chemin rapide dedie ; c'est le
  // piege classique — marcher a l'apercu et ne rien faire a l'export.
  const [cubNeutre, cubSans, cubVarie] = await Promise.all([
    build({ mappingMode: 6, pieceOffset: 0 }),
    build({ mappingMode: 6, pieceOfTri: null }),
    build({ mappingMode: 6, pieceOffset: 1, pieceSeed: 9 }),
  ]);
  check('cubique : a zero, bit-identique', () => {
    assert.deepEqual(Array.from(cubNeutre.attributes.position.array),
                     Array.from(cubSans.attributes.position.array));
  });
  check('cubique : actif, la variation s\'applique', () => {
    assert.notDeepEqual(Array.from(cubVarie.attributes.position.array),
                        Array.from(cubSans.attributes.position.array));
  });
}

console.log('');
console.log('7. Seuil de taille : les petites pieces ne varient pas');

/**
 * Deux pieces : un CARRE de `c` mm de cote, et une LATTE longue et fine.
 *
 * La latte est le cas qui compte. Elle est mince sur un axe et longue sur
 * l'autre : une taille mesuree sur la plus PETITE dimension l'eliminerait avec
 * les rivets, et mesuree sur la DIAGONALE une plaque mince passerait pour une
 * grande piece. On mesure donc la plus GRANDE dimension.
 */
function deuxPieces(c, longueur) {
  const t = [];
  const quad = (a, b, d, e) => { t.push(...a, ...b, ...d, ...a, ...d, ...e); };
  quad([0, 0, 0], [c, 0, 0], [c, c, 0], [0, c, 0]);
  quad([100, 0, 0], [100 + longueur, 0, 0], [100 + longueur, 1, 0], [100, 1, 0]);
  return { positions: Float32Array.from(t), pieceOfTri: Int32Array.from([0, 0, 1, 1]) };
}

const REGL = { pieceOffset: 1, pieceRotate: 5, pieceFlip: true, pieceSeed: 7 };

check('a seuil nul, la table est BIT-IDENTIQUE a l\'absence de seuil', () => {
  const { positions, pieceOfTri } = deuxPieces(3, 40);
  const sans = buildPieceXforms(positions, pieceOfTri, REGL);
  const zero = buildPieceXforms(positions, pieceOfTri, { ...REGL, pieceMinSizeMm: 0 });
  assert.deepEqual(zero.table, sans.table);
});

check('une piece plus petite que le seuil est laissee INTACTE', () => {
  const { positions, pieceOfTri } = deuxPieces(3, 40);
  const r = buildPieceXforms(positions, pieceOfTri, { ...REGL, pieceMinSizeMm: 10 });
  const petite = r.table[r.index[0]];
  assert.equal(petite.du, 0, 'la petite piece a bouge');
  assert.equal(petite.dv, 0);
  assert.equal(petite.rotDeg, 0);
  assert.equal(petite.mirrorU, false);
  assert.equal(r.ignorees, 1, 'ignorees = ' + r.ignorees + ', attendu 1');
});

check('une LATTE longue et fine survit au seuil', () => {
  const { positions, pieceOfTri } = deuxPieces(3, 40);
  const r = buildPieceXforms(positions, pieceOfTri, { ...REGL, pieceMinSizeMm: 10 });
  const latte = r.table[r.index[2]];
  assert.ok(latte.du !== 0 || latte.dv !== 0 || latte.rotDeg !== 0 || latte.mirrorU,
    'la latte de 40 mm a ete ignoree alors qu elle depasse le seuil de 10 mm');
});

check('le seuil est un PLANCHER, compare a la plus grande dimension', () => {
  const { positions, pieceOfTri } = deuxPieces(3, 40);
  const haut = buildPieceXforms(positions, pieceOfTri, { ...REGL, pieceMinSizeMm: 50 });
  assert.equal(haut.ignorees, 2, 'a 50 mm les deux devraient tomber, obtenu ' + haut.ignorees);
  const bas = buildPieceXforms(positions, pieceOfTri, { ...REGL, pieceMinSizeMm: 2 });
  assert.equal(bas.ignorees, 0, 'a 2 mm aucune ne devrait tomber, obtenu ' + bas.ignorees);
});
console.log(`\nVERDICT: ${fail ? 'FAIL' : 'PASS'}  (${pass} ok, ${fail} failed)`);
process.exit(fail ? 1 : 0);
