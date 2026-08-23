// Chaque module de js/ doit PARSER COMME MODULE ES.
//
// POURQUOI CE FICHIER EXISTE
// --------------------------
// Un import en double (`import { x } ...` alors que `x` est deja importe plus
// haut) est une erreur de syntaxe AU NIVEAU MODULE : le fichier entier cesse
// d'etre evalue, donc main.js ne construit plus rien — ni la grille de
// textures, ni les ecouteurs, rien. L'app s'ouvre sur une fenetre vide en
// apparence normale.
//
// Deux garde-fous ont laisse passer exactement ca :
//
//   1. `node --check js/main.js` rend 0. Le fichier n'a pas d'extension .mjs et
//      le package n'est pas `"type": "module"`, donc node ne le parse PAS comme
//      un module ES. C'est une fausse assurance, pas un oubli de ma part de le
//      lancer.
//   2. Le smoke E2E « l'app demarre sans erreur » passait aussi : il attache
//      ses ecouteurs APRES le delai de launchApp, donc une erreur d'evaluation
//      de module — qui survient a la milliseconde zero — lui est invisible.
//
// Ici on force le parseur ES en copiant chaque fichier en .mjs. C'est instantane
// et sans DOM : aucune raison de ne pas le faire tourner a chaque fois.

import { readdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const jsDir = join(here, '..', 'js');
const tmp = mkdtempSync(join(tmpdir(), 'bf-syntax-'));

let checked = 0;
const bad = [];
try {
  for (const f of readdirSync(jsDir)) {
    if (!f.endsWith('.js')) continue;
    const copy = join(tmp, f.replace(/\.js$/, '.mjs'));
    writeFileSync(copy, readFileSync(join(jsDir, f)));
    try {
      execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' });
    } catch (e) {
      const msg = String(e.stderr || e.message).split('\n')
        .find(l => /Error|error/.test(l)) || String(e.message);
      bad.push(`${f} : ${msg.trim().slice(0, 160)}`);
    }
    checked++;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// Un compteur nul passerait tous les tests sans rien verifier — le mensonge
// d'oracle classique. On exige donc d'avoir reellement examine des fichiers.
assert.ok(checked >= 20, `seulement ${checked} modules examines : le scan n'a pas trouve js/`);
assert.deepEqual(bad, [], `modules qui ne parsent pas comme module ES :\n  ${bad.join('\n  ')}`);

console.error(`moduleSyntax: ${checked} modules parsent comme module ES`);
