// Multi-slot face-mask core.
//
// Pure geometry/data helpers, extracted verbatim from main.js so they can be
// unit-tested headless (they were buried in the 8.5k-line UI module). No DOM,
// no module globals — everything is passed in. The console.log debug lines are
// kept as-is for a strictly behavior-preserving extraction; they will be
// removed in the hygiene pass.

import * as THREE from 'three';
import { buildFaceWeights } from './exclusion.js';

/**
 * Per-vertex exclusion weights for the subdivision pass, combining painted
 * exclusion with angle-based (top/bottom) masking.
 */
export function buildCombinedFaceWeights(geometry, excludedFaces, invert, settings) {
  const weights = buildFaceWeights(geometry, excludedFaces, invert);

  const hasAngleMask = settings.bottomAngleLimit > 0 || settings.topAngleLimit > 0;
  if (!hasAngleMask) return weights;

  const posAttr = geometry.attributes.position;
  const triCount = posAttr.count / 3;
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const faceNrm = new THREE.Vector3();

  for (let t = 0; t < triCount; t++) {
    if (weights[t * 3] > 0.99) continue; // already excluded
    vA.fromBufferAttribute(posAttr, t * 3);
    vB.fromBufferAttribute(posAttr, t * 3 + 1);
    vC.fromBufferAttribute(posAttr, t * 3 + 2);
    edge1.subVectors(vB, vA);
    edge2.subVectors(vC, vA);
    faceNrm.crossVectors(edge1, edge2);
    const faceArea  = faceNrm.length();
    const faceNzNorm = faceArea > 1e-12 ? faceNrm.z / faceArea : 0;
    const faceAngle  = Math.acos(Math.abs(faceNzNorm)) * (180 / Math.PI);
    const angleMasked = faceNzNorm < 0
      ? (settings.bottomAngleLimit > 0 && faceAngle <= settings.bottomAngleLimit)
      : (settings.topAngleLimit    > 0 && faceAngle <= settings.topAngleLimit);
    if (angleMasked) {
      weights[t * 3]     = 1.0;
      weights[t * 3 + 1] = 1.0;
      weights[t * 3 + 2] = 1.0;
    }
  }
  return weights;
}

/**
 * Union of faces NOT owned by any slot, as the excluded set for the shared
 * subdivision pass (so Export All Slots only refines faces some slot uses).
 */
export function buildUnionExcludedFacesForSlots(readySlots, geometry) {
  const triCount = geometry?.attributes?.position
    ? (geometry.attributes.position.count / 3) | 0
    : 0;

  const owned = new Set();

  for (const slot of readySlots || []) {
    for (const face of slot.assignedFaces || []) {
      const idx = Number(face);
      if (Number.isInteger(idx) && idx >= 0 && idx < triCount) {
        owned.add(idx);
      }
    }
  }

  const excluded = new Set();
  for (let i = 0; i < triCount; i++) {
    if (!owned.has(i)) excluded.add(i);
  }

  console.log('Export All Slots union subdivision mask:', {
    triCount,
    owned: owned.size,
    excluded: excluded.size
  });

  return excluded;
}

/**
 * Slot PROPRIETAIRE de chaque face du maillage ORIGINAL.
 *
 * Regle : la premiere case qui reclame une face la garde (le recouvrement se
 * tranche par ORDRE de slot). -1 = personne, donc pas de texture.
 *
 * SOURCE UNIQUE. C'est la regle de l'export, et c'est desormais aussi celle que
 * lit la vue « couleurs par slot » : une carte qui montrerait une autre
 * appartenance que celle du fichier ecrit serait pire qu'aucune carte. La
 * fonction ci-dessous, qui produit les masques exclusifs du maillage SUBDIVISE,
 * s'appuie sur elle plutot que d'en garder une copie.
 *
 * @param {{assignedFaces:Set<number>}[]} readySlots
 * @param {number} triCount  nombre de faces du maillage original
 * @returns {Int16Array}  index de slot par face, -1 si aucune
 */
export function ownerSlotOfFaces(readySlots, triCount) {
  const owner = new Int16Array(triCount).fill(-1);

  for (let slotIndex = 0; slotIndex < readySlots.length; slotIndex++) {
    const assigned = readySlots[slotIndex].assignedFaces || new Set();

    for (const face of assigned) {
      const idx = Number(face);
      if (!Number.isInteger(idx) || idx < 0 || idx >= triCount) continue;
      if (owner[idx] < 0) owner[idx] = slotIndex;
    }
  }

  return owner;
}

/**
 * One exclusive face mask per slot on the SUBDIVIDED mesh: each original face is
 * owned by the first slot that claims it (overlap resolved by slot order), then
 * expanded to subdivided faces via faceParentId.
 */
export function buildExclusiveSlotFaceMasks(faceParentId, readySlots) {
  const masks = readySlots.map(() => new Uint8Array(faceParentId.length));

  // Taille du maillage ORIGINAL, deduite de la carte enfant->parent : c'est la
  // seule information dont on dispose ici, et elle suffit.
  let maxParent = -1;
  for (let i = 0; i < faceParentId.length; i++) {
    if (faceParentId[i] > maxParent) maxParent = faceParentId[i];
  }
  const ownerByParent = ownerSlotOfFaces(readySlots, maxParent + 1);

  const counts = new Array(readySlots.length).fill(0);

  for (let subTri = 0; subTri < faceParentId.length; subTri++) {
    const owner = ownerByParent[faceParentId[subTri]];

    if (owner >= 0) {
      masks[owner][subTri] = 1;
      counts[owner]++;
    }
  }

  console.log('Exclusive slot mask triangle counts:', counts);
  return { masks, counts };
}
