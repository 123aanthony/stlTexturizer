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

## Couverture du chemin `main.js` — état

- **Export multi-slot : COUVERT** (étape B). L'orchestration est extraite dans
  `exportPipeline.runMultiSlotExport` (sans DOM) ; le cas golden `cube-multislot`
  appelle la vraie fonction de prod, pas un wrapper de test.
- **Boot de l'app : COUVERT** (étape C) par un smoke test Playwright-Electron
  (`test/e2e/`, `npm run test:e2e`) — vert sur machine GPU (exige WebGL réel ;
  cf. test/e2e/README pour CI headless).
- **Données save/load projet : COUVERT** (étape 1d) — `serializeSlotFaces`/
  `restoreSlotFaces` purs, round-trip headless (y compris ré-indexation).
- **Reste non couvert headless** : `restoreSlotState` (écritures DOM) et le
  transport IPC natif lui-même. Le round-trip *UI/IPC* attend un E2E (window-API).

## Décisions actées

- **« Premier slot gagne »** sur chevauchement de faces (`buildExclusiveSlotFaceMasks`)
  — décision *produit* (l'ordre des slots tranche), aujourd'hui figée par un test.
- **`three` épinglé 0.170.0** (= CDN prod). **Pas de `type:module`** (Electron CommonJS).

## Journal des extractions

| Étape | Quoi | État |
|---|---|---|
| 0 | Golden-master géométrique (`test/golden.mjs`, 9 cas) | ✅ |
| 1a | `slotMasks.js` (masques multi-slot, purs) + 7 unités | ✅ |
| 1b | `slotState.js` — noyau de données pur (signatures round-trip, computeAssignedFaces, normalize) + 8 unités | ✅ |
| 1c | Contrat réglages per-slot/global extrait (`GLOBAL_EXPORT_QUALITY_KEYS` + pick/strip/with, purs) + 4 unités | ✅ |
| B  | Orchestration export multi-slot extraite (`exportPipeline.runMultiSlotExport`, sans DOM) ; golden branché sur le chemin réel ; blocs `if(false)` morts retirés | ✅ |
| C  | E2E Playwright-Electron (smoke boot) — **vert sur machine GPU** (2,4 s) ; confirme que l'app boote après 1a+1b+1c+B | ✅ |
| 1d | serialize/restore des faces de projet extrait (`serializeSlotFaces`/`restoreSlotFaces`, purs) + 2 round-trips | ✅ |
| 2 | Décimation multi-slot réactivée avec **garde watertight** (`decimateWithGuard`) + checkbox `decimateEnabled` ; corrige aussi le bug non-manifold mono-slot. Variante golden `cube-multislot-decim` | ✅ |
| 3 | Source unique de vérité pour l'état slot (le vrai fix ch.8) | ⏳ |

Cumul : `main.js` ≈ −485 lignes nettes (1a→1d) ; 31 vérifs headless (21 unités + 10 golden) + smoke E2E.

Reste backlog : regularize multi-slot (toujours OFF, à décider) ; retrait des `console.log` debug ; supprimer le doublon `js/index.html` ; README amont à actualiser.

**Validation app** (utilisateur, après 1a/1b) : peinture 2 slots → save/reload projet
(sélections restaurées) → Export All Slots. Le chemin réel de `main.js` — non couvert
par le golden — est confirmé sain.

## Backlog process (quand le rythme sera pris)

- **Hook pre-commit** lançant `npm test` sur `refactor/*`.
- Retirer les `console.log` de debug (dont ceux de `slotMasks.js`) au lot hygiène.
- Mettre à jour le `README.md` (encore celui de l'amont BumpMesh : ignore multi-slot,
  Electron, Wood, tests).
- **Bug latent** : `cubeWithSmallFillets.stl` watertight en entrée → non-watertight
  après le pipeline (cf. `test/README.md`).
