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

- `main.js` — **monolithe ~9.7k lignes** : bootstrap, UI, état global, slots,
  orchestration d'export. **Cible du refacto en cours** (voir REFACTOR.md).
- `subdivision.js` — subdivision adaptative **sans T-jonction**, watertight préservé.
- `displacement.js` — **cœur du displacement** : normale lisse unique par position
  (anti-fissures), support multi-slot en une passe.
- `mapping.js` — projection UV (planar/cylindrical/spherical/triplanar/cubic + Wood
  X/Y/Z). Modes : triplanar=5, cubic=6, wood X/Y/Z=8/9/10.
- `presetTextures.js` — chargement des cartes, presets et personnalisées.
  ⚠️ `SIZE` est la résolution de TRAVAIL : aperçu **et** échantillonnage. Portée de
  512 à **1024**, parce que le facteur limitant n'est pas la texture mais le
  MAILLAGE — il ne peut porter qu'une longueur d'onde de deux arêtes. Le point de
  bascule vaut `SIZE × refineLength / 2`, soit 38.4 mm de tuile à 512 px et 0.15 mm
  d'arête ; mesuré sur un projet réel, 5 slots sur 22 dépassaient ce seuil.
  ⚠️ `fitDimensions` clampe à 1 : une source plus petite n'est JAMAIS agrandie —
  relever le cap ne coûte donc rien sur les presets déjà sous la barre. Et les
  cartes déjà STOCKÉES dans un projet passent par le même clamp : il faut
  ré-importer le fichier source pour bénéficier du nouveau cap.
  ⚠️ **Ce cap a un effet de levier sur le poids du projet** : à 1024 les data URL
  d'un projet réel sont passées de 15.9 à 57.7 Mo, rendant insupportable la
  duplication par slot qui préexistait (voir « Format projet » plus bas). Les deux
  se lisent ensemble.
- `mipPyramid.js` — **préfiltre d'antialiasing** : pyramide mip mémoïsée sur
  l'identité de l'ImageData, LOD depuis l'empreinte texel (`arête_mm × texPerMm`).
  Une bilinéaire est un filtre de RECONSTRUCTION, pas un préfiltre : sous-
  échantillonner sans elle repliait le spectre. ⚠️ Charnière de non-régression :
  `if (!pyr || !(lod > 0)) return sampleBilinear(...)` — le chemin inactif exécute
  la MÊME ligne sur les MÊMES octets, ce que les goldens prouvent bit-à-bit.
- `smoothNormals.js` — normales d'AFFICHAGE par angle de pli (`creaseDeg`).
  ⚠️ Ne touche JAMAIS l'attribut `normal` du pipeline, dont `exporter.js:62` tire
  les normales de facette du STL. Mesuré : facettage 10.93° → 0.29°, arêtes vives
  conservées à 44.32°, zéro changement de position.
- `mapPrep.js` — préparation de carte : niveaux (noir/blanc/gamma) puis séparation
  MACRO/MICRO autour de la moyenne comme point fixe. `isMapPrepActive` teste
  l'égalité EXACTE aux neutres : réglages neutres ⇒ la carte n'est pas touchée.
- `pieceVariation.js` — variation du motif par PIÈCE (le veinage ne traverse plus
  toutes les planches). ⚠️ La clé est le **centroïde pondéré par l'AIRE**, pas
  l'index : une renumérotation du maillage déplacerait l'index, donc le veinage.
  Identité des pièces = solides BREP du STEP quand il y en a (mesuré : 557
  composantes connexes contre **34** solides réels) ; les composantes connexes ne
  sont qu'un repli. `buildPieceXforms` est la SOURCE UNIQUE partagée par le moteur
  CPU et l'attribut GPU — `test/previewParity.mjs` compare les deux formules.
- `seamBlend.js` — étalement des poids de projection autour des coutures, sur une
  largeur en **MILLIMÈTRES** (`seamBlendWidthMm`, 0 = désactivé).
  ⚠️ Un mélange piloté par la NORMALE ne peut rien pour une arête vive : la normale
  y saute de 90° sans valeur intermédiaire — mesuré, « Seam Blend » au MAXIMUM
  donne **0.0 %** sur un mur plat, 0.1 % à 30°, et 50 % seulement à 45°.
  ⚠️ Et `blendNormalSmoothing` (lissage laplacien) est une DIFFUSION : sa portée
  croît en **√k** ET proportionnellement au pas du maillage — 1.88 / 4.38 / 8.75 /
  16.88 mm pour k = 8 / 32 / 128 / 512, et 8.75 → 2.19 mm quand le pas passe de 2.0
  à 0.5. À 0.15 mm de résolution les 32 itérations par défaut ne couvrent que
  ~0.65 mm, et **affiner l'export RESSERRE la couture**. D'où une distance
  géodésique réelle, bornée à la largeur demandée : coût proportionnel à la BANDE,
  pas au maillage. La couture est repérée par un critère de GRAPHE (arête dont les
  deux bouts n'ont pas le même axe dominant), donc valable même à mélange nul.
  ⚠️ **Ce que ce module NE corrige PAS** : le « chevron » vu à un angle convexe
  n'est PAS un défaut de placage — mesuré sur le modèle du PO, `du`/`dv` valent
  +0.4858 des deux côtés et les stries penchent pareil (19.6° contre 21.3°). C'est
  l'ÉCLAIRAGE : deux faces perpendiculaires sous une lumière unique orientent leurs
  reflets jusqu'à 85° d'écart, exactement en miroir sous une lumière symétrique
  (et l'écart retombe à 1.6° sous une lumière zénithale). Le seul levier est le
  GRAIN de la carte — cf. la mesure d'anisotropie par tenseur de structure.
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
- **Format projet — cartes DÉDUPLIQUÉES** (`mapLibrary` + `customMapKey` par slot,
  empreinte de contenu FNV-1a). Chaque slot portait sa propre copie en data URL :
  sur un projet réel de 18 slots pour 3 textures distinctes, **57.7 Mo** — la même
  image écrite SEIZE fois. La compression n'y peut rien, la fenêtre de deflate
  faisant 32 Ko. Prix payé à CHAQUE édition, l'instantané de reprise re-sérialisant
  tout : gel de **1488 ms**, six secondes après chaque réglage touché.
  ⚠️ La LECTURE accepte toujours l'ancien format en ligne — les projets existants
  s'ouvrent inchangés, ce que `test/e2e/mapDedupe.spec.mjs` vérifie en partant d'un
  fichier à l'ancien format, slot par slot : sur un changement de FORMAT, la
  fidélité compte avant la taille.
  ⚠️ Il fallait DEUX correctifs. La restauration créait une entrée PAR SLOT (18
  canevas et 18 textures GPU pour 3 images) : sans partage des entrées, mémoïser
  l'encodage ne servait à rien, chaque entrée ayant son propre cache. Mesuré :
  encodages 645 → 619 ms avec la seule déduplication, **105 ms** avec le partage.
  Le partage est conditionné au NOM autant qu'au contenu (`entry.name` a pour repli
  le nom du SLOT). Résultat : 47.8 → **10.8 Mo**, gel 1488 → **415 ms**.
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
npm test                    # 25 harnais headless, golden compris (liste dans package.json)
npm run test:i18n           # parité des 8 packs vs en.js + clés réellement demandées par t()
npm run test:golden         # golden seul (cube/sphère/cylindre/plaque + multi-slot + 2 STL réels)
npm run fixtures            # régénère les modèles de référence
npm run test:seamband       # caractérisation √k du lissage — HORS batterie (pas un invariant)
npm run test:interop:update # régénère les fixtures FreeCAD (pilote FreeCADCmd)
npm run test:e2e            # Playwright-Electron : 6 specs (machine GPU, app fermée)
```
- `npm test` tourne en **headless** (Node + `three@0.170.0`, sans DOM/Electron) et
  est lancé **à chaque commit** par le hook `.githooks/pre-commit`
  (`git config core.hooksPath .githooks` une fois par clone ; bypass `--no-verify`).
- **Trois gardes valent d'être connus**, chacun né d'un défaut qu'aucun autre
  n'aurait vu :
  - `moduleSyntax.mjs` importe RÉELLEMENT les 33 modules. Un `import` en double
    est une erreur de syntaxe au niveau module : `main.js` cessait de s'évaluer,
    l'app était morte à l'écran — et `node --check` rendait **0** (le fichier n'est
    pas analysé comme module ES), pendant que le smoke passait au vert en attachant
    ses écouteurs d'erreur APRÈS le délai de lancement.
  - `settingsCoverage.mjs` DÉRIVE la couverture de persistance du code lui-même.
    `PERSISTED_KEYS` est une liste d'inclusion tenue à la main : elle se périme en
    silence, et **9 réglages** (`decimateEnabled` + les 8 `regularize*`) n'étaient
    écrits NULLE PART — ils pilotent pourtant la géométrie exportée.
  - `bootFallback.mjs` + `e2e/projectSlotMaps.spec.mjs` : le repli de carte du
    démarrage écrasait la restauration. ⚠️ Le second a attrapé le défaut alors que
    les gardes de câblage du premier étaient DÉJÀ posés — la vraie cause était
    ailleurs (un `setInterval` de 500 ms). Un oracle de câblage ne remplace pas un
    oracle de comportement.
- ⚠️ **Les oracles de performance COMPTENT, ils ne chronomètrent pas.** Un seuil en
  millisecondes dépend de la machine, de la charge et du GC ; un oracle instable
  finit ignoré. `e2e/tabThumbs.spec.mjs` compte les appels à `toDataURL` — une
  propriété du CODE, qui doit être NULLE quel que soit le matériel. Il vérifie
  d'abord que les vignettes sont PEINTES : une mémoïsation qui n'afficherait rien
  serait rapide et fausse.
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
- **Pas de push / réécriture d'historique sans demander.** GitHub `mine` :
  **2 branches**, dépôt **17 Mo**. L'artefact `dist/*.exe` de 216 Mo qui bloquait
  13 branches a été purgé et les branches mortes élaguées (23 → 2).
  ⚠️ Le contrôle d'accessibilité doit interroger `refs/heads` AUTANT que
  `refs/tags` et `refs/remotes` : un premier passage les avait oubliées, `gc` ne
  récupérait que 0.4 Mo et le binaire vivait encore dans 13 branches locales.
- Posture : expert proactif, livrer par **lots validés** (un comportement = un commit).

## Docs

- [REFACTOR.md](REFACTOR.md) — méthode du refacto, barre de vérif, carte des extractions.
- [test/README.md](test/README.md) — harnais golden-master, modèles, bug latent connu.
- [INTEROP_FREECAD.md](INTEROP_FREECAD.md) — pont FreeCAD (2 pipelines, contrat des
  clés de faces, lien vif, auto-slots couleurs, pièges).
- [AUDIT.md](AUDIT.md) — audit slots/persistance (tout traité sauf note #4 max).
- [SAVE_AUDIT.md](SAVE_AUDIT.md) — audit UX sauvegarde (lots 1→5 tous faits).
