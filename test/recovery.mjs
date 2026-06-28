// Tests for js/recovery.js — the pure crash-recovery decision logic.

import assert from 'node:assert/strict';
import { shouldOfferRecovery, recoveryAgeSeconds, recoveryAgeParts } from '../js/recovery.js';

let passed = 0;
function test(name, fn) {
  try { fn(); console.error(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

test('offer: a draft with bytes + timestamp is offerable', () => {
  assert.equal(shouldOfferRecovery({ bytes: new Uint8Array([1, 2]), savedAt: 1000 }), true);
});

test('offer: missing/empty/garbage drafts are not offerable', () => {
  assert.equal(shouldOfferRecovery(null), false);
  assert.equal(shouldOfferRecovery({}), false);
  assert.equal(shouldOfferRecovery({ bytes: new Uint8Array([]), savedAt: 1 }), false);
  assert.equal(shouldOfferRecovery({ bytes: new Uint8Array([1]) }), false);             // no timestamp
  assert.equal(shouldOfferRecovery({ bytes: new Uint8Array([1]), savedAt: NaN }), false);
});

test('age: whole seconds, clamped at zero', () => {
  const now = 100_000;
  assert.equal(recoveryAgeSeconds(now - 5_000, now), 5);
  assert.equal(recoveryAgeSeconds(now + 5_000, now), 0); // future → 0, never negative
});

test('age buckets: sec / min / hour / day', () => {
  const now = 10 * 24 * 3600 * 1000;
  assert.deepEqual(recoveryAgeParts(now - 30_000, now), { unit: 'sec', value: 30 });
  assert.deepEqual(recoveryAgeParts(now - 5 * 60_000, now), { unit: 'min', value: 5 });
  assert.deepEqual(recoveryAgeParts(now - 3 * 3600_000, now), { unit: 'hour', value: 3 });
  assert.deepEqual(recoveryAgeParts(now - 2 * 24 * 3600_000, now), { unit: 'day', value: 2 });
});

console.error(`\nrecovery: ${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
