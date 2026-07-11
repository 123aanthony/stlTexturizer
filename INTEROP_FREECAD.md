# Interop FreeCAD ↔ BumpForge

Objectif atteint : **plus jamais de resélection de faces** après une modification
FreeCAD. Les sélections sont ancrées aux **faces BREP** par une clé géométrique
et se ré-apparient toutes seules à chaque re-export. Deux pipelines coexistent et
convergent vers la même table de faces en mémoire — tout l'aval (snap sélection,
ré-appariement, lien vif, slots) est partagé.

```
.stl + .bumpforge-faces.json ──┐        (v1 — commande FW « Exporter pour BumpForge »)
                               ├──► table de faces (plages + clés) ──► sélections, lien vif, slots
.step  via meshStep vendorisé ─┘        (v2 — Fichier → Exporter STEP natif)
```

## Flux recommandé (v2, STEP direct)

1. **FreeCAD** : colorier les matériaux (les chaînes FW ont déjà leurs couleurs de
   groupe) → sélectionner les objets → **Fichier → Exporter** en `.step`.
2. **BumpForge** : déposer le `.step` (ou Charger un modèle). Toasts :
   « N faces reconnues » + « Lien vif » + « N slots créés depuis les couleurs ».
3. Choisir une texture par slot (les faces sont déjà assignées par couleur).
4. **Modifier dans FreeCAD → ré-exporter sur le même fichier** : BumpForge se
   recharge tout seul et ré-apparie les sélections (toast « ré-appariées »).

Le flux v1 (STL + sidecar JSON via la commande FW « Exporter pour BumpForge »,
toolbar *FW — Outils*) reste supporté à l'identique — c'est le **repli** pour un
STEP pathologique (meshStep ~3 % d'échecs sur CAO non curée).

## Comment ça tient (contrat v1 du sidecar)

Chaque face BREP = une **plage de triangles contiguë** dans le maillage + une
**clé géométrique** `{c: centroïde monde (mm), n: normale moyenne pondérée aire,
area}`. Les sélections sont stockées en clés de faces (pas en indices de
triangles) ; au re-export, `matchFaceKeys` (js/faceGroups.js) ré-apparie par
score centroïde+aire+normale (glouton unique, orphelins au-delà du seuil).

- **Jamais d'ancrage sur le nom `FaceN`** : le nommage topologique OCC est
  instable ; le nom ne sert qu'au debug.
- `n = (0,0,0)` est légitime (face fermée : cylindre/sphère) → appariement sur
  centroïde+aire seuls.
- Les clés sont en **coordonnées monde du fichier source** (avant le recentrage
  du viewer) — les deux pipelines partagent le même espace de clés (testé :
  des clés issues du STL se ré-apparient sur des faces STEP).

## Modules

| | |
|---|---|
| `js/faceGroups.js` | cœur pur : parse/validation sidecar, snap sélection→faces, `matchFaceKeys`, `groupFacesByColor` |
| `js/stepImport.js` | STEP → soupe + sidecar en mémoire (réordonné par face BREP), noms de pièces, groupes de couleur |
| `js/vendor/meshstep/` | build tsc de CNCKitchen/meshStep (AGPL, voir son README pour la mise à jour) |
| `main.js` `loadModelWithSidecar` | orchestration : détection sidecar (drop ou à côté du fichier via `webUtils`), snapshot→ré-appariement, auto-slots, lien vif |
| FW `fw_export_bumpforge.py` | export v1 (STL + sidecar), commande `FW_ExportBumpForge` |

## Lien vif

Modèle taggé chargé depuis un chemin disque → le main Electron surveille le
**dossier** (`fs.watch`, robuste au replace-by-rename), filtre modèle + sidecar,
notifie le renderer qui débounce 900 ms puis recharge/ré-apparie. Coupé sur New
et sur modèle non taggé. Un rechargement vif **ne détache pas** le `.bforge`
(Ctrl+S continue d'écraser le bon fichier projet).

## Auto-slots par couleur

STEP coloré + **aucune face peinte** nulle part → un slot par groupe de couleur
(les plus gros d'abord, cap 6), nommé d'après la pièce dominante, faces
pré-assignées en include-only. Jamais sur un re-export (les sélections
ré-appariées priment). Une texture déjà choisie ne bloque pas (elle reste sur le
slot renommé).

## Pièges connus

- **`autoTessellation()` de meshStep v0.1.0 est cassé** (options nulles → toutes
  les faces échouent) : `stepImport.tessOptionsForSize` calcule des options
  explicites depuis la diagonale.
- Export STEP **headless** FreeCAD : `Import.export` (PAS `Part.export`) ; les
  **couleurs n'existent qu'en GUI** (pas de ViewObject en headless) — d'où la
  fixture `interop_colored.step` (vrai export GUI).
- Un assemblage multi-pièces déclenche le bandeau « non-manifold / coques
  déconnectées » du diagnostic : **attendu** (pièces distinctes qui se touchent,
  philosophie « mur aveugle » FW) ; chaque solide est watertight individuellement.
- Sur un maillage **non taggé**, recharger perd les sélections (indices) — c'est
  pour ça que le lien vif ne s'arme que sur les modèles taggés.

## Tests

- `npm test` : contrat, matcher, import STEP, cross-pipeline, couleurs (fixtures
  réelles committées dans `test/fixtures/freecad/`).
- `npm run test:interop:update` : régénère les fixtures via FreeCADCmd
  (`FW_Diorama_tools/fc_bumpforge_interop.py`).
- `npm run test:e2e` : chaîne complète ×2 pipelines dans la vraie app (GPU),
  y compris lien vif (écrasement du fichier → auto-reload → sélection intacte).
