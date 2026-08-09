// Aperçus du pilote T0 : plateaux ASSEMBLÉS (bac + 4 dalles) + face arrière.
// Compagnon de make-pilot-tiles.mjs — lit les STL déjà générés dans
// PILOTE_DALLES et écrit les PNG dans PILOTE_DALLES/apercus/ (à côté des
// pièces, pour juger le raccord avant de slicer).
//
//   node scripts/render-pilot-tiles.mjs
//
// Rendu CPU (test/render/raster.mjs). Leçon encodée : la caméra regarde LE
// LONG de viewDir → Z négatif pour voir le dessus, Z positif pour le dos.

import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTris, savePNG } from '../test/render/raster.mjs';

const OUT = 'C:/Users/geton/OneDrive/Bureau/CAD/DOOR/PILOTE_DALLES';
const APERCUS = join(OUT, 'apercus');
const W = 50.8, TH = 6.5, AMP = 0.6, LIP = 4, BASE_T = 2.4;

// dalles à monter en plateau 2×2 (les candidates encore en course)
const BOARDS = ['v4_dallage', 'v7_bordure'];
const BACKS = ['v7_bordure'];               // vues du dos (chanfrein + rainure)

function readSTL(path) {
  const buf = readFileSync(path);
  const n = buf.readUInt32LE(80);
  const tris = [];
  let o = 84;
  for (let k = 0; k < n; k++) {
    const p = [];
    for (let i = 0; i < 3; i++) {
      const b = o + 12 + i * 12;
      p.push([buf.readFloatLE(b), buf.readFloatLE(b + 4), buf.readFloatLE(b + 8)]);
    }
    tris.push(p);
    o += 50;
  }
  return tris;
}
// inverse de upright([x,y,z] → [x, -z+TH+AMP, y]) : remettre la dalle À PLAT
const unUp = ([X, Y, Z]) => [X, Z, TH + AMP - Y];

function withNormals(raw) {
  return raw.map(p => {
    const u = [p[1][0]-p[0][0], p[1][1]-p[0][1], p[1][2]-p[0][2]];
    const v = [p[2][0]-p[0][0], p[2][1]-p[0][1], p[2][2]-p[0][2]];
    return { p, uv: [[0,0],[0,0],[0,0]],
      n: [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]] };
  });
}

function center(raw) {
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const t of raw) for (const p of t) for (let i = 0; i < 3; i++) {
    if (p[i] < mn[i]) mn[i] = p[i]; if (p[i] > mx[i]) mx[i] = p[i];
  }
  return { x: (mn[0]+mx[0])/2, y: (mn[1]+mx[1])/2, z: (mn[2]+mx[2])/2 };
}

const TEX = { width: 1, height: 1, data: new Uint8Array([235, 235, 235, 255]) };
function render(raw, viewDir, light, path) {
  const img = renderTris(withNormals(raw), {
    width: 1100, height: 900, viewDir, up: [0, 1, 0], light,
    bounds: { center: center(raw) }, texture: TEX, bg: 18,
  });
  savePNG(img, path);
  console.log(`apercus/${path.split(/[\\/]/).pop()}`);
}

mkdirSync(APERCUS, { recursive: true });
const plate = readSTL(join(OUT, 'pilote_plaque_2x2.stl'));

for (const name of BOARDS) {
  const tile = readSTL(join(OUT, `pilote_${name}.stl`)).map(t => t.map(unUp));
  const all = [...plate];
  for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const dx = LIP + 0.1 + cx * W, dy = LIP + 0.1 + cy * W;
    for (const t of tile) all.push(t.map(([x, y, z]) => [x + dx, y + dy, z + BASE_T]));
  }
  render(all, [0.3, -0.45, -0.83], [0.4, 0.5, 0.85], join(APERCUS, `plateau_${name}.png`));
}

for (const name of BACKS) {
  const tile = readSTL(join(OUT, `pilote_${name}.stl`)).map(t => t.map(unUp));
  render(tile, [0.3, 0.45, 0.83], [0.4, 0.5, -0.85], join(APERCUS, `dos_${name}.png`));
}

console.log(`\nAperçus : ${APERCUS}`);
