// Etalement des poids de projection autour d'une couture, sur une largeur
// exprimee en MILLIMETRES.
//
// LE PROBLEME
// -----------
// En projection cubique, l'axe est choisi d'apres la NORMALE. A une arete vive
// — un coin de batiment a 90 degres — la normale saute de 90 degres d'un coup,
// sans valeur intermediaire. Aucun melange fonde sur la normale n'a donc de
// quoi travailler : mesure, a « Seam Blend » MAXIMUM, le melange effectif vaut
// 0.0 % sur un mur plat, 0.1 % a 30 degres, et ne devient 50 % qu'a 45 degres.
//
// Le mecanisme existant (`blendNormalSmoothing`, k iterations de lissage
// laplacien) contourne cela en faisant balayer la normale progressivement
// autour de l'arete. Mais un lissage laplacien est une DIFFUSION : sa portee
// croit en racine(k), et proportionnellement au PAS du maillage. Mesure sur un
// cube (bande ou la normale devie encore de plus de 5 degres) :
//
//     k =   8  ->  1.88 mm        pas 2.0 mm  ->  8.75 mm
//     k =  32  ->  4.38 mm        pas 1.0 mm  ->  4.38 mm
//     k = 128  ->  8.75 mm        pas 0.5 mm  ->  2.19 mm
//     k = 512  -> 16.88 mm
//
// Deux consequences. La bande vaut environ 0.77 * racine(k) * pas, donc a la
// resolution d'export courante (0.15 mm) les 32 iterations par defaut ne
// couvrent que ~0.65 mm : invisible sur un batiment de 91 mm. Et surtout, elle
// RETRECIT quand on affine le maillage — affiner son export resserre la couture
// sans que l'on ait touche a quoi que ce soit. Atteindre 5 mm a 0.15 mm de pas
// demanderait ~1900 iterations sur des millions de sommets : impraticable.
//
// LA METHODE RETENUE
// ------------------
// On ne diffuse pas : on MESURE la distance geodesique a la couture, et on
// etale les poids sur exactement la largeur demandee. Un parcours multi-source
// borne a cette largeur suffit — son cout est proportionnel a la BANDE, pas au
// maillage, ce qui le rend utilisable a n'importe quelle resolution.
//
// La couture est reperee par un critere de GRAPHE, pas de normale : une arete
// du maillage dont les deux extremites n'ont pas le meme axe dominant. C'est
// vrai quel que soit le reglage de melange, y compris a zero.

/**
 * Adjacence des positions DEDUPLIQUEES, en CSR.
 *
 * Chaque triangle apporte ses trois aretes, dans les deux sens. Les doublons
 * sont conserves : deux surfaces qui partagent beaucoup d'aretes se couplent
 * d'autant plus, ce qui est le comportement voulu.
 *
 * @returns {{csrStart: Uint32Array, neighbors: Uint32Array}}
 */
export function buildDedupAdjacency(vertexId, count, uniqueCount) {
  const degree = new Uint32Array(uniqueCount);
  for (let t = 0; t < count; t += 3) {
    const a = vertexId[t], b = vertexId[t + 1], c = vertexId[t + 2];
    if (a !== b) { degree[a]++; degree[b]++; }
    if (b !== c) { degree[b]++; degree[c]++; }
    if (c !== a) { degree[c]++; degree[a]++; }
  }
  const csrStart = new Uint32Array(uniqueCount + 1);
  for (let id = 0; id < uniqueCount; id++) csrStart[id + 1] = csrStart[id] + degree[id];
  const neighbors = new Uint32Array(csrStart[uniqueCount]);
  const cursor = new Uint32Array(uniqueCount);
  for (let t = 0; t < count; t += 3) {
    const a = vertexId[t], b = vertexId[t + 1], c = vertexId[t + 2];
    if (a !== b) { neighbors[csrStart[a] + cursor[a]++] = b; neighbors[csrStart[b] + cursor[b]++] = a; }
    if (b !== c) { neighbors[csrStart[b] + cursor[b]++] = c; neighbors[csrStart[c] + cursor[c]++] = b; }
    if (c !== a) { neighbors[csrStart[c] + cursor[c]++] = a; neighbors[csrStart[a] + cursor[a]++] = c; }
  }
  return { csrStart, neighbors };
}

/** Axe dominant d'un vecteur de poids : 0 = X, 1 = Y, 2 = Z. */
function axeDominant(wX, wY, wZ, id) {
  const x = wX[id], y = wY[id], z = wZ[id];
  if (x >= y && x >= z) return 0;
  return y >= z ? 1 : 2;
}

/** Interpolation douce, derivee nulle aux deux bouts. */
function adoucir(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/**
 * Etale les poids de projection autour des coutures, sur `widthMm`.
 *
 * Les tableaux de poids sont modifies EN PLACE. `widthMm <= 0` ne fait rien du
 * tout — pas une boucle qui ne modifie rien, mais un retour immediat : c'est ce
 * qui garantit que la fonctionnalite desactivee est strictement l'ancien
 * comportement, sans avoir a s'en remettre a une comparaison de flottants.
 *
 * @param {Object}  a
 * @param {Float32Array|Float64Array} a.wX,a.wY,a.wZ  poids par position dedupliquee
 * @param {number}  a.uniqueCount
 * @param {Uint32Array} a.csrStart,a.neighbors        adjacence dedupliquee
 * @param {Float64Array} a.posX,a.posY,a.posZ         position par id (mm)
 * @param {number}  a.widthMm                          largeur de la bande, en mm
 * @returns {{seeds:number, visited:number, maxDist:number, skipped:boolean}}
 */
export function spreadSeamWeights({ wX, wY, wZ, uniqueCount, csrStart, neighbors,
                                    posX, posY, posZ, widthMm }) {
  if (!(widthMm > 0)) return { seeds: 0, visited: 0, maxDist: 0, skipped: true };

  // ── 1. Repérage des coutures, par un critere de GRAPHE ────────────────────
  // Une arete dont les deux bouts n'ont pas le meme axe dominant traverse une
  // couture. On ne consulte aucune normale : le repérage reste donc valable
  // meme quand le melange par normale est a zero, cas ou il n'y a justement
  // rien a lire.
  const estSource = new Uint8Array(uniqueCount);
  let seeds = 0;
  for (let id = 0; id < uniqueCount; id++) {
    const a = axeDominant(wX, wY, wZ, id);
    for (let k = csrStart[id], e = csrStart[id + 1]; k < e; k++) {
      if (axeDominant(wX, wY, wZ, neighbors[k]) !== a) {
        if (!estSource[id]) { estSource[id] = 1; seeds++; }
        break;
      }
    }
  }
  if (seeds === 0) return { seeds: 0, visited: 0, maxDist: 0, skipped: false };

  // ── 2. Poids de couture : la moyenne locale, de part et d'autre ───────────
  // On prend, pour chaque source, la moyenne de ses propres poids et de ceux de
  // ses voisins. A un coin a 90 degres cela donne naturellement ~50/50 entre
  // les deux axes — sans dependre du reglage de melange, qui peut valoir zero.
  const srcX = new Float32Array(uniqueCount);
  const srcY = new Float32Array(uniqueCount);
  const srcZ = new Float32Array(uniqueCount);
  for (let id = 0; id < uniqueCount; id++) {
    if (!estSource[id]) continue;
    let sx = wX[id], sy = wY[id], sz = wZ[id], n = 1;
    for (let k = csrStart[id], e = csrStart[id + 1]; k < e; k++) {
      const nb = neighbors[k];
      sx += wX[nb]; sy += wY[nb]; sz += wZ[nb]; n++;
    }
    const s = sx + sy + sz;
    if (s > 1e-12) { srcX[id] = sx / s; srcY[id] = sy / s; srcZ[id] = sz / s; }
    else { srcX[id] = wX[id]; srcY[id] = wY[id]; srcZ[id] = wZ[id]; }
  }

  // ── 3. Distance geodesique aux coutures, BORNEE a widthMm ────────────────
  // Relaxation en file (type SPFA) : les distances ne progressent que si elles
  // s'ameliorent, et rien au-dela de la largeur demandee n'est jamais visite.
  // Le cout est donc proportionnel a la BANDE, pas au maillage — c'est ce qui
  // rend le procede utilisable a 0.15 mm de resolution.
  const dist = new Float32Array(uniqueCount).fill(Infinity);
  const porteX = new Float32Array(uniqueCount);
  const porteY = new Float32Array(uniqueCount);
  const porteZ = new Float32Array(uniqueCount);
  const dansFile = new Uint8Array(uniqueCount);
  let file = new Uint32Array(seeds);
  let nFile = 0;
  for (let id = 0; id < uniqueCount; id++) {
    if (!estSource[id]) continue;
    dist[id] = 0;
    porteX[id] = srcX[id]; porteY[id] = srcY[id]; porteZ[id] = srcZ[id];
    file[nFile++] = id;
    dansFile[id] = 1;
  }

  let visited = seeds, maxDist = 0;
  let tete = 0;
  const pousser = (id) => {
    if (dansFile[id]) return;
    if (tete > 0 && nFile === file.length) {          // compacter avant d'agrandir
      file.copyWithin(0, tete, nFile); nFile -= tete; tete = 0;
    }
    if (nFile === file.length) {
      const plus = new Uint32Array(Math.max(16, file.length * 2));
      plus.set(file.subarray(0, nFile)); file = plus;
    }
    file[nFile++] = id;
    dansFile[id] = 1;
  };

  while (tete < nFile) {
    const id = file[tete++];
    dansFile[id] = 0;
    const d0 = dist[id];
    if (d0 >= widthMm) continue;
    const x0 = posX[id], y0 = posY[id], z0 = posZ[id];
    for (let k = csrStart[id], e = csrStart[id + 1]; k < e; k++) {
      const nb = neighbors[k];
      const dx = posX[nb] - x0, dy = posY[nb] - y0, dz = posZ[nb] - z0;
      const nd = d0 + Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (nd >= widthMm || nd >= dist[nb]) continue;
      if (dist[nb] === Infinity) visited++;
      dist[nb] = nd;
      if (nd > maxDist) maxDist = nd;
      porteX[nb] = porteX[id]; porteY[nb] = porteY[id]; porteZ[nb] = porteZ[id];
      pousser(nb);
    }
  }

  // ── 4. Application : du poids de couture au poids propre, en douceur ──────
  for (let id = 0; id < uniqueCount; id++) {
    const d = dist[id];
    if (!(d < widthMm)) continue;                     // hors bande (et gere Infinity)
    const t = adoucir(d / widthMm);                   // 0 sur la couture, 1 au bord
    const ax = porteX[id] * (1 - t) + wX[id] * t;
    const ay = porteY[id] * (1 - t) + wY[id] * t;
    const az = porteZ[id] * (1 - t) + wZ[id] * t;
    const s = ax + ay + az;
    if (s > 1e-12) { wX[id] = ax / s; wY[id] = ay / s; wZ[id] = az / s; }
  }

  return { seeds, visited, maxDist, skipped: false };
}
