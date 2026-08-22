// Golden-master harness for the BumpForge geometry pipeline.
//
//   node test/golden.mjs            compare current pipeline output to goldens
//   node test/golden.mjs --update   (re)write the goldens from current output
//
// Each case runs the REAL subdivision + displacement modules and fingerprints
// the result. A behavior-preserving refactor must keep every fingerprint
// identical; any change is reported as a per-property diff. This is the safety
// net that makes the main.js refactor reversible and verifiable.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readBinarySTL } from './lib/stl.mjs';
import { proceduralTexture } from './lib/texture.mjs';
import { fingerprintGeometry, diffFingerprints } from './lib/fingerprint.mjs';
import { runSingle, runMultiSlot, baseSettings } from './lib/pipeline.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const goldenDir = join(here, 'golden');
const UPDATE = process.argv.includes('--update');
mkdirSync(goldenDir, { recursive: true });

const checker = proceduralTexture(128, 128, 'checker');
const sine    = proceduralTexture(128, 128, 'sine');

const fixture = (n) => readBinarySTL(join(here, 'fixtures', `${n}.stl`));
const real    = (n) => readBinarySTL(join(root, n));

const s = (over) => ({ ...baseSettings, ...over });

// name -> () => Promise<BufferGeometry>
const cases = {
  'cube-triplanar':    () => runSingle(fixture('cube'),     { refineLength: 3, settings: s({ amplitude: 1.5 }), texture: checker }),
  'cube-cubic':        () => runSingle(fixture('cube'),     { refineLength: 3, settings: s({ mappingMode: 6, amplitude: 1.5 }), texture: checker }),
  'cube-woodz':        () => runSingle(fixture('cube'),     { refineLength: 3, settings: s({ mappingMode: 10, amplitude: 1.5 }), texture: sine }),
  'sphere-triplanar':  () => runSingle(fixture('sphere'),   { refineLength: 3, settings: s({ amplitude: 1.0 }), texture: checker }),
  'cylinder-cubic':    () => runSingle(fixture('cylinder'), { refineLength: 3, settings: s({ mappingMode: 6, amplitude: 1.0 }), texture: checker }),
  'plate-noDownZ':     () => runSingle(fixture('plate'),    { refineLength: 2, settings: s({ amplitude: 0.5, noDownwardZ: true }), texture: sine }),
  'real-fillets':      () => runSingle(real('cubeWithSmallFillets.stl'), { refineLength: 4, settings: s({ amplitude: 1.0 }), texture: checker }),
  'real-laserplate':   () => runSingle(real('laserPlate.stl'),           { refineLength: 4, settings: s({ amplitude: 1.0 }), texture: checker }),
  // Real production orchestration (exportPipeline.runMultiSlotExport). Top faces
  // -> slot0, bottom -> slot1, the four walls left UNOWNED so the union-exclusion
  // /shared-subdivision path is genuinely exercised (unowned faces aren't refined
  // or displaced, and the result must stay watertight).
  'cube-multislot':    () => runMultiSlot(fixture('cube'), {
    refineLength: 4,
    slots: [
      { texture: checker, settings: s({ amplitude: 1.5 }) },
      { texture: sine,    settings: s({ amplitude: 1.0 }) },
    ],
    assignOriginal: (_t, _c, n) => (n.z > 0.5 ? 0 : n.z < -0.5 ? 1 : -1),
  }),

  // Multi-slot WITH guarded decimation (step 2): all faces owned (real material
  // seam), dense refine, then decimate toward maxTriangles. Pins that decimation
  // runs, the watertight guard holds across the seam, and triangles are reduced.
  'cube-multislot-decim': () => runMultiSlot(fixture('cube'), {
    refineLength: 1.2,
    maxTriangles: 12000,
    slots: [
      { texture: checker, settings: s({ amplitude: 1.5 }) },
      { texture: sine,    settings: s({ amplitude: 1.0 }) },
    ],
    assignOriginal: (_t, _c, n) => (n.z >= 0 ? 0 : 1),  // all owned
  }),

  // ── Prefiltre d'antialiasing (js/mipPyramid.js) ────────────────────────────
  // Les cas ci-dessus figent le sampler HISTORIQUE : `baseSettings` y coupe
  // explicitement `textureAntialias`, si bien que leurs empreintes prouvent que
  // le chemin legacy n'a pas bouge d'un bit. Les trois cas qui suivent sont les
  // MEMES montages avec le prefiltre allume : ils figent le nouveau chemin, et
  // le damier 128 px sur une arete de 3-4 mm est franchement sous-echantillonne,
  // donc ils exercent reellement des niveaux de mip eleves.
  'aa-cube-triplanar': () => runSingle(fixture('cube'), {
    refineLength: 3, texture: checker,
    settings: s({ amplitude: 1.5, textureAntialias: true }),
  }),
  'aa-sphere-triplanar': () => runSingle(fixture('sphere'), {
    refineLength: 3, texture: checker,
    settings: s({ amplitude: 1.0, textureAntialias: true }),
  }),
  'aa-cube-multislot': () => runMultiSlot(fixture('cube'), {
    refineLength: 4,
    slots: [
      { texture: checker, settings: s({ amplitude: 1.5, textureAntialias: true }) },
      { texture: sine,    settings: s({ amplitude: 1.0, textureAntialias: true }) },
    ],
    assignOriginal: (_t, _c, n) => (n.z > 0.5 ? 0 : n.z < -0.5 ? 1 : -1),
  }),
};

let pass = 0, fail = 0, wrote = 0;
const t0 = Date.now();

for (const [name, run] of Object.entries(cases)) {
  let geo;
  try {
    geo = await run();
  } catch (e) {
    console.error(`✗ ${name.padEnd(20)} ERROR  ${e.message}`);
    fail++;
    continue;
  }
  const fp = fingerprintGeometry(geo);
  const gp = join(goldenDir, `${name}.json`);

  if (UPDATE || !existsSync(gp)) {
    writeFileSync(gp, JSON.stringify(fp, null, 2) + '\n');
    console.log(`● ${name.padEnd(20)} baseline  ${fp.triangles} tris, watertight=${fp.watertight}`);
    wrote++;
  } else {
    const golden = JSON.parse(readFileSync(gp, 'utf8'));
    const diffs = diffFingerprints(golden, fp);
    if (diffs.length === 0) {
      console.log(`✓ ${name.padEnd(20)} ${fp.triangles} tris, watertight=${fp.watertight}`);
      pass++;
    } else {
      console.error(`✗ ${name.padEnd(20)} REGRESSION`);
      for (const d of diffs) console.error(`    ${d}`);
      fail++;
    }
  }
}

const dt = ((Date.now() - t0) / 1000).toFixed(1);
console.log('');
if (fail) {
  console.log(`VERDICT: FAIL  (${fail} failed, ${pass} ok)  ${dt}s`);
  process.exit(1);
} else if (wrote) {
  console.log(`VERDICT: BASELINE WRITTEN  (${wrote} goldens)  ${dt}s`);
} else {
  console.log(`VERDICT: PASS  (${pass} ok)  ${dt}s`);
}
