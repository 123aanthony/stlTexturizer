// T0 — Pilote d'impression du système de dalles (SPEC_TILEABLE / SPEC_FW_DALLE).
//
// Génère DEUX dalles texturées « à la main » (le mode Tileable n'existe pas
// encore) pour choisir le joint par défaut sur pièce réelle :
//   pilote_continu.stl — relief organique continu (pierre érodée), bords
//                        identiques par construction (heightmap périodique)
//   pilote_rainure.stl — pavés de 25,4 mm (la case D&D !) avec joint de mortier
//                        aux frontières → demi-rainure sur chaque bord
//
// Sémantique = celle des specs : déplacement STRICTEMENT axial (+Z du dessus),
// heightmap périodique (h(0,y) = h(W,y)), parois planes, watertight. Export
// DEBOUT (posé sur le chant Y-min, convention partagée), prêt à slicer.
//
//   node scripts/make-pilot-tiles.mjs
//
// Sortie : C:\Users\geton\OneDrive\Bureau\CAD\DOOR\PILOTE_DALLES\

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'C:/Users/geton/OneDrive/Bureau/CAD/DOOR/PILOTE_DALLES';
const W = 50.8;        // largeur/profondeur de dalle (2×2 cases de 25,4)
const TH = 6.5;        // épaisseur de corps (défaut rue, spec FW_Dalle)
const STEP = 0.25;     // pas de la grille du dessus (relief net à buse 0,4)
const AMP = 0.6;       // amplitude par défaut du mode (spec Tileable)

// ── PRNG déterministe (reproductible d'un run à l'autre) ─────────────────────
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Bruit de valeur PÉRIODIQUE (période = la dalle → seamless par construction)
function periodicNoise(period, seed) {
  const rnd = mulberry32(seed);
  const grid = Array.from({ length: period * period }, () => rnd());
  const at = (ix, iy) => grid[((iy % period + period) % period) * period + ((ix % period + period) % period)];
  const smooth = (t) => t * t * (3 - 2 * t);
  return (u, v) => { // u,v ∈ [0,1), lattice period×period
    const x = u * period, y = v * period;
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = smooth(x - ix), fy = smooth(y - iy);
    const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

// ── Heightmap « continu » : 3 octaves périodiques → pierre érodée ────────────
function makeContinu() {
  const o1 = periodicNoise(4, 101), o2 = periodicNoise(8, 202), o3 = periodicNoise(16, 303);
  return (x, y) => {
    const u = (((x / W) % 1) + 1) % 1, v = (((y / W) % 1) + 1) % 1;
    const n = 0.55 * o1(u, v) + 0.30 * o2(u, v) + 0.15 * o3(u, v);
    return n * AMP;
  };
}

// ── Heightmap « rainure » : pavés 25,4 + mortier aux frontières ──────────────
// Le joint (0,9 de large, plein creux) tombe sur les bords de dalle → chaque
// bord porte une DEMI-rainure ; deux dalles côte à côte = un joint complet.
// Bonus : la ligne médiane dessine la grille de jeu 25,4.
function makeRainure() {
  const CASE = 25.4, GROUT = 0.9, R = 2.2; // largeur joint, congé d'épaule
  const micro = periodicNoise(16, 404);    // grain de pierre sur les pavés
  const jitter = mulberry32(505);
  const heights = [[0, 0], [0, 0]].map(r => r.map(() => 0.42 + jitter() * 0.14));
  return (x, y) => {
    const u = (((x / W) % 1) + 1) % 1 * W, v = (((y / W) % 1) + 1) % 1 * W;
    const cx = Math.floor(u / CASE), cy = Math.floor(v / CASE);        // pavé 0/1
    const lx = u - cx * CASE, ly = v - cy * CASE;                       // local au pavé
    // distance au bord du pavé (le joint mange GROUT/2 de chaque côté)
    const d = Math.min(lx, CASE - lx, ly, CASE - ly) - GROUT / 2;
    if (d <= 0) return 0;                                               // fond de joint
    const plateau = heights[cy % 2][cx % 2];
    const shoulder = d < R ? (1 - Math.cos((d / R) * Math.PI)) / 2 : 1; // épaule douce
    const grain = micro(u / W, v / W) * 0.12;
    return (plateau + grain) * shoulder;
  };
}

// ── Maillage : height-field box (dessus déplacé AXIALEMENT, parois planes) ───
function buildTile(hmap) {
  const N = Math.round(W / STEP);                 // cellules par côté
  const vTop = [], vBot = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const x = (i / N) * W, y = (j / N) * W;
      // échantillonner à x mod W : la colonne i=N relit EXACTEMENT i=0 → bords
      // identiques par construction (le contrat du mode Tileable)
      vTop.push([x, y, TH + hmap(x % W, y % W)]);
      vBot.push([x, y, 0]);
    }
  }
  const idx = (i, j) => j * (N + 1) + i;
  const tris = [];
  const quad = (a, b, c, d) => { tris.push([a, b, c], [a, c, d]); };
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = idx(i, j), b = idx(i + 1, j), c = idx(i + 1, j + 1), d = idx(i, j + 1);
      quad(vTop[a], vTop[b], vTop[c], vTop[d]);           // dessus (+Z)
      quad(vBot[a], vBot[d], vBot[c], vBot[b]);           // dessous (−Z)
    }
  }
  for (let i = 0; i < N; i++) {                           // parois
    quad(vBot[idx(i, 0)], vBot[idx(i + 1, 0)], vTop[idx(i + 1, 0)], vTop[idx(i, 0)]);             // y=0
    quad(vBot[idx(i + 1, N)], vBot[idx(i, N)], vTop[idx(i, N)], vTop[idx(i + 1, N)]);             // y=W
    quad(vBot[idx(0, i + 1)], vBot[idx(0, i)], vTop[idx(0, i)], vTop[idx(0, i + 1)]);             // x=0
    quad(vBot[idx(N, i)], vBot[idx(N, i + 1)], vTop[idx(N, i + 1)], vTop[idx(N, i)]);             // x=W
  }
  return tris;
}

// ── Export DEBOUT : rotation +90° autour de X → le chant Y-min touche le
// plateau (convention partagée FW_Dalle/Tileable), la texture regarde devant.
function upright(tris) {
  return tris.map(t => t.map(([x, y, z]) => [x, -z + TH + AMP, y]));
}

function signedVolume(tris) {
  let v = 0;
  for (const [p0, p1, p2] of tris) {
    v += p0[0] * (p1[1] * p2[2] - p1[2] * p2[1])
       - p0[1] * (p1[0] * p2[2] - p1[2] * p2[0])
       + p0[2] * (p1[0] * p2[1] - p1[1] * p2[0]);
  }
  return v / 6;
}

function writeSTL(tris, path) {
  const buf = Buffer.alloc(84 + 50 * tris.length);
  buf.write('BumpForge tile pilot (T0)', 0, 'ascii');
  buf.writeUInt32LE(tris.length, 80);
  let o = 84;
  for (const [p0, p1, p2] of tris) {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    buf.writeFloatLE(nx / l, o); buf.writeFloatLE(ny / l, o + 4); buf.writeFloatLE(nz / l, o + 8);
    let p = o + 12;
    for (const pt of [p0, p1, p2]) {
      buf.writeFloatLE(pt[0], p); buf.writeFloatLE(pt[1], p + 4); buf.writeFloatLE(pt[2], p + 8);
      p += 12;
    }
    buf.writeUInt16LE(0, o + 48);
    o += 50;
  }
  writeFileSync(path, buf);
}

// ── Oracle du pilote : bords opposés identiques (le contrat, vérifié) ────────
function edgeOracle(hmap) {
  let worst = 0;
  for (let k = 0; k <= 200; k++) {
    const t = (k / 200) * W;
    worst = Math.max(worst,
      Math.abs(hmap(0, t % W) - hmap(W % W, t % W)),
      Math.abs(hmap(t % W, 0) - hmap(t % W, W % W)));
  }
  return worst;
}

mkdirSync(OUT, { recursive: true });
for (const [name, hmap] of [['continu', makeContinu()], ['rainure', makeRainure()]]) {
  const oracleGap = edgeOracle(hmap);
  const flat = buildTile(hmap);
  const up = upright(flat);
  const vol = signedVolume(up);
  writeSTL(up, join(OUT, `pilote_${name}.stl`));
  console.log(`pilote_${name}.stl : ${up.length} tris, volume ${vol.toFixed(0)} mm³, oracle bords = ${oracleGap.toExponential(1)} mm`);
  if (oracleGap > 1e-9) throw new Error(`bords non identiques (${name})`);
  if (vol < W * W * TH * 0.9) throw new Error(`volume suspect (${name})`);
}
console.log(`\nSortie : ${OUT}`);
