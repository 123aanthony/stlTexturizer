# BumpForge / stlTexturizer — instructions projet (Claude)

Application **Electron + JS vanilla** (sans framework ni bundler) de **texturisation
par displacement** pour maquettes/dioramas imprimés en **FDM** (univers *Framed
Worlds*). On charge un STL/OBJ/3MF/**STEP** nu, on lui applique des reliefs gravés à
partir de textures (pierre, bois, tuile, métal) via **multi-slots** (un matériau = une
texture + une sélection de faces), puis on exporte un STL/3MF déplacé prêt à slicer.

Fork de **`CNCKitchen/stlTexturizer`** (BumpMesh, Stefan Hermann). Le multi-slot,
l'app Electron et le **Wood mapping** sont des ajouts du fork.

## Emplacements

| | |
|---|---|
| Copie de travail vive | `C:\Users\geton\Documents\stlTexturizer` |
| Code app (frontend) | `js/` (chargé en `<script type="module">` par `index.html`) |
| Process principal Electron | `electron-main.js`, `preload.js` (**CommonJS** — voir contrainte) |
| Harnais de tests | `test/` |
| Fork GitHub de l'utilisateur | `mine` → `github.com/123aanthony/stlTexturizer` |

## Architecture (modules `js/`)

- `main.js` — **monolithe ~8.4k lignes** : bootstrap, UI, état global, slots,
  orchestration d'export. **Cible du refacto en cours** (voir REFACTOR.md).
- `subdivision.js` — subdivision adaptative **sans T-jonction**, watertight préservé.
- `displacement.js` — **cœur du displacement** : normale lisse unique par position
  (anti-fissures), support multi-slot en une passe.
- `mapping.js` — projection UV (planar/cylindrical/spherical/triplanar/cubic + Wood
  X/Y/Z). Modes : triplanar=5, cubic=6, wood X/Y/Z=8/9/10.
- `slotMasks.js` — **cœur des masques multi-slot** (pur, extrait de main.js, testé).
- `slotState.js` — état slot pur : signatures de faces, split réglages per-slot/
  globaux, **`resolveSlotState` = source unique de vérité** des lecteurs de slot.
  **Doublons** (`computeOverlapFaces`/`countSlotOverlap`) : faces réclamées par
  ≥ 2 slots — l'export les tranche EN SILENCE par ordre de slot
  (`buildExclusiveSlotFaceMasks`), d'où 2 signaux nourris par la MÊME règle :
  onglet + highlight dans la vue (case « Surfaces en double » du pied de
  viewport → `viewer.setOverlapOverlay`, mesh dédié : `setExclusionOverlay`
  est remis à null par 8 sites, l'overlay sauterait au 1er coup de pinceau).
  ⚠️ **MAGENTA `#ff2fd0`, quasi opaque** (retour PO : le rouge d'origine était
  « très peu visible ») : une face en doublon est par construction MASQUÉE du
  point de vue du slot actif, donc posée sur l'ORANGE du shader
  (`userMaskColor` 0.85/0.40/0.15) — rouge sur orange ne se lit pas. Le magenta
  est la seule teinte que le shader ne produit JAMAIS (teal = texturé, orange =
  masqué, gris = masqué par angle) ; onglet et vue partagent la couleur.
  Les slots en mode **Exclude sont IGNORÉS** (décision PO) : leur matière est le
  complément des trous peints, ils réclameraient donc tout le modèle.
  **Pinceau de matériau** (`pickSlotMaterial`/`applySlotMaterial`, bouton
  « Copier le matériau ») : un slot porte DEUX choses indépendantes — son
  MATÉRIAU (carte + réglages artistiques) et sa SÉLECTION (faces + mode
  Inclure/Exclure). Le pinceau ne copie que le premier, la cible garde le
  second (là où « Dupliquer » copie les deux dans un slot NEUF) ; les clés
  d'export GLOBALES ne sont jamais du matériau. ⚠️ le slot ACTIF porte son état
  dans les globales, pas dans ses champs stockés → `saveActiveSlotState()`
  AVANT de lire la source, et `restoreSlotState(cible)` après si la cible est
  active, sinon le prochain save réécrirait l'ancien matériau par-dessus.
- `exportPipeline.js` — orchestration export multi-slot sans DOM (+`decimateWithGuard`
  watertight). `scaleSnap.js` — snap d'échelle cylindrique (fix dérive au reload).
- `beamAxis.js` — **Wood Auto orienté poutre** : PCA des faces du slot ; V classifié
  par la **normale de facette** (l'export subdivise avec normales splittées aux
  arêtes vives — valider sur le VRAI pipeline, jamais sur un maillage re-normalé).
- **Interop FreeCAD** (voir [INTEROP_FREECAD.md](INTEROP_FREECAD.md)) :
  `faceGroups.js` (pur : sidecar, ré-appariement par clés, groupes couleur),
  `stepImport.js` + `vendor/meshstep/` (import STEP direct), lien vif (fs.watch),
  auto-slots par couleur. Sélections ancrées aux faces BREP → survivent aux
  re-exports FreeCAD.
- `recovery.js` + `idbStore.js` — récupération après crash (brouillon projet complet
  en IndexedDB, bannière au relancement). `projectMigrate.js` — migration versionnée
  du payload projet.
- `exclusion.js` — peinture/poids d'exclusion de faces. `exporter.js` — STL/3MF
  binaire. `subdivision`/`decimation`/`regularize` — pipeline maille.
- `viewer.js`, `previewMaterial.js`, `stlLoader.js`, `i18n.js`, `meshValidation.js`.
  ⚠️ **i18n : `t()` retombe sur l'anglais en silence**, donc un pack incomplet ne
  casse RIEN — il parle juste anglais (les packs avaient dérivé de 23 à 27 clés
  en de/it/es/pt/ja/ko). Comblé, et surtout **mesuré** : `test/i18n.mjs` (dans
  `npm test`) exige la parité avec `en.js`, l'égalité des `{placeholder}` et
  l'existence de toute clé demandée par un `t('…')` du code. Toute nouvelle clé
  se pose donc dans les **8 fichiers**, jamais dans `en.js` seul.
  ⚠️ **SANS `scene.environment`, UN `MeshStandardMaterial` N'A AUCUNE LUMIERE
  INDIRECTE** (22/08) — une face qui ne voit pas la cle vaut exactement
  `albedo x ambiante`, a plat. C'est ce qui noircissait les facades du **Preview
  All Slots** (retour PO « certaines zones des batiments sont dans l'ombre »).
  S'y ajoutaient 2 causes : la cle etait posee en **(80, 120, 60)**, une position
  **Y-up dans une scene Z-UP** (`camera.up = 0,0,1`) donc une lumiere quasi
  horizontale — toits ternes, toute facade -X/-Y a l'ambiante ; et les 3 lumieres
  etaient **fixes en monde**, donc une facade dans l'ombre y restait quel que soit
  l'angle d'orbite. Corrige par `RoomEnvironment` + `PMREMGenerator` (IBL),
  `HemisphereLight` au lieu de l'`AmbientLight` plate, cle en (60, -90, 150), et
  une lumiere **liee a la camera** rafraichie avant chaque rendu
  (`_updateCameraLight`) — decalee a l'epaule gauche, PAS un phare frontal qui
  aplatirait la forme.
  ⚠️ **UN ECLAIRAGE SE CALIBRE SUR UNE ORBITE COMPLETE, PAS SUR 3 ANGLES
  CHOISIS** : le premier jeu de valeurs (env 0.85) supprimait bien les zones
  noires mais **la forme ne se lisait plus** — echange d'un defaut contre un
  autre, et invisible aux angles ou l'on regarde spontanement. Banc de mesure :
  36 vues (12 azimuts x 3 elevations) d'un groupe de batiments shade avec le
  materiau EXACT du Preview All Slots (`0x9ca3af`, roughness 0.72). Metrique
  decisive = **l'ETENDUE tonale au pire angle**, jamais la luminance moyenne
  (meme dilution que le volume ou le SSIM moyen) : MESURE 11 niveaux de gris
  avant (2.30 % de pixels quasi noirs), 28 a env 0.85, **34 a env 0.60 avec
  0 % de noirs** — d'ou `ENV_DARK = 0.60`, le seul reglage qui domine sur les
  3 axes (jamais sombre, le plus stable a l'orbite, le plus de modele conserve).
  ⚠️ **RESTE** : l'apercu teal live (`previewMaterial.js`) a son PROPRE
  eclairage code en dur dans le fragment shader (2 lumieres en espace vue, donc
  il suit la camera) avec une ambiante plate a 0.55 — meme cote ombre illisible,
  non aligne exprès (le lot visait le Preview All Slots).

## Tests — workflow OBLIGATOIRE après tout changement géométrique

```bash
npm test                    # unités (i18n/slots/scale/beam/recovery/migrate/interop/STEP) + golden
npm run test:i18n           # parité des 8 packs vs en.js + clés réellement demandées par t()
npm run test:golden         # golden seul (cube/sphère/cylindre/plaque + multi-slot + 2 STL réels)
npm run fixtures            # régénère les modèles de référence
npm run test:interop:update # régénère les fixtures FreeCAD (pilote FreeCADCmd)
npm run test:e2e            # Playwright-Electron : smoke + interop×2 (machine GPU, app fermée)
```
- `npm test` tourne en **headless** (Node + `three@0.170.0`, sans DOM/Electron) et
  est lancé **à chaque commit** par le hook `.githooks/pre-commit`
  (`git config core.hooksPath .githooks` une fois par clone ; bypass `--no-verify`).
- Toute empreinte qui change = **régression**, sauf changement voulu → alors
  `npm run test:golden:update` **avec justification dans le commit** (cf. REFACTOR.md).
- ⚠️ Le golden couvre le **cœur géométrique**, PAS le chemin d'appel de `main.js`.
  Pour un changement touchant l'orchestration d'export ou l'UI slots, **tester aussi
  l'app réelle** : `npm start` → vérifier un « Export All Slots ».
- Les e2e exigent un **profil vierge** (géré par `test/e2e/launch.mjs` +
  `BF_TEST_USERDATA`) : avec le vrai profil, le scan de la bibliothèque de textures
  (~275 Mo de dataURLs) tue la connexion de debug Playwright.

## Contraintes permanentes

- **Ne PAS mettre `"type": "module"` dans package.json** : `electron-main.js`/
  `preload.js` sont en CommonJS (`require`), ça les casserait. Le frontend est ESM
  via `<script type="module">`, indépendamment.
- **`three` épinglé à 0.170.0** = version du CDN en prod. Ne pas bumper sans
  rebaseliner le golden (les empreintes peuvent légitimement bouger).
- **FDM sans support** : parois ≥ ~0.8 mm, pontage en Y. L'imprimabilité prime.
- **Pas de push / réécriture d'historique sans demander.** GitHub `mine` : 21
  branches propres poussées ; 13 « sales » (artefact `dist/*.exe` 216 Mo > limite
  100 Mo GitHub) laissées en local — nettoyage `git filter-repo` à proposer à part.
- Posture : expert proactif, livrer par **lots validés** (un comportement = un commit).

## Docs

- [REFACTOR.md](REFACTOR.md) — méthode du refacto, barre de vérif, carte des extractions.
- [test/README.md](test/README.md) — harnais golden-master, modèles, bug latent connu.
- [INTEROP_FREECAD.md](INTEROP_FREECAD.md) — pont FreeCAD (2 pipelines, contrat des
  clés de faces, lien vif, auto-slots couleurs, pièges).
- [AUDIT.md](AUDIT.md) — audit slots/persistance (tout traité sauf note #4 max).
- [SAVE_AUDIT.md](SAVE_AUDIT.md) — audit UX sauvegarde (lots 1→5 tous faits).
