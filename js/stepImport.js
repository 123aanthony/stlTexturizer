// Direct STEP import (FreeCAD interop v2) — vendored CNCKitchen/meshStep.
//
// Produces the SAME two artefacts as the STL+sidecar pipeline, from one file:
//   - a non-indexed triangle-soup Float32Array (BumpForge's mesh convention)
//   - an in-memory face sidecar (contract v1: contiguous ranges + geometric keys)
// so everything downstream (selection snap, re-matching, live link) is shared.
//
// Triangles are REORDERED grouped by BREP face to honour the contiguous-range
// contract. Keys are computed from the RAW STEP coordinates (world mm) BEFORE
// the loader recentres the geometry — re-matching compares world keys across
// exports, so they must not depend on the (bbox-dependent) recentre offset.
//
// The vendored module (~700 KB) is imported lazily on the first .step load.

let _meshstep = null;
async function _lib() {
  if (!_meshstep) _meshstep = await import('./vendor/meshstep/index.js');
  return _meshstep;
}

/** Explicit tessellation options from the model size. NEVER use the library's
 *  autoTessellation(): in v0.1.0 it returns null options and every face fails. */
export function tessOptionsForSize(diagMm) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  return {
    surfaceDeviation: clamp(diagMm / 3000, 0.005, 0.05),
    maxEdge: clamp(diagMm / 30, 0.5, 10),
  };
}

/**
 * Parse STEP text → { positions, sidecar, partOfFace, colorGroupOfFace, diagnostics }.
 * `positions` is a raw soup (not centred, not a BufferGeometry — the loader owns
 * that); `sidecar` follows the .bumpforge-faces.json contract v1.
 * Throws when meshStep reports missing geometry (diagnostics.ok === false with
 * error-severity warnings) — the caller falls back to asking for an STL export.
 */
export async function importStepText(text) {
  const { importStep, estimateStepSize } = await _lib();
  const size = estimateStepSize(text);
  const r = importStep(text, tessOptionsForSize(size?.diag || 50));

  const errors = (r.diagnostics?.warnings || []).filter(w => w.severity === 'error');
  if (!r.diagnostics?.ok && errors.length) {
    throw new Error(`STEP import: ${errors.length} face(s) failed (${errors[0].detail || errors[0].code})`);
  }
  const triCount = (r.mesh.indices.length / 3) | 0;
  if (!triCount) throw new Error('STEP import: empty mesh');

  // Map solid id → part name (structure tree: node.bodies[].id keys solidOfTri).
  const partOfSolid = new Map();
  (function walk(node) {
    for (const b of node.bodies || []) partOfSolid.set(b.id, node.name || 'part');
    for (const c of node.children || []) walk(c);
  })(r.structure || {});

  // Group triangles by BREP face (order of first appearance) → contiguous ranges.
  const order = new Map(); // faceId → [triIndex...]
  for (let t = 0; t < triCount; t++) {
    const fid = r.faceOfTri[t];
    let arr = order.get(fid);
    if (!arr) order.set(fid, arr = []);
    arr.push(t);
  }

  const P = r.mesh.positions, I = r.mesh.indices;
  const positions = new Float32Array(triCount * 9);
  const faces = [];
  const partOfFace = [];
  const colorGroupOfFace = [];
  const faceColor = r.colors?.faceColor || null;
  // FW Diorama — couleur SENTINELLE (magenta pur) = "do not texture".
  // FreeCAD cannot export a face with NO colour: its STEP exporter decides per
  // OBJECT (measured on a real GUI export: 27 solids styled at solid level, 7
  // styled face-by-face, ZERO partially styled), and meshStep then makes every
  // face inherit its solid's colour (`faceRaw.get(id) ?? sc` in step/styles.js).
  // So a reserved colour is the only way to say "this face gets no slot": we map
  // it to -1, which groupFacesByColor already skips.
  const _isSentinel = (c) => !!c && Math.abs(c[0] - 1) < 0.02
    && Math.abs(c[1]) < 0.02 && Math.abs(c[2] - 1) < 0.02;
  const sentinelIdx = (r.colors?.palette || []).findIndex(_isSentinel);
  let w = 0, cursor = 0;

  for (const [fid, tris] of order) {
    let a2sum = 0, cx = 0, cy = 0, cz = 0, nx = 0, ny = 0, nz = 0;
    for (const t of tris) {
      const i0 = I[t * 3] * 3, i1 = I[t * 3 + 1] * 3, i2 = I[t * 3 + 2] * 3;
      const ax = P[i0], ay = P[i0 + 1], az = P[i0 + 2];
      const bx = P[i1], by = P[i1 + 1], bz = P[i1 + 2];
      const cx3 = P[i2], cy3 = P[i2 + 1], cz3 = P[i2 + 2];
      positions[w++] = ax; positions[w++] = ay; positions[w++] = az;
      positions[w++] = bx; positions[w++] = by; positions[w++] = bz;
      positions[w++] = cx3; positions[w++] = cy3; positions[w++] = cz3;
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx3 - ax, vy = cy3 - ay, vz = cz3 - az;
      const tnx = uy * vz - uz * vy, tny = uz * vx - ux * vz, tnz = ux * vy - uy * vx;
      const a2 = Math.hypot(tnx, tny, tnz);
      a2sum += a2;
      cx += a2 * (ax + bx + cx3) / 3; cy += a2 * (ay + by + cy3) / 3; cz += a2 * (az + bz + cz3) / 3;
      nx += tnx; ny += tny; nz += tnz;
    }
    const nl = Math.hypot(nx, ny, nz);
    const solidId = r.solidOfTri[tris[0]];
    const part = partOfSolid.get(solidId) || 'part';
    faces.push({
      id: `${part}.Face${fid}`,
      range: [cursor, tris.length],
      key: {
        c: a2sum > 0 ? [cx / a2sum, cy / a2sum, cz / a2sum] : [0, 0, 0],
        n: nl > 1e-9 ? [nx / nl, ny / nl, nz / nl] : [0, 0, 0],
        area: a2sum / 2,
      },
    });
    partOfFace.push(part);
    const _g = faceColor ? (faceColor.get(fid) ?? -1) : -1;
    colorGroupOfFace.push(_g === sentinelIdx ? -1 : _g);
    cursor += tris.length;
  }

  return {
    positions,
    sidecar: { version: 1, units: 'mm', triCount, faces },
    partOfFace,
    colorGroupOfFace,
    palette: r.colors?.palette || null,
    diagnostics: r.diagnostics,
  };
}
