// Regenerates test/fixtures/freecad/ by driving FreeCADCmd on the FW Diorama
// interop script, then re-runs the integration test. Run after any change to
// fw_export_bumpforge.py (FreeCAD side) or to the sidecar contract.
//
//   npm run test:interop:update
//
// Requires FreeCAD 1.1 and the FW Diorama repo at their usual locations.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FREECAD = 'C:/Program Files/FreeCAD 1.1/bin/FreeCADCmd.exe';
const FW_SCRIPT = 'C:/Users/geton/OneDrive/Bureau/CAD/DOOR/CLAUDE/FW_Diorama_tools/fc_bumpforge_interop.py';

for (const [what, p] of [['FreeCADCmd', FREECAD], ['FW interop script', FW_SCRIPT]]) {
  if (!existsSync(p)) {
    console.error(`${what} not found: ${p}`);
    process.exit(1);
  }
}

console.log('Generating fixtures via FreeCADCmd…');
const gen = spawnSync(FREECAD, [FW_SCRIPT], {
  encoding: 'utf8',
  env: { ...process.env, BF_FIXTURES_DIR: join(ROOT, 'test', 'fixtures', 'freecad') },
  timeout: 180_000,
});
const out = `${gen.stdout || ''}${gen.stderr || ''}`;
for (const line of out.split(/\r?\n/)) if (/FIXTURE|VERDICT|Exception/.test(line)) console.log(' ', line);
if (gen.status !== 0 || !/VERDICT: PASS/.test(out)) {
  console.error('Fixture generation FAILED');
  process.exit(1);
}

console.log('Re-running the integration test…');
const t = spawnSync(process.execPath, [join(ROOT, 'test', 'freecadInterop.mjs')], { stdio: 'inherit' });
process.exit(t.status ?? 1);
