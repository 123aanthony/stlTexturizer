/**
 * Mip pyramid prefilter for the displacement sampler.
 *
 * WHY THIS EXISTS
 * ---------------
 * `displacement.js` moves one vertex per *sample*: it takes a single bilinear
 * tap of the displacement map at the vertex's UV. Bilinear is a RECONSTRUCTION
 * filter, not a PREFILTER — it interpolates between the 4 nearest texels and is
 * blind to everything in between. So the sampling rate is the mesh vertex
 * spacing, while the signal bandwidth is the texture's.
 *
 * With the app defaults (25 mm tile, 1 mm target edge, 600 px map) each mesh
 * edge spans
 *
 *     texels_per_edge = (edge_mm / period_mm) * imgWidth = (1 / 25) * 600 = 24
 *
 * i.e. one tap every 24 texels — 23/24 of the source data is discarded and the
 * texel we land on is essentially arbitrary. Nyquist says only features coarser
 * than 2 edges (2 mm world / 48 texels) survive; everything finer does not fade
 * out, it ALIASES into structured noise. That is why smooth, low-frequency maps
 * (leather, noise) print well while fine ones (knurling, weave) come out as
 * mush: the smooth ones are already band-limited below the mesh Nyquist.
 *
 * THE FIX
 * -------
 * Band-limit the texture to the sampling rate BEFORE sampling it — a mip
 * pyramid plus a per-vertex level chosen from the local texel footprint. This
 * is ordinary texture minification filtering, applied to geometry instead of
 * pixels. Fine detail collapses to its local mean, which is the correct answer,
 * instead of to noise.
 *
 * Why a pyramid rather than one global blur of the map: the footprint VARIES
 * across a single export — triplanar and cubic blends, U and V periods that
 * differ, cylindrical/spherical mapping near small radii, and simply uneven
 * triangle sizes out of subdivision. A global blur has to be sized for the
 * worst case and over-smooths everywhere else. The global blur still exists as
 * `textureSmoothing` and remains useful as deliberate ARTISTIC softening —
 * this module is about correctness, not taste.
 *
 * NON-REGRESSION BY CONSTRUCTION
 * ------------------------------
 * At lod <= 0 — i.e. whenever the mesh samples the map at one texel per edge or
 * finer, i.e. whenever there was no aliasing to fix — this module delegates to
 * the caller's own `sampleBilinear` on the original RGBA buffer. Not
 * "numerically equivalent": the same function on the same bytes. Only genuinely
 * undersampled exports change, which is precisely the intent.
 *
 * Known simplifications, deliberate (SIMPLE FIRST):
 *   - ISOTROPIC: the footprint is max(U, V), so a map stretched hard along one
 *     axis is filtered by its worst axis. Anisotropic filtering would take N
 *     taps along the major axis; not worth it until a case demands it.
 *   - Odd dimensions drop their last row/column when halved. Sub-texel error at
 *     high levels, invisible in a displacement prefilter.
 *   - Downsampling WRAPS, because a displacement map tiles, so the pyramid
 *     stays seamless — same reason `getEffectiveMapEntry` blurs a 3x3 tiling.
 */

// Pyramids are memoised on ImageData identity, like textureAnalysis.js. Entries
// are immutable in this app (re-import creates a new object), so reference
// identity IS content identity.
import { computeWorldPeriod } from './mapping.js';

const _cache = new WeakMap();

/**
 * Build (or fetch) the mip pyramid of a greyscale displacement map.
 *
 * levels[0] is the full-resolution greyscale base. It exists only as the source
 * for level 1 — sampling at lod 0 goes through the caller's original bilinear
 * on the original bytes, see the header note on non-regression.
 *
 * @param {{data:Uint8ClampedArray, width:number, height:number}} imageData
 * @returns {{levels: Array<{data:Float32Array,w:number,h:number}>, maxLevel:number}|null}
 */
export function getMipPyramid(imageData) {
  if (!imageData || !imageData.width || !imageData.height) return null;
  const cached = _cache.get(imageData);
  if (cached) return cached;

  const { width: w, height: h, data } = imageData;
  const base = new Float32Array(w * h);
  // Red channel only — the map is greyscale, and it is the channel
  // displacement.js samples.
  for (let i = 0, n = w * h; i < n; i++) base[i] = data[i * 4] / 255;

  const levels = [{ data: base, w, h }];
  let cur = levels[0];
  while (cur.w > 1 || cur.h > 1) {
    cur = _halve(cur);
    levels.push(cur);
  }

  const pyr = { levels, maxLevel: levels.length - 1 };
  _cache.set(imageData, pyr);
  return pyr;
}

/** 2x2 box downsample with wraparound, because the map tiles. */
function _halve(src) {
  const w = Math.max(1, src.w >> 1);
  const h = Math.max(1, src.h >> 1);
  const out = new Float32Array(w * h);
  const sw = src.w, sh = src.h, sd = src.data;
  for (let y = 0; y < h; y++) {
    const y0 = (2 * y) % sh;
    const y1 = (2 * y + 1) % sh;
    const r0 = y0 * sw, r1 = y1 * sw;
    for (let x = 0; x < w; x++) {
      const x0 = (2 * x) % sw;
      const x1 = (2 * x + 1) % sw;
      out[y * w + x] = 0.25 * (sd[r0 + x0] + sd[r0 + x1] + sd[r1 + x0] + sd[r1 + x1]);
    }
  }
  return { data: out, w, h };
}

/**
 * Bilinear tap inside one pyramid level.
 *
 * Uses the SAME uv-to-texel convention as displacement.js's `sampleBilinear`
 * (tile by mod 1, flip V, map onto [0, n-1]) so a level change shifts detail
 * scale only, never position.
 */
export function sampleLevel(level, u, v) {
  u = ((u % 1) + 1) % 1;
  v = ((v % 1) + 1) % 1;
  v = 1 - v;

  const { data, w, h } = level;
  const fx = u * (w - 1);
  const fy = v * (h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const v00 = data[y0 * w + x0];
  const v10 = data[y0 * w + x1];
  const v01 = data[y1 * w + x0];
  const v11 = data[y1 * w + x1];

  return v00 * (1 - tx) * (1 - ty)
       + v10 * tx * (1 - ty)
       + v01 * (1 - tx) * ty
       + v11 * tx * ty;
}

/**
 * Texels de la carte parcourus par MILLIMÈTRE de surface, pour un jeu de
 * réglages et une taille de carte donnés.
 *
 * SOURCE UNIQUE de l'empreinte. L'empreinte d'un sommet vaut simplement
 * `arête_mm × texPerMm` — la partie qui ne dépend pas du sommet est isolée ici
 * pour que `displacement.js` la hisse hors de sa boucle, et pour que le sampler
 * et la recommandation de lissage décrivent LA MÊME empreinte. Deux fonctions
 * qui décrivent la même géométrie doivent partager le même point d'évaluation,
 * sinon elles divergent en silence sur le cas extrême.
 *
 * Isotrope : on retient l'axe le plus DENSE (cf. simplifications, en tête).
 */
export function texPerMm(settings, texW, texH) {
  const { periodU_mm, periodV_mm } = computeWorldPeriod(settings);
  return Math.max(texW / Math.max(periodU_mm, 1e-9), texH / Math.max(periodV_mm, 1e-9));
}

/**
 * Sigma recommandé pour le flou gaussien de la carte (`textureSmoothing`), et
 * le diagnostic qui va avec.
 *
 * Le flou et le préfiltre mip attaquent la MÊME contrainte de Nyquist : les
 * empiler filtrerait deux fois. Cette fonction les fait composer.
 *
 *   - `resolved`    : la maille résout la carte (<= 1 texel par arête). Rien à
 *                     filtrer, et flouter ne ferait que détruire du détail que
 *                     l'export sait porter.
 *   - `prefiltered` : sous-échantillonné, mais le préfiltre est actif. Il fait
 *                     déjà le travail, PAR SOMMET donc mieux qu'un flou global ;
 *                     le slider redevient un réglage purement ARTISTIQUE et
 *                     l'auto ne propose rien.
 *   - `undersampled`: sous-échantillonné, préfiltre coupé. Le flou est le seul
 *                     recours ; on le dimensionne sur le pas d'échantillonnage
 *                     RÉEL — sigma = empreinte / 2, soit un Gaussien dont ±1σ
 *                     couvre un intervalle d'échantillonnage complet.
 *
 * @returns {{texelsPerEdge:number, sigma:number, reason:string, clamped:boolean}}
 */
export function recommendedSmoothing({ settings, texW, texH, refineLength, antialias, sigmaMax = 20 }) {
  if (!texW || !texH || !(refineLength > 0)) {
    return { texelsPerEdge: 0, sigma: 0, reason: 'unknown', clamped: false };
  }
  const texelsPerEdge = refineLength * texPerMm(settings, texW, texH);

  if (texelsPerEdge <= 1) return { texelsPerEdge, sigma: 0, reason: 'resolved', clamped: false };
  if (antialias)          return { texelsPerEdge, sigma: 0, reason: 'prefiltered', clamped: false };

  const want = texelsPerEdge / 2;
  return {
    texelsPerEdge,
    sigma: Math.min(want, sigmaMax),
    reason: 'undersampled',
    clamped: want > sigmaMax,
  };
}

/**
 * Level of detail for a texel footprint, in the usual mip convention: a
 * footprint of F source texels wants level log2(F), whose texels are F wide.
 *
 * Returns 0 for any footprint <= 1 texel, which is what routes adequately
 * sampled exports back onto the untouched legacy path.
 */
export function lodForFootprint(footprintTexels) {
  if (!(footprintTexels > 1)) return 0;
  return Math.log2(footprintTexels);
}

/**
 * Sample bilinéaire d'une ImageData RGBA en niveaux de gris (0-1), tuilée
 * par mod 1.
 *
 * DÉPLACÉ VERBATIM depuis displacement.js — c'est le sampler historique, et
 * c'est lui qui définit la convention uv-vers-texel de toute la chaîne. Il vit
 * ici pour que `sampleFiltered` puisse l'appeler sans closure par sommet ni
 * dépendance circulaire : le module porte désormais TOUTE la pile
 * d'échantillonnage, la version pleine résolution comme la version filtrée.
 */
export function sampleBilinear(data, w, h, u, v) {
  // Ensure [0,1) — guard against floating-point edge cases
  u = ((u % 1) + 1) % 1;
  v = ((v % 1) + 1) % 1;
  // Flip V to match WebGL/Three.js texture convention (flipY=true means
  // v=0 is the bottom of the image, but ImageData row 0 is the top).
  v = 1 - v;

  const fx = u * (w - 1);
  const fy = v * (h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const tx = fx - x0;
  const ty = fy - y0;

  // Red channel — image is greyscale so R == G == B
  const v00 = data[(y0 * w + x0) * 4] / 255;
  const v10 = data[(y0 * w + x1) * 4] / 255;
  const v01 = data[(y1 * w + x0) * 4] / 255;
  const v11 = data[(y1 * w + x1) * 4] / 255;

  return v00 * (1-tx) * (1-ty)
       + v10 * tx * (1-ty)
       + v01 * (1-tx) * ty
       + v11 * tx * ty;
}

/**
 * Sample TRILINÉAIRE : bilinéaire dans les deux niveaux qui encadrent `lod`,
 * puis interpolation entre eux.
 *
 * `lod <= 0` (ou pyramide absente) retombe sur `sampleBilinear` AVEC LES
 * OCTETS D'ORIGINE — pas un équivalent numérique, la même fonction sur les
 * mêmes données. C'est ce qui rend le chemin « rien à corriger » identique au
 * bit près au comportement historique, et pas seulement proche.
 *
 * @param {object} pyr   de getMipPyramid, ou null pour forcer le pleine résolution
 * @param {Uint8ClampedArray} data  buffer RGBA d'origine
 * @param {number} w
 * @param {number} h
 * @param {number} u
 * @param {number} v
 * @param {number} lod
 */
export function sampleFiltered(pyr, data, w, h, u, v, lod) {
  if (!pyr || !(lod > 0)) return sampleBilinear(data, w, h, u, v);

  const maxLevel = pyr.maxLevel;
  if (lod >= maxLevel) return sampleLevel(pyr.levels[maxLevel], u, v);

  const l0 = Math.floor(lod);
  const frac = lod - l0;
  // Le niveau 0 de la pyramide n'est JAMAIS échantillonné : il n'existe que
  // comme source du niveau 1. Le bout pleine résolution du mélange passe par
  // le sampler d'origine (cf. la non-régression par construction, en tête).
  const a = l0 === 0 ? sampleBilinear(data, w, h, u, v) : sampleLevel(pyr.levels[l0], u, v);
  if (frac < 1e-6) return a;
  const b = sampleLevel(pyr.levels[l0 + 1], u, v);
  return a + (b - a) * frac;
}
