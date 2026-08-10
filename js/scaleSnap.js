// Pure scale-resolution logic for the U texture scale.
//
// Extracted from main.js's _applyScaleU so the snap-vs-verbatim DECISION is
// testable headless (the DOM/global bits — reading the active texture aspect and
// driving the sliders — stay in main.js and call resolveScaleU). This is what
// lets the "don't re-snap on restore" fix (AUDIT.md #3) be validated by
// `npm test`, not only by hand in the app.
//
// ÉCHELLE ABSOLUE (portage amont 4437135) : scaleU est désormais la taille
// d'une tuile de texture en MILLIMÈTRES, plus une fraction du modèle. Le snap
// cylindrique raisonne donc en longueur d'arc : le nombre de tuiles autour de
// la circonférence C est (aspectU × C) / mm et doit être un entier positif.

export const MODE_CYLINDRICAL = 3;

// Bornes de la saisie numérique (mm) — le slider, lui, est ancré au modèle
// (0,05×–10× de sa plus grande arête, géré côté main.js).
export const SCALE_MM_INPUT_MIN = 0.01;
export const SCALE_MM_INPUT_MAX = 10000;

/**
 * Round a U tile size (mm) to the nearest seamless-wrap value:
 *   tiles around circumference = (aspectU × C) / mm  →  positive integer.
 * Clamped to [aspectU·C / maxTiles, aspectU·C].
 */
export function snapScaleUForSeamlessWrap(scaleUMm, aspectU, circumferenceMm, maxTiles = 20) {
  const arc = aspectU * Math.max(circumferenceMm, 1e-6);
  let n = Math.round(arc / Math.max(scaleUMm, 1e-6));
  if (!Number.isFinite(n) || n < 1) n = 1;
  if (n > maxTiles) n = maxTiles;
  return parseFloat((arc / n).toFixed(4));
}

/**
 * Final U tile size (mm) to apply: clamp to the input bounds, then snap for
 * seamless wrap ONLY when cylindrical projection is active, snapping is
 * enabled, and we're not restoring a snapshot (a restored value is
 * authoritative — re-snapping it drifts the scale, especially before the
 * texture aspect is known).
 *
 * @param {number} rawScaleUMm
 * @param {{ mappingMode:number, snapSeamlessWrap:boolean, suppressSnap:boolean,
 *           aspectU:number, circumferenceMm:number }} ctx
 */
export function resolveScaleU(rawScaleUMm, { mappingMode, snapSeamlessWrap, suppressSnap, aspectU, circumferenceMm }) {
  const v = Math.max(SCALE_MM_INPUT_MIN, Math.min(SCALE_MM_INPUT_MAX, rawScaleUMm));
  if (snapSeamlessWrap && mappingMode === MODE_CYLINDRICAL && !suppressSnap) {
    return snapScaleUForSeamlessWrap(v, aspectU, circumferenceMm ?? 1);
  }
  return v;
}
