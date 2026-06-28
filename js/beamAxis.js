// Beam-oriented wood projection: find a piece's own long axis (PCA) and project
// the grain along it, so timber gets correct lengthwise grain at ANY orientation
// — not only when aligned to a world axis (the Wood Auto limitation).
//
// Pure + headless-testable. computeBeamFrame is run once over the mesh; the
// resulting frame is passed to computeUV via settings.beamFrame, and
// orientedRawUV produces the per-vertex raw (U,V) the way the world-axis Wood
// modes do — but in the beam's local frame.

/** Dominant eigenvector of the vertex covariance = the beam's long axis. */
export function computeBeamFrame(positions) {
  const n = (positions.length / 3) | 0;
  if (n === 0) return null;

  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < positions.length; i += 3) { cx += positions[i]; cy += positions[i+1]; cz += positions[i+2]; }
  cx /= n; cy /= n; cz /= n;

  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const dx = positions[i] - cx, dy = positions[i+1] - cy, dz = positions[i+2] - cz;
    xx += dx*dx; xy += dx*dy; xz += dx*dz; yy += dy*dy; yz += dy*dz; zz += dz*dz;
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
  const Wx = vy*Vz - vz*Vy, Wy = vz*Vx - vx*Vz, Wz = vx*Vy - vy*Vx;
  const V = [Vx, Vy, Vz], W = [Wx, Wy, Wz];

  // Local-frame extents (for normalising like the world modes' (pos-min)/md).
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity, minW = Infinity, maxW = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const dx = positions[i] - cx, dy = positions[i+1] - cy, dz = positions[i+2] - cz;
    const u = dx*U[0]+dy*U[1]+dz*U[2], v = dx*V[0]+dy*V[1]+dz*V[2], w = dx*W[0]+dy*W[1]+dz*W[2];
    if (u<minU)minU=u; if(u>maxU)maxU=u; if(v<minV)minV=v; if(v>maxV)maxV=v; if(w<minW)minW=w; if(w>maxW)maxW=w;
  }
  const md = Math.max(maxU-minU, maxV-minV, maxW-minW, 1e-6);
  return { center: [cx, cy, cz], U, V, W, min: { u: minU, v: minV, w: minW }, md };
}

/**
 * Raw (U,V) for a vertex in the beam's local frame. U runs along the beam; V is
 * chosen from the cross axis the face faces, so the grain doesn't smear on the
 * perpendicular sides (mirrors the world-axis Wood logic, in local coords).
 */
export function orientedRawUV(pos, normal, frame) {
  const { center, U, V, W, min, md } = frame;
  const dx = pos.x - center[0], dy = pos.y - center[1], dz = pos.z - center[2];
  const lu = dx*U[0]+dy*U[1]+dz*U[2];
  const lv = dx*V[0]+dy*V[1]+dz*V[2];
  const lw = dx*W[0]+dy*W[1]+dz*W[2];
  const nu = Math.abs(normal.x*U[0]+normal.y*U[1]+normal.z*U[2]);
  const nv = Math.abs(normal.x*V[0]+normal.y*V[1]+normal.z*V[2]);
  const nw = Math.abs(normal.x*W[0]+normal.y*W[1]+normal.z*W[2]);

  const rawU = (lu - min.u) / md;
  let rawV;
  if (nu >= nv && nu >= nw) rawV = (lv - min.v) / md;        // end cap
  else if (nw >= nv)        rawV = (lv - min.v) / md;        // top/bottom (normal ∥ W)
  else                      rawV = (lw - min.w) / md;        // side (normal ∥ V)
  return { rawU, rawV };
}
