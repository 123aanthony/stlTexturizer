// Integration test: the app export path doesn't pass a beamFrame — Wood Auto
// (mode 7) must auto-compute the PCA frame inside applyDisplacement so the
// exported displacement is beam-oriented (differs from world-axis Wood X).

import * as THREE from 'three';
import assert from 'node:assert/strict';
import { runSingle, baseSettings } from './lib/pipeline.mjs';

function vbands() {
  const w = 64, h = 64, d = new Uint8ClampedArray(w*h*4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const g = (Math.floor((y/h)*8) % 2) ? 235 : 25;
    const i = (y*w+x)*4; d[i]=d[i+1]=d[i+2]=g; d[i+3]=255;
  }
  return { data: d, width: w, height: h };
}
const beam = () => new THREE.BoxGeometry(90, 14, 14, 1, 1, 1).toNonIndexed().rotateZ(45 * Math.PI / 180);
const tex = vbands();
const s = (m) => ({ ...baseSettings, mappingMode: m, amplitude: 1.5, symmetricDisplacement: true, scaleU: 1, scaleV: 1 });

const cases = [
  ['Wood Auto (no frame supplied) auto-orients → differs from world-X Wood', async () => {
    const d8 = await runSingle(beam(), { refineLength: 1.5, settings: s(8), texture: tex });
    const d7 = await runSingle(beam(), { refineLength: 1.5, settings: s(7), texture: tex });
    const a = d8.attributes.position.array, b = d7.attributes.position.array;
    let diff = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i]-b[i]) > 1e-4) diff++;
    assert.ok(diff > 1000, `expected many differing coords (oriented≠world), got ${diff}`);
  }],
];

let passed = 0;
for (const [name, fn] of cases) {
  try { await fn(); console.error(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}
console.error(`\nwoodAutoExport: ${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
