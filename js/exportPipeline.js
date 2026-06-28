// Multi-slot export orchestration — DOM-free seam.
//
// Extracted from main.js's buildExportGeometryForAllSlots so the REAL export
// path (union mask -> shared subdivide -> exclusive masks -> single-pass
// displace -> finish) can run headless and be covered by the golden harness.
// All UI coupling is injected: progress, cancellation, frame-yielding, and the
// per-slot texture fetch (which in the app goes through a Canvas2D blur).
//
// The two `if (false && …)` dead blocks (regularize / decimate) that used to sit
// inline were dropped during extraction — they were unreachable, so behavior is
// identical (golden-verified). Whether multi-slot export should regularize or
// decimate is a separate, still-open decision (see REFACTOR.md step 2).

import * as THREE from 'three';
import { subdivide } from './subdivision.js';
import { applyDisplacement } from './displacement.js';
import { buildUnionExcludedFacesForSlots, buildCombinedFaceWeights,
         buildExclusiveSlotFaceMasks } from './slotMasks.js';
import { withGlobalQuality } from './slotState.js';

/** Snap near-bottom vertices to the exact bottom plane and refresh their normals. */
export function snapBottomToFlat(geometry, bottomZ, tol = 0.1) {
  const pa = geometry.attributes.position.array;
  const na = geometry.attributes.normal
    ? geometry.attributes.normal.array
    : new Float32Array(pa.length);
  let dirtyTris = 0;

  for (let i = 0; i < pa.length; i += 9) {
    let dirty = false;
    if (Math.abs(pa[i+2] - bottomZ) <= tol) { pa[i+2] = bottomZ; dirty = true; }
    if (Math.abs(pa[i+5] - bottomZ) <= tol) { pa[i+5] = bottomZ; dirty = true; }
    if (Math.abs(pa[i+8] - bottomZ) <= tol) { pa[i+8] = bottomZ; dirty = true; }
    if (dirty) {
      dirtyTris++;
      const ux = pa[i+3]-pa[i],   uy = pa[i+4]-pa[i+1], uz = pa[i+5]-pa[i+2];
      const vx = pa[i+6]-pa[i],   vy = pa[i+7]-pa[i+1], vz = pa[i+8]-pa[i+2];
      const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
      const len = Math.sqrt(nx*nx+ny*ny+nz*nz) || 1;
      na[i]   = na[i+3] = na[i+6] = nx/len;
      na[i+1] = na[i+4] = na[i+7] = ny/len;
      na[i+2] = na[i+5] = na[i+8] = nz/len;
    }
  }

  if (dirtyTris > 0) {
    geometry.attributes.position.needsUpdate = true;
    if (!geometry.attributes.normal) {
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(na, 3));
    } else {
      geometry.attributes.normal.needsUpdate = true;
    }
  }
  return dirtyTris;
}

/**
 * Build the displaced multi-slot geometry. Pure of DOM — all UI/global coupling
 * is injected.
 *
 * @param {object}   o
 * @param {THREE.BufferGeometry} o.geometry        original (un-subdivided) mesh
 * @param {object}   o.bounds          {min,max,center,size} of the original mesh
 * @param {object[]} o.readySlots      slots with { assignedFaces:Set, settings, name, ... }
 * @param {object}   o.qualitySettings global export-quality snapshot
 * @param {function} o.getSlotImageData (slot, slotSettings) => {imageData,width,height}
 * @param {function} [o.onProgress]    (fraction, label) => void
 * @param {function} [o.checkCancel]   () => void  (throw to abort)
 * @param {function} [o.yield]         () => Promise (frame yield)
 * @returns {Promise<THREE.BufferGeometry>}
 */
export async function runMultiSlotExport({
  geometry,
  bounds,
  readySlots,
  qualitySettings,
  getSlotImageData,
  onProgress = () => {},
  checkCancel = () => {},
  yield: yieldFn = () => Promise.resolve(),
}) {
  let subdivided = null;
  let working = null;
  let finalGeometry = null;
  let faceParentId = null;

  try {
    // One union face-weight mask before subdivision: only refine faces some slot uses.
    const unionExcludedFaces = buildUnionExcludedFacesForSlots(readySlots, geometry);
    const sharedFaceWeights = buildCombinedFaceWeights(geometry, unionExcludedFaces, false, qualitySettings);

    onProgress(0.02, 'Subdividing shared mesh');
    await yieldFn();
    checkCancel();

    // Subdivide ONCE for all slots.
    ({ geometry: subdivided, faceParentId } = await subdivide(
      geometry,
      qualitySettings.refineLength,
      (p, triCount, longestEdge) => {
        const label = triCount != null
          ? `Refining shared mesh ${Math.round(p * 100)}% — ${triCount.toLocaleString()} tris, edge ${longestEdge.toFixed(2)}`
          : `Subdividing shared mesh ${Math.round(p * 100)}%`;
        onProgress(0.02 + p * 0.28, label);
      },
      sharedFaceWeights
    ));
    checkCancel();

    working = subdivided;
    subdivided = null;

    const { masks: exclusiveFaceMasks, counts: exclusiveMaskCounts } =
      buildExclusiveSlotFaceMasks(faceParentId, readySlots);

    const multiSlots = [];
    for (let i = 0; i < readySlots.length; i++) {
      const slot = readySlots[i];
      const slotSettings = withGlobalQuality(slot.settings || {}, qualitySettings);
      const faceMask = exclusiveFaceMasks[i];

      if (!faceMask || exclusiveMaskCounts[i] === 0) {
        console.warn(`Skipping ${slot.name}: no exclusive triangles assigned`);
        continue;
      }

      const { imageData, width, height } = getSlotImageData(slot, slotSettings);

      multiSlots.push({
        name: slot.name || slot.id || `Slot ${i + 1}`,
        imageData,
        width,
        height,
        settings: slotSettings,
        faceMask,
      });
    }

    if (multiSlots.length === 0) {
      throw new Error('No exclusive slot triangles were generated.');
    }

    onProgress(0.40, `Applying ${multiSlots.length} texture slots in one pass`);
    await yieldFn();
    const displaced = applyDisplacement(
      working,
      multiSlots[0].imageData,
      multiSlots[0].width,
      multiSlots[0].height,
      { ...qualitySettings, multiSlots },
      bounds,
      (p) => onProgress(0.40 + p * 0.42, `Displacing multi-slot mesh ${Math.round(p * 100)}%`)
    );

    working.dispose();
    working = displaced;
    finalGeometry = working;
    working = null;

    // Post-export finishing (matches the standard export path).
    if (qualitySettings.bottomAngleLimit > 0) {
      const bottomZ = bounds.min.z;
      const pa = finalGeometry.attributes.position.array;
      const na = finalGeometry.attributes.normal ? finalGeometry.attributes.normal.array : new Float32Array(pa.length);

      for (let i = 0; i < pa.length; i += 9) {
        let dirty = false;
        if (pa[i+2] < bottomZ) { pa[i+2] = bottomZ; dirty = true; }
        if (pa[i+5] < bottomZ) { pa[i+5] = bottomZ; dirty = true; }
        if (pa[i+8] < bottomZ) { pa[i+8] = bottomZ; dirty = true; }

        if (dirty) {
          const ux = pa[i+3]-pa[i],   uy = pa[i+4]-pa[i+1], uz = pa[i+5]-pa[i+2];
          const vx = pa[i+6]-pa[i],   vy = pa[i+7]-pa[i+1], vz = pa[i+8]-pa[i+2];
          const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
          const len = Math.sqrt(nx*nx+ny*ny+nz*nz) || 1;
          na[i]   = na[i+3] = na[i+6] = nx/len;
          na[i+1] = na[i+4] = na[i+7] = ny/len;
          na[i+2] = na[i+5] = na[i+8] = nz/len;
        }
      }

      finalGeometry.attributes.position.needsUpdate = true;
      if (finalGeometry.attributes.normal) finalGeometry.attributes.normal.needsUpdate = true;
    }

    if (qualitySettings.smoothBottom) {
      snapBottomToFlat(finalGeometry, bounds.min.z, 0.1);
    }

    return finalGeometry;
  } catch (err) {
    if (subdivided) subdivided.dispose();
    if (working) working.dispose();
    if (finalGeometry) finalGeometry.dispose();
    throw err;
  }
}
