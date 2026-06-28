// Generates the reference STL fixtures deterministically from three.js
// primitives. Committed so they can be opened in a slicer, but reproducible:
// `node test/genFixtures.mjs` rewrites identical bytes.
//
// Each model targets a specific code path (see test/README.md):
//   cube      hard dihedral edges  -> sharp-edge split (SHARP_COS)
//   sphere    smooth curvature     -> area-weighted smooth normals
//   cylinder  smooth + hard caps   -> cubic/cylindrical seam, reliability fallback
//   plate     thin walls/knife-edge-> reliability<0.5 fallback, bottom clamp

import * as THREE from 'three';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeBinarySTL } from './lib/stl.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'fixtures');

function nonIndexed(geo) {
  const ni = geo.toNonIndexed();
  geo.dispose();
  return ni;
}

const models = {
  cube:     nonIndexed(new THREE.BoxGeometry(30, 30, 30, 1, 1, 1)),
  sphere:   nonIndexed(new THREE.IcosahedronGeometry(20, 2)),
  cylinder: nonIndexed(new THREE.CylinderGeometry(15, 15, 40, 32, 1)),
  plate:    nonIndexed(new THREE.BoxGeometry(40, 40, 2, 2, 2, 1)),
};

for (const [name, geo] of Object.entries(models)) {
  const path = join(out, `${name}.stl`);
  writeBinarySTL(geo, path);
  const tris = geo.attributes.position.count / 3;
  console.log(`  wrote fixtures/${name}.stl  (${tris} tris)`);
}
console.log('Fixtures generated.');
