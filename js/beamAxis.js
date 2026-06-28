// Beam-oriented wood projection: find a piece's own long axis (PCA) and project
// the grain along it, so timber gets correct lengthwise grain at ANY orientation
// — not only when aligned to a world axis (the Wood Auto limitation).
//
// Pure + headless-testable. computeBeamFrame is run once over the mesh; the
// resulting frame is passed to computeUV via settings.beamFrame, and
// orientedRawUV produces the per-vertex raw (U,V) the way the world-axis Wood
// modes do — but in the beam's local frame.

/**
 * Dominant eigenvector of the vertex covariance = the long axis of the piece.
 *
 * @param {Float32Array} positions  non-indexed (9 floats per triangle)
 * @param {Uint8Array}  [faceMask]  optional per-triangle mask; when given, only
 *   the masked triangles' vertices are used. CRUCIAL: a beam is a SELECTION of
 *   faces inside a larger model — without the mask the PCA returns the whole
 *   model's axis (e.g. the building), not the beam's.
 */
export function computeBeamFrame(positions, faceMask = null) {
  const triCount = (positions.length / 9) | 0;
  const inc = faceMask ? (t) => faceMask[t] : () => true;

  let cx = 0, cy = 0, cz = 0, n = 0;
  for (let t = 0; t < triCount; t++) {
    if (!inc(t)) continue;
    const o = t * 9;
    for (let v = 0; v < 3; v++) { cx += positions[o+v*3]; cy += positions[o+v*3+1]; cz += positions[o+v*3+2]; n++; }
  }
  if (n === 0) return null;
  cx /= n; cy /= n; cz /= n;

  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let t = 0; t < triCount; t++) {
    if (!inc(t)) continue;
    const o = t * 9;
    for (let v = 0; v < 3; v++) {
      const dx = positions[o+v*3] - cx, dy = positions[o+v*3+1] - cy, dz = positions[o+v*3+2] - cz;
      xx += dx*dx; xy += dx*dy; xz += dx*dz; yy += dy*dy; yz += dy*dz; zz += dz*dz;
    }
  }

  // Power iteration → dominant eigenvector (direction of greatest extent).
  // Seed off-axis so a perfectly axis-aligned beam doesn't sit on a saddle.
  let vx = 0.91, vy = 0.31, vz = 0.27;
  for (let it = 0; it < 50; it++) {
    const nx = xx*vx + xy*vy + xz*vz;
    const ny = xy*vx + yy*vy + yz*vz;
    const nz = xz*vx + yz*vy + zz*vz;
    const l = Math.hypot(nx, ny, nz) || 1;
    vx = nx/l; vy = ny/l; vz = nz/l;
  }
  const U = [vx, vy, vz];

  // Orthonormal cross axes (V, W).
  const ref = Math.abs(vz) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let Vx = ref[1]*vz - ref[2]*vy, Vy = ref[2]*vx - ref[0]*vz, Vz = ref[0]*vy - ref[1]*vx;
  const lv = Math.hypot(Vx, Vy, Vz) || 1; Vx /= lv; Vy /= lv; Vz /= lv;
  let Wx = vy*Vz - vz*Vy, Wy = vz*Vx - vx*Vz, Wz = vx*Vy - vy*Vx;
  // Orient W upward (world +Z) so the unwrap's seam (placed at -W) lands on the
  // beam's underside — the least-visible / print-bed face.
  if (Wz < 0) { Wx = -Wx; Wy = -Wy; Wz = -Wz; }
  const V = [Vx, Vy, Vz], W = [Wx, Wy, Wz];

  // Local-frame extents (for normalising like the world modes' (pos-min)/md).
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity, minW = Infinity, maxW = -Infinity;
  for (let t = 0; t < triCount; t++) {
    if (!inc(t)) continue;
    const o = t * 9;
    for (let vtx = 0; vtx < 3; vtx++) {
      const dx = positions[o+vtx*3] - cx, dy = positions[o+vtx*3+1] - cy, dz = positions[o+vtx*3+2] - cz;
      const u = dx*U[0]+dy*U[1]+dz*U[2], v = dx*V[0]+dy*V[1]+dz*V[2], w = dx*W[0]+dy*W[1]+dz*W[2];
      if (u<minU)minU=u; if(u>maxU)maxU=u; if(v<minV)minV=v; if(v>maxV)maxV=v; if(w<minW)minW=w; if(w>maxW)maxW=w;
    }
  }
  const md = Math.max(maxU-minU, maxV-minV, maxW-minW, 1e-6);
  // Cross-section half-extents — used to normalise the wrap angle so the texture
  // density is even on all faces (a raw angle crushes the texture on the narrow
  // face of a flat beam).
  const half = [Math.max((maxV-minV)/2, 1e-6), Math.max((maxW-minW)/2, 1e-6)];
  // Cross-section box CENTER in V/W (the centroid is not the box center, so lv/lw
  // must be re-centred before classifying which face a point is on).
  const cmid = [(minV + maxV) / 2, (minW + maxW) / 2];
  return { center: [cx, cy, cz], U, V, W, min: { u: minU, v: minV, w: minW }, md, half, cmid };
}

/**
 * Raw (U,V) for a vertex in the beam's local frame. U runs along the beam; V is
 * chosen from the cross axis the face faces, so the grain doesn't smear on the
 * perpendicular sides (mirrors the world-axis Wood logic, in local coords).
 */
export function orientedRawUV(pos, _normal, frame) {
  const { center, U, V, W, min, md } = frame;
  const dx = pos.x - center[0], dy = pos.y - center[1], dz = pos.z - center[2];
  const lu = dx*U[0]+dy*U[1]+dz*U[2];
  const lv = dx*V[0]+dy*V[1]+dz*V[2];
  const lw = dx*W[0]+dy*W[1]+dz*W[2];

  // U = along the beam. V = angle around the cross-section, so the texture WRAPS
  // continuously around the 4 faces. This is NORMAL-INDEPENDENT — a per-face,
  // normal-based cross axis fans out where the smooth/interpolated normal bends
  // near an edge (the visible defect on imported meshes). iso-V lines stay
  // parallel to the beam on every face.
  const rawU = (lu - min.u) / md;
  // V = arc-length around the cross-section's bounding box (a "box unwrap"):
  // even texture density on every face (no corner crush, unlike a raw angle),
  // continuous around the faces (wraps), and NORMAL-INDEPENDENT (no fan at edges).
  // lv/lw are re-centred on the box (frame.cmid) so the face classification holds.
  const a = frame.half[0], b = frame.half[1];
  const lvc = lv - frame.cmid[0], lwc = lw - frame.cmid[1];
  const nv = lvc / a, nw = lwc / b;
  const perim = 4 * (a + b);
  // Seam (s = 0 ≡ perim) at the bottom-face centre, so it hides on the underside.
  let s;
  if (Math.abs(nv) >= Math.abs(nw)) s = (nv >= 0) ? (a + (lwc + b)) : (3 * a + 2 * b + (b - lwc)); // right / left
  else if (nw >= 0)                 s = a + 2 * b + (a - lvc);                                     // top
  else                              s = (lvc >= 0) ? lvc : (3 * a + 4 * b + (lvc + a));            // bottom (split = seam)
  const rawV = s / perim;
  return { rawU, rawV };
}
