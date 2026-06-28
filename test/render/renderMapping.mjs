// Render a beam with the REAL mapping.js projection so the wood-grain direction
// can be SEEN headlessly (PNG), without the live GPU app.
//
//   node test/render/renderMapping.mjs wood-x   (or wood-y / wood-z / triplanar / cubic)
//
// The texture is a directional line pattern (lines run along texture-U). If the
// projection is right, wood-X grain should run ALONG the beam's length.

import * as THREE from 'three';
import { computeUV } from '../../js/mapping.js';
import { renderTris, savePNG } from './raster.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MODES = { 'wood-auto': 7, 'wood-x': 8, 'wood-y': 9, 'wood-z': 10, 'triplanar': 5, 'cubic': 6 };
const arg = process.argv[2] || 'wood-x';
const mode = MODES[arg] ?? 8;
const incline = parseFloat(process.argv[3] || '0'); // degrees, rotate beam about Z

// Directional grain: lines whose colour depends on texture-V → lines run along U.
function grainTex(w = 128, h = 128) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const band = (Math.floor(y / 4) % 2) ? 215 : 45;
    for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; data[i] = data[i+1] = data[i+2] = band; data[i+3] = 255; }
  }
  return { data, width: w, height: h };
}

// Beam: long axis = X. Optionally inclined about Z to expose world-axis wood
// projection failing on non-axis-aligned timber.
const geo = new THREE.BoxGeometry(120, 16, 16, 1, 1, 1).toNonIndexed();
if (incline) geo.rotateY(incline * Math.PI / 180); // tilt in the vertical XZ plane (rafter)
const pos = geo.attributes.position.array;
geo.computeBoundingBox();
const bb = geo.boundingBox;
const bounds = {
  min: bb.min, max: bb.max,
  center: new THREE.Vector3().addVectors(bb.min, bb.max).multiplyScalar(0.5),
  size: new THREE.Vector3().subVectors(bb.max, bb.min),
};
const settings = { mappingMode: mode, scaleU: 0.5, scaleV: 0.5, offsetU: 0, offsetV: 0, rotation: 0, textureAspectU: 1, textureAspectV: 1 };

const tris = [];
const triCount = pos.length / 9;
for (let t = 0; t < triCount; t++) {
  const o = t * 9;
  const A = [pos[o], pos[o+1], pos[o+2]], B = [pos[o+3], pos[o+4], pos[o+5]], C = [pos[o+6], pos[o+7], pos[o+8]];
  const e1 = [B[0]-A[0], B[1]-A[1], B[2]-A[2]], e2 = [C[0]-A[0], C[1]-A[1], C[2]-A[2]];
  let n = [e1[1]*e2[2]-e1[2]*e2[1], e1[2]*e2[0]-e1[0]*e2[2], e1[0]*e2[1]-e1[1]*e2[0]];
  const ln = Math.hypot(...n) || 1; n = [n[0]/ln, n[1]/ln, n[2]/ln];
  const nObj = { x: n[0], y: n[1], z: n[2] };
  const uv = [A, B, C].map(p => {
    const r = computeUV({ x: p[0], y: p[1], z: p[2] }, nObj, mode, settings, bounds);
    return [r.u, r.v];
  });
  tris.push({ p: [A, B, C], uv, n });
}

const img = renderTris(tris, {
  width: 760, height: 380,
  viewDir: [0.55, -1, 0.5], up: [0, 0, 1], light: [0.4, -0.7, 0.85],
  bounds, texture: grainTex(),
});
const suffix = incline ? `${arg}-incl${incline}` : arg;
const out = join(dirname(fileURLToPath(import.meta.url)), `render-${suffix}.png`);
savePNG(img, out);
console.log('wrote', out, `(mode=${mode}, incline=${incline})`);
