// L'APERCU FIGE SE RAFRAICHIT-IL A CHAQUE EDITION ?
//
// LE DEFAUT (rapporte en GUI : « en mode preview, toutes les modifications ne
// declenchent pas le recalcul de la visu »)
// ---------------------------------------------------------------------------
// L'apercu « tous les slots » est une PHOTO : il ne se rebatit que quand on le
// lui demande, via `updatePreview()`. Or six controles ne l'appelaient pas —
// resolution (`refineLength`), budget de triangles (`maxTriangles`), decimation,
// antialias de texture, aplanissement du dessous, regularisation — et leurs
// commentaires justifiaient ce silence : « la case ne change rien a l'ecran,
// seulement a l'export », « No preview rebuild needed — final-export step only ».
//
// C'etait vrai de l'apercu SHADER, qui ombre par PIXEL et se moque de la finesse
// du maillage. C'est FAUX de l'apercu fige, qui EST l'export. Meme famille de
// defaut que l'empilement des slots (voir allSlotsPreview.mjs) : deux vues qui
// pretendent montrer la meme chose et ne lisent pas les memes entrees.
//
// CE QUE CE FICHIER PROUVE
// ------------------------
// Le correctif ne cable pas six appels de plus — il compare une SIGNATURE des
// reglages, donc il couvre aussi les reglages a naitre. Un oracle qui se
// contenterait de chercher `updatePreview()` dans les six gestionnaires
// raterait cette forme-la. On verifie donc les trois maillons de la chaine :
//   §1 la signature existe, est prise au bake, et remise a zero en sortant ;
//   §2 la delegation est posee sur le panneau, gardee par l'etat d'apercu ;
//   §3 elle ATTEINT vraiment les controles fautifs — ils sont dans le panneau —
//      et aucune cle LUE PAR LE PIPELINE n'est exclue de la signature (critere
//      DERIVE : on interroge les sources de subdivision/displacement/export,
//      pas une liste recopiee ici, qui se perimerait) ;
//   §4 on ne peut pas peindre sur la photo — les index de triangle bakes ne
//      sont pas ceux de la selection.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// Source DEBARRASSEE DE SES COMMENTAIRES (idiome de previewParity.mjs) : ce
// fichier-ci nomme les memes symboles dans ses propres commentaires, et main.js
// aussi — un oracle qui ne distingue pas le code du commentaire ne prouve rien.
const MAIN = readFileSync(join(root, 'js', 'main.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/.*/g, ' ');
const HTML = readFileSync(join(root, 'index.html'), 'utf8');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

/** Corps d'une fonction nommee, du `function X` jusqu'a l'ancre de fin donnee. */
function bodyOf(startNeedle, endNeedle) {
  const a = MAIN.indexOf(startNeedle);
  const b = MAIN.indexOf(endNeedle, a);
  return a >= 0 && b > a ? MAIN.slice(a, b) : '';
}

console.log('\n1. La signature des reglages du bake');

check('_bakeSignature est definie', () => {
  assert.match(MAIN, /function\s+_bakeSignature\s*\(/, '_bakeSignature absente');
  assert.match(MAIN, /let\s+_lastBakeSig/, '_lastBakeSig absente');
});

check('elle est prise AU MOMENT du bake', () => {
  const body = bodyOf('async function rebuildAllSlotsPreview', 'function exitAllSlotsPreview');
  assert.ok(body.length > 0, 'rebuildAllSlotsPreview introuvable');
  assert.match(body, /_lastBakeSig\s*=\s*_bakeSignature\(\)/,
    'la vue est construite sans enregistrer les reglages qui la produisent : ' +
    'la comparaison suivante porterait sur une reference perimee');
});

check('elle est remise a zero en sortant de l\'apercu', () => {
  const body = bodyOf('function exitAllSlotsPreview', 'async function toggleAllSlotsPreview');
  assert.ok(body.length > 0, 'exitAllSlotsPreview introuvable');
  assert.match(body, /_lastBakeSig\s*=\s*null/,
    'une signature survivante ferait sauter la premiere reconstruction du prochain apercu');
});

console.log('\n2. La delegation sur le panneau de reglages');

check('input ET change sont delegues', () => {
  // Les deux : un curseur emet `input`, une case a cocher et une liste `change`.
  // N'en cabler qu'un laisserait la moitie des controles muets.
  assert.match(MAIN, /_settingsPanel\.addEventListener\('input',\s*_bakeOnEdit\)/,
    "la delegation 'input' est absente (curseurs et champs muets)");
  assert.match(MAIN, /_settingsPanel\.addEventListener\('change',\s*_bakeOnEdit\)/,
    "la delegation 'change' est absente (cases a cocher et listes muettes)");
});

check('elle ne travaille que pendant l\'apercu, et seulement si le bake change', () => {
  const a = MAIN.indexOf('_bakeOnEdit = ');
  const body = MAIN.slice(a, MAIN.indexOf('};', a));
  assert.match(body, /if\s*\(!allSlotsPreviewActive\)\s*return/,
    'sans ce garde, chaque edition planifierait un bake hors apercu');
  assert.match(body, /_bakeSignature\(\)\s*===\s*_lastBakeSig/,
    'sans comparaison, tout clic dans le panneau relancerait un bake complet');
  assert.match(body, /_scheduleAllSlotsRebuild\(\)/,
    'la reconstruction n\'est pas planifiee');
});

console.log('\n3. La delegation atteint bien les controles fautifs');

// Les six reglages que le rapport visait, avec l'id de leur controle. Etre DANS
// `#settings-panel` est ce qui les rend couverts : l'evenement doit y remonter.
const MUETS = [
  ['refine-length',          'resolution / longueur d\'arete'],
  ['max-triangles',          'budget de triangles'],
  ['decimate-enabled',       'decimation'],
  ['texture-antialias',      'antialias de texture'],
  ['smooth-bottom-chk',      'aplanissement du dessous'],
  ['regularize-enabled-chk', 'regularisation'],
];

const panelStart = HTML.indexOf('<aside id="settings-panel"');
const panelEnd   = HTML.indexOf('</aside>', panelStart);

check('#settings-panel est bien delimite dans index.html', () => {
  assert.ok(panelStart >= 0 && panelEnd > panelStart, 'panneau de reglages introuvable');
});

for (const [id, label] of MUETS) {
  check(`« ${label} » (#${id}) est dans le panneau, donc couvert`, () => {
    const at = HTML.indexOf(`id="${id}"`);
    assert.ok(at >= 0, `controle #${id} absent de index.html`);
    assert.ok(at > panelStart && at < panelEnd,
      `#${id} vit hors de #settings-panel : son evenement ne remonte pas au delegue`);
  });
}

check('aucune cle LUE PAR LE BAKE n\'est exclue de la signature', () => {
  // CRITERE DERIVE, PAS UNE LISTE. Premiere version de cet oracle : « une cle
  // exclue ne doit pas etre dans GLOBAL_EXPORT_QUALITY_KEYS ». Il est parti
  // ROUGE sur du code sain — `displayCreaseAngle` EST dans cette liste, mais
  // pour une tout autre raison (le split global / par-slot ; slotState.js le
  // dit : « propriete de la VUE, pas de la carte »). La question n'est pas
  // « ou la cle est-elle declaree » mais « le pipeline la LIT-il ? ». On
  // interroge donc les trois modules qui construisent la geometrie.
  const m = /_BAKE_SIG_SKIP\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(MAIN);
  assert.ok(m, '_BAKE_SIG_SKIP introuvable');
  const skipped = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  const PIPELINE = ['subdivision.js', 'displacement.js', 'exportPipeline.js']
    .map(f => readFileSync(join(root, 'js', f), 'utf8')).join('\n');
  const lues = skipped.filter(k => PIPELINE.includes(k));
  assert.deepEqual(lues, [],
    `ces reglages sont lus par le pipeline et pourtant exclus : ${lues.join(', ')}`);
  // Et toute exclusion doit etre JUSTIFIEE par un chemin de rafraichissement
  // dedie — sinon le reglage redevient muet, juste plus discretement.
  assert.deepEqual(skipped, ['displayCreaseAngle'],
    `exclusion non prevue : ${skipped.join(', ')}`);
  assert.match(MAIN, /settings\.displayCreaseAngle\s*=[\s\S]{0,200}?refreshDisplayNormals\(\)/,
    'displayCreaseAngle est exclu de la signature sans que rien ne le rafraichisse');
});

console.log('\n4. On ne peint pas sur une photo');

check('armer un outil de masquage sort de l\'apercu fige', () => {
  const body = bodyOf('function setExclusionTool', 'function ');
  const src = body || MAIN.slice(MAIN.indexOf('function setExclusionTool'),
                                 MAIN.indexOf('function setExclusionTool') + 2500);
  assert.match(src, /exclusionTool\s*&&\s*allSlotsPreviewActive\)\s*exitAllSlotsPreview\(\)/,
    'le maillage affiche est le maillage BAKE : ses index de triangle ne sont ' +
    'pas ceux de currentGeometry, donc peindre dessus selectionne des faces au hasard');
});

console.log(`\n${pass} ok, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
