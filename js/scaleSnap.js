// Pure scale-resolution logic for the U texture scale.
//
// Extracted from main.js's _applyScaleU so the snap-vs-verbatim DECISION is
// testable headless (the DOM/global bits — reading the active texture aspect and
// driving the sliders — stay in main.js and call resolveScaleU). This is what
// lets the "don't re-snap on restore" fix (AUDIT.md #3) be validated by
// `npm test`, not only by hand in the app.

export const MODE_CYLINDRICAL = 3;

/**
 * Round a U scale to the nearest seamless-wrap value:
 *   tiles around circumference = aspectU / scaleU  →  must be a positive integer.
 * Clamped to [aspectU / MAX_TILES, aspectU].
 */
export function snapScaleUForSeamlessWrap(scaleU, aspectU, maxTiles = 20) {
  let n = Math.round(aspectU / Math.max(scaleU, 1e-6));
  if (!Number.isFinite(n) || n < 1) n = 1;
  if (n > maxTiles) n = maxTiles;
  return parseFloat((aspectU / n).toFixed(4));
}

/**
 * Final U scale to apply: clamp to [0.01, 10], then snap for seamless wrap ONLY
 * when cylindrical projection is active, snapping is enabled, and we're not
 * restoring a snapshot (a restored value is authoritative — re-snapping it
 * drifts the scale, especially before the texture aspect is known).
 *
 * @param {number} rawScaleU
 * @param {{ mappingMode:number, snapSeamlessWrap:boolean, suppressSnap:boolean, aspectU:number }} ctx
 */
export function resolveScaleU(rawScaleU, { mappingMode, snapSeamlessWrap, suppressSnap, aspectU }) {
  const v = Math.max(0.01, Math.min(10, rawScaleU));
  if (snapSeamlessWrap && mappingMode === MODE_CYLINDRICAL && !suppressSnap) {
    return snapScaleUForSeamlessWrap(v, aspectU);
  }
  return v;
}
