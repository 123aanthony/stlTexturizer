// PROJECTION POLAIRE : LES CLAVEAUX RAYONNENT-ILS, ET LES DEUX MOTEURS
// DISENT-ILS LA MEME CHOSE ?
//
// POURQUOI CE MODE EXISTE (rapporte en GUI : « pour les cadres de portes et de
// fenetres j'ai une piece unique avec le seuil, les montants et une arche —
// quand j'ajoute une texture le rendu a l'air un peu stupide »)
// ---------------------------------------------------------------------------
// Une projection est GLOBALE : un seul repere UV pour trois membres qui ne
// courent pas dans le meme sens. Et decouper en slots ne sauve pas l'arche,
// parce qu'aucun des dix autres modes ne suit une COURBE. Le cylindrique en
// approche — mais son axe est code sur +Z, et surtout la face qu'on REGARDE a
// sa normale le long de cet axe : c'est un « cap », et il lui applique une
// projection PLANAIRE. Grille droite sur la face avant.
//
// LES DEUX PROMESSES A TENIR
// --------------------------
//   A. u = ANGLE partout, donc des joints qui rayonnent — et le MEME angle sur
//      la face frontale et sur l'intrados, faute de quoi les joints ne se
//      rejoindraient pas sur l'arete, ce qui est tout l'interet.
//   B. CPU et GLSL decrivent la meme transformation. L'apercu ombre par PIXEL
//      dans un shader, l'export deplace par SOMMET sur CPU : si les deux
//      divergent, l'apercu montre une arche et le fichier en imprime une
//      autre — et rien ne le signale, chacun ayant l'air correct pris seul.
//      C'est le defaut le plus grave possible ici, et le projet l'a deja vecu
//      (voir previewParity.mjs).
//
// CE QUE CE FICHIER NE PROUVE PAS
// -------------------------------
// Il n'execute pas de GLSL — pas de GPU en headless. Il transcrit la formule du
// shader et la confronte NUMERIQUEMENT a `computeUV`, puis verifie sur le
// SOURCE que la branche existe vraiment et n'a pas ete deplacee. Ni l'un ni
// l'autre ne remplace un regard sur l'ecran.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeUV, getScaleReferenceLengths, polarFrame, polarPlaneAxes, MODE_POLAR }
  from '../js/mapping.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

// Une arche : bati de 20 de large, 10 d'epaisseur de mur, axe Y (perpendiculaire
// a la facade), centre a la naissance (z = 0), rayon 8.
const B = {
  min: { x: -10, y: -5, z: -2 }, max: { x: 10, y: 5, z: 12 },
  center: { x: 0, y: 0, z: 5 },  size: { x: 20, y: 10, z: 14 },
};
const base = {
  offsetU: 0, offsetV: 0, rotation: 0, textureAspectU: 1, textureAspectV: 1,
  polarAxis: 'y', polarCenter1: 0, polarCenter2: 0, polarRadius: 8,
  capAngle: 20, seamBandWidth: 0.5,
};
// Echelle NEUTRE : scaleU = scaleV = la longueur de reference, donc rel = 1 et
// applyTransform se reduit a fract(). C'est ce qui rend les deux moteurs
// comparables terme a terme sans re-implementer la transformation.
const REF = getScaleReferenceLengths(MODE_POLAR, base, B);
const S = { ...base, scaleU: REF.refU, scaleV: REF.refV };

const uv = (pos, nrm, over = {}) => computeUV(pos, nrm, MODE_POLAR, { ...S, ...over }, B);
const first = (r) => (r.triplanar ? r.samples[0] : r);
/** Somme ponderee d'une fonction test sur les echantillons rendus. */
const mix = (r, f) => (r.triplanar
  ? r.samples.reduce((a, s) => a + s.w * f(s.u, s.v), 0)
  : f(r.u, r.v));

const NY = { x: 0, y: 1, z: 0 };                       // face frontale
const radial = (x, z) => { const d = Math.hypot(x, z) || 1; return { x: x / d, y: 0, z: z / d }; };

console.log('\n1. Les joints rayonnent');

check('u ne depend QUE de l\'angle, pas du rayon', () => {
  // Deux points sur le meme rayon, a des distances differentes du centre :
  // meme u. C'est la definition d'un joint radial.
  const a = first(uv({ x: 4, y: 5, z: 4 }, NY)).u;
  const b = first(uv({ x: 7, y: 5, z: 7 }, NY)).u;
  assert.ok(Math.abs(a - b) < 1e-12, `u varie avec le rayon : ${a} vs ${b}`);
});

check('v suit le RAYON sur la face frontale', () => {
  // Les rangs concentriques de l'arche. Sans ca, pas de lits de pose.
  const a = first(uv({ x: 4, y: 5, z: 0 }, NY)).v;
  const b = first(uv({ x: 6, y: 5, z: 0 }, NY)).v;
  assert.ok(b > a, 'v ne croit pas avec le rayon');
  // Rayons 4 et 6 sur une circonference 2*pi*8 : ecart attendu 2/C.
  const C = 2 * Math.PI * 8;
  assert.ok(Math.abs((b - a) - 2 / C) < 1e-12, `ecart ${b - a}, attendu ${2 / C}`);
});

check('face frontale et intrados portent le MEME angle', () => {
  // LE point du mode : les joints doivent se rejoindre sur l'arete. Une
  // divergence ici et l'arche se lit comme deux textures collees.
  for (const [x, z] of [[0, 8], [5.6569, 5.6569], [8, 0], [-8, 0], [-5, 6.245]]) {
    const uFace = first(uv({ x, y: 5, z }, NY)).u;
    const uIntr = first(uv({ x, y: 0, z }, radial(x, z))).u;
    assert.ok(Math.abs(uFace - uIntr) < 1e-12,
      `x=${x} z=${z} : face ${uFace} vs intrados ${uIntr}`);
  }
});

check('la face frontale recoit un poids de face PLEIN', () => {
  // Regression pincee : avec la bande de fondu du cylindrique (centree sur le
  // seuil), une face parfaitement alignee sur l'axe ne recevait que 0.62 — le
  // reste venant de la projection ETIREE que ce mode existe pour eviter.
  const r = uv({ x: 5, y: 5, z: 5 }, NY);
  assert.ok(!r.triplanar, 'la face frontale devrait etre un echantillon UNIQUE');
  const rIntr = uv({ x: 8, y: 0, z: 0 }, radial(8, 0));
  assert.ok(!rIntr.triplanar, 'l\'intrados devrait etre un echantillon UNIQUE');
});

check('entre les deux, le melange est progressif', () => {
  const r = uv({ x: 5, y: 3, z: 5 }, { x: 0, y: 0.7071, z: 0.7071 });
  assert.ok(r.triplanar, 'une face a 45 deg devrait melanger flanc et face');
  const w = r.samples.reduce((a, s) => a + s.w, 0);
  assert.ok(Math.abs(w - 1) < 1e-12, `les poids ne somment pas a 1 : ${w}`);
});

console.log('\n2. L\'axe est un vrai parametre');

check('les trois axes tournent dans le sens DROITIER', () => {
  // x->(y,z), y->(z,x), z->(x,y). Un ordre different renverrait un angle qui
  // tourne a l'envers : les claveaux d'une arche se liraient en miroir selon la
  // facade regardee, ce qui ne se voit qu'a l'impression.
  assert.deepEqual(polarPlaneAxes('x'), ['y', 'z', 'x']);
  assert.deepEqual(polarPlaneAxes('y'), ['z', 'x', 'y']);
  assert.deepEqual(polarPlaneAxes('z'), ['x', 'y', 'z']);
});

check('changer d\'axe change vraiment la projection', () => {
  const p = { x: 3, y: 4, z: 5 }, n = { x: 0, y: 0, z: 1 };
  const uz = first(uv(p, n, { polarAxis: 'z' })).u;
  const uy = first(uv(p, n, { polarAxis: 'y' })).u;
  const ux = first(uv(p, n, { polarAxis: 'x' })).u;
  assert.ok(new Set([uz.toFixed(9), uy.toFixed(9), ux.toFixed(9)]).size === 3,
    `un axe sur trois est inerte : ${uz}, ${uy}, ${ux}`);
});

check('centre et rayon a null se deduisent de la boite englobante', () => {
  const pf = polarFrame({ polarAxis: 'y' }, B);
  assert.deepEqual([pf.a1, pf.a2, pf.ax], ['z', 'x', 'y']);
  assert.equal(pf.c1, B.center.z);
  assert.equal(pf.c2, B.center.x);
  assert.equal(pf.R, Math.max(B.size.z, B.size.x) * 0.5);
});

console.log('\n3. Parite CPU <-> GLSL');

const SHADER = readFileSync(join(root, 'js', 'previewMaterial.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*/g, ' ');

check('la branche polaire est reellement cablee dans le shader', () => {
  // Source DEBARRASSEE de ses commentaires : ce fichier-ci nomme les memes
  // symboles dans les siens (lecon de previewParity.mjs).
  assert.match(SHADER, /mappingMode == 11/, 'aucune branche mode 11 dans le shader');
  assert.match(SHADER, /uniform\s+int\s+polarAxis\s*;/, 'uniform polarAxis absent');
  assert.match(SHADER, /uniform\s+vec2\s+polarCenter\s*;/, 'uniform polarCenter absent');
  assert.match(SHADER, /uniform\s+float\s+polarRadius\s*;/, 'uniform polarRadius absent');
  assert.match(SHADER, /pos\.yzx[\s\S]{0,120}pos\.zxy/,
    'les permutations d\'axe du shader ne suivent pas l\'ordre droitier');
  assert.match(SHADER, /u\.polarCenter\.value\.set/, 'les uniformes ne sont jamais mis a jour');
  assert.match(SHADER, /polarFrame\(settings/,
    'le shader resout son repere ailleurs que dans la source unique de mapping.js');
});

/** Transcription de la branche GLSL. Doit rendre ce que rend computeUV. */
function glsl(pos, nrm, st) {
  const IDX = { x: 0, y: 1, z: 2 };
  const P = [pos.x, pos.y, pos.z], N = [nrm.x, nrm.y, nrm.z];
  const MN = [B.min.x, B.min.y, B.min.z];
  // pos.yzx / pos.zxy / pos.xyz selon polarAxis, comme le shader.
  const perm = st.polarAxis === 'x' ? [1, 2, 0] : st.polarAxis === 'y' ? [2, 0, 1] : [0, 1, 2];
  const pAx = perm.map(i => P[i]), nAx = perm.map(i => N[i]), mnAx = perm.map(i => MN[i]);

  const pf = polarFrame(st, B);
  const p1 = pAx[0] - pf.c1, p2 = pAx[1] - pf.c2;
  const Cp = 2 * Math.PI * pf.R;
  const uPol = Math.atan2(p2, p1) / (2 * Math.PI) + 0.5;
  const vSide = (pAx[2] - mnAx[2]) / Cp;
  const vCap = Math.hypot(p1, p2) / Cp;

  const smoothstep = (e0, e1, x) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const capThr = Math.cos((st.capAngle ?? 20) * Math.PI / 180);
  const band = Math.max(st.seamBandWidth ?? 0.5, 1e-3);
  const capLo = Math.max(0, capThr - band);
  const capW = smoothstep(capLo, Math.max(capThr, capLo + 1e-6), Math.abs(nAx[2]));

  const fract = (x) => x - Math.floor(x);
  // ⚠️ La longueur de reference se relit POUR CES REGLAGES-LA. Une premiere
  // version figeait le REF calcule au chargement du fichier (rayon 8, axe y)
  // alors que les cas de parite laissent centre et rayon a null : la
  // reference depend alors de l'AXE, et l'oracle annoncait 1.98 d'ecart sur du
  // code sain. Le shader, lui, recoit `scaleUV` deja resolu par la meme
  // `scaleMmToRelative` — il ne pouvait pas se tromper la.
  const refHere = getScaleReferenceLengths(MODE_POLAR, st, B);
  const rel = { u: st.scaleU / refHere.refU, v: st.scaleV / refHere.refV };
  const smp = (u, v, f) => f(fract(u / rel.u), fract(v / rel.v));

  return (f) => {
    const seamBand = (st.seamBandWidth ?? 0.5) * 0.1;
    const seamDist = Math.min(uPol, 1 - uPol);
    let hSide, hCap;
    if (seamBand > 0.001 && seamDist < seamBand) {
      const d = uPol < 0.5 ? uPol : uPol - 1.0;
      const t = smoothstep(0, 1, (d + seamBand) / (2 * seamBand));
      const L2 = (v) => smp(1.0 + d, v, f), R2 = (v) => smp(d, v, f);
      hSide = L2(vSide) * (1 - t) + R2(vSide) * t;
      hCap = L2(vCap) * (1 - t) + R2(vCap) * t;
    } else {
      hSide = smp(uPol, vSide, f);
      hCap = smp(uPol, vCap, f);
    }
    return hSide * (1 - capW) + hCap * capW;
  };
}

check('les deux moteurs rendent la MEME hauteur, partout', () => {
  // Fonction test sensible aux DEUX coordonnees : une divergence sur u seul ou
  // sur v seul doit se voir.
  const f = (u, v) => Math.sin(12.9898 * u + 78.233 * v);
  let n = 0, worst = 0, pire = null;
  let rng = 123456789;
  const rnd = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (const axis of ['x', 'y', 'z']) {
    for (let k = 0; k < 400; k++) {
      const pos = { x: -10 + 20 * rnd(), y: -5 + 10 * rnd(), z: -2 + 14 * rnd() };
      let nx = rnd() * 2 - 1, ny = rnd() * 2 - 1, nz = rnd() * 2 - 1;
      const d = Math.hypot(nx, ny, nz) || 1;
      const nrm = { x: nx / d, y: ny / d, z: nz / d };
      const st = { ...S, polarAxis: axis, polarCenter1: null, polarCenter2: null, polarRadius: null };
      const cpu = mix(computeUV(pos, nrm, MODE_POLAR, st, B), f);
      const gpu = glsl(pos, nrm, st)(f);
      const e = Math.abs(cpu - gpu);
      if (e > worst) { worst = e; pire = { axis, pos, nrm }; }
      n++;
    }
  }
  console.log(`       ${n} points, ecart max ${worst.toExponential(2)}`);
  assert.ok(n === 1200, `seulement ${n} points compares`);
  assert.ok(worst < 1e-12,
    `CPU et shader divergent de ${worst} (${JSON.stringify(pire)})`);
});

console.log('\n4. Le cablage');

const MAIN = readFileSync(join(root, 'js', 'main.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*/g, ' ');
const HTML = readFileSync(join(root, 'index.html'), 'utf8');

check('le mode est proposé dans la liste', () => {
  assert.match(HTML, /<option value="11"/, 'mode 11 absent du selecteur');
});

check('les quatre reglages sont PERSISTES', () => {
  // Un reglage absent de PERSISTED_KEYS est ecrit nulle part : le projet se
  // rouvre avec un centre deduit de la bbox, et l'arche se retexture de travers
  // sans un mot. Le projet a deja paye ce trou sur neuf cles.
  for (const k of ['polarAxis', 'polarCenter1', 'polarCenter2', 'polarRadius']) {
    assert.ok(new RegExp(`'${k}'`).test(MAIN), `${k} absente de PERSISTED_KEYS`);
    assert.ok(new RegExp(`snap\\.${k}|'${k}' in snap`).test(MAIN),
      `${k} n'est jamais relue a la restauration`);
  }
});

check('changer d\'axe efface un centre devenu absurde', () => {
  // On vise le GESTIONNAIRE, pas la declaration de l'element : `indexOf` seul
  // tombait sur le `document.getElementById` et lisait 700 caracteres qui ne
  // contenaient pas le code teste — l'oracle etait rouge sur du code sain.
  const a = MAIN.indexOf("polarAxisSelect?.addEventListener");
  assert.ok(a >= 0, 'gestionnaire de changement d\'axe introuvable');
  const body = MAIN.slice(a, a + 700);
  assert.match(body, /settings\.polarCenter1 = null/,
    'un centre saisi pour l\'ancien plan resterait, en designant autre chose');
});

check('l\'ajustement automatique connait l\'axe ET la selection', () => {
  const a = MAIN.indexOf('function autoFitPolarCentre');
  assert.ok(a >= 0, 'autoFitPolarCentre absente');
  const body = MAIN.slice(a, MAIN.indexOf('\n}', MAIN.indexOf('return true;', a)));
  assert.match(body, /polarPlaneAxes/, 'l\'ajustement ne lit pas l\'axe choisi');
  assert.match(body, /getAssignedFacesForCurrentSlot/,
    'ajuster sur le modele ENTIER tire le cercle : la bbox d\'un cadre complet ' +
    'a son centre a mi-hauteur, pas a la naissance de l\'arche');
  assert.match(body, /return false/, 'un ajustement rate doit garder le centre precedent');
});

check('un changement de modele efface le centre mesure', () => {
  // Un centre ajuste sur le modele PRECEDENT — ou avant une rotation bakee —
  // designe un point qui n'existe plus. Le cylindre remet deja les siens a null
  // aux deux endroits ; le polaire doit suivre, sinon la premiere arche du
  // modele suivant se texture de travers sans un mot.
  const resets = [...MAIN.matchAll(/settings\.polarCenter1 = null/g)].length;
  assert.ok(resets >= 3,
    `le repere polaire est remis a zero ${resets} fois sur 3 attendues ` +
    '(rotation bakee, nouveau modele, changement d\'axe)');

  // ⚠️ ON VISE LA CAUSE, PAS UNE CORRELATION. Premiere version de ce controle :
  // « tout endroit qui remet `cylinderRadius` a null doit remettre le polaire
  // aussi ». Il est parti ROUGE sur du code sain, en accusant le bouton
  // « Reinitialiser » DU CYLINDRE — une action de l'utilisateur sur le seul
  // cylindre, qui ne doit surtout pas toucher au repere de l'arche (le polaire
  // a son propre bouton). La cause commune est le CHANGEMENT DE MODELE, pas la
  // remise a zero du cylindre : on ancre donc sur les deux sites de modele.
  // Les sites se reperent dans le source BRUT (commentaires compris) : `MAIN`
  // en est debarrasse, et « Geometry rotated » y avait disparu — un ancrage sur
  // un commentaire dans une source strippee ne trouve jamais rien. On classe
  // donc les remises a zero du cylindre par ce qui les DECLENCHE : celles du
  // bouton « Reinitialiser » sont une action utilisateur sur le seul cylindre,
  // toutes les autres sont des changements de modele.
  const RAW = readFileSync(join(root, 'js', 'main.js'), 'utf8');
  let sitesModele = 0;
  for (const m of RAW.matchAll(/settings\.cylinderCenterX = null;/g)) {
    const avant = RAW.slice(Math.max(0, m.index - 400), m.index);
    const estBouton = avant.includes('cylinderResetBtn.addEventListener');
    const apres = RAW.slice(m.index, m.index + 900);
    if (estBouton) {
      // Deux modes independants : le bouton d'un mode n'efface pas l'autre.
      assert.ok(!/settings\.polarCenter1 = null/.test(apres),
        'le bouton Reinitialiser du cylindre efface aussi le repere polaire');
    } else {
      sitesModele++;
      assert.match(apres, /settings\.polarCenter1 = null/,
        'un changement de modele laisse le repere polaire perime : un centre ' +
        'mesure sur le modele precedent survit et retexture l\'arche de travers');
    }
  }
  assert.equal(sitesModele, 2,
    sitesModele + ' site(s) de changement de modele au lieu de 2 : la carte des ' +
    'points de remise a zero a bouge, ce controle est a relire');
});

console.log(`\n${pass} ok, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
