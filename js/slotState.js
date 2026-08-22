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
  // Préfiltre mip du sampler de déplacement. GLOBAL et non par slot : c'est une
  // propriété d'ÉCHANTILLONNAGE (le niveau de mip se déduit de la longueur
  // d'arête, elle-même globale), pas un choix artistique. Vivre ici le fait
  // aussi arriver dans `qualitySettings`, donc jusqu'au chemin multi-slot —
  // `applyDisplacement` le lit sur les settings de TÊTE, pas sur ceux du slot.
  'textureAntialias',
  // Angle de pli de l'ombrage : propriété de la VUE, pas de la carte. Par slot,
  // il changerait en basculant de slot alors que rien à l'écran ne le justifie.
  // (À l'inverse, les réglages `map*` de préparation restent PAR SLOT : ils se
  // calibrent sur le contenu d'UNE carte.)
  'displayCreaseAngle',
  'maxTriangles',
  'decimateEnabled',
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

// ── Single source of truth for slot state (audit #4) ─────────────────────────
// The globals (activeMapEntry/excludedFaces/selectionMode/…) mirror the ACTIVE
// slot and are only re-synced at save/restoreSlotState boundaries. Readers that
// each picked their own source (active globals vs stored fields) could diverge —
// e.g. slotHasContent OR-ed both, getSlotFaceCount read only stored fields.
// resolveSlotState funnels every reader through ONE rule: for the active slot the
// live globals are authoritative; for any other slot its stored fields.

const _EMPTY_SET = new Set();

/**
 * @param slot      slot object (may be null/undefined)
 * @param isActive  whether `slot` is the currently active slot
 * @param live      live globals for the active slot:
 *                  { activeMapEntry, excludedFaces, assignedFaces, selectionMode }
 * @returns {{ activeMapEntry, customMapEntry, excludedFaces:Set, assignedFaces:Set, selectionMode:boolean }}
 */
export function resolveSlotState(slot, isActive, live = {}) {
  if (slot && isActive) {
    return {
      activeMapEntry: live.activeMapEntry || slot.activeMapEntry || null,
      customMapEntry: slot.customMapEntry || null,
      excludedFaces: live.excludedFaces || slot.excludedFaces || _EMPTY_SET,
      assignedFaces: live.assignedFaces || slot.assignedFaces || _EMPTY_SET,
      selectionMode: typeof live.selectionMode === 'boolean' ? live.selectionMode : !!slot.selectionMode,
    };
  }
  return {
    activeMapEntry: slot?.activeMapEntry || null,
    customMapEntry: slot?.customMapEntry || null,
    excludedFaces: slot?.excludedFaces || _EMPTY_SET,
    assignedFaces: slot?.assignedFaces || _EMPTY_SET,
    selectionMode: !!slot?.selectionMode,
  };
}

/** True when a resolved slot state carries a map or any painted faces. */
export function stateHasContent(state) {
  return !!(
    state.activeMapEntry ||
    state.customMapEntry ||
    (state.excludedFaces && state.excludedFaces.size > 0) ||
    (state.assignedFaces && state.assignedFaces.size > 0)
  );
}

/** Face count for a resolved slot state (assigned wins, else excluded). */
export function stateFaceCount(state) {
  return (state.assignedFaces && state.assignedFaces.size) ||
         (state.excludedFaces && state.excludedFaces.size) || 0;
}

// ── Material brush: copy WHAT a slot paints, not WHERE ───────────────────────
// A slot holds two independent things: its MATERIAL (displacement map + the
// per-slot artistic settings) and its SELECTION (painted faces + Include /
// Exclude mode). Duplicating a slot copies both; the format painter copies only
// the material onto a slot that keeps its own selection — the move that matters
// when a dozen slots must share one wood setting but each owns its own beams.
//
// Global export-quality keys are NOT material (they are global by contract, see
// GLOBAL_EXPORT_QUALITY_KEYS) and are stripped on the way out.

/**
 * The material of a slot, detached from it (settings are copied, not aliased).
 *
 * Reads the slot's STORED fields, so for the active slot the caller must first
 * flush the live globals into it (saveActiveSlotState) — the globals are the
 * authority there, see resolveSlotState.
 */
export function pickSlotMaterial(source) {
  return {
    activeMapEntry: source?.activeMapEntry || null,
    customMapEntry: source?.customMapEntry || null,
    settings: stripGlobalQuality({ ...(source?.settings || {}) }),
  };
}

/** True when a slot has something worth copying (a map or any setting). */
export function hasSlotMaterial(source) {
  const m = pickSlotMaterial(source);
  return !!(m.activeMapEntry || m.customMapEntry || Object.keys(m.settings).length > 0);
}

/**
 * Paste a material onto a slot IN PLACE. excludedFaces / assignedFaces /
 * selectionMode are deliberately never read nor written here: that is the whole
 * contract of the brush, and it is what the tests pin.
 * @returns the mutated target
 */
export function applySlotMaterial(target, material) {
  if (!target || !material) return target;
  target.activeMapEntry = material.activeMapEntry || null;
  target.customMapEntry = material.customMapEntry || null;
  target.settings = { ...(material.settings || {}) };
  return target;
}

// ── Slot overlap: faces claimed by more than one slot ────────────────────────
// Two slots claiming the same face is a real conflict — the export resolves it
// SILENTLY by slot order (buildExclusiveSlotFaceMasks: the first slot wins), so
// the user has to be able to see WHERE it happens, not just that it happens.
//
// Exclude-mode slots are IGNORED (product decision): their material is the
// complement of the painted holes, so such a slot claims nearly the whole model
// and would flag every other slot's selection as "double" — technically true,
// useless as a signal (and it would light up half the viewport).

/**
 * Faces claimed by at least two INCLUDE-mode slots, in ONE pass over the
 * assigned sets (the per-slot count re-scanned every slot for every slot).
 *
 * @param {Array} states     resolved slot states (see resolveSlotState)
 * @param {number} triCount  triangle count of the live geometry (range filter,
 *                           so a stale selection from a bigger model can't feed
 *                           out-of-range indices to the overlay builder)
 * @returns {Set<number>}
 */
export function computeOverlapFaces(states, triCount = Infinity) {
  const max = Number.isFinite(triCount) && triCount > 0 ? triCount : Infinity;
  const claimed = new Set();
  const overlap = new Set();

  for (const state of states || []) {
    if (!state || !state.selectionMode) continue;   // Exclude-mode slot: ignored
    for (const face of state.assignedFaces || []) {
      const idx = Number(face);
      if (!Number.isInteger(idx) || idx < 0 || idx >= max) continue;
      if (claimed.has(idx)) overlap.add(idx);
      else claimed.add(idx);
    }
  }

  return overlap;
}

/**
 * How many of a slot's own faces are contested (0 for an Exclude-mode slot,
 * which never takes part in the overlap rule above).
 * Face indices are numbers by contract (normalizeFaceIndexArray /
 * computeAssignedFaces), so the smaller set can be the one walked.
 */
export function countSlotOverlap(state, overlapFaces) {
  if (!state || !state.selectionMode) return 0;
  const assigned = state.assignedFaces;
  if (!assigned || assigned.size === 0) return 0;
  if (!overlapFaces || overlapFaces.size === 0) return 0;

  let n = 0;
  if (assigned.size <= overlapFaces.size) {
    for (const face of assigned) if (overlapFaces.has(Number(face))) n++;
  } else {
    for (const face of overlapFaces) if (assigned.has(face)) n++;
  }
  return n;
}
