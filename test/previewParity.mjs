// Parité APERÇU ↔ EXPORT pour la variation par pièce.
//
// LE DEFAUT CRAINT
// ----------------
// L'apercu deplace dans un shader GLSL, l'export sur CPU. Ce sont deux
// implementations de la MEME transformation UV. Si elles divergent, l'apercu
// montre un bois et le fichier imprime en montre un autre — et rien ne le
// signale : les deux ont l'air corrects pris separement. C'est le pire defaut
// possible ici, et il s'est deja produit dans ce projet (le chemin rapide
// cubique de displacement.js court-circuite computeUV).
//
// CE QUE CE FICHIER PROUVE, ET CE QU'IL NE PROUVE PAS
// ---------------------------------------------------
// Il ne peut pas EXECUTER du GLSL : pas de GPU en headless. Il fait donc deux
// choses complementaires :
//   1. il lit le SOURCE du shader et verifie que l'injection y est reellement
//      cablee, au bon endroit et dans le bon ordre (une suppression ou un
//      deplacement casse le test) ;
//   2. il verifie NUMERIQUEMENT que la formule du shader, transcrite ici,
//      redonne exactement ce que rend `computeUV` — la version CPU.
// Ni l'un ni l'autre ne remplace un regard sur l'ecran, mais ensemble ils
// attrapent la divergence silencieuse.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeUV } from '../js/mapping.js';
import { buildPieceXforms, pieceTransform, pieceKey } from '../js/pieceVariation.js';

const here = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(join(here, '..', 'js', 'previewMaterial.js'), 'utf8');

/**
 * Source DEBARRASSEE DE SES COMMENTAIRES.
 *
 * ⚠️ Indispensable, et paye : une premiere version de ce fichier cherchait
 * simplement la chaine `vPieceXform.w` dans le source. Mise a l'epreuve en
 * commentant la ligne du miroir dans le shader — un defaut parfaitement
 * plausible — le test restait VERT, puisque la chaine survit dans le
 * commentaire. Un oracle qui ne distingue pas le code du commentaire ne prouve
 * rien.
 */
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*/g, ' ');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

console.log('\n1. Le shader porte reellement l\'injection');

check('l\'attribut et le varying sont declares', () => {
  assert.match(SRC, /attribute\s+vec4\s+pieceXform\s*;/, 'attribut pieceXform absent du vertex shader');
  assert.match(SRC, /varying\s+vec4\s+vPieceXform\s*;/, 'varying vPieceXform absent');
  assert.match(SRC, /uniform\s+int\s+pieceVarOn\s*;/, 'garde pieceVarOn absent');
});

check('sampleMap applique decalage, rotation ET miroir', () => {
  const i = SRC.indexOf('float sampleMap(');
  assert.ok(i > 0, 'sampleMap introuvable');
  const body = SRC.slice(i, i + 900);
  assert.ok(body.includes('vPieceXform.xy'), 'le decalage n\'est pas applique');
  assert.ok(body.includes('vPieceXform.z'), 'la rotation n\'est pas appliquee');
  assert.ok(body.includes('vPieceXform.w'), 'le miroir n\'est pas applique');
  assert.ok(/scaleUV\s*\*\s*vec2\(\s*mir/.test(body),
    'le miroir doit passer par le SIGNE de l\'echelle, comme cote CPU');
});

check('le varying est affecte AVANT le premier appel a sampleMap', () => {
  // computeHeightAtPoint appelle sampleMap depuis le VERTEX shader. Si
  // l'affectation venait apres, le deplacement des sommets lirait la valeur du
  // sommet precedent — un decalage d'une pièce, invisible mais faux.
  const vs = SRC.slice(SRC.indexOf('const vertexShader'));
  const iAssign = vs.indexOf('vPieceXform =');
  const iUse = vs.indexOf('computeHeightAtPoint(');
  assert.ok(iAssign > 0, 'vPieceXform jamais affecte dans le vertex shader');
  assert.ok(iUse > 0, 'computeHeightAtPoint introuvable');
  assert.ok(iAssign < iUse,
    `affectation en ${iAssign} mais utilisation en ${iUse} : ordre inverse`);
});

check('le garde neutralise vraiment (pas de division par zero)', () => {
  // Un attribut absent vaut 0 cote THREE. Sans garde, vPieceXform.w = 0 et
  // l'echelle serait divisee par zero. Le repli doit forcer w = 1.
  assert.ok(/vPieceXform\s*=\s*\(\s*pieceVarOn\s*==\s*1\s*\)\s*\?\s*pieceXform\s*:\s*vec4\(0\.0,\s*0\.0,\s*0\.0,\s*1\.0\)/.test(SRC),
    'le repli doit valoir vec4(0,0,0,1), pas vec4(0)');
});

console.log('\n2. Parite NUMERIQUE avec la version CPU');

/**
 * Transcription de `sampleMap` (GLSL) en JS.
 *
 * C'est volontairement une copie LITTERALE de la formule du shader, y compris
 * l'ordre des operations : le but est justement de comparer deux ecritures
 * independantes de la meme transformation.
 */
function glslSampleMap(rawU, rawV, u) {
  let offU = u.offsetU, offV = u.offsetV;
  let rot = u.rotation * Math.PI / 180;
  let mir = 1;
  if (u.px) { offU += u.px.du; offV += u.px.dv; rot += u.px.rotDeg * Math.PI / 180; mir = u.px.mirrorU ? -1 : 1; }
  let uu = (rawU * u.aspectU) / (u.scaleU * mir) + offU;
  let vv = (rawV * u.aspectV) / u.scaleV + offV;
  const c = Math.cos(rot), s = Math.sin(rot);
  uu -= 0.5; vv -= 0.5;
  const ru = c * uu - s * vv, rv = s * uu + c * vv;
  uu = ru + 0.5; vv = rv + 0.5;
  const fract = (x) => x - Math.floor(x);
  return { u: fract(uu), v: fract(vv) };
}

check('shader et CPU rendent la MEME UV, sur 5 transformations x 9 points', () => {
  const bounds = {
    min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 20 },
    size: { x: 20, y: 20, z: 20 }, center: { x: 10, y: 10, z: 10 },
  };
  const base = { scaleU: 7, scaleV: 7, offsetU: 0.1, offsetV: -0.2, rotation: 13,
                 textureAspectU: 1, textureAspectV: 1 };
  const xforms = [
    null,
    { du: 0.31, dv: 0.07, rotDeg: 0,    mirrorU: false },
    { du: 0,    dv: 0,    rotDeg: 6.5,  mirrorU: false },
    { du: 0,    dv: 0,    rotDeg: 0,    mirrorU: true  },
    { du: 0.62, dv: 0.44, rotDeg: -4.2, mirrorU: true  },
  ];
  let n = 0;
  for (const px of xforms) {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const pos = { x: 3 + i * 6, y: 2 + j * 7, z: 5 };
      const nrm = { x: 0, y: 0, z: 1 };
      // MODE_PLANAR_XY = 0 : rawU = (x-min)/md, rawV = (y-min)/md
      const cpu = computeUV(pos, nrm, 0, { ...base, pieceXform: px }, bounds);
      const md = 20;
      const gpu = glslSampleMap((pos.x - 0) / md, (pos.y - 0) / md, {
        ...base, aspectU: 1, aspectV: 1,
        // computeUV divise l'echelle mm par la longueur de reference : on
        // reproduit la meme conversion pour comparer des grandeurs comparables.
        scaleU: base.scaleU / md, scaleV: base.scaleV / md, px,
      });
      assert.ok(Math.abs(cpu.u - gpu.u) < 1e-9 && Math.abs(cpu.v - gpu.v) < 1e-9,
        `divergence a (${pos.x},${pos.y}) px=${JSON.stringify(px)} : ` +
        `CPU (${cpu.u.toFixed(9)}, ${cpu.v.toFixed(9)}) vs GLSL (${gpu.u.toFixed(9)}, ${gpu.v.toFixed(9)})`);
      n++;
    }
  }
  assert.equal(n, 45, 'le balayage doit vraiment couvrir 45 points');
});

console.log('\n3. La table est bien PARTAGEE');

check('buildPieceXforms est deterministe et pondere par l\'AIRE', () => {
  // Deux triangles pour une piece, l'un beaucoup plus grand : le centroide doit
  // pencher vers le grand. Sinon un simple changement de resolution de maillage
  // deplacerait la cle, donc le veinage.
  const pos = new Float32Array([
    0,0,0,  1,0,0,  0,1,0,          // petit, autour de (0.33, 0.33)
    0,0,0,  20,0,0, 0,20,0,         // grand, autour de (6.67, 6.67)
  ]);
  const { table, count } = buildPieceXforms(pos, new Int32Array([7, 7]), { pieceOffset: 1, pieceSeed: 3 });
  assert.equal(count, 1, 'les deux triangles portent le meme identifiant');
  // La cle attendue si la ponderation par l'aire est correcte.
  const aSmall = 1, aBig = 400;                    // 2x l'aire, mais le rapport suffit
  const cx = (0.3333333 * aSmall + 6.6666667 * aBig) / (aSmall + aBig);
  const attendu = pieceTransform(pieceKey(cx, cx, 0, 3), { pieceOffset: 1, pieceSeed: 3 });
  assert.ok(Math.abs(table[0].du - attendu.du) < 1e-12,
    'le centroide n\'est pas pondere par l\'aire');
});

check('appelee deux fois, elle rend exactement la meme table', () => {
  const pos = new Float32Array([0,0,0, 5,0,0, 0,5,0,  10,0,0, 15,0,0, 10,5,0]);
  const ids = new Int32Array([1, 2]);
  const a = buildPieceXforms(pos, ids, { pieceOffset: 1, pieceRotate: 3, pieceSeed: 42 });
  const b = buildPieceXforms(pos, ids, { pieceOffset: 1, pieceRotate: 3, pieceSeed: 42 });
  assert.deepEqual(a.table, b.table);
  assert.deepEqual(Array.from(a.index), Array.from(b.index));
});

console.log(`\nVERDICT: ${fail ? 'FAIL' : 'PASS'}  (${pass} ok, ${fail} failed)`);
process.exit(fail ? 1 : 0);
