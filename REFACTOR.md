# Refacto BumpForge — méthode & journal

## Objectif

Démêler le monolithe `js/main.js` (~8.4k lignes, ~40 globals mutables) pour tuer la
**classe de bugs multi-slot** (slots liés, sélections perdues, restaurations
incorrectes). La cause-racine est un **double état** : des variables globales
miroitent l'état des slots, synchronisées à la main via `saveActiveSlotState()` /
`restoreSlotState()`. Cible finale = **source unique de vérité** (lire/écrire à
travers le slot actif, supprimer les globals miroirs).

## Méthode (golden-first, pas réversibles)

1. **Filet d'abord.** Aucun changement de comportement sans test qui fige l'état
   courant (golden-master + unités). Voir `test/`.
2. **Déplacer, pas réécrire.** Extraire la logique de `main.js` vers des modules
   en copiant **verbatim**, puis ré-importer. La réécriture vient *après*, couverte.
3. **Un comportement = un commit.** Jamais « nettoyer + corriger » ensemble. Si un
   golden casse, le commit fautif est évident.
4. **Le fix risqué en dernier.** La source unique de vérité (changement de
   comportement de l'état) se fait quand tout autour est isolé et couvert.

## Barre de vérification — par niveau de risque

| Type de pas | Vérification minimale |
|---|---|
| **Déplacement pur** (fonction sans état/DOM) | `node --check`, 0 définition orpheline, `npm test` vert |
| **Déplacement avec état** (données + couplage DOM) | + **test de round-trip** (ex. save→switch→restore) écrit AVANT le déplacement |
| **Changement de comportement** voulu | + `test:golden:update` justifié dans le commit + **test manuel app** (`npm start`) |

## Protocole de rebaseline du golden

- Empreinte qui change = **régression par défaut**. On n'« update » que pour un
  changement **voulu**, et le message de commit dit **pourquoi**.
- Une montée de version `three` ou `node` peut déplacer des empreintes
  légitimement → ce n'est PAS une régression de code, mais ça impose un rebaseline
  conscient. (D'où `three` épinglé.)

## Trou connu du filet (à combler)

Le golden teste `subdivision`/`displacement` en direct et `slotMasks` en unités,
mais **rien ne teste le chemin d'appel de `main.js`** (`buildExportGeometryForAllSlots`,
les `if(false)` de décimation/regularize, la mutation/restauration de globals).
→ **Objectif à double bénéfice** : extraire l'orchestration d'export en fonction
**sans DOM** (`runExportPipeline(geometry, slots, settings) → geometry`) ; le golden
pourra alors appeler le vrai chemin de prod.

## Décisions actées

- **« Premier slot gagne »** sur chevauchement de faces (`buildExclusiveSlotFaceMasks`)
  — décision *produit* (l'ordre des slots tranche), aujourd'hui figée par un test.
- **`three` épinglé 0.170.0** (= CDN prod). **Pas de `type:module`** (Electron CommonJS).

## Journal des extractions

| Étape | Quoi | État |
|---|---|---|
| 0 | Golden-master géométrique (`test/golden.mjs`, 9 cas) | ✅ |
| 1a | `slotMasks.js` (masques multi-slot, purs) + 7 unités | ✅ |
| 1b | `slotState.js` — modèle de données des slots (données séparées du DOM) | ⏳ à venir |
| 2 | Trancher les `if(false)` (décimation/regularize en multi-slot) | ⏳ |
| 3 | Source unique de vérité pour l'état slot (le vrai fix ch.8) | ⏳ |

## Backlog process (quand le rythme sera pris)

- **Hook pre-commit** lançant `npm test` sur `refactor/*`.
- Retirer les `console.log` de debug (dont ceux de `slotMasks.js`) au lot hygiène.
- Mettre à jour le `README.md` (encore celui de l'amont BumpMesh : ignore multi-slot,
  Electron, Wood, tests).
- **Bug latent** : `cubeWithSmallFillets.stl` watertight en entrée → non-watertight
  après le pipeline (cf. `test/README.md`).
