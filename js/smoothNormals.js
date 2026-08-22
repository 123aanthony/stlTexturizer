/**
 * smoothNormals.js — normales lissées pour l'AFFICHAGE d'un maillage déplacé.
 *
 * LE DEFAUT
 * ---------
 * `applyDisplacement` rend une normale PAR FACE, recopiée sur les 3 sommets
 * (displacement.js, « Compute exact per-face normals from the displaced
 * positions »). L'apercu « All Slots » demande pourtant explicitement un
 * ombrage lisse — `MeshStandardMaterial({ flatShading: false })` — mais avec
 * des normales deja plates il rend plat quand meme : la surface se couvre de
 * chevrons qui suivent la triangulation. La forme, elle, est lisse ; c'est
 * l'eclairage qui ment.
 *
 * POURQUOI PAS `computeVertexNormals()`
 * -------------------------------------
 * Sur un maillage NON INDEXE — ce que produit toute la chaine — chaque sommet
 * n'appartient qu'a un triangle : `computeVertexNormals()` redonne exactement
 * les normales plates. Il faut moyenner entre POSITIONS COINCIDENTES, d'ou
 * `weldVertices`.
 *
 * Et il y a la raison pour laquelle displacement.js s'en etait tenu au plat :
 * moyenner aveuglement « peut retourner les normales des faces exclues dont les
 * voisines ont ete deplacees vers l'exterieur ». C'est le GROUPE DE LISSAGE PAR
 * ANGLE qui repond a ca : une face ne moyenne qu'avec les faces voisines dont
 * la normale est a moins de `creaseDeg` de la SIENNE. Une face restee au nu,
 * voisine d'une face poussee dehors, ne les rencontre donc jamais — pas plus
 * que les trois faces d'un coin de cube.
 *
 * ⚠️ COMPARER FACE A FACE, PAS FACE A LA MOYENNE. Une premiere version testait
 * chaque face contre la moyenne ponderee par l'aire du sommet. C'est plus
 * simple et ca a l'air equivalent — ca ne l'est pas, parce que la moyenne est
 * ASYMETRIQUE : sur un gradin ou deux grands triangles du dessus rencontrent
 * une petite face verticale, la moyenne reste dominee par le dessus
 * (MESURE : (-0.2425, 0, 0.9701)), si bien que le mur, minoritaire, gardait
 * bien sa normale — mais le dessus, lui, se faisait incliner de 14° vers le
 * mur. L'arete vive etait donc a moitie franchie, dans le sens qu'on ne
 * regardait pas. Une comparaison face a face est symetrique par construction.
 *
 * CE QUE CE MODULE NE FAIT PAS
 * ----------------------------
 * Il ne touche JAMAIS l'attribut `normal` produit par le pipeline. Celui-ci est
 * lu comme une DONNEE GEOMETRIQUE par plusieurs etages — `exporter.js` y copie
 * la normale de facette du STL (et depend de l'invariant « les 3 sont
 * identiques »), `exportPipeline.snapBottomToFlat` et `exclusion.js` s'en
 * servent pour decider quelles faces traiter. Le lissage est purement cosmetique
 * et reste confine aux geometries d'AFFICHAGE : aucune POSITION ne bouge, donc
 * rien de ce qui est exporte ou imprime ne change.
 */

import { weldVertices } from './meshIndex.js';

// Grille de soudure : celle de displacement.js / subdivision.js (10 µm), pas
// celle de l'export (1e4). Une grille plus grossiere collerait des points
// distincts et lisserait par-dessus de vraies aretes.
const QUANT = 1e5;

// Angle de PLI par defaut, entre faces voisines : au-dela, l'arete reste vive.
// 40° laisse un cube franc (ses aretes font 90°) et lisse une surface plissee,
// dont les facettes voisines ne different que de quelques degres.
export const DEFAULT_CREASE_DEG = 40;

/**
 * Normales lissées calculées sur les positions DEPLACEES.
 *
 * @param {THREE.BufferGeometry} geometry  non indexé, avec `position`
 * @param {object} [opts]
 * @param {number} [opts.creaseDeg]  angle entre faces au-delà duquel l'arête reste vive
 * @returns {Float32Array|null}  normales (même disposition que `position`), ou
 *                               null si la géométrie n'a pas de positions
 */
export function computeSmoothNormals(geometry, { creaseDeg = DEFAULT_CREASE_DEG } = {}) {
  const posAttr = geometry?.attributes?.position;
  if (!posAttr) return null;

  const pos = posAttr.array;
  const count = posAttr.count;
  const triCount = (count / 3) | 0;
  if (triCount === 0) return null;

  const { vertexId, uniqueCount } = weldVertices(pos, count, QUANT);

  // ── Normales de face : direction unitaire + aire ─────────────────────────
  // Le produit vectoriel non normalise vaut deja 2x l'aire, d'ou la ponderation
  // gratuite : une grande facette doit peser plus qu'un sliver dans la moyenne.
  const fnX = new Float32Array(triCount);
  const fnY = new Float32Array(triCount);
  const fnZ = new Float32Array(triCount);
  const fArea = new Float32Array(triCount);

  for (let t = 0; t < triCount; t++) {
    const a = t * 9;
    const ux = pos[a + 3] - pos[a],     uy = pos[a + 4] - pos[a + 1], uz = pos[a + 5] - pos[a + 2];
    const vx = pos[a + 6] - pos[a],     vy = pos[a + 7] - pos[a + 1], vz = pos[a + 8] - pos[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-20) continue;   // degenere : aire 0, ne vote jamais, garde le plat
    fnX[t] = nx / len; fnY[t] = ny / len; fnZ[t] = nz / len;
    fArea[t] = len;
  }

  // ── Faces incidentes a chaque position, en CSR ───────────────────────────
  // Il FAUT cette adjacence : sans elle on ne peut comparer qu'a une moyenne
  // deja formee, et l'asymetrie decrite en tete revient.
  const offs = new Uint32Array(uniqueCount + 1);
  for (let i = 0; i < count; i++) offs[vertexId[i] + 1]++;
  for (let id = 0; id < uniqueCount; id++) offs[id + 1] += offs[id];
  const faceOf = new Uint32Array(count);
  const cursor = Uint32Array.from(offs.subarray(0, uniqueCount));
  for (let t = 0; t < triCount; t++) {
    for (let v = 0; v < 3; v++) faceOf[cursor[vertexId[t * 3 + v]]++] = t;
  }

  const cosCrease = Math.cos(creaseDeg * Math.PI / 180);
  const out = new Float32Array(count * 3);

  for (let t = 0; t < triCount; t++) {
    const fx = fnX[t], fy = fnY[t], fz = fnZ[t];
    for (let v = 0; v < 3; v++) {
      const i = t * 3 + v;
      const id = vertexId[i];

      // Moyenne des SEULES faces incidentes qui appartiennent au meme groupe de
      // lissage que celle-ci — c'est-a-dire dont la normale est a moins de
      // creaseDeg de la sienne. La face elle-meme en fait toujours partie
      // (dot = 1), donc la somme n'est jamais vide tant qu'elle n'est pas
      // degeneree.
      let ax = 0, ay = 0, az = 0;
      for (let k = offs[id], end = offs[id + 1]; k < end; k++) {
        const g = faceOf[k];
        const area = fArea[g];
        if (area === 0) continue;
        const gx = fnX[g], gy = fnY[g], gz = fnZ[g];
        if (fx * gx + fy * gy + fz * gz <= cosCrease) continue;
        ax += gx * area; ay += gy * area; az += gz * area;
      }

      const len = Math.sqrt(ax * ax + ay * ay + az * az);
      // Somme quasi nulle = faces qui s'annulent (lame de couteau, plaque fine
      // repliee) : la direction moyenne n'y veut rien dire, on garde le plat.
      const useSmooth = len > 1e-20;
      out[i * 3]     = useSmooth ? ax / len : fx;
      out[i * 3 + 1] = useSmooth ? ay / len : fy;
      out[i * 3 + 2] = useSmooth ? az / len : fz;
    }
  }

  return out;
}

// NOTE : ce module ne pose pas lui-meme l'attribut et n'importe pas THREE — il
// rend un Float32Array brut. Ca le garde chargeable et testable HEADLESS (les
// harnais tournent sous node), et ca laisse l'appelant decider sur quelle
// geometrie il ecrit — decision qui compte, puisque le lissage ne doit jamais
// atterrir sur une geometrie destinee a l'export.
