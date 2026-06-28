// Slot-state data core.
//
// Pure data/geometry helpers extracted from main.js, with the geometry passed in
// explicitly instead of read from the `currentGeometry` global. This is the first
// step toward a single source of truth for slot state: the DATA logic lives here
// (testable headless), while the DOM/global wiring stays in main.js and delegates
// to these functions.

import * as THREE from 'three';

/** Keep only valid integer face indices in [0, triCount). */
export function normalizeFaceIndexArray(value, triCount = Infinity) {
  if (!Array.isArray(value)) return [];
  const max = Number.isFinite(triCount) && triCount > 0 ? triCount : Infinity;
  return value
    .map(v => Number(v))
    .filter(v => Number.isInteger(v) && v >= 0 && v < max);
}

/**
 * Material faces for a slot, given its painted set and selection mode.
 * Include mode: painted faces ARE the material. Exclude mode: painted faces are
 * holes, so the material is the complement. With no geometry, the painted set is
 * returned as-is (can't compute a complement without a triangle count).
 */
export function computeAssignedFaces(geometry, excludedFaces, selectionMode) {
  const assigned = new Set();

  if (!geometry) {
    for (const f of excludedFaces || []) assigned.add(f);
    return assigned;
  }

  const triCount = (geometry.attributes.position.count / 3) | 0;

  if (selectionMode) {
    for (const f of excludedFaces || []) {
      const idx = Number(f);
      if (Number.isInteger(idx) && idx >= 0 && idx < triCount) assigned.add(idx);
    }
  } else {
    const excluded = new Set(excludedFaces || []);
    for (let i = 0; i < triCount; i++) {
      if (!excluded.has(i)) assigned.add(i);
    }
  }

  return assigned;
}

/**
 * Build position-independent signatures (centroid + face normal) for a set of
 * face indices, so a selection can survive a project save/load even if the mesh
 * is re-indexed on reload.
 */
export function buildFaceSignatures(faceSet, geometry) {
  if (!geometry || !faceSet) return [];

  const pos = geometry.attributes.position.array;
  const triCount = geometry.attributes.position.count / 3;
  const signatures = [];

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const n = new THREE.Vector3();

  for (const faceIndex of faceSet) {
    const idx = Number(faceIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= triCount) continue;

    const o = idx * 9;
    a.set(pos[o],     pos[o + 1], pos[o + 2]);
    b.set(pos[o + 3], pos[o + 4], pos[o + 5]);
    c.set(pos[o + 6], pos[o + 7], pos[o + 8]);

    n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).normalize();

    signatures.push({
      faceIndex: idx,
      cx: (a.x + b.x + c.x) / 3,
      cy: (a.y + b.y + c.y) / 3,
      cz: (a.z + b.z + c.z) / 3,
      nx: n.x,
      ny: n.y,
      nz: n.z
    });
  }

  return signatures;
}

/**
 * Resolve signatures back to face indices on (possibly re-indexed) geometry by
 * nearest centroid + normal agreement. Falls back to the given indices if no
 * signatures resolve.
 */
export function restoreFacesFromSignatures(signatures, fallbackIndices = [], geometry) {
  const fallback = normalizeFaceIndexArray(
    fallbackIndices,
    geometry ? ((geometry.attributes.position.count / 3) | 0) : Infinity
  );

  if (!geometry || !Array.isArray(signatures) || signatures.length === 0) {
    return new Set(fallback);
  }

  const pos = geometry.attributes.position.array;
  const triCount = geometry.attributes.position.count / 3;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const n = new THREE.Vector3();

  const cents = new Float64Array(triCount * 3);
  const nrms = new Float64Array(triCount * 3);

  for (let idx = 0; idx < triCount; idx++) {
    const o = idx * 9;
    a.set(pos[o],     pos[o + 1], pos[o + 2]);
    b.set(pos[o + 3], pos[o + 4], pos[o + 5]);
    c.set(pos[o + 6], pos[o + 7], pos[o + 8]);

    n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).normalize();

    cents[idx * 3]     = (a.x + b.x + c.x) / 3;
    cents[idx * 3 + 1] = (a.y + b.y + c.y) / 3;
    cents[idx * 3 + 2] = (a.z + b.z + c.z) / 3;

    nrms[idx * 3]     = n.x;
    nrms[idx * 3 + 1] = n.y;
    nrms[idx * 3 + 2] = n.z;
  }

  const out = new Set();

  for (const sig of signatures) {
    if (!sig) continue;

    let bestIndex = -1;
    let bestScore = Infinity;

    for (let idx = 0; idx < triCount; idx++) {
      const co = idx * 3;
      const dx = cents[co]     - Number(sig.cx);
      const dy = cents[co + 1] - Number(sig.cy);
      const dz = cents[co + 2] - Number(sig.cz);

      const dot =
        nrms[co]     * Number(sig.nx) +
        nrms[co + 1] * Number(sig.ny) +
        nrms[co + 2] * Number(sig.nz);

      const score = dx * dx + dy * dy + dz * dz + Math.max(0, 1 - dot) * 10000;

      if (score < bestScore) {
        bestScore = score;
        bestIndex = idx;
      }
    }

    if (bestIndex >= 0) out.add(bestIndex);
  }

  if (out.size === 0) {
    for (const idx of fallback) out.add(idx);
  }

  return out;
}

// ── Per-slot vs global settings split ────────────────────────────────────────
// Export-mesh-quality controls are GLOBAL, not per texture slot. Per-slot
// settings carry texture/projection/amplitude. This list is the single source
// of truth for that split; switching slots must keep the CURRENT global quality
// rather than resurrecting whatever quality a slot happened to be saved with.
export const GLOBAL_EXPORT_QUALITY_KEYS = [
  'refineLength',
  'maxTriangles',
  'smoothBottom',
  'regularizeEnabled',
  'regularizeAspectThreshold',
  'regularizeSlack',
  'regularizeAggressiveSlack',
  'regularizeExtremeAspect',
  'regularizeNormalDeg',
  'regularizeAggressiveNormalDeg',
  'regularizeSecondPassMul',
];

/** Snapshot of just the global export-quality settings (every key present). */
export function pickGlobalQuality(settings) {
  const snap = {};
  for (const key of GLOBAL_EXPORT_QUALITY_KEYS) snap[key] = settings[key];
  return snap;
}

/** Remove the global export-quality keys from a settings object (mutates + returns). */
export function stripGlobalQuality(settings) {
  if (!settings) return settings;
  for (const key of GLOBAL_EXPORT_QUALITY_KEYS) delete settings[key];
  return settings;
}

/** Overlay the current global export-quality onto per-slot settings (global wins). */
export function withGlobalQuality(slotSettings = {}, globalSettings) {
  return { ...slotSettings, ...pickGlobalQuality(globalSettings) };
}

// ── Project save/load: face-selection serialize/restore ──────────────────────
// Symmetric pair pinning the "selections survive a project reload" contract
// (the manual save→reload→selections-come-back check, now headless). The map/
// texture entries (data URLs, presets) stay in main.js — those are DOM/async.

/** Serialize a slot's face selection for a project file (indices + signatures). */
export function serializeSlotFaces(slot, geometry) {
  const faceSource = slot.assignedFaces || slot.excludedFaces || new Set();
  return {
    excludedFaces: Array.from(slot.excludedFaces || []),
    assignedFaces: Array.from(slot.assignedFaces || slot.excludedFaces || []),
    faceSignatures: buildFaceSignatures(faceSource, geometry),
  };
}

/**
 * Restore a slot's face selection from saved project data. Material faces are
 * resolved from position signatures (so a re-indexed mesh still maps), falling
 * back to the saved indices.
 * @returns {{ excludedFaces: Set<number>, assignedFaces: Set<number> }}
 */
export function restoreSlotFaces(saved, geometry) {
  const triCount = geometry ? ((geometry.attributes.position.count / 3) | 0) : Infinity;
  const excludedFaces = new Set(normalizeFaceIndexArray(saved.excludedFaces, triCount));
  const validAssigned = normalizeFaceIndexArray(saved.assignedFaces || saved.excludedFaces, triCount);
  const assignedFaces = new Set(restoreFacesFromSignatures(saved.faceSignatures, validAssigned, geometry));
  return { excludedFaces, assignedFaces };
}
