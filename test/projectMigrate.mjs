// Tests for js/projectMigrate.js — the pure project-payload forward migration.

import assert from 'node:assert/strict';
import { migrateProjectPayload } from '../js/projectMigrate.js';

let passed = 0;
function test(name, fn) {
  try { fn(); console.error(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

test('current version passes through, fields preserved', () => {
  const out = migrateProjectPayload({ version: 1, scaleU: 2, textureSlots: [{ id: 's1' }] }, 1);
  assert.equal(out.version, 1);
  assert.equal(out.scaleU, 2);
  assert.deepEqual(out.textureSlots, [{ id: 's1' }]);
});

test('unversioned legacy is stamped to the current version', () => {
  const out = migrateProjectPayload({ scaleU: 1 }, 1);
  assert.equal(out.version, 1);
  assert.equal(out.scaleU, 1);
});

test('a newer file loads best-effort and is flagged, not clobbered', () => {
  const out = migrateProjectPayload({ version: 99, foo: 'bar' }, 1);
  assert.equal(out.version, 99);          // its own version kept
  assert.equal(out.__futureVersion, 99);  // gap recorded for a caller warning
  assert.equal(out.foo, 'bar');
});

test('does not mutate the input', () => {
  const input = { scaleU: 1 };
  const out = migrateProjectPayload(input, 1);
  assert.equal(input.version, undefined); // untouched
  assert.notEqual(out, input);
});

test('null / non-object returned as-is (no throw)', () => {
  assert.equal(migrateProjectPayload(null), null);
  assert.equal(migrateProjectPayload(undefined), undefined);
  assert.equal(migrateProjectPayload('x'), 'x');
});

console.error(`\nprojectMigrate: ${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
