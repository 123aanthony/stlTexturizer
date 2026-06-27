# BumpForge / stlTexturizer — instructions projet (Claude)

Application **Electron + JS vanilla** (sans framework ni bundler) de **texturisation
par displacement** pour maquettes/dioramas imprimés en **FDM** (univers *Framed
Worlds*). On charge un STL/OBJ/3MF nu, on lui applique des reliefs gravés à partir
de textures (pierre, bois, tuile, métal) via **multi-slots** (un matériau = une
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
- `exclusion.js` — peinture/poids d'exclusion de faces. `exporter.js` — STL/3MF
  binaire. `subdivision`/`decimation`/`regularize` — pipeline maille.
- `viewer.js`, `previewMaterial.js`, `stlLoader.js`, `i18n.js`, `meshValidation.js`.

## Tests — workflow OBLIGATOIRE après tout changement géométrique

```bash
npm test            # unités slotMasks + golden-master géométrique
npm run test:golden # golden seul (9 cas : cube/sphère/cylindre/plaque + multi-slot + 2 STL réels)
npm run fixtures    # régénère les modèles de référence
```
- Tourne en **headless** (Node + `three@0.170.0`, sans DOM/Electron).
- Toute empreinte qui change = **régression**, sauf changement voulu → alors
  `npm run test:golden:update` **avec justification dans le commit** (cf. REFACTOR.md).
- ⚠️ Le golden couvre le **cœur géométrique**, PAS le chemin d'appel de `main.js`.
  Pour un changement touchant l'orchestration d'export ou l'UI slots, **tester aussi
  l'app réelle** : `npm start` → vérifier un « Export All Slots ».

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
