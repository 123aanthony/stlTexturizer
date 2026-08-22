// Thin wrappers that drive the REAL production pipeline modules headless.
// Nothing here reimplements logic — it only feeds js/subdivision.js and
// js/displacement.js the same kind of inputs the browser app feeds them.

import * as THREE from 'three';
import { subdivide } from '../../js/subdivision.js';
import { applyDisplacement } from '../../js/displacement.js';
import { runMultiSlotExport } from '../../js/exportPipeline.js';
import { getScaleReferenceLengths } from '../../js/mapping.js';

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
  // Les goldens HISTORIQUES figent le sampler d'origine (bilinéaire pleine
  // résolution, un tap par sommet). Le préfiltre mip est donc explicitement
  // COUPÉ ici : ces empreintes prouvent que le chemin legacy n'a pas bougé
  // d'un bit. Les cas qui exercent l'antialiasing le rallument nommément.
  textureAntialias: false,
};

// ÉCHELLE ABSOLUE (portage 4437135) : le moteur attend désormais scaleU/scaleV
// en MILLIMÈTRES. Les fixtures historiques restent écrites en RELATIF (fraction
// des longueurs de référence du mode) et sont converties ICI — les fingerprints
// golden inchangés PROUVENT l'équivalence mm ↔ relatif du portage. Une fixture
// déjà en mm se marque scaleUnit:'mm' pour passer verbatim.
export function legacyRelToMm(settings, bounds) {
  if (settings.scaleUnit === 'mm') return settings;
  const { refU, refV } = getScaleReferenceLengths(settings.mappingMode, settings, bounds);
  return {
    ...settings,
    scaleU: (settings.scaleU ?? 1) * refU,
    scaleV: (settings.scaleV ?? 1) * refV,
    scaleUnit: 'mm',
  };
}

/** Single-texture run: subdivide then displace. */
export async function runSingle(geo, { refineLength, settings, texture, faceWeights = null }) {
  const { geometry: sub } = await subdivide(geo, refineLength, null, faceWeights);
  const bounds = computeBounds(geo);
  return applyDisplacement(sub, texture, texture.width, texture.height, legacyRelToMm(settings, bounds), bounds, null);
}

/**
 * Multi-slot run through the REAL production orchestration
 * (exportPipeline.runMultiSlotExport): assign each ORIGINAL triangle to a slot
 * (or leave it unowned), then let the pipeline build the union mask, subdivide
 * once, expand exclusive masks, and displace all slots in one pass.
 *
 * @param assignOriginal  (triIndex, centroid:{x,y,z}, normal:{x,y,z}) => slotIndex | -1
 * @param slots           [{ texture, settings }]
 */
export async function runMultiSlot(geo, { refineLength, maxTriangles, slots, assignOriginal }) {
  const bounds = computeBounds(geo);

  const readySlots = slots.map((s, si) => ({
    name: `slot${si}`,
    assignedFaces: new Set(),
    settings: legacyRelToMm(s.settings, bounds),
    _texture: s.texture,
  }));

  const pos = geo.attributes.position.array;
  const triCount = (pos.length / 9) | 0;
  for (let t = 0; t < triCount; t++) {
    const b = t * 9;
    const cx = (pos[b]     + pos[b + 3] + pos[b + 6]) / 3;
    const cy = (pos[b + 1] + pos[b + 4] + pos[b + 7]) / 3;
    const cz = (pos[b + 2] + pos[b + 5] + pos[b + 8]) / 3;
    const ux = pos[b + 3] - pos[b],     uy = pos[b + 4] - pos[b + 1], uz = pos[b + 5] - pos[b + 2];
    const vx = pos[b + 6] - pos[b],     vy = pos[b + 7] - pos[b + 1], vz = pos[b + 8] - pos[b + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1; nx /= len; ny /= len; nz /= len;
    const si = assignOriginal(t, { x: cx, y: cy, z: cz }, { x: nx, y: ny, z: nz });
    if (si >= 0) readySlots[si].assignedFaces.add(t);
  }

  return runMultiSlotExport({
    geometry: geo,
    bounds,
    readySlots,
    qualitySettings: {
      refineLength, smoothBottom: false, maxTriangles,
      decimateEnabled: maxTriangles != null,
      // Réglage GLOBAL : `applyDisplacement` le lit sur les settings de tête,
      // que le chemin multi-slot construit depuis `qualitySettings`. Le prendre
      // sur le 1er slot suffit — les cas de test le posent via `baseSettings`.
      textureAntialias: slots[0]?.settings?.textureAntialias,
    },
    getSlotImageData: (slot) => ({
      imageData: slot._texture,
      width: slot._texture.width,
      height: slot._texture.height,
    }),
  });
}
