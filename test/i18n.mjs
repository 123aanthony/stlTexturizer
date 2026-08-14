// i18n gate: the language packs must stay in step with en.js, and every key the
// app asks for must exist.
//
// Why this exists: the packs had silently drifted — 23 to 27 keys missing in
// de/it/es/pt/ja/ko (recovery banner, unsaved-changes dialog, FreeCAD interop,
// smooth-bottom) and 4 in fr. Nothing ever failed, because t() falls back to
// English: the UI simply spoke English inside six other languages, and the only
// signal was a console.warn nobody reads. A gap that only a measurement can see
// is a gap that comes back — so it is measured here, at every commit.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const I18N = join(HERE, '..', 'js', 'i18n');
const JSDIR = join(HERE, '..', 'js');

let passed = 0;
function test(name, fn) {
  try { fn(); console.error(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const LANGS = readdirSync(I18N).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3)).sort();
const packs = {};
for (const l of LANGS) {
  packs[l] = (await import(pathToFileURL(join(I18N, `${l}.js`)).href)).default;
}
const en = packs.en;
const others = LANGS.filter(l => l !== 'en');

// {placeholder} set of a string, order-independent.
const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');

// ── Packs vs the English reference ───────────────────────────────────────────

test('every language pack carries every en.js key', () => {
  const bad = others
    .map(l => [l, Object.keys(en).filter(k => !(k in packs[l]))])
    .filter(([, missing]) => missing.length);
  assert.deepEqual(bad, [],
    bad.map(([l, m]) => `${l}: ${m.length} missing (${m.slice(0, 5).join(', ')}…)`).join(' | '));
});

test('no language pack carries a key en.js does not have', () => {
  // An extra key is dead weight at best, a renamed-key leftover at worst.
  const bad = others
    .map(l => [l, Object.keys(packs[l]).filter(k => !(k in en))])
    .filter(([, extra]) => extra.length);
  assert.deepEqual(bad, [], bad.map(([l, e]) => `${l}: ${e.join(', ')}`).join(' | '));
});

test('placeholders match the English string, key by key', () => {
  // t() only substitutes what the caller passes: a translated "{nb}" where the
  // English says "{n}" renders the literal token in the UI, silently.
  const bad = [];
  for (const l of others) {
    for (const k of Object.keys(en)) {
      if (k in packs[l] && ph(en[k]) !== ph(packs[l][k])) {
        bad.push(`${l}/${k}: {${ph(en[k])}} vs {${ph(packs[l][k])}}`);
      }
    }
  }
  assert.deepEqual(bad, [], bad.join(' | '));
});

test('no empty or non-string value', () => {
  const bad = [];
  for (const l of LANGS) {
    for (const [k, v] of Object.entries(packs[l])) {
      if (typeof v !== 'string' || v.trim() === '') bad.push(`${l}/${k}`);
    }
  }
  assert.deepEqual(bad, [], bad.join(', '));
});

test('the language picker lists exactly the packs on disk', () => {
  const src = readFileSync(join(JSDIR, 'i18n.js'), 'utf8');
  const block = src.slice(src.indexOf('TRANSLATIONS = {'), src.indexOf('};', src.indexOf('TRANSLATIONS = {')));
  const registered = [...block.matchAll(/^\s*(\w+):\s*\{/gm)].map(m => m[1]).sort();
  assert.deepEqual(registered, LANGS, `registry ${registered} vs files ${LANGS}`);
});

// ── Keys the app actually asks for ───────────────────────────────────────────
// Catches the other direction: a typo in a t('…') call, or a key added to the UI
// and never to the packs. Vendor code is skipped (it does not use t()).

const SOURCES = readdirSync(JSDIR)
  .filter(f => f.endsWith('.js'))
  .map(f => [f, readFileSync(join(JSDIR, f), 'utf8')]);

// `t('key')` but not `.t(`, `xt(`, `format(`…
const STATIC = /(?<![\w$.])t\(\s*(['"])([\w.]+)\1/g;
// `t(`prefix.${unit}`)` — one such call exists (recovery.age.<unit>).
const DYNAMIC = /(?<![\w$.])t\(\s*`([\w.]*)\$\{/g;

test('every static t(\'key\') exists in en.js', () => {
  const missing = [];
  for (const [file, src] of SOURCES) {
    for (const m of src.matchAll(STATIC)) {
      if (!(m[2] in en)) missing.push(`${file}: ${m[2]}`);
    }
  }
  assert.deepEqual(missing, [], missing.join(', '));
});

test('every dynamic t(`prefix.${…}`) has at least one key under that prefix', () => {
  const orphan = [];
  for (const [file, src] of SOURCES) {
    for (const m of src.matchAll(DYNAMIC)) {
      const prefix = m[1];
      if (!prefix) continue;                       // fully dynamic: nothing to check
      if (!Object.keys(en).some(k => k.startsWith(prefix))) orphan.push(`${file}: ${prefix}…`);
    }
  }
  assert.deepEqual(orphan, [], orphan.join(', '));
});

test('the scan actually found keys (a silent zero would pass everything)', () => {
  // Same trap as any counting oracle: an empty set satisfies every assertion.
  const n = SOURCES.reduce((acc, [, src]) => acc + [...src.matchAll(STATIC)].length, 0);
  assert.ok(n > 50, `only ${n} t('…') calls found — the regex probably stopped matching`);
});

console.error(`\ni18n: ${passed} checks passed (${LANGS.length} packs × ${Object.keys(en).length} keys)` +
              `${process.exitCode ? ' (with failures)' : ''}`);
