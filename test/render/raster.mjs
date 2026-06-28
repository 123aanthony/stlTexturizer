// Tiny CPU software renderer — no GPU, no native deps. Orthographic, z-buffered,
// per-triangle textured fill with Lambert shading. Its job is to make the wood/
// beam PROJECTION visible as a PNG (UVs come from the real mapping.js), so the
// grain direction can be judged headlessly instead of only in the live app.

import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';

function norm(x, y, z) { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; }
function cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }

function sampleTex(tex, u, v) {
  let uu = ((u % 1) + 1) % 1, vv = ((v % 1) + 1) % 1;
  const x = Math.min(tex.width - 1, (uu * tex.width) | 0);
  const y = Math.min(tex.height - 1, (vv * tex.height) | 0);
  return tex.data[(y * tex.width + x) * 4] / 255; // grayscale (R)
}

/**
 * @param tris  [{ p:[[x,y,z]×3], uv:[[u,v]×3], n:[x,y,z] }]
 * @param opts  { width, height, viewDir:[x,y,z], up:[x,y,z], light:[x,y,z],
 *                bounds:{min,max,center,size}, texture, bg }
 * @returns {{rgba:Uint8Array,width,height}}
 */
export function renderTris(tris, opts) {
  const W = opts.width, H = opts.height;
  const rgba = new Uint8Array(W * H * 4);
  const zbuf = new Float64Array(W * H).fill(Infinity);
  const bg = opts.bg ?? 18;
  for (let i = 0; i < W * H; i++) { rgba[i*4] = rgba[i*4+1] = rgba[i*4+2] = bg; rgba[i*4+3] = 255; }

  const c = opts.bounds.center;
  const v = norm(...opts.viewDir);
  const right = norm(...cross(opts.up, v));
  const trueUp = cross(v, right);
  const L = norm(...opts.light);

  // Fit: project all verts, find screen extent, scale to fill with margin.
  const sx = [], sy = [], sz = [];
  for (const t of tris) for (const p of t.p) {
    const r = [p[0]-c.x, p[1]-c.y, p[2]-c.z];
    sx.push(dot(r, right)); sy.push(dot(r, trueUp)); sz.push(dot(r, v));
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < sx.length; i++) {
    if (sx[i] < minX) minX = sx[i]; if (sx[i] > maxX) maxX = sx[i];
    if (sy[i] < minY) minY = sy[i]; if (sy[i] > maxY) maxY = sy[i];
  }
  const margin = 0.9;
  const scale = margin * Math.min(W / (maxX - minX || 1), H / (maxY - minY || 1));
  const toPx = (X, Y) => [W/2 + (X - (minX+maxX)/2) * scale, H/2 - (Y - (minY+maxY)/2) * scale];

  for (const t of tris) {
    const shade = Math.max(0.15, Math.min(1, Math.abs(dot(norm(...t.n), L))));
    const P = t.p.map(p => {
      const r = [p[0]-c.x, p[1]-c.y, p[2]-c.z];
      const X = dot(r, right), Y = dot(r, trueUp), Z = dot(r, v);
      const [px, py] = toPx(X, Y);
      return { px, py, z: Z };
    });
    const [a, b, d] = P;
    const minPx = Math.max(0, Math.floor(Math.min(a.px, b.px, d.px)));
    const maxPx = Math.min(W - 1, Math.ceil(Math.max(a.px, b.px, d.px)));
    const minPy = Math.max(0, Math.floor(Math.min(a.py, b.py, d.py)));
    const maxPy = Math.min(H - 1, Math.ceil(Math.max(a.py, b.py, d.py)));
    const area = (b.px-a.px)*(d.py-a.py) - (b.py-a.py)*(d.px-a.px);
    if (Math.abs(area) < 1e-9) continue;
    const uv = t.uv;
    for (let y = minPy; y <= maxPy; y++) {
      for (let x = minPx; x <= maxPx; x++) {
        const w0 = ((b.px-x)*(d.py-y) - (b.py-y)*(d.px-x)) / area;
        const w1 = ((d.px-x)*(a.py-y) - (d.py-y)*(a.px-x)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0*a.z + w1*b.z + w2*d.z;
        const idx = y*W + x;
        if (z >= zbuf[idx]) continue;
        zbuf[idx] = z;
        const u = w0*uv[0][0] + w1*uv[1][0] + w2*uv[2][0];
        const vv = w0*uv[0][1] + w1*uv[1][1] + w2*uv[2][1];
        const g = sampleTex(opts.texture, u, vv);
        const col = Math.max(0, Math.min(255, (40 + 215 * g) * shade)) | 0;
        rgba[idx*4] = col; rgba[idx*4+1] = col; rgba[idx*4+2] = col;
      }
    }
  }
  return { rgba, width: W, height: H };
}

export function savePNG({ rgba, width, height }, path) {
  const png = new PNG({ width, height });
  png.data.set(rgba);
  writeFileSync(path, PNG.sync.write(png));
}
