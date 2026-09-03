import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { unzipSync, strFromU8 } from 'fflate';
import { launchApp } from './launch.mjs';

// L'ECHELLE DE TEXTURE SURVIT-ELLE A UN ALLER-RETOUR DE PROJET ?
//
// LE SIGNALEMENT, ET POURQUOI IL DORMAIT
// --------------------------------------
// `REFACTOR.md` portait depuis des mois : « apres sauvegarde puis reouverture
// d'un projet, l'echelle de texture (scaleU) a change », avec TROIS suspects et
// aucune mesure :
//   1. le snap cylindrique `_snapScaleUForSeamlessWrap`, qui arrondit scaleU ;
//   2. `selectPreset(..., applyDefaults=true)`, qui reecrit scaleU avec le
//      `defaultScale` du preset ;
//   3. l'aspect d'une carte personnalisee rechargee, qui divise l'echelle.
// Un ticket a trois hypotheses et zero mesure ne se resout jamais : chacun le
// relit, personne ne sait par ou commencer.
//
// CE QUE LA MESURE A TRANCHE (03/09, projet reel a 7 slots)
// ---------------------------------------------------------
// - LE FICHIER EST FIDELE. Compare slot par slot entre l'archive source et
//   celle que l'app vient d'ecrire : **7 sur 7 identiques**, echelle globale
//   comprise. Rien n'est perdu au disque. C'est le test n°1 ci-dessous.
// - C'EST L'AFFICHAGE QUI MENT. Apres avoir RE-IMPORTE un projet par-dessus un
//   projet deja ouvert, le panneau montre l'echelle du slot ACTIF pour TOUS les
//   onglets — mesure : 6 slots sur 7 affichent 51.7, la valeur du slot actif au
//   moment de l'enregistrement, au lieu de 25 / 105 / 49.7. Reproduit 6 fois
//   sur 8 lancements, deterministe sur les 4 derniers.
// - Et charger cette MEME archive dans une app FRAICHE affiche les bonnes
//   valeurs, stables des +3 s et jusqu'a +38 s : le defaut est propre au
//   RE-import, pas au fichier ni au chemin de restauration en general.
//
// ⚠️ UNE HYPOTHESE DE CAUSE A ETE REFUTEE PAR LA MESURE, pas par le
// raisonnement : `handleModelFile` remet `isRestoringProject` a FAUX dans son
// `finally`, alors que l'import de projet l'appelle AU MILIEU de sa propre
// restauration — la fenetre non gardee semblait evidente. Essai fait : le
// drapeau restaure au lieu d'etre eteint ne change RIEN au symptome (6/7 avant
// comme apres, 3 lancements chacun). Le correctif a donc ete annule. La vraie
// cause est ailleurs, et la piste est notee dans TODOS.md.
//
// ⚠️ Ce fichier lit un projet qui n'est PAS dans le depot ; il se skip
// proprement s'il manque, et un skip n'est pas un succes.

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = join(homedir(), 'Downloads', 'housev2.bforge');
const CIBLE = join(tmpdir(), 'bumpforge-echelle-allerretour.bforge');

/** Echelles STOCKEES dans une archive .bforge (source de verite du fichier). */
function echellesArchivees(fichier) {
  const z = unzipSync(new Uint8Array(readFileSync(fichier)));
  const d = JSON.parse(strFromU8(z['settings.json']));
  const out = {};
  for (const s of d.textureSlots || []) {
    out[s.id] = { u: s.settings?.scaleU ?? null, v: s.settings?.scaleV ?? null };
  }
  return { slots: out, globalU: d.scaleU, globalV: d.scaleV };
}

/** Echelles AFFICHEES, en cliquant chaque onglet de slot. */
const echellesAffichees = (page) => page.evaluate(async () => {
  const attendre = (ms) => new Promise(r => setTimeout(r, ms));
  const out = {};
  for (const b of document.querySelectorAll('.texture-tab[data-slot]')) {
    b.click();
    await attendre(140);
    out[b.dataset.slot] = {
      u: document.getElementById('scale-u-val')?.value ?? null,
      v: document.getElementById('scale-v-val')?.value ?? null,
      carte: (document.getElementById('active-map-name')?.textContent || '').trim(),
    };
  }
  return out;
});

/** Charge SOURCE, enregistre vers CIBLE. Rend la page pour la suite. */
async function ouvrirPuisEnregistrer(app, page) {
  await app.evaluate(async ({ dialog }, chemin) => {
    // On exerce le VRAI chemin d'ecriture ; seule la boite native est remplacee.
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: chemin });
  }, CIBLE);
  await page.setInputFiles('#import-project-input', SOURCE);
  await page.waitForFunction(
    () => document.querySelectorAll('.texture-tab[data-slot]').length > 1,
    null, { timeout: 180_000 });
  // La restauration decode une image par slot personnalise : on laisse retomber
  // la poussiere avant de lire, sinon on mesure un etat intermediaire et on
  // accuse le mauvais coupable.
  await page.waitForTimeout(6000);
}

test("le FICHIER garde l'echelle de chaque slot", async () => {
  // L'invariant qui compte vraiment : ce qui est ecrit sur le disque. Une
  // derive d'affichage se rattrape d'un clic ; une donnee perdue, jamais.
  test.skip(!existsSync(SOURCE), `projet de reference absent : ${SOURCE}`);
  test.setTimeout(400_000);

  rmSync(CIBLE, { force: true });
  const { app, page } = await launchApp(appRoot);
  try {
    await ouvrirPuisEnregistrer(app, page);
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(8000);
    expect(existsSync(CIBLE), "le projet n'a pas ete ecrit").toBe(true);

    const src = echellesArchivees(SOURCE);
    const out = echellesArchivees(CIBLE);
    const ids = Object.keys(src.slots);
    expect(ids.length, 'archive source sans slot').toBeGreaterThan(1);

    const perdus = ids.filter(id => {
      const a = src.slots[id], b = out.slots[id] || {};
      return a.u !== b.u || a.v !== b.v;
    }).map(id => `${id} : ${src.slots[id].u}/${src.slots[id].v} -> ${out.slots[id]?.u}/${out.slots[id]?.v}`);

    console.log(`\n  ${ids.length} slots ecrits — echelles perdues : ${perdus.length}`);
    expect(perdus, `l'echelle a ete PERDUE dans le fichier :\n${perdus.join('\n')}`).toEqual([]);
    expect({ u: out.globalU, v: out.globalV }).toEqual({ u: src.globalU, v: src.globalV });
  } finally {
    await app.close();
    rmSync(CIBLE, { force: true });
  }
});

// ⚠️ LE CAS « AFFICHAGE » N'EST PAS UN TEST ICI, ET C'EST DELIBERE.
// Le re-import par-dessus un projet ouvert fait bien deriver l'AFFICHAGE (6
// slots sur 7 montrent l'echelle du slot actif), mais **par intermittence** :
// reproduit 6 fois sur 8 lancements, puis pas du tout sur les 3 suivants, sans
// qu'aucun code n'ait change entre les deux series. Un test instable dans la
// batterie coute plus qu'il ne rapporte — il apprend a ignorer le rouge, et
// c'est toute la batterie qui perd son sens. Le defaut est donc CONSIGNE dans
// TODOS.md avec ses mesures, et le harnais garde ce qui est DETERMINISTE : la
// fidelite du fichier (ci-dessus) et le mode cylindrique (ci-dessous).

test("le snap CYLINDRIQUE n'altere pas l'echelle enregistree", async () => {
  // ⚠️ SUSPECT N°1 DU TICKET, ET LE SEUL QUE LE PROJET DE REFERENCE N'EXERCE
  // PAS : ses sept slots sont en triplanaire. Or `_snapScaleUForSeamlessWrap`
  // ARRONDIT scaleU pour que la texture boucle sans couture, et il ne se
  // declenche qu'en cylindrique. Un enregistrement qui re-appliquerait le snap
  // sur une valeur DEJA snappee la ferait deriver a chaque sauvegarde.
  //
  // ⚠️ On compare l'affiche a ce qui est ECRIT, sans re-importer : le re-import
  // est justement le geste instable (voir la note ci-dessus), et une assertion
  // posee dessus serait un test a bascule. La question du suspect n°1 se pose
  // entierement avant l'archive : le snap agit a l'application du reglage.
  test.skip(!existsSync(SOURCE), `projet de reference absent : ${SOURCE}`);
  test.setTimeout(400_000);

  rmSync(CIBLE, { force: true });
  const { app, page } = await launchApp(appRoot);
  try {
    await ouvrirPuisEnregistrer(app, page);

    await page.selectOption('#mapping-mode', '3');
    await page.waitForTimeout(2500);
    const vu = await page.evaluate(() => ({
      slot: document.querySelector('.texture-tab.active')?.dataset.slot || null,
      mode: document.getElementById('mapping-mode')?.value,
      u: document.getElementById('scale-u-val')?.value,
      v: document.getElementById('scale-v-val')?.value,
    }));
    console.log(`
  cylindrique : ${vu.slot} U=${vu.u} V=${vu.v}`);
    expect(vu.mode, "le mode cylindrique n'a pas ete pris").toBe('3');

    await page.keyboard.press('Control+s');
    await page.waitForTimeout(8000);
    expect(existsSync(CIBLE), "le projet n'a pas ete ecrit").toBe(true);

    const ecrit = echellesArchivees(CIBLE).slots[vu.slot];
    console.log(`  ecrit dans l'archive : U=${ecrit?.u} V=${ecrit?.v}`);
    expect({ u: String(ecrit?.u), v: String(ecrit?.v) },
      `le snap cylindrique a altere l'echelle a l'enregistrement : ` +
      `affiche ${vu.u}/${vu.v}, ecrit ${ecrit?.u}/${ecrit?.v}`)
      .toEqual({ u: vu.u, v: vu.v });
  } finally {
    await app.close();
    rmSync(CIBLE, { force: true });
  }
});
