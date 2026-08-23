/**
 * CPU-side UV mapping — exact JavaScript mirror of the GLSL in previewMaterial.js.
 * All functions take Three.js Vector3 objects for position/normal and
 * a bounds object { min, max, center, size } (all THREE.Vector3).
 */

import { orientedRawUV } from './beamAxis.js';

export const MODE_PLANAR_XY   = 0;
export const MODE_PLANAR_XZ   = 1;
export const MODE_PLANAR_YZ   = 2;
export const MODE_CYLINDRICAL = 3;
export const MODE_SPHERICAL   = 4;
export const MODE_TRIPLANAR   = 5;
export const MODE_CUBIC       = 6;
export const MODE_WOOD_AUTO   = 7;
export const MODE_WOOD_X      = 8;
export const MODE_WOOD_Y      = 9;
export const MODE_WOOD_Z      = 10;

const TWO_PI = Math.PI * 2;
const CUBIC_AXIS_EPSILON = 1e-4;

export function getDominantCubicAxis(normal) {
  const ax = Math.abs(normal.x);
  const ay = Math.abs(normal.y);
  const az = Math.abs(normal.z);

  // Treat near-ties as an intentional tie so 45° faces pick one stable axis
  // instead of flipping projection due to tiny normal jitter between triangles.
  if (ax >= ay - CUBIC_AXIS_EPSILON && ax >= az - CUBIC_AXIS_EPSILON) return 'x';
  if (ay >= az - CUBIC_AXIS_EPSILON) return 'y';
  return 'z';
}

export function getCubicBlendWeights(normal, blend, seamBandWidth = 0.35) {
  const axis = getDominantCubicAxis(normal);
  const ax = Math.abs(normal.x);
  const ay = Math.abs(normal.y);
  const az = Math.abs(normal.z);
  const primary = axis === 'x' ? ax : axis === 'y' ? ay : az;
  const secondary = axis === 'x' ? Math.max(ay, az) : axis === 'y' ? Math.max(ax, az) : Math.max(ax, ay);

  // blend=0: hard one-hot for sharp seams. Do NOT also short-circuit at the
  // primary≈secondary tie when blend>0 — the smooth weight branch handles
  // an exact 45° normal correctly (it produces 0.5/0.5), and short-circuiting
  // to one-hot there creates a single-vertex spike on fillets where the
  // smooth normal sweeps continuously across the cube-face boundary.
  if (blend <= 0.001) {
    return {
      x: axis === 'x' ? 1 : 0,
      y: axis === 'y' ? 1 : 0,
      z: axis === 'z' ? 1 : 0,
    };
  }

  const oneHot = {
    x: axis === 'x' ? 1 : 0,
    y: axis === 'y' ? 1 : 0,
    z: axis === 'z' ? 1 : 0,
  };

  // Only blend inside a seam band around the cube-face boundary. This keeps
  // strongly dominant faces fully textured even when the slider is barely on.
  const seamWidth = Math.max(seamBandWidth, CUBIC_AXIS_EPSILON * 2);
  const seamMixRaw = 1 - Math.min(1, Math.max(0, (primary - secondary) / seamWidth));
  const seamMix = blend * seamMixRaw * seamMixRaw * (3 - 2 * seamMixRaw);
  if (seamMix <= 0.001) return oneHot;

  // blend=1 should produce a genuinely soft triplanar-style transition.
  // Lower blend values progressively sharpen the weights back toward a single
  // dominant axis without snapping until the slider reaches zero.
  const power = 1 + (1 - seamMix) * 11;
  const sx = Math.pow(ax, power);
  const sy = Math.pow(ay, power);
  const sz = Math.pow(az, power);
  const smoothSum = sx + sy + sz + 1e-6;
  const smooth = {
    x: sx / smoothSum,
    y: sy / smoothSum,
    z: sz / smoothSum,
  };

  const mx = oneHot.x * (1 - seamMix) + smooth.x * seamMix;
  const my = oneHot.y * (1 - seamMix) + smooth.y * seamMix;
  const mz = oneHot.z * (1 - seamMix) + smooth.z * seamMix;
  const sum = mx + my + mz;

  return {
    x: mx / sum,
    y: my / sum,
    z: mz / sum,
  };
}

/**
 * Compute normalised UV coordinates [0, 1) (tiling) for a vertex.
 *
 * @param {{ x:number, y:number, z:number }} pos      vertex position
 * @param {{ x:number, y:number, z:number }} normal   vertex normal (unit)
 * @param {number}  mode    one of the MODE_* constants
 * @param {{ scaleU:number, scaleV:number, offsetU:number, offsetV:number }} settings
 * @param {{ min, max, center, size }} bounds           THREE.Vector3 fields
 * @returns {{ u:number, v:number }}                    tiled UV after scale+offset
 */
/**
 * Longueurs de référence (mm) qu'une unité UV pleine couvre en U et V, par
 * mode de projection. settings.scaleU/scaleV sont des TAILLES DE TUILE
 * ABSOLUES en mm (portage amont 4437135) ; la maths interne reste en
 * coordonnées normalisées, les consommateurs divisent donc les mm par ces
 * longueurs pour retrouver le facteur relatif :
 *   planaire / triplanaire / cubique / bois : plus grande arête de la bbox
 *     (s'annule contre la normalisation des coordonnées → texture ancrée
 *     au monde, même motif physique sur tout modèle)
 *   cylindrique : circonférence du cylindre de projection (U = longueur
 *     d'arc, V normalisé par le même C dans computeUV)
 *   sphérique : arc équatorial pour U, arc méridien pôle-à-pôle pour V
 */
export function getScaleReferenceLengths(mode, settings, bounds) {
  const { size } = bounds;
  const md = Math.max(size.x, size.y, size.z, 1e-6);
  switch (mode) {
    case MODE_CYLINDRICAL: {
      const r = Math.max(settings.cylinderRadius ?? Math.max(size.x, size.y) * 0.5, 1e-6);
      const C = TWO_PI * r;
      return { refU: C, refV: C };
    }
    case MODE_SPHERICAL: {
      const R = Math.max(0.5 * md, 1e-6);
      return { refU: TWO_PI * R, refV: Math.PI * R };
    }
    default:
      return { refU: md, refV: md };
  }
}

/** Convertit les tailles de tuile absolues (mm) en facteurs d'échelle relatifs. */
export function scaleMmToRelative(mode, settings, bounds) {
  const { refU, refV } = getScaleReferenceLengths(mode, settings, bounds);
  const u = Math.max(Number(settings.scaleU) || 1e-6, 1e-6) / refU;
  const v = Math.max(Number(settings.scaleV) || 1e-6, 1e-6) / refV;
  return { u, v };
}

export function computeUV(pos, normal, mode, settings, bounds) {
  const { min, size, center } = bounds;
  // Compensate for non-square textures: divide scale by aspect correction
  // so equal world-space distances produce equal physical texture distances.
  const aU = settings.textureAspectU ?? 1;
  const aV = settings.textureAspectV ?? 1;
  // settings.scaleU/scaleV sont des mm absolus — conversion vers les facteurs
  // relatifs qu'attend la maths normalisée ci-dessous.
  const rel = scaleMmToRelative(mode, settings, bounds);
  // ── Variation par PIÈCE (js/pieceVariation.js) ────────────────────────────
  // Modificateur ORTHOGONAL, applique ici — AVANT le switch — donc valable pour
  // les 11 modes d'un coup, sans toucher une seule de leurs branches.
  //
  // NEUTRALITE PAR CONSTRUCTION : sans `pieceXform`, `px` vaut undefined, les
  // trois `?? 0` rendent 0, `mirrorU` est faux, et les quatre constantes
  // ci-dessous valent EXACTEMENT ce qu'elles valaient avant. Ce n'est pas une
  // equivalence numerique : c'est la meme expression.
  //
  // Le miroir passe par le SIGNE de l'echelle : applyTransform ne fait que
  // `u / scaleU`, donc un scaleU negatif y produit exactement `-u/|scaleU|`.
  // Le plancher anti-zero de scaleMmToRelative est en amont, il ne detruit
  // donc pas ce signe.
  const px = settings.pieceXform;
  const mir = (px && px.mirrorU) ? -1 : 1;
  const scaleU = (rel.u / aU) * mir;
  const scaleV = rel.v / aV;
  const offsetU = settings.offsetU + (px?.du ?? 0);
  const offsetV = settings.offsetV + (px?.dv ?? 0);
  const rotRad = ((settings.rotation ?? 0) + (px?.rotDeg ?? 0)) * Math.PI / 180;
  const cosR = Math.cos(rotRad);
  const sinR = Math.sin(rotRad);
  const maxDim = Math.max(size.x, size.y, size.z);
  const md     = Math.max(maxDim, 1e-6);

  // Wood Auto: keep texture U aligned to the longest model axis so wood grain
  // runs continuously across the top and side faces of beams/rafters.
  function getWoodAxisForMode(mode) {
    if (mode === MODE_WOOD_X) return 'x';
    if (mode === MODE_WOOD_Y) return 'y';
    if (mode === MODE_WOOD_Z) return 'z';

    const sx = size.x, sy = size.y, sz = size.z;
    if (sy >= sx && sy >= sz) return 'y';
    if (sz >= sx && sz >= sy) return 'z';
    return 'x';
  }

  function computeWoodUVForAxis(axis) {
    const ax = Math.abs(normal.x);
    const ay = Math.abs(normal.y);
    const az = Math.abs(normal.z);

    let rawU = 0;
    let rawV = 0;

    if (axis === 'x') {
      rawU = (pos.x - min.x) / md;
      if (ax >= ay && ax >= az) rawV = (pos.y - min.y) / md; // beam end cap
      else if (az >= ay) rawV = (pos.y - min.y) / md;        // top / bottom
      else rawV = (pos.z - min.z) / md;                      // side
    } else if (axis === 'y') {
      rawU = (pos.y - min.y) / md;
      if (ay >= ax && ay >= az) rawV = (pos.x - min.x) / md; // beam end cap
      else if (az >= ax) rawV = (pos.x - min.x) / md;        // top / bottom
      else rawV = (pos.z - min.z) / md;                      // side
    } else {
      rawU = (pos.z - min.z) / md;
      if (az >= ax && az >= ay) rawV = (pos.x - min.x) / md; // beam end cap
      else if (ay >= ax) rawV = (pos.x - min.x) / md;        // side
      else rawV = (pos.y - min.y) / md;                      // side
    }

    return applyTransform(rawU, rawV, scaleU, scaleV, offsetU, offsetV, cosR, sinR);
  }

  // Wood Auto: keep texture U aligned to the longest model axis so wood grain
  // runs continuously across the top and side faces of beams/rafters.
  // Wood X/Y/Z use the same mapping but let the user choose the beam axis manually.
  function computeWoodAutoUV() {
    return computeWoodUVForAxis(getWoodAxisForMode(mode));
  }

  let u = 0, v = 0;

  switch (mode) {

    case MODE_PLANAR_XY: {
      u = (pos.x - min.x) / md;
      v = (pos.y - min.y) / md;
      break;
    }

    case MODE_PLANAR_XZ: {
      u = (pos.x - min.x) / md;
      v = (pos.z - min.z) / md;
      break;
    }

    case MODE_PLANAR_YZ: {
      u = (pos.y - min.y) / md;
      v = (pos.z - min.z) / md;
      break;
    }

    case MODE_CYLINDRICAL: {
      // mappingBlend=0 → pure side projection for all faces (original behaviour, no cap seam).
      // mappingBlend>0 → smooth side↔cap blend.
      // Cylinder axis is +Z. Center XY and radius default to the AABB but can
      // be overridden so partial cylinders (pie slices) project undistorted.
      const cx = settings.cylinderCenterX ?? center.x;
      const cy = settings.cylinderCenterY ?? center.y;
      const r  = Math.max(settings.cylinderRadius ?? Math.max(size.x, size.y) * 0.5, 1e-6);
      const C  = TWO_PI * r;
      const rx = pos.x - cx;
      const ry = pos.y - cy;
      const blend = settings.mappingBlend ?? 0.0;
      const theta = Math.atan2(ry, rx);
      const uRaw = (theta / TWO_PI) + 0.5;
      const vSide = (pos.z - min.z) / C;

      // Seam smoothing: cross-fade between left-side and right-side texture
      // continuations at the atan2 wrap. Both sides use smoothly varying UVs
      // (shifted by ±1.0 in raw space), preserving full texture detail.
      const seamBand = (settings.seamBandWidth ?? 0.5) * 0.1;
      const seamDist = Math.min(uRaw, 1.0 - uRaw);
      const inSeamZone = seamBand > 0.001 && seamDist < seamBand;

      let sideSamples;
      if (inSeamZone) {
        const d = uRaw < 0.5 ? uRaw : uRaw - 1.0;
        const tRaw = (d + seamBand) / (2.0 * seamBand);
        const t = tRaw * tRaw * (3 - 2 * tRaw); // smoothstep
        const tLeft  = applyTransform(1.0 + d, vSide, scaleU, scaleV, offsetU, offsetV, cosR, sinR);
        const tRight = applyTransform(d,       vSide, scaleU, scaleV, offsetU, offsetV, cosR, sinR);
        sideSamples = [
          { u: tRight.u, v: tRight.v, w: t },
          { u: tLeft.u,  v: tLeft.v,  w: 1 - t },
        ];
      } else {
        const tSide = applyTransform(uRaw, vSide, scaleU, scaleV, offsetU, offsetV, cosR, sinR);
        sideSamples = [{ u: tSide.u, v: tSide.v, w: 1 }];
      }

      if (blend <= 0.001) {
        if (sideSamples.length === 1 && sideSamples[0].w === 1) return sideSamples[0];
        return { triplanar: true, samples: sideSamples };
      }

      const capThreshold = Math.cos((settings.capAngle ?? 20) * Math.PI / 180);
      const blendHalf = (settings.seamBandWidth ?? 0.5) * 0.5;
      const absnz = Math.abs(normal.z);
      const capW = Math.max(0, Math.min(1, (absnz - (capThreshold - blendHalf)) / (2 * blendHalf + 1e-6)));

      if (capW <= 0) {
        if (sideSamples.length === 1 && sideSamples[0].w === 1) return sideSamples[0];
        return { triplanar: true, samples: sideSamples };
      }

      const uCap  = rx / C + 0.5;
      const vCap  = ry / C + 0.5;
      const tCap = applyTransform(uCap, vCap, scaleU, scaleV, offsetU, offsetV, cosR, sinR);

      if (capW >= 1) {
        return tCap;
      }

      // Combine seam-blended side samples with cap sample
      const samples = sideSamples.map(s => ({ u: s.u, v: s.v, w: s.w * (1 - capW) }));
      samples.push({ u: tCap.u, v: tCap.v, w: capW });
      return { triplanar: true, samples };
    }

    case MODE_SPHERICAL: {
      const rx = pos.x - center.x;
      const ry = pos.y - center.y;
      const rz = pos.z - center.z;
      const r  = Math.sqrt(rx*rx + ry*ry + rz*rz);
      const phi   = Math.acos(Math.max(-1, Math.min(1, rz / Math.max(r, 1e-6)))); // [0, PI], Z is up
      const theta = Math.atan2(ry, rx);              // [-PI, PI]
      const uRaw = (theta / TWO_PI) + 0.5;
      const vRaw = phi / Math.PI;

      // Seam smoothing: cross-fade at the atan2 wrap
      const seamBand = (settings.seamBandWidth ?? 0.5) * 0.1;
      const seamDist = Math.min(uRaw, 1.0 - uRaw);
      if (seamBand > 0.001 && seamDist < seamBand) {
        const d = uRaw < 0.5 ? uRaw : uRaw - 1.0;
        const tRaw = (d + seamBand) / (2.0 * seamBand);
        const t = tRaw * tRaw * (3 - 2 * tRaw); // smoothstep
        const tLeft  = applyTransform(1.0 + d, vRaw, scaleU, scaleV, offsetU, offsetV, cosR, sinR);
        const tRight = applyTransform(d,       vRaw, scaleU, scaleV, offsetU, offsetV, cosR, sinR);
        return {
          triplanar: true,
          samples: [
            { u: tRight.u, v: tRight.v, w: t },
            { u: tLeft.u,  v: tLeft.v,  w: 1 - t },
          ],
        };
      }

      u = uRaw;
      v = vRaw;
      break;
    }

    case MODE_CUBIC: {
      const weights = getCubicBlendWeights(normal, settings.mappingBlend ?? 0.0, settings.seamBandWidth ?? 0.35);
      // Flip U based on normal sign so opposite faces show correct (non-mirrored) text.
      // Derived from camera right = view_dir × up_dir for each face orientation (Z-up).
      let yzU = (pos.y - min.y) / md;
      if (normal.x < 0) yzU = -yzU;
      let xzU = (pos.x - min.x) / md;
      if (normal.y > 0) xzU = -xzU;
      let xyU = (pos.x - min.x) / md;
      if (normal.z < 0) xyU = -xyU;
      const tYZ = applyTransform(yzU, (pos.z - min.z) / md, scaleU, scaleV, offsetU, offsetV, cosR, sinR);
      const tXZ = applyTransform(xzU, (pos.z - min.z) / md, scaleU, scaleV, offsetU, offsetV, cosR, sinR);
      const tXY = applyTransform(xyU, (pos.y - min.y) / md, scaleU, scaleV, offsetU, offsetV, cosR, sinR);

      if (weights.x > 0.999) return tYZ;
      if (weights.y > 0.999) return tXZ;
      if (weights.z > 0.999) return tXY;

      return {
        triplanar: true,
        samples: [
          { u: tXY.u, v: tXY.v, w: weights.z },
          { u: tXZ.u, v: tXZ.v, w: weights.y },
          { u: tYZ.u, v: tYZ.v, w: weights.x },
        ],
      };
    }

    case MODE_WOOD_AUTO: {
      // Beam-oriented: project the grain along the piece's OWN long axis (PCA
      // frame in settings.beamFrame), so it runs lengthwise at any orientation —
      // fixing the world-axis Wood Auto limitation on inclined timber. Falls
      // back to the legacy longest-world-axis pick when no frame was supplied.
      if (settings.beamFrame) {
        const { rawU, rawV } = orientedRawUV(pos, normal, settings.beamFrame);
        // Échelle PHYSIQUE : orientedRawUV normalise par l'étendue de la
        // SÉLECTION (frame.md) → la même valeur d'échelle donnait un grain
        // plus petit sur une poutre plus courte, et copier un slot obligeait
        // à re-régler échelle+lissage par poutre (vécu). Re-normaliser par le
        // md GLOBAL (la convention de tous les autres modes) rend l'échelle
        // identique en mm sur toutes les poutres. Miroir GLSL : woodBeamHeight.
        const k = settings.beamFrame.md / md;
        return applyTransform(rawU * k, rawV * k, scaleU, scaleV, offsetU, offsetV, cosR, sinR);
      }
      return computeWoodAutoUV();
    }
    case MODE_WOOD_X:
    case MODE_WOOD_Y:
    case MODE_WOOD_Z: {
      return computeWoodAutoUV();
    }

    case MODE_TRIPLANAR:
    default: {
      // World-space normal blending
      const ax = Math.abs(normal.x);
      const ay = Math.abs(normal.y);
      const az = Math.abs(normal.z);
      const ax2 = ax * ax, ay2 = ay * ay, az2 = az * az;
      const bx = ax2 * ax2;
      const by = ay2 * ay2;
      const bz = az2 * az2;
      const sum = bx + by + bz + 1e-6;
      const wx = bx / sum;
      const wy = by / sum;
      const wz = bz / sum;

      // Flip U based on normal sign so opposite faces show correct (non-mirrored) text.
      let yzU = (pos.y - min.y) / md;
      if (normal.x < 0) yzU = -yzU;
      let xzU = (pos.x - min.x) / md;
      if (normal.y > 0) xzU = -xzU;
      let xyU = (pos.x - min.x) / md;
      if (normal.z < 0) xyU = -xyU;
      const uvXY = {
        u: xyU,
        v: (pos.y - min.y) / md,
        w: wz,
      };
      const uvXZ = {
        u: xzU,
        v: (pos.z - min.z) / md,
        w: wy,
      };
      const uvYZ = {
        u: yzU,
        v: (pos.z - min.z) / md,
        w: wx,
      };

      // Apply scale+offset+rotation and tile each independently
      return {
        triplanar: true,
        samples: [
          { ...applyTransform(uvXY.u, uvXY.v, scaleU, scaleV, offsetU, offsetV, cosR, sinR), w: uvXY.w },
          { ...applyTransform(uvXZ.u, uvXZ.v, scaleU, scaleV, offsetU, offsetV, cosR, sinR), w: uvXZ.w },
          { ...applyTransform(uvYZ.u, uvYZ.v, scaleU, scaleV, offsetU, offsetV, cosR, sinR), w: uvYZ.w },
        ],
      };
    }
  }

  return applyTransform(u, v, scaleU, scaleV, offsetU, offsetV, cosR, sinR);
}

function applyTransform(u, v, scaleU, scaleV, offsetU, offsetV, cosR, sinR) {
  let uu = u / scaleU + offsetU;
  let vv = v / scaleV + offsetV;
  if (cosR !== 1 || sinR !== 0) {
    uu -= 0.5; vv -= 0.5;
    const ru = cosR * uu - sinR * vv;
    const rv = sinR * uu + cosR * vv;
    uu = ru + 0.5; vv = rv + 0.5;
  }
  return { triplanar: false, u: fract(uu), v: fract(vv) };
}

/** Fractional part, always positive (mirrors GLSL fract) */
function fract(x) { return x - Math.floor(x); }

/**
 * Période MONDE de la texture : combien de millimètres couvre UNE tuile
 * complète, le long de U et de V.
 *
 * Depuis le portage en échelle absolue, scaleU/scaleV SONT la taille de tuile
 * en mm (à l'aspect près), quel que soit le mode — les modes cylindrique et
 * sphérique la mesurent en longueur d'ARC à leur rayon de référence, donc la
 * valeur dérive un peu si la surface réelle s'en écarte.
 *
 * SOURCE UNIQUE : deux consommateurs en dépendent — `smartResolution.js`, qui
 * choisit une longueur d'arête assez fine pour résoudre la texture, et
 * `displacement.js`, qui choisit le niveau de mip qui band-limite la texture à
 * cette arête. Ce sont les deux bouts de la MÊME contrainte de Nyquist (monter
 * le taux d'échantillonnage, ou baisser la bande passante du signal) : s'ils
 * calculaient la période séparément, ils pourraient diverger en silence et se
 * contredire.
 */
export function computeWorldPeriod(settings) {
  const aspectU = settings.textureAspectU ?? 1;
  const aspectV = settings.textureAspectV ?? 1;
  return {
    periodU_mm: (settings.scaleU || 1e-6) / aspectU,
    periodV_mm: (settings.scaleV || 1e-6) / aspectV,
  };
}
