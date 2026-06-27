// Node-safe binary STL read/write.
//
// The production exporter (js/exporter.js) writes STL via a browser Blob
// download, so it can't run headless. This is the equivalent for the test
// harness: it only touches typed arrays + node:fs, no DOM.

import * as THREE from 'three';
import { readFileSync, writeFileSync } from 'node:fs';

/** Read a binary STL into a non-indexed BufferGeometry (position + normals). */
export function readBinarySTL(path) {
  const buf = readFileSync(path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const triCount = dv.getUint32(80, true);
  const positions = new Float32Array(triCount * 9);
  let o = 84;
  for (let i = 0; i < triCount; i++) {
    o += 12; // skip the stored face normal — recomputed below
    for (let v = 0; v < 9; v++) { positions[i * 9 + v] = dv.getFloat32(o, true); o += 4; }
    o += 2;  // attribute byte count
  }
  return geometryFromPositions(positions);
}

/** Wrap a flat non-indexed position array as a BufferGeometry with smooth normals. */
export function geometryFromPositions(positions) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

/** Write a non-indexed BufferGeometry to a binary STL file. */
export function writeBinarySTL(geo, path) {
  const pos = geo.attributes.position.array;
  const triCount = (pos.length / 9) | 0;
  const buf = Buffer.alloc(84 + 50 * triCount);
  buf.writeUInt32LE(triCount, 80);
  for (let i = 0; i < triCount; i++) {
    const b = i * 9;
    const ux = pos[b + 3] - pos[b], uy = pos[b + 4] - pos[b + 1], uz = pos[b + 5] - pos[b + 2];
    const vx = pos[b + 6] - pos[b], vy = pos[b + 7] - pos[b + 1], vz = pos[b + 8] - pos[b + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1; nx /= len; ny /= len; nz /= len;
    const o = 84 + i * 50;
    buf.writeFloatLE(nx, o); buf.writeFloatLE(ny, o + 4); buf.writeFloatLE(nz, o + 8);
    for (let v = 0; v < 9; v++) buf.writeFloatLE(pos[b + v], o + 12 + v * 4);
  }
  writeFileSync(path, buf);
}
