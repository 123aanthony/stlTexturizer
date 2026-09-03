// CLIQUET SUR main.js — le monolithe ne peut que MAIGRIR.
//
// LE PROBLEME QU'IL RESOUT
// ------------------------
// `main.js` est declare « cible du refacto » depuis des mois, et le refacto
// travaille : slotMasks, slotState, exportPipeline, scaleSnap, recovery,
// projectMigrate, materialLibrary, printAudit… ont ete extraits. Mais MESURE :
// le fichier faisait ~8 500 lignes au fork, ~9 700 quand la doc a ete ecrite,
// et **10 533 aujourd'hui**. Le refacto ne perd pas : il est DEPASSE PAR LE
// FLUX. Chaque lot ajoute son cablage, et le solde reste positif.
//
// Une campagne d'extraction de plus ne changerait rien a ca — elle ferait
// baisser le chiffre une fois, puis il remonterait. Ce qu'il faut, c'est une
// REGLE QUI TIENT ENTRE LES LOTS. D'ou ce cliquet : il n'interdit rien, il
// oblige seulement a poser la logique nouvelle dans un module — ce qui est deja
// la methode du projet quand on y pense, et jamais quand on est presse.
//
// ⚠️ CE N'EST PAS UN PLAFOND, C'EST UN CLIQUET. Un plafond se contente d'etre
// respecte et pourrit : on s'installe dessous et le fichier stagne. Le cliquet
// echoue AUSSI quand le compte descend nettement sous la limite, pour forcer a
// la RESSERRER — sinon la marge gagnee se reperd en silence au lot suivant.
//
// ⚠️ ET IL COMPTE DEUX CHOSES, PAS UNE. Les lignes disent la taille ; les
// LIAISONS MUTABLES au niveau module disent l'ETAT PARTAGE, qui est la vraie
// cause des defauts multi-slot que ce projet traine (des lecteurs qui prennent
// chacun leur source — cf. `resolveSlotState`). Un lot peut tres bien retirer
// cent lignes et ajouter trois globales : ce serait une perte, et seul le
// second compteur le verrait.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, '..', 'js', 'main.js');

// ── Le cliquet ───────────────────────────────────────────────────────────────
//
// Ces deux nombres ne DESCENDENT jamais tout seuls : les baisser est un geste
// deliberé, qu'on fait apres avoir extrait quelque chose. Les MONTER demande
// une justification dans le message de commit — et il n'y en a qu'une de
// valable : « ce cablage ne peut pas vivre ailleurs ».
const LIMITE_LIGNES   = 10492;   // 03/09/2026, apres le 2e ecrivain STL et la passe d hygiene
const LIMITE_MUTABLES = 113;     // `let` / `var` au niveau module

// Marge toleree avant de demander un resserrage. Assez large pour qu'un
// nettoyage ordinaire ne fasse pas echouer la barriere, assez etroite pour que
// la marge ne devienne pas un matelas.
const MARGE = 150;

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

const src = readFileSync(MAIN, 'utf8');
const lignes = src.split(/\r?\n/);
// ⚠️ Un fichier qui finit par un saut de ligne rend un dernier element VIDE :
// le compte serait de 1 de trop et ne collerait pas a `wc -l`. Un cliquet dont
// le chiffre ne se retrouve pas a la main n'inspire pas confiance.
if (lignes.length && lignes[lignes.length - 1] === '') lignes.pop();
const nbLignes = lignes.length;

// Liaisons mutables au niveau module : `let`/`var` en colonne 0. Les `const`
// sont exclus — une reference figee vers un element du DOM n'est pas de l'etat
// partage ; ce qui fait diverger les lecteurs, c'est ce qui CHANGE.
const nbMutables = lignes.filter(l => /^(let|var)\s/.test(l)).length;

/**
 * Longueur REELLE des fonctions de premier niveau, par equilibre des accolades.
 * ⚠️ Compter « jusqu'a la prochaine fonction » (le reflexe) est FAUX : le code
 * de module qui suit une fonction lui est alors attribue — mesure sur ce
 * fichier, `blurCanvas` sortait a 218 lignes pour 24 reelles, parce que les
 * declarations d'etat qui la suivent etaient comptees avec elle. Un chiffre
 * faux ferait extraire la mauvaise fonction.
 */
function fonctionsDePremierNiveau(lignes) {
  const out = [];
  for (let i = 0; i < lignes.length; i++) {
    const m = /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(lignes[i]);
    if (!m) continue;
    let profondeur = 0, j = i, ouvert = false;
    for (; j < lignes.length; j++) {
      // Approximation assumee : on ignore accolades en chaine et en commentaire.
      // Sur ce fichier l'ecart reste marginal, et la mesure ne sert qu'a
      // CLASSER des candidats a l'extraction, pas a decider d'un echec.
      for (const c of lignes[j]) {
        if (c === '{') { profondeur++; ouvert = true; }
        else if (c === '}') profondeur--;
      }
      if (ouvert && profondeur <= 0) break;
    }
    out.push({ nom: m[1], ligne: i + 1, taille: j - i + 1 });
    i = j;
  }
  return out.sort((a, b) => b.taille - a.taille);
}

console.log('\nmain.js — cliquet');
console.log(`  lignes            ${nbLignes} / ${LIMITE_LIGNES}`);
console.log(`  liaisons mutables ${nbMutables} / ${LIMITE_MUTABLES}`);

check('main.js n a pas grossi', () => {
  if (nbLignes <= LIMITE_LIGNES) return;
  const gros = fonctionsDePremierNiveau(lignes).slice(0, 5)
    .map(f => `      ${String(f.taille).padStart(4)} lignes  ${f.nom}  (js/main.js:${f.ligne})`)
    .join('\n');
  assert.fail(
    `main.js passe de ${LIMITE_LIGNES} a ${nbLignes} lignes (+${nbLignes - LIMITE_LIGNES}).\n` +
    `       La logique nouvelle va dans un MODULE, pas ici — main.js garde le cablage.\n` +
    `       Si ce cablage ne peut vraiment pas vivre ailleurs : relever LIMITE_LIGNES\n` +
    `       dans ce fichier, et dire pourquoi dans le message de commit.\n` +
    `       Les plus grosses fonctions du fichier, si l une d elles est la vraie cible :\n${gros}`);
});

check('l etat partage de main.js n a pas grossi', () => {
  assert.ok(nbMutables <= LIMITE_MUTABLES,
    `liaisons mutables au niveau module : ${nbMutables} pour ${LIMITE_MUTABLES} tolerees.\n` +
    `       C'est l'etat GLOBAL qui augmente — la cause des divergences entre lecteurs\n` +
    `       que ce projet a deja payees (cf. resolveSlotState). Une valeur qui change\n` +
    `       et que plusieurs fonctions lisent appartient a un module qui la possede.`);
});

check('le cliquet est bien SERRE (pas de marge dormante)', () => {
  // Une barriere qu'on a distancee cesse de mordre : la marge gagnee se
  // reperdrait en silence au lot suivant.
  const ecart = LIMITE_LIGNES - nbLignes;
  assert.ok(ecart <= MARGE,
    `main.js fait ${nbLignes} lignes pour une limite de ${LIMITE_LIGNES} : ${ecart} de marge.\n` +
    `       Bravo — et RESSERRE le cliquet : LIMITE_LIGNES = ${nbLignes} dans ce fichier.`);
  const ecartM = LIMITE_MUTABLES - nbMutables;
  assert.ok(ecartM <= 8,
    `liaisons mutables : ${nbMutables} pour ${LIMITE_MUTABLES} tolerees.\n` +
    `       Resserre : LIMITE_MUTABLES = ${nbMutables}.`);
});

check('le compteur mesure bien le fichier attendu', () => {
  // Une barriere qui compterait un fichier vide serait verte pour toujours.
  assert.ok(nbLignes > 5000, `main.js ne fait que ${nbLignes} lignes : mauvais fichier ?`);
  assert.ok(nbMutables > 50, `${nbMutables} liaisons mutables : le motif ne matche plus rien`);
  assert.ok(src.includes("from './slotState.js'"),
    'main.js ne ressemble plus a lui-meme (import de slotState absent)');
});

console.log(`\nVERDICT: ${fail ? 'FAIL' : 'PASS'}  (${pass} ok, ${fail} failed)`);
process.exit(fail ? 1 : 0);
