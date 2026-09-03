// PARITE APERCU <-> EXPORT, sur les 12 MODES DE PROJECTION.
//
// LE DEFAUT CRAINT
// ----------------
// L'apercu deplace dans un shader GLSL (js/previewMaterial.js), l'export sur
// CPU (js/mapping.js computeUV, appele par js/displacement.js). Ce sont DEUX
// ecritures de la MEME transformation. Quand elles divergent, l'ecran montre
// une matiere et le fichier imprime en montre une autre — et rien ne le
// signale : chacune a l'air correcte prise seule. C'est le pire defaut
// possible ici, et il s'est deja produit plusieurs fois dans ce projet.
//
// CE QUI EXISTAIT AVANT CE FICHIER
// --------------------------------
// `previewParity.mjs` compare le mode 0 (planar XY) et `polarMapping.mjs` le
// mode 11. Soit 2 modes sur 12 : les 10 autres — dont le cylindrique, le
// triplanaire, le cubique et les quatre bois — n'avaient AUCUN oracle de
// parite. Ce fichier ferme le trou par un seul mecanisme, applique a tous.
//
// POURQUOI COMPARER DES HAUTEURS, ET PAS DES UV
// ---------------------------------------------
// `computeUV` rend soit un UV, soit une LISTE d'echantillons ponderes
// (triplanaire, cubique, couture, calotte) ; le GLSL, lui, melange ses
// echantillons a l'interieur de `computeHeightAtPoint` et ne rend qu'un
// nombre. Comparer les UV terme a terme obligerait a apparier des structures
// differentes — donc a ecrire un oracle qui epouse l'implementation. On
// compare donc ce que l'utilisateur voit reellement : LA HAUTEUR, obtenue en
// echantillonnant la MEME fonction de texture des deux cotes. Les POIDS
// entrent alors dans la comparaison, ce qu'un test d'UV seul ne peut pas
// faire — et c'est justement la qu'etait la divergence trouvee (mode 3).
//
// LA TEXTURE EST ANALYTIQUE, PAS UNE IMAGE
// ----------------------------------------
// Une image echantillonnee ferait entrer le sampler dans la mesure et
// masquerait les petits ecarts (un decalage d'UV sous le texel ne changerait
// rien). La fonction ci-dessous est periodique — donc insensible au `fract`
// que le CPU applique et que le GPU delegue au wrapping — et son gradient est
// borne : un ecart d'UV de e produit un ecart de hauteur d'au plus ~7.9 e.
// Le seuil de 1e-6 attrape donc toute derive d'UV a partir de ~1.3e-7.
//
// CE QUE CE FICHIER NE PROUVE PAS
// -------------------------------
// 1. Il n'EXECUTE pas le GLSL (pas de GPU en headless) : la fonction
//    `glslHeight` en est une TRANSCRIPTION. Elle peut donc se perimer si le
//    shader change sans qu'on la suive — d'ou les controles STRUCTURELS de la
//    section 1, qui lisent le source du shader et tombent si une branche
//    disparait ou si un mode cesse d'etre cable.
// 2. Il compare la couche PROJECTION. La couche DEPLACEMENT (poids etales par
//    seamBlend.js, prefiltre mip) a ses propres miroirs, et certains n'existent
//    PAS cote apercu — ils sont recenses en fin de fichier.
//
// CE QU'IL A TROUVE A LA POSE (03/09), ET CE QUI A ETE FAIT
// ---------------------------------------------------------
// Trois divergences, sur du code que personne ne soupconnait :
//   - CYLINDRIQUE 4.4e-2 : `capW` etait une rampe LINEAIRE cote CPU et un
//     SMOOTHSTEP cote shader. Memes bornes, courbe differente — donc l'ecart
//     maximal au MILIEU de la bande, la ou aucune des deux ne parait fausse :
//     9.62 % de poids, a 37.3 deg de l'axe, AUX REGLAGES D'USINE.
//   - TRIPLANAIRE 2.2e-4 : epsilon de garde +1e-6 (CPU) contre +1e-4 (GLSL).
//   - CUBIQUE 1e-6 residuel : normalisation finale `somme + eps` cote shader
//     contre somme EXACTE cote CPU.
// Decision PO du 03/09 : c'est l'APERCU qui s'aligne sur l'export, jamais
// l'inverse — corriger le CPU aurait change une geometrie deja imprimee pour
// rattraper un affichage. Les trois corrections sont donc DANS
// `previewMaterial.js`, et le golden est reste bit-identique.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeUV, scaleMmToRelative, polarFrame, getCubicBlendWeights } from '../js/mapping.js';
import { _cubicUV } from '../js/displacement.js';
import { computeBeamFrame } from '../js/beamAxis.js';

const here = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(join(here, '..', 'js', 'previewMaterial.js'), 'utf8');
// Source DEBARRASSEE DE SES COMMENTAIRES : sans ca, un controle structurel
// resterait vert sur une ligne mise en commentaire (piege deja paye par
// previewParity.mjs, cf. son en-tete).
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*/g, ' ');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

// ── Texture analytique, periodique, a gradient borne ─────────────────────────
const TEX = (u, v) => 0.5 + 0.25 * Math.sin(2 * Math.PI * (3 * u + 0.17))
                          + 0.25 * Math.sin(2 * Math.PI * (5 * v - 0.41));

// ── Petite algebre GLSL ──────────────────────────────────────────────────────
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
const radians = (d) => d * Math.PI / 180;
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ── Uniformes : DERIVES COMME LE FAIT L'APPLICATION ──────────────────────────
// Miroir de previewMaterial.updateMaterial. Les deux derivations reellement
// partagees (l'echelle mm -> relatif et le repere polaire) sont IMPORTEES de
// mapping.js, comme le fait le module d'apercu — on ne les recopie pas. Les
// controles structurels de la section 1 verifient que les autres lignes n'ont
// pas bouge.
function uniformsFor(settings, bounds) {
  const rel = scaleMmToRelative(settings.mappingMode, settings, bounds);
  const pf = polarFrame(settings, bounds);
  return {
    mappingMode: settings.mappingMode,
    scaleU: rel.u, scaleV: rel.v,
    offsetU: settings.offsetU ?? 0, offsetV: settings.offsetV ?? 0,
    rotation: radians(settings.rotation ?? 0),
    aspectU: settings.textureAspectU ?? 1, aspectV: settings.textureAspectV ?? 1,
    boundsMin: [bounds.min.x, bounds.min.y, bounds.min.z],
    boundsSize: [bounds.size.x, bounds.size.y, bounds.size.z],
    boundsCenter: [bounds.center.x, bounds.center.y, bounds.center.z],
    cylinderCenter: [settings.cylinderCenterX ?? bounds.center.x,
                     settings.cylinderCenterY ?? bounds.center.y],
    cylinderRadius: settings.cylinderRadius ?? Math.max(bounds.size.x, bounds.size.y) * 0.5,
    polarAxis: pf.ax === 'x' ? 0 : pf.ax === 'y' ? 1 : 2,
    polarCenter: [pf.c1, pf.c2],
    polarRadius: pf.R,
    mappingBlend: settings.mappingBlend ?? 0,
    seamBandWidth: settings.seamBandWidth ?? 0.35,
    capAngle: settings.capAngle ?? 20,
    pieceVarOn: settings.pieceXform ? 1 : 0,
    px: settings.pieceXform || null,
    beam: settings.beamFrame || null,
  };
}

// ── Transcription du GLSL ────────────────────────────────────────────────────
// Copie LITTERALE de js/previewMaterial.js (bloc sharedGLSL), y compris
// l'ordre des operations et les epsilons : le but est de comparer deux
// ecritures independantes, pas de les rapprocher.

function sampleMap(rawU, rawV, U) {                       // <- GLSL sampleMap
  let offU = U.offsetU, offV = U.offsetV, rot = U.rotation, mir = 1;
  if (U.pieceVarOn === 1) {
    offU += U.px.du ?? 0; offV += U.px.dv ?? 0;
    rot += radians(U.px.rotDeg ?? 0);
    mir = U.px.mirrorU ? -1 : 1;
  }
  let u = (rawU * U.aspectU) / (U.scaleU * mir) + offU;
  let v = (rawV * U.aspectV) / U.scaleV + offV;
  const c = Math.cos(rot), s = Math.sin(rot);
  u -= 0.5; v -= 0.5;
  const ru = c * u - s * v, rv = s * u + c * v;
  return TEX(ru + 0.5, rv + 0.5);
}

const CUBIC_EPS = 1e-4;
function dominantCubicAxis(n) {                            // <- GLSL
  const a = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])];
  if (a[0] >= a[1] - CUBIC_EPS && a[0] >= a[2] - CUBIC_EPS) return 0;
  if (a[1] >= a[2] - CUBIC_EPS) return 1;
  return 2;
}
function cubicBlendWeights(n, U) {                         // <- GLSL
  const a = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])];
  const axis = dominantCubicAxis(n);
  const primary = a[axis];
  const secondary = axis === 0 ? Math.max(a[1], a[2])
                  : axis === 1 ? Math.max(a[0], a[2]) : Math.max(a[0], a[1]);
  const oneHot = [0, 0, 0]; oneHot[axis] = 1;
  if (U.mappingBlend < 0.001) return oneHot;
  const seamWidth = Math.max(U.seamBandWidth, CUBIC_EPS * 2);
  const raw = 1 - clamp((primary - secondary) / seamWidth, 0, 1);
  const seamMix = U.mappingBlend * raw * raw * (3 - 2 * raw);
  if (seamMix <= 0.001) return oneHot;
  const power = 1 + (1 - seamMix) * 11;
  let soft = a.map(x => Math.pow(x, power));
  const ssum = soft[0] + soft[1] + soft[2] + 1e-6;
  soft = soft.map(x => x / ssum);
  const bl = [0, 1, 2].map(i => mix(oneHot[i], soft[i], seamMix));
  const bsum = Math.max(bl[0] + bl[1] + bl[2], 1e-6);   // <- max, pas +eps (cf. shader)
  return bl.map(x => x / bsum);
}

function woodAxisForMode(U) {                              // <- GLSL
  if (U.mappingMode === 8) return 0;
  if (U.mappingMode === 9) return 1;
  if (U.mappingMode === 10) return 2;
  const s = U.boundsSize;
  if (s[1] >= s[0] && s[1] >= s[2]) return 1;
  if (s[2] >= s[0] && s[2] >= s[1]) return 2;
  return 0;
}

function woodBeamHeight(p, projN, md, U) {                 // <- GLSL
  if (U.mappingMode === 7 && U.beam) {
    const f = U.beam;
    const rel = [p[0] - f.center[0], p[1] - f.center[1], p[2] - f.center[2]];
    const lu = dot3(rel, f.U);
    const lvc = dot3(rel, f.V) - f.cmid[0];
    const lwc = dot3(rel, f.W) - f.cmid[1];
    const nV = Math.abs(dot3(projN, f.V));
    const nW = Math.abs(dot3(projN, f.W));
    const oU = (lu - f.min.u) / md;
    const oV = (nV >= nW) ? (lwc / md) : (lvc / md);
    return sampleMap(oU, oV, U);
  }
  const a = [Math.abs(projN[0]), Math.abs(projN[1]), Math.abs(projN[2])];
  const m = U.boundsMin;
  const axis = woodAxisForMode(U);
  let rawU = 0, rawV = 0;
  if (axis === 0) {
    rawU = (p[0] - m[0]) / md;
    if (a[0] >= a[1] && a[0] >= a[2]) rawV = (p[1] - m[1]) / md;
    else if (a[2] >= a[1]) rawV = (p[1] - m[1]) / md;
    else rawV = (p[2] - m[2]) / md;
  } else if (axis === 1) {
    rawU = (p[1] - m[1]) / md;
    if (a[1] >= a[0] && a[1] >= a[2]) rawV = (p[0] - m[0]) / md;
    else if (a[2] >= a[0]) rawV = (p[0] - m[0]) / md;
    else rawV = (p[2] - m[2]) / md;
  } else {
    rawU = (p[2] - m[2]) / md;
    if (a[2] >= a[0] && a[2] >= a[1]) rawV = (p[0] - m[0]) / md;
    else if (a[1] >= a[0]) rawV = (p[0] - m[0]) / md;
    else rawV = (p[1] - m[1]) / md;
  }
  return sampleMap(rawU, rawV, U);
}

const TWO_PI = 2 * Math.PI;

/** Miroir de computeHeightAtPoint (js/previewMaterial.js). */
function glslHeight(p, projN, blendN, U) {
  const m = U.boundsMin, c = U.boundsCenter, s = U.boundsSize;
  const rel = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  const md = Math.max(Math.max(s[0], Math.max(s[1], s[2])), 1e-6);
  const M = U.mappingMode;

  if (M === 0) return sampleMap((p[0] - m[0]) / md, (p[1] - m[1]) / md, U);
  if (M === 1) return sampleMap((p[0] - m[0]) / md, (p[2] - m[2]) / md, U);
  if (M === 2) return sampleMap((p[1] - m[1]) / md, (p[2] - m[2]) / md, U);

  if (M === 3) {
    const rx = p[0] - U.cylinderCenter[0], ry = p[1] - U.cylinderCenter[1];
    const r = Math.max(U.cylinderRadius, 1e-6), C = TWO_PI * r;
    const uCyl = Math.atan2(ry, rx) / TWO_PI + 0.5;
    const vCyl = (p[2] - m[2]) / C;
    const seamBand = U.seamBandWidth * 0.1;
    const seamDist = Math.min(uCyl, 1 - uCyl);
    let hSide;
    if (seamBand > 0.001 && seamDist < seamBand) {
      const d = uCyl < 0.5 ? uCyl : uCyl - 1;
      const t = smoothstep(0, 1, (d + seamBand) / (2 * seamBand));
      hSide = mix(sampleMap(1 + d, vCyl, U), sampleMap(d, vCyl, U), t);
    } else {
      hSide = sampleMap(uCyl, vCyl, U);
    }
    if (U.mappingBlend < 0.001) return hSide;
    const capThreshold = Math.cos(radians(U.capAngle));
    const blendHalf = U.seamBandWidth * 0.5;
    const capW = clamp((Math.abs(blendN[2]) - (capThreshold - blendHalf)) / (2 * blendHalf + 1e-6), 0, 1);
    const hCap = sampleMap(rx / C + 0.5, ry / C + 0.5, U);
    return mix(hSide, hCap, capW);
  }

  if (M === 11) {
    const sw = (v, ax) => ax === 0 ? [v[1], v[2], v[0]] : ax === 1 ? [v[2], v[0], v[1]] : v;
    const pAx = sw(p, U.polarAxis), nAx = sw(blendN, U.polarAxis), mnAx = sw(m, U.polarAxis);
    const p1 = pAx[0] - U.polarCenter[0], p2 = pAx[1] - U.polarCenter[1];
    const R = Math.max(U.polarRadius, 1e-4), C = TWO_PI * R;
    const uPol = Math.atan2(p2, p1) / TWO_PI + 0.5;
    const vSide = (pAx[2] - mnAx[2]) / C;
    const vCap = Math.hypot(p1, p2) / C;
    const capThr = Math.cos(radians(U.capAngle));
    const band = Math.max(U.seamBandWidth, 1e-3);
    const capLo = Math.max(0, capThr - band);
    const capW = smoothstep(capLo, Math.max(capThr, capLo + 1e-6), Math.abs(nAx[2]));
    const seamBand = U.seamBandWidth * 0.1;
    const seamDist = Math.min(uPol, 1 - uPol);
    let hSide, hCap;
    if (seamBand > 0.001 && seamDist < seamBand) {
      const d = uPol < 0.5 ? uPol : uPol - 1;
      const t = smoothstep(0, 1, (d + seamBand) / (2 * seamBand));
      hSide = mix(sampleMap(1 + d, vSide, U), sampleMap(d, vSide, U), t);
      hCap  = mix(sampleMap(1 + d, vCap,  U), sampleMap(d, vCap,  U), t);
    } else {
      hSide = sampleMap(uPol, vSide, U);
      hCap  = sampleMap(uPol, vCap,  U);
    }
    return mix(hSide, hCap, capW);
  }

  if (M === 4) {
    const r = Math.hypot(rel[0], rel[1], rel[2]);
    const phi = Math.acos(clamp(rel[2] / Math.max(r, 1e-6), -1, 1));
    const uSph = Math.atan2(rel[1], rel[0]) / TWO_PI + 0.5;
    const vSph = phi / Math.PI;
    const seamBand = U.seamBandWidth * 0.1;
    const seamDist = Math.min(uSph, 1 - uSph);
    if (seamBand > 0.001 && seamDist < seamBand) {
      const d = uSph < 0.5 ? uSph : uSph - 1;
      const t = smoothstep(0, 1, (d + seamBand) / (2 * seamBand));
      return mix(sampleMap(1 + d, vSph, U), sampleMap(d, vSph, U), t);
    }
    return sampleMap(uSph, vSph, U);
  }

  if (M >= 7 && M <= 10) return woodBeamHeight(p, projN, md, U);

  if (M === 5) {
    let b = [Math.abs(projN[0]), Math.abs(projN[1]), Math.abs(projN[2])].map(x => Math.pow(x, 4));
    const sum = b[0] + b[1] + b[2] + 1e-6;
    b = b.map(x => x / sum);
    let yzU = (p[1] - m[1]) / md; if (projN[0] < 0) yzU = -yzU;
    let xzU = (p[0] - m[0]) / md; if (projN[1] > 0) xzU = -xzU;
    let xyU = (p[0] - m[0]) / md; if (projN[2] < 0) xyU = -xyU;
    const hXY = sampleMap(xyU, (p[1] - m[1]) / md, U);
    const hXZ = sampleMap(xzU, (p[2] - m[2]) / md, U);
    const hYZ = sampleMap(yzU, (p[2] - m[2]) / md, U);
    return hXY * b[2] + hXZ * b[1] + hYZ * b[0];
  }

  // MODE_CUBIC (6) et defaut
  let yzU = (p[1] - m[1]) / md; if (projN[0] < 0) yzU = -yzU;
  let xzU = (p[0] - m[0]) / md; if (projN[1] > 0) xzU = -xzU;
  let xyU = (p[0] - m[0]) / md; if (projN[2] < 0) xyU = -xyU;
  const hYZ = sampleMap(yzU, (p[2] - m[2]) / md, U);
  const hXZ = sampleMap(xzU, (p[2] - m[2]) / md, U);
  const hXY = sampleMap(xyU, (p[1] - m[1]) / md, U);
  let bN = blendN;
  const af = [Math.abs(projN[0]), Math.abs(projN[1]), Math.abs(projN[2])];
  const facePrimary = Math.max(af[0], Math.max(af[1], af[2]));
  const faceSecondary = af[0] + af[1] + af[2] - facePrimary - Math.min(af[0], Math.min(af[1], af[2]));
  if (facePrimary - faceSecondary <= CUBIC_EPS) bN = projN;
  const w = cubicBlendWeights(bN, U);
  return hYZ * w[0] + hXZ * w[1] + hXY * w[2];
}

// ── Cote CPU : le chemin REELLEMENT parcouru a l'export ──────────────────────
//
// ⚠️ LE MODE CUBIQUE NE PASSE PAS PAR `computeUV`. `displacement.js` a un
// chemin RAPIDE dedie (`if (sampleSettings.mappingMode === 6) … continue`) qui
// court-circuite `mapping.js` : a l'export, la branche MODE_CUBIC de
// `computeUV` n'est atteinte que si les trois poids sont nuls, ce qui
// n'arrive pas. Comparer le shader a cette branche-la, c'est le comparer a du
// code MORT — et la premiere version de ce fichier le faisait, ce qui lui a
// fait annoncer une divergence de 1.3e-4 (le court-circuit `w > 0.999` de
// `computeUV`) qui n'existe PAS entre l'apercu et l'export. Un oracle qui vise
// le mauvais chemin ne mesure rien de reel. On reproduit donc ici le chemin
// rapide : memes poids (`getCubicBlendWeights`, deja partagee) et meme
// transformation (`_cubicUV`, exportee pour ca).
function cpuHeightCubic(p, n, settings, bounds) {
  const md = Math.max(bounds.size.x, bounds.size.y, bounds.size.z, 1e-6);
  const relScale = scaleMmToRelative(6, settings, bounds);
  const px = settings.pieceXform || null;
  const rotRad = ((settings.rotation ?? 0) + (px?.rotDeg ?? 0)) * Math.PI / 180;
  const aU = settings.textureAspectU ?? 1, aV = settings.textureAspectV ?? 1;
  const w = getCubicBlendWeights({ x: n[0], y: n[1], z: n[2] },
                                 settings.mappingBlend ?? 0, settings.seamBandWidth ?? 0.35);
  let h = 0;
  if (w.x > 0) {
    let rawU = (p[1] - bounds.min.y) / md; if (n[0] < 0) rawU = -rawU;
    const uv = _cubicUV(rawU, (p[2] - bounds.min.z) / md, settings, rotRad, aU, aV, relScale, px);
    h += TEX(uv.u, uv.v) * w.x;
  }
  if (w.y > 0) {
    let rawU = (p[0] - bounds.min.x) / md; if (n[1] > 0) rawU = -rawU;
    const uv = _cubicUV(rawU, (p[2] - bounds.min.z) / md, settings, rotRad, aU, aV, relScale, px);
    h += TEX(uv.u, uv.v) * w.y;
  }
  if (w.z > 0) {
    let rawU = (p[0] - bounds.min.x) / md; if (n[2] < 0) rawU = -rawU;
    const uv = _cubicUV(rawU, (p[1] - bounds.min.y) / md, settings, rotRad, aU, aV, relScale, px);
    h += TEX(uv.u, uv.v) * w.z;
  }
  return h;
}

function cpuHeight(p, n, settings, bounds) {
  if (settings.mappingMode === 6) return cpuHeightCubic(p, n, settings, bounds);
  const r = computeUV({ x: p[0], y: p[1], z: p[2] }, { x: n[0], y: n[1], z: n[2] },
                      settings.mappingMode, settings, bounds);
  if (r.triplanar) {
    let h = 0;
    for (const s of r.samples) h += TEX(s.u, s.v) * s.w;
    return h;
  }
  return TEX(r.u, r.v);
}

// ── Scene d'epreuve ──────────────────────────────────────────────────────────
const bounds = {
  min: { x: -30, y: -20, z: 0 }, max: { x: 30, y: 20, z: 45 },
  size: { x: 60, y: 40, z: 45 }, center: { x: 0, y: 0, z: 22.5 },
};

/** Points + normales : faces d'axe, biais, et deux balayages continus. */
function samplePoints() {
  const pts = [];
  const norms = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    [0.5773502692, 0.5773502692, 0.5773502692], [-0.6, 0.3, 0.7416198487], [0.13, -0.97, 0.2050609665],
  ];
  for (const n of norms) {
    for (const p of [[7, 3, 11], [-13, 9, 31], [22, -17, 5], [-2.5, -6.5, 40]]) pts.push([p, n]);
  }
  // Balayage de l'inclinaison : traverse les bandes de fondu (calotte, cubique)
  for (let i = 0; i <= 40; i++) {
    const a = (i / 40) * Math.PI / 2;
    pts.push([[9.5, -4.25, 17.75], [Math.cos(a), 0, Math.sin(a)]]);
    pts.push([[-11.25, 6.75, 29.5], [Math.cos(a) * 0.6, Math.cos(a) * 0.8, Math.sin(a)]]);
  }
  // Balayage azimutal : traverse la couture atan2 (cylindrique, spherique, polaire)
  for (let i = 0; i <= 60; i++) {
    const th = -Math.PI + (i / 60) * TWO_PI;
    pts.push([[18 * Math.cos(th), 18 * Math.sin(th), 13.5], [Math.cos(th), Math.sin(th), 0]]);
  }
  return pts;
}
const POINTS = samplePoints();

const beamFrame = (() => {
  // Poutre inclinee : le repere PCA sert le mode 7 oriente.
  const pos = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    const cx = -25 + t * 50, cy = -15 + t * 30, cz = 5 + t * 20;
    for (const [dx, dy, dz] of [[0, 0, 0], [1.5, 0, 0], [0, 1.5, 0], [0, 0, 1.5], [1.5, 1.5, 0]]) {
      pos.push(cx + dx, cy + dy, cz + dz);
    }
  }
  return computeBeamFrame(new Float32Array(pos), null);
})();

const S0 = {
  scaleU: 12, scaleV: 9, offsetU: 0.13, offsetV: -0.27, rotation: 17,
  textureAspectU: 1, textureAspectV: 1, mappingBlend: 0, seamBandWidth: 0.5,
  capAngle: 20, cylinderRadius: 21, bounds,
};

// mode -> variantes de reglages a eprouver
const CASES = [
  ['planar XY',      0,  [{}, { rotation: 0 }, { textureAspectU: 1.6, textureAspectV: 0.7 },
                           { pieceXform: { du: 0.31, dv: -0.12, rotDeg: 7, mirrorU: true } }]],
  ['planar XZ',      1,  [{}, { scaleU: 4, scaleV: 40 }]],
  ['planar YZ',      2,  [{}, { offsetU: 0, offsetV: 0, rotation: 0 }]],
  ['cylindrique',    3,  [{}, { mappingBlend: 0.6 }, { mappingBlend: 1, capAngle: 35 },
                           { mappingBlend: 0.6, seamBandWidth: 0.2 }]],
  ['spherique',      4,  [{}, { seamBandWidth: 0.9 }]],
  ['triplanaire',    5,  [{}, { rotation: 0 }]],
  ['cubique',        6,  [{}, { mappingBlend: 0.5 }, { mappingBlend: 1, seamBandWidth: 0.6 }]],
  ['bois auto',      7,  [{}, { rotation: 0 }]],
  ['bois auto PCA',  7,  [{ beamFrame }, { beamFrame, scaleU: 30 }]],
  ['bois X',         8,  [{}]],
  ['bois Y',         9,  [{}]],
  ['bois Z',        10,  [{}]],
  ['polaire Z',     11,  [{ mappingBlend: 0.6 }, { mappingBlend: 1, capAngle: 30 }]],
  ['polaire X',     11,  [{ polarAxis: 'x', mappingBlend: 0.6 }]],
];

// ── DIVERGENCES CONNUES, PUBLIEES ────────────────────────────────────────────
// ⚠️ Une baseline qui enregistre un defaut le rend PERMANENT et MUET. Cette
// table n'existe donc que pour garder la barriere VERTE sur ce qui etait deja
// casse le jour de sa pose, et chaque ligne porte sa mesure et sa decision a
// prendre. Une entree dont l'ecart RETOMBE fait echouer le test : on ne garde
// pas un pansement sur une plaie fermee.
// La table est VIDE : les trois divergences relevees a la pose ont ete
// corrigees le jour meme (decision PO du 03/09 : c'est l'APERCU qui s'aligne
// sur l'export, jamais l'inverse — sinon on change une geometrie deja imprimee
// pour rattraper un affichage). Elle reste en place parce que la prochaine
// divergence trouvee y sera baselinee de la meme facon : avec sa MESURE et sa
// CAUSE, et sous la garde ci-dessous qui fait ECHOUER une entree dont l'ecart
// est retombe — un pansement ne doit pas survivre a sa plaie.
const KNOWN = {};

console.log('\n1. Le shader porte encore toutes ses branches');

check('les 12 modes sont cables dans computeHeightAtPoint', () => {
  const i = SRC.indexOf('float computeHeightAtPoint(');
  assert.ok(i > 0, 'computeHeightAtPoint introuvable');
  const body = SRC.slice(i, SRC.indexOf('const vertexShader'));
  for (const m of [0, 1, 2, 3, 4, 5, 11]) {
    assert.ok(new RegExp(`mappingMode\\s*==\\s*${m}\\b`).test(body),
      `le mode ${m} n a plus de branche dans le shader`);
  }
  assert.ok(/mappingMode\s*>=\s*7\s*&&\s*mappingMode\s*<=\s*10/.test(body),
    'la branche bois (7-10) a disparu');
  assert.ok(/cubicBlendWeights\s*\(/.test(body), 'le cubique ne pondere plus');
});

check('les derivations d uniformes que ce test recopie sont toujours la', () => {
  // Si l une de ces lignes change, la transcription ci-dessus ment sans le dire.
  assert.match(SRC, /scaleMmToRelative/, 'l echelle mm->relatif n est plus partagee avec mapping.js');
  assert.match(SRC, /polarFrame\s*\(/, 'le repere polaire n est plus partage avec mapping.js');
  assert.match(SRC, /u\.rotation\.value\s*=\s*\(settings\.rotation\s*\?\?\s*0\)\s*\*\s*Math\.PI\s*\/\s*180/,
    'la conversion degres->radians de la rotation a change');
  assert.match(SRC, /Math\.max\(settings\.bounds\.size\.x,\s*settings\.bounds\.size\.y\)\s*\*\s*0\.5/,
    'le rayon cylindrique par defaut a change');
});

console.log('\n2. Parite NUMERIQUE hauteur apercu vs hauteur export, 12 modes');

const TOL = 1e-6;
const report = [];

for (const [label, mode, variants] of CASES) {
  let worst = 0, worstAt = null, n = 0;
  for (const over of variants) {
    const settings = { ...S0, ...over, mappingMode: mode };
    const U = uniformsFor(settings, bounds);
    for (const [p, nrm] of POINTS) {
      // Chemin d APERCU par deplacement : projN == blendN == normale du sommet,
      // exactement ce que passe le vertex shader (previewMaterial.js:397).
      const g = glslHeight(p, nrm, nrm, U);
      const c = cpuHeight(p, nrm, settings, bounds);
      const d = Math.abs(g - c);
      if (d > worst) { worst = d; worstAt = { p, nrm, over }; }
      n++;
    }
  }
  report.push({ label, worst, n, worstAt });
}

for (const r of report) {
  const known = KNOWN[r.label];
  const budget = known ? known.max : TOL;
  const ok = r.worst <= budget;
  const tag = known ? (ok ? 'CONNU' : 'FAIL ') : (ok ? 'ok   ' : 'FAIL ');
  console.log(`  ${tag} ${r.label.padEnd(16)} ecart max ${r.worst.toExponential(2)}  (${r.n} points)`);
  if (ok) pass++;
  else {
    fail++;
    console.log(`       au point ${JSON.stringify(r.worstAt.p)} n=${JSON.stringify(r.worstAt.nrm)} reglages ${JSON.stringify(r.worstAt.over)}`);
  }
}

check('aucune divergence CONNUE n a disparu sans que la table suive', () => {
  for (const [label, k] of Object.entries(KNOWN)) {
    const r = report.find(x => x.label === label);
    assert.ok(r, `entree KNOWN "${label}" sans cas correspondant`);
    assert.ok(r.worst > TOL,
      `"${label}" ne diverge plus (ecart ${r.worst.toExponential(2)}) : retirer l entree KNOWN`);
  }
});

console.log('\n3. La sonde MORD (auto-controle)');

check('un decalage d UV de 1e-6 est bien vu', () => {
  // Sans ce controle, un oracle qui compare deux fois la meme chose passerait
  // au vert pour toujours. On injecte un biais minuscule dans les uniformes.
  const settings = { ...S0, mappingMode: 0 };
  const U = uniformsFor(settings, bounds);
  const biaise = { ...U, offsetU: U.offsetU + 1e-6 };
  let worst = 0;
  for (const [p, nrm] of POINTS) {
    worst = Math.max(worst, Math.abs(glslHeight(p, nrm, nrm, biaise) - cpuHeight(p, nrm, settings, bounds)));
  }
  assert.ok(worst > TOL, `un biais de 1e-6 sur l offset ne produit que ${worst.toExponential(2)}`);
});

console.log('\n4. Ce que ce fichier ne couvre PAS (recense, non teste ici)');
console.log('   - poids etales par seamBlend.js (seamBlendWidthMm) : AUCUN miroir dans');
console.log('     le shader — le reglage ne change rien a l apercu, seulement a l export.');
console.log('   - prefiltre mip (mipPyramid.js) : le shader echantillonne sans LOD.');
console.log('   - le GLSL n est pas EXECUTE : glslHeight en est une transcription, tenue');
console.log('     par les controles structurels de la section 1. Le lot qui fermerait ce');
console.log('     trou : exporter sharedGLSL et le faire tourner dans les e2e Electron.');

console.log(`\nVERDICT: ${fail ? 'FAIL' : 'PASS'}  (${pass} ok, ${fail} failed)`);
process.exit(fail ? 1 : 0);
