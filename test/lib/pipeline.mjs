// Thin wrappers that drive the REAL production pipeline modules headless.
// Nothing here reimplements logic — it only feeds js/subdivision.js and
// js/displacement.js the same kind of inputs the browser app feeds them.

import * as THREE from 'three';
import { subdivide } from '../../js/subdivision.js';
import { applyDisplacement } from '../../js/displacement.js';

/** Bounds object in the shape displacement.js expects ({min,max,center,size}). */
export function computeBounds(geo) {
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const min = bb.min.clone(), max = bb.max.clone();
  const size = new THREE.Vector3().subVectors(max, min);
  const center = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
  return { min, max, center, size };
}

// MODE_TRIPLANAR = 5. Representative artistic settings; export-quality fields
// (refineLength) are passed separately to subdivide().
export const baseSettings = {
  mappingMode: 5,
  scaleU: 1, scaleV: 1, offsetU: 0, offsetV: 0, rotation: 0,
  amplitude: 1.0,
  symmetricDisplacement: true,
  topAngleLimit: 0, bottomAngleLimit: 0,
  mappingBlend: 0, seamBandWidth: 0.35,
  blendNormalSmoothing: 0,
  boundaryFalloff: 0,
  noDownwardZ: false,
};

/** Single-texture run: subdivide then displace. */
export async function runSingle(geo, { refineLength, settings, texture, faceWeights = null }) {
  const { geometry: sub } = await subdivide(geo, refineLength, null, faceWeights);
  const bounds = computeBounds(geo);
  return applyDisplacement(sub, texture, texture.width, texture.height, settings, bounds, null);
}

/**
 * Multi-slot run: assign each ORIGINAL triangle to a slot, expand that to the
 * subdivided mesh via faceParentId (exactly as buildExclusiveSlotFaceMasks does
 * in main.js), then displace all slots in one pass.
 *
 * @param assignOriginal  (triIndex, centroid:{x,y,z}) => slotIndex | -1
 * @param slots           [{ texture, settings }]
 */
export async function runMultiSlot(geo, { refineLength, slots, assignOriginal }) {
  const { geometry: sub, faceParentId } = await subdivide(geo, refineLength, null, null);
  const bounds = computeBounds(geo);

  // Per-original-triangle slot assignment.
  const origPos = geo.attributes.position.array;
  const origTriCount = (origPos.length / 9) | 0;
  const origAssign = new Int16Array(origTriCount);
  for (let t = 0; t < origTriCount; t++) {
    const b = t * 9;
    const cx = (origPos[b] + origPos[b + 3] + origPos[b + 6]) / 3;
    const cy = (origPos[b + 1] + origPos[b + 4] + origPos[b + 7]) / 3;
    const cz = (origPos[b + 2] + origPos[b + 5] + origPos[b + 8]) / 3;
    origAssign[t] = assignOriginal(t, { x: cx, y: cy, z: cz });
  }

  // Expand to per-subdivided-face exclusive masks.
  const subTriCount = (sub.attributes.position.array.length / 9) | 0;
  const multiSlots = slots.map((s, si) => {
    const faceMask = new Uint8Array(subTriCount);
    for (let i = 0; i < subTriCount; i++) {
      if (origAssign[faceParentId[i]] === si) faceMask[i] = 1;
    }
    return {
      faceMask,
      imageData: s.texture,
      width: s.texture.width,
      height: s.texture.height,
      settings: s.settings,
    };
  });

  return applyDisplacement(
    sub, multiSlots[0].imageData, multiSlots[0].width, multiSlots[0].height,
    { ...baseSettings, multiSlots }, bounds, null,
  );
}
