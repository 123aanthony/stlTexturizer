// One-off measurement to DECIDE step 2 (should multi-slot export decimate?).
// Not part of `npm test`. Builds dense displaced meshes through the real
// pipeline, decimates to several targets, and reports the trade-off:
//   - triangle reduction
//   - watertight preserved? (the multi-slot seam risk)
//   - shape deviation vs the un-decimated mesh (detail lost), in mm and % of
//     the bounding-box diagonal.
//
// Run: node test/measure-decimation.mjs

import { decimate } from '../js/decimation.js';
import { fingerprintGeometry } from './lib/fingerprint.mjs';
import { proceduralTexture } from './lib/texture.mjs';
import { runSingle, runMultiSlot, baseSettings } from './lib/pipeline.mjs';
import { readBinarySTL } from './lib/stl.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cube = () => readBinarySTL(join(here, 'fixtures', 'cube.stl'));
const checker = proceduralTexture(128, 128, 'checker');
const sine = proceduralTexture(128, 128, 'sine');
const s = (o) => ({ ...baseSettings, ...o });

// Unique (quantized) vertex set of a geometry.
function uniqueVerts(geo) {
  const pos = geo.attributes.position.array;
  const seen = new Set();
  const out = [];
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    const k = Math.round(x * 1e4) + ',' + Math.round(y * 1e4) + ',' + Math.round(z * 1e4);
    if (!seen.has(k)) { seen.add(k); out.push(x, y, z); }
  }
  return new Float64Array(out);
}

function bboxDiag(geo) {
  const p = geo.attributes.position.array;
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < mnx) mnx = p[i]; if (p[i] > mxx) mxx = p[i];
    if (p[i+1] < mny) mny = p[i+1]; if (p[i+1] > mxy) mxy = p[i+1];
    if (p[i+2] < mnz) mnz = p[i+2]; if (p[i+2] > mxz) mxz = p[i+2];
  }
  return Math.hypot(mxx - mnx, mxy - mny, mxz - mnz);
}

// Sampled one-directional nearest-vertex distance: for ~N sampled points in A,
// distance to the nearest vertex in B. Returns {mean, max}.
function nearestDist(A, B, sampleN = 1500) {
  const an = A.length / 3, bn = B.length / 3;
  const step = Math.max(1, Math.floor(an / sampleN));
  let sum = 0, cnt = 0, max = 0;
  for (let i = 0; i < an; i += step) {
    const ax = A[i*3], ay = A[i*3+1], az = A[i*3+2];
    let best = Infinity;
    for (let j = 0; j < bn; j++) {
      const dx = ax - B[j*3], dy = ay - B[j*3+1], dz = az - B[j*3+2];
      const d2 = dx*dx + dy*dy + dz*dz;
      if (d2 < best) best = d2;
    }
    const d = Math.sqrt(best);
    sum += d; cnt++; if (d > max) max = d;
  }
  return { mean: sum / cnt, max };
}

async function measure(label, geo) {
  const fp0 = fingerprintGeometry(geo);
  const diag = bboxDiag(geo);
  const vIn = uniqueVerts(geo);
  console.log(`\n### ${label}`);
  console.log(`  input: ${fp0.triangles} tris, watertight=${fp0.watertight}, bboxDiag=${diag.toFixed(2)}mm`);

  for (const frac of [0.5, 0.25, 0.1]) {
    const target = Math.max(4, Math.round(fp0.triangles * frac));
    // decimate works on a fresh clone-ish; pass the geometry (it builds its own indexed copy)
    const dec = await decimate(geo, target, null);
    const fp = fingerprintGeometry(dec);
    const vOut = uniqueVerts(dec);
    const dAB = nearestDist(vIn, vOut);   // original detail -> nearest decimated (detail loss)
    const dBA = nearestDist(vOut, vIn);   // decimated -> nearest original (intrusion)
    const devMax = Math.max(dAB.max, dBA.max);
    const devMean = Math.max(dAB.mean, dBA.mean);
    const reduction = (100 * (1 - fp.triangles / fp0.triangles)).toFixed(0);
    console.log(
      `  → target ${frac*100}%: ${fp.triangles} tris (-${reduction}%), ` +
      `watertight=${fp.watertight}${fp.watertight ? '' : ` (open=${fp.openEdges}, nm=${fp.nonManifold})`}, ` +
      `dev mean=${devMean.toFixed(3)}mm (${(100*devMean/diag).toFixed(2)}%), max=${devMax.toFixed(3)}mm (${(100*devMax/diag).toFixed(2)}%)`
    );
  }
}

// Dense multi-slot: all faces owned (real material seam between top & bottom),
// fine refine so there's something to decimate.
const multi = await runMultiSlot(cube(), {
  refineLength: 1.2,
  slots: [
    { texture: checker, settings: s({ amplitude: 1.5 }) },
    { texture: sine,    settings: s({ amplitude: 1.0 }) },
  ],
  assignOriginal: (_t, _c, n) => (n.z >= 0 ? 0 : 1),  // top->0, bottom->1, all owned
});
await measure('multi-slot cube (seam between 2 materials)', multi);

// Dense single-slot for contrast (this path already decimates in prod).
const single = await runSingle(cube(), { refineLength: 1.2, settings: s({ amplitude: 1.5 }), texture: checker });
await measure('single-slot cube', single);

console.log('\n(FDM ref: nozzle 0.4mm, layer ~0.1-0.2mm — deviation below ~0.1mm is below print resolution.)');
