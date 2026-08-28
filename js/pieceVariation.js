/**
 * pieceVariation.js — un grain différent sur chaque pièce.
 *
 * LE DÉFAUT
 * ---------
 * Une projection est GLOBALE : toutes les lattes d'une porte partagent le même
 * repère UV, donc le veinage du bois traverse les planches d'un trait continu.
 * Aucun menuisier n'a jamais debite une porte dans une planche unique — chaque
 * latte vient d'un autre endroit de la grume, avec ses propres veines, et une
 * sur deux est retournee bout pour bout.
 *
 * CE QUE FAIT CE MODULE
 * ---------------------
 * Il rend, pour une pièce donnée, un petit décalage UV / une rotation / un
 * miroir, tirés d'une graine. C'est tout : il ne sait rien de la géométrie, ne
 * lit aucun fichier, ne touche à rien. La partie « qui est quelle pièce » vit
 * ailleurs (identite de solide STEP, ou composantes connexes) ; la partie
 * « comment appliquer la transformation » vit dans mapping.js.
 *
 * ORTHOGONAL, PAS UN MODE DE PROJECTION
 * -------------------------------------
 * On aurait pu en faire un 12e mode a cote des 11 existants. C'aurait ete PLUS
 * risque pour l'existant, pas moins : le numero de mode est teste en dur dans
 * au moins 14 endroits hors de mapping.js (displacement.js:64/246/605,
 * main.js:1987/2061/3560/3567/4964/5366, previewMaterial.js:118-131...), et
 * chacun est une occasion d'oublier le nouveau venu EN SILENCE — exactement le
 * piege du chemin rapide cubique, qui court-circuite computeUV. Un modificateur
 * neutre par defaut se compose au contraire avec les 11 modes d'un coup.
 *
 * NEUTRALITÉ PAR CONSTRUCTION
 * ---------------------------
 * `isPieceVariationActive` teste l'EGALITE aux valeurs neutres. Quand elle est
 * fausse, l'appelant ne construit aucune table et ne passe aucun `pieceXform` :
 * `computeUV` lit alors ses `?? 0` habituels et execute LA MEME LIGNE
 * qu'aujourd'hui. Pas « equivalente » — la meme. C'est ce qui permet aux 13
 * empreintes golden de rester inchangees, et c'est l'engagement pris : ramener
 * les reglages a zero redonne exactement l'etat d'origine.
 *
 * ⚠️ LA CLÉ EST LE CENTROÏDE, PAS L'INDEX DE PIÈCE.
 * Hacher l'index rendrait le resultat dependant de l'ORDRE des triangles : un
 * ré-import, un changement de version de FreeCAD ou une renumerotation des
 * solides redistribuerait tout le veinage sans que rien de visible n'ait bouge.
 * On hache donc la position MOYENNE de la piece, quantifiee au dixieme de mm :
 * une planche garde son veinage tant qu'elle reste au meme endroit, et deux
 * planches identiques a deux endroits differents en recoivent deux differents.
 */

/** Réglages neutres : à ces valeurs, la variation est inactive. */
export const PIECE_VARIATION_DEFAULTS = Object.freeze({
  pieceOffset: 0,   // 0-1 : ampleur du décalage aléatoire le long du motif
  pieceRotate: 0,   // degrés : rotation aléatoire max, +/- cette valeur
  pieceFlip: false,
  // Taille MINIMALE d'une piece pour qu'elle varie, en millimetres. 0 = aucun
  // seuil, donc le comportement historique au bit pres.
  //
  // Mesure qui l'a motive, sur un modele reel : le slot du bois d'une porte
  // comptait 118 « pieces », dont 67 de moins de 9 mm et d'a peine 1.93 mm
  // d'epaisseur, eparpillees sur 86 x 71 x 68 mm — des clous et de petites
  // ferrures, pas des planches. Avec un decalage de 0.3 tuile, 8 degres
  // d'inclinaison et un retournement, chacune recevait son propre veinage :
  // l'oeil y lisait un patchwork. Une tete de clou de 2 mm n'a pas de fil.
  pieceMinSizeMm: 0, // retourner pseudo-aléatoirement une pièce sur deux
});

/**
 * Y a-t-il quelque chose à faire ?
 *
 * Test d'EGALITE aux valeurs neutres, pas un seuil : l'appelant s'en sert pour
 * ne RIEN construire du tout, donc un faux positif couterait une passe inutile
 * et, pire, ferait diverger le resultat d'un export cense etre inchange.
 */
export function isPieceVariationActive(s = {}) {
  const d = PIECE_VARIATION_DEFAULTS;
  return (s.pieceOffset ?? d.pieceOffset) !== d.pieceOffset
      || (s.pieceRotate ?? d.pieceRotate) !== d.pieceRotate
      || (s.pieceFlip   ?? d.pieceFlip)   !== d.pieceFlip;
}

/**
 * Hachage entier 32 bits (variante de splitmix32).
 *
 * Deterministe et sans etat : la meme entree rend toujours la meme sortie, quel
 * que soit l'ordre des appels. Un generateur a etat (mulberry32 avance a chaque
 * piece) aurait fait dependre le resultat de l'ORDRE DE PARCOURS des pieces,
 * donc de l'ordre des triangles — precisement ce qu'on veut eviter.
 */
function hash32(x) {
  x = (x + 0x9E3779B9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x21F0AAAD);
  x = Math.imul(x ^ (x >>> 15), 0x735A2D97);
  return (x ^ (x >>> 15)) >>> 0;
}

/** Flottant dans [0,1) tiré de (clé, canal). */
function rand01(key, channel) {
  return hash32(key ^ Math.imul(channel + 1, 0x45D9F3B)) / 4294967296;
}

/**
 * Clé stable d'une pièce, à partir de sa position MOYENNE et de la graine.
 *
 * Quantifiée au dixième de millimètre : assez fin pour distinguer deux lattes
 * voisines (une latte fait quelques mm), assez grossier pour que le bruit de
 * calcul en virgule flottante ne fasse pas sauter la clé d'un export à l'autre.
 *
 * @param {number} cx @param {number} cy @param {number} cz  centroïde, en mm
 * @param {number} seed
 */
export function pieceKey(cx, cy, cz, seed = 0) {
  const q = (v) => Math.round(v * 10) | 0;
  let k = hash32(q(cx) ^ 0x9E3779B9);
  k = hash32(k ^ q(cy));
  k = hash32(k ^ q(cz));
  return hash32(k ^ (seed | 0));
}

/**
 * Transformation UV d'une pièce.
 *
 * @param {number} key      de pieceKey()
 * @param {object} settings pieceOffset / pieceRotate / pieceFlip
 * @returns {{du:number, dv:number, rotDeg:number, mirrorU:boolean}}
 *          `du`/`dv` en TOURS de motif (1 = une tuile entière), `rotDeg` en degrés.
 */
export function pieceTransform(key, settings = {}) {
  const d = PIECE_VARIATION_DEFAULTS;
  const amount = settings.pieceOffset ?? d.pieceOffset;
  const rotMax = settings.pieceRotate ?? d.pieceRotate;
  const flip   = settings.pieceFlip   ?? d.pieceFlip;

  return {
    // Décalage LE LONG du motif : c'est lui qui décorrèle vraiment deux lattes
    // voisines, puisque le veinage du bois court dans cette direction.
    du: amount === 0 ? 0 : amount * rand01(key, 0),
    // En travers : plus discret, mais c'est ce qui change les veines montrées
    // plutôt que de les faire seulement glisser.
    dv: amount === 0 ? 0 : amount * rand01(key, 1),
    // Rotation SYMÉTRIQUE autour de 0 : un bois legerement de travers reste du
    // bois, un bois tourne toujours dans le meme sens se voit.
    // `rotMax === 0` court-circuite : `0 * negatif` rend -0, et -0 n'est pas 0
    // pour un comparateur strict. Une valeur neutre doit l'etre au bit pres.
    rotDeg: rotMax === 0 ? 0 : rotMax * (rand01(key, 2) * 2 - 1),
    // Retournement bout pour bout : ~une piece sur deux.
    mirrorU: flip && rand01(key, 3) < 0.5,
  };
}

/** Transformation NEUTRE — l'identité. Utile comme repli explicite. */
export const NEUTRAL_XFORM = Object.freeze({ du: 0, dv: 0, rotDeg: 0, mirrorU: false });

/**
 * Table des transformations d'un maillage : une entrée par pièce.
 *
 * SOURCE UNIQUE, et c'est le point important. Deux consommateurs en dépendent —
 * le moteur CPU (`displacement.js`, qui produit le maillage exporté) et
 * l'aperçu GPU (l'attribut par sommet lu par le shader). S'ils calculaient
 * chacun leur table, ils divergeraient au premier détail : une pondération
 * d'aire, un arrondi de centroïde, un ordre de parcours. L'aperçu montrerait
 * alors un bois, l'export en imprimerait un autre — le pire défaut possible ici,
 * parce que rien ne le signalerait.
 *
 * Le centroïde est pondéré PAR L'AIRE et non par le nombre de triangles : une
 * face densément maillée tirerait sinon le centre vers elle, et la clé — donc
 * le veinage — changerait au moindre changement de résolution.
 *
 * @param {Float32Array} positions  positions du maillage, non indexé (x,y,z par sommet)
 * @param {Int32Array}   pieceOfTri identifiant de pièce par triangle (épars accepté)
 * @param {object}       settings   pieceOffset / pieceRotate / pieceFlip / pieceSeed
 * @returns {{index: Int32Array, table: Array, count: number}}
 *          `index[t]` = indice DENSE de la pièce du triangle t ; `table[i]` = sa
 *          transformation.
 */
export function buildPieceXforms(positions, pieceOfTri, settings = {}) {
  const triCount = pieceOfTri.length;

  // Compactage : les identifiants viennent d'un solide STEP ou d'une composante
  // connexe, donc épars et potentiellement grands. On les ramène à [0, n) pour
  // pouvoir indexer des tableaux plats.
  const seen = new Map();
  const index = new Int32Array(triCount);
  let count = 0;
  for (let t = 0; t < triCount; t++) {
    const raw = pieceOfTri[t];
    let k = seen.get(raw);
    if (k === undefined) { k = count++; seen.set(raw, k); }
    index[t] = k;
  }

  const cx = new Float64Array(count), cy = new Float64Array(count);
  const cz = new Float64Array(count), ca = new Float64Array(count);
  // Boite englobante par piece — seulement si un seuil est demande. Sans cela
  // on paierait six tableaux et un balayage pour rien sur le chemin courant.
  const minSize = Math.max(0, settings.pieceMinSizeMm ?? PIECE_VARIATION_DEFAULTS.pieceMinSizeMm);
  const bb = minSize > 0 ? {
    lo: new Float64Array(count * 3).fill(Infinity),
    hi: new Float64Array(count * 3).fill(-Infinity),
  } : null;
  for (let t = 0; t < triCount; t++) {
    const a = t * 9;
    const ax = positions[a],     ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[a + 3], by = positions[a + 4], bz = positions[a + 5];
    const dx = positions[a + 6], dy = positions[a + 7], dz = positions[a + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = dx - ax, vy = dy - ay, vz = dz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const area = Math.sqrt(nx * nx + ny * ny + nz * nz);   // = 2x l'aire
    if (!(area > 0)) continue;                             // degenere : ne vote pas
    const p = index[t];
    cx[p] += ((ax + bx + dx) / 3) * area;
    cy[p] += ((ay + by + dy) / 3) * area;
    cz[p] += ((az + bz + dz) / 3) * area;
    ca[p] += area;
    if (bb) {
      const b = p * 3;
      for (let v = 0; v < 3; v++) {
        const o = a + v * 3;
        for (let k = 0; k < 3; k++) {
          const q = positions[o + k];
          if (q < bb.lo[b + k]) bb.lo[b + k] = q;
          if (q > bb.hi[b + k]) bb.hi[b + k] = q;
        }
      }
    }
  }

  const seed = settings.pieceSeed | 0;
  const table = new Array(count);
  let ignorees = 0;
  for (let i = 0; i < count; i++) {
    const a = ca[i] || 1;
    if (bb) {
      // TAILLE = la plus grande dimension de la boite englobante. Une planche
      // est longue et fine : sa longueur la sauve. Un rivet est petit dans les
      // TROIS axes. Prendre la diagonale ferait passer une plaque mince pour
      // une grande piece ; prendre la plus petite dimension eliminerait toutes
      // les planches.
      const b = i * 3;
      const dx = bb.hi[b] - bb.lo[b];
      const dy = bb.hi[b + 1] - bb.lo[b + 1];
      const dz = bb.hi[b + 2] - bb.lo[b + 2];
      const grand = Math.max(dx, dy, dz);
      if (Number.isFinite(grand) && grand < minSize) {
        table[i] = NEUTRAL_XFORM;
        ignorees++;
        continue;
      }
    }
    table[i] = pieceTransform(pieceKey(cx[i] / a, cy[i] / a, cz[i] / a, seed), settings);
  }
  return { index, table, count, ignorees };
}
