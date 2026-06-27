// Characterization fingerprint of a non-indexed BufferGeometry.
//
// The golden master compares these fingerprints. They capture the properties a
// behavior-preserving refactor must NOT change: triangle count, exact shape
// (hash of quantized positions), watertightness, and bounding box. If a refactor
// leaves all of these identical, the displaced mesh is byte-for-byte the same
// shape; if one changes, the diff says exactly which property moved.

import { createHash } from 'node:crypto';

const Q = 1e4; // quantize positions to 1e-4 mm (well below FDM resolution)

export function fingerprintGeometry(geo) {
  const pos = geo.attributes.position.array;
  const triCount = (pos.length / 9) | 0;

  // Bounding box
  let minx = Infinity, miny = Infinity, minz = Infinity;
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < minx) minx = x; if (y < miny) miny = y; if (z < minz) minz = z;
    if (x > maxx) maxx = x; if (y > maxy) maxy = y; if (z > maxz) maxz = z;
  }

  // Watertight / manifold check via quantized-vertex edge multiset.
  const vid = new Map();
  const idOf = (i) => {
    const k = Math.round(pos[i * 3] * Q) + ',' +
              Math.round(pos[i * 3 + 1] * Q) + ',' +
              Math.round(pos[i * 3 + 2] * Q);
    let v = vid.get(k);
    if (v === undefined) { v = vid.size; vid.set(k, v); }
    return v;
  };
  const edges = new Map();
  const addEdge = (a, b) => {
    if (a === b) return;
    const k = a < b ? (a + '_' + b) : (b + '_' + a);
    edges.set(k, (edges.get(k) || 0) + 1);
  };
  for (let t = 0; t < triCount; t++) {
    const a = idOf(t * 3), b = idOf(t * 3 + 1), c = idOf(t * 3 + 2);
    addEdge(a, b); addEdge(b, c); addEdge(c, a);
  }
  let openEdges = 0, nonManifold = 0;
  for (const cnt of edges.values()) {
    if (cnt === 1) openEdges++;
    else if (cnt > 2) nonManifold++;
  }

  // Exact-shape hash: quantized positions in stored triangle order.
  const h = createHash('sha256');
  const ibuf = Buffer.alloc(pos.length * 4);
  for (let i = 0; i < pos.length; i++) ibuf.writeInt32LE(Math.round(pos[i] * Q), i * 4);
  h.update(ibuf);

  const r = (v) => Math.round(v * 1e4) / 1e4;
  return {
    triangles: triCount,
    uniqueVerts: vid.size,
    bbox: [r(minx), r(miny), r(minz), r(maxx), r(maxy), r(maxz)],
    openEdges,
    nonManifold,
    watertight: openEdges === 0 && nonManifold === 0,
    vhash: h.digest('hex').slice(0, 16),
  };
}

/** Structural diff between two fingerprints. Returns array of human-readable diffs. */
export function diffFingerprints(golden, current) {
  const diffs = [];
  for (const key of ['triangles', 'uniqueVerts', 'openEdges', 'nonManifold', 'watertight', 'vhash']) {
    if (JSON.stringify(golden[key]) !== JSON.stringify(current[key])) {
      diffs.push(`${key}: ${JSON.stringify(golden[key])} -> ${JSON.stringify(current[key])}`);
    }
  }
  const bb = (a, b) => a.some((v, i) => Math.abs(v - b[i]) > 1e-3);
  if (bb(golden.bbox, current.bbox)) {
    diffs.push(`bbox: ${JSON.stringify(golden.bbox)} -> ${JSON.stringify(current.bbox)}`);
  }
  return diffs;
}
