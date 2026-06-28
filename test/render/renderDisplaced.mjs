// Render the REAL displaced relief (not just flat texture): subdivide + the
// production applyDisplacement, then shade the displaced surface so the grain
// shows as actual grooves — the printable result. Headless, no GPU.
//
//   node test/render/renderDisplaced.mjs wood-x 0  woodgrain_02
//   node test/render/renderDisplaced.mjs wood-x 35 woodgrain_02
//
// Output: test/render/disp-<mode>[-incl<deg>]-<tex>.png

import * as THREE from 'three';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runSingle, baseSettings } from '../lib/pipeline.mjs';
import { loadTexture } from './loadTexture.mjs';
import { renderTris, savePNG } from './raster.mjs';

const MODES = { 'wood-auto': 7, 'wood-x': 8, 'wood-y': 9, 'wood-z': 10, 'triplanar': 5, 'cubic': 6 };
const arg = process.argv[2] || 'wood-x';
const mode = MODES[arg] ?? 8;
const incline = parseFloat(process.argv[3] || '0');
const texName = process.argv[4] || 'woodgrain_02';
const scale = parseFloat(process.argv[5] || '0.5'); // texture scale (U & V)

const here = dirname(fileURLToPath(import.meta.url));
// Controlled procedural textures: 'vbands' grey varies with V (grain lines along
// U), 'ubands' varies with U — to isolate which coordinate drives the grain.
function procTex(kind, w = 256, h = 256) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const coord = kind === 'ubands' ? x / w : y / h;
    const g = (Math.floor(coord * 10) % 2) ? 235 : 25;
    const i = (y * w + x) * 4; d[i] = d[i+1] = d[i+2] = g; d[i+3] = 255;
  }
  return { data: d, width: w, height: h };
}
const texture = (texName === 'vbands' || texName === 'ubands')
  ? procTex(texName)
  : loadTexture(join(here, '..', '..', 'textures', texName.includes('.') ? texName : `${texName}.jpg`));

// Beam, long axis X, optional rafter tilt about Y.
const axis = (process.argv[6] || 'z').toLowerCase(); // tilt axis: 'z' (plan) discriminates oriented vs world; 'y' is degenerate
const by = parseFloat(process.argv[7] || '14');     // cross-section width (Y)
const bz = parseFloat(process.argv[8] || '14');     // cross-section height (Z)
const geo = new THREE.BoxGeometry(90, by, bz, 1, 1, 1).toNonIndexed();
if (incline) (axis === 'y' ? geo.rotateY : geo.rotateZ).call(geo, incline * Math.PI / 180);

const settings = {
  ...baseSettings,
  mappingMode: mode,
  amplitude: 1.6,
  symmetricDisplacement: true,
  scaleU: scale, scaleV: scale,
  // No explicit beamFrame: Wood Auto (mode 7) auto-computes it in applyDisplacement,
  // exercising the real app export path.
};

const displaced = await runSingle(geo, { refineLength: 0.8, settings, texture });

// Build shaded tris from the DISPLACED geometry (face normals encode the relief).
const pos = displaced.attributes.position.array;
const triCount = pos.length / 9;
let minx=1e9,miny=1e9,minz=1e9,maxx=-1e9,maxy=-1e9,maxz=-1e9;
for (let i = 0; i < pos.length; i += 3) {
  if (pos[i]<minx)minx=pos[i]; if(pos[i]>maxx)maxx=pos[i];
  if (pos[i+1]<miny)miny=pos[i+1]; if(pos[i+1]>maxy)maxy=pos[i+1];
  if (pos[i+2]<minz)minz=pos[i+2]; if(pos[i+2]>maxz)maxz=pos[i+2];
}
const bounds = {
  min:{x:minx,y:miny,z:minz}, max:{x:maxx,y:maxy,z:maxz},
  center:{x:(minx+maxx)/2,y:(miny+maxy)/2,z:(minz+maxz)/2},
  size:{x:maxx-minx,y:maxy-miny,z:maxz-minz},
};
const tris = [];
for (let t = 0; t < triCount; t++) {
  const o = t*9;
  const A=[pos[o],pos[o+1],pos[o+2]],B=[pos[o+3],pos[o+4],pos[o+5]],C=[pos[o+6],pos[o+7],pos[o+8]];
  const e1=[B[0]-A[0],B[1]-A[1],B[2]-A[2]],e2=[C[0]-A[0],C[1]-A[1],C[2]-A[2]];
  const n=[e1[1]*e2[2]-e1[2]*e2[1], e1[2]*e2[0]-e1[0]*e2[2], e1[0]*e2[1]-e1[1]*e2[0]];
  tris.push({ p:[A,B,C], uv:[[0,0],[0,0],[0,0]], n });
}

// White texture → pure relief shading (the grooves are the signal).
const white = { data: new Uint8ClampedArray([255,255,255,255]), width:1, height:1 };
const img = renderTris(tris, {
  width: 860, height: 420,
  viewDir:[0.45,-1,0.5], up:[0,0,1], light:[0.35,-0.65,0.9],
  bounds, texture: white,
});
const suffix = `${arg}${incline?`-incl${incline}`:''}-${texName.replace(/\..+$/,'')}`;
const out = join(here, `disp-${suffix}.png`);
savePNG(img, out);
console.log('wrote', out, `(${triCount} tris)`);
