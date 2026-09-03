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

## Flux recommandé (v2, STEP direct + lien de sauvegarde)

1. **FreeCAD** : commande **« FW Coloriser (BumpForge) »** (toolbar *FW — Outils*,
   voir « Périmètre et fil du bois » plus bas) → sélectionner les objets à
   exporter → commande **« Lier à
   BumpForge »** (toolbar *FW — Outils*) → choisir le fichier `.step` cible.
   La sélection + le chemin sont mémorisés dans le document (objet
   `BumpForge_Link`) et **chaque Ctrl+S ré-exporte automatiquement** ce STEP.
2. **BumpForge** : déposer le `.step` une fois. Toasts : « N faces reconnues » +
   « Lien vif » + « N slots créés depuis les couleurs ».
3. Choisir une texture par slot (les faces sont déjà assignées par couleur),
   puis **« Mémoriser les matières »** : au bâtiment suivant, les mêmes couleurs
   reviennent déjà texturées et nommées (cf. « Bibliothèque de matières »).
4. **Modifier dans FreeCAD → Ctrl+S** : le STEP se ré-exporte, BumpForge se
   recharge et ré-apparie les sélections tout seul. **Un seul geste.**

Relancer « Lier à BumpForge » avec une nouvelle sélection met le périmètre à
jour ; sans sélection, la commande propose de délier. (L'export manuel
Fichier → Exporter reste possible — le lien vif réagit pareil.)

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
(les plus gros d'abord, **cap 16**), nommé d'après la pièce dominante, faces
pré-assignées en include-only. Jamais sur un re-export (les sélections
ré-appariées priment). Une texture déjà choisie ne bloque pas (elle reste sur le
slot renommé).

### Bibliothèque de matières par couleur (03/09)

⚠️ **La couleur ne servait qu'à GROUPER : elle était jetée juste après.** Le
slot arrivait donc **nu** — sans carte ni réglages — et nommé d'après sa PIÈCE
dominante (« FW_Storey »), qui ne dit rien de la matière. Sur un bâtiment réel
de seize groupes, seize matières à re-choisir, **à chaque bâtiment**.

Le transfert de matière EXISTAIT pourtant (`.stltprofile`) : ce qui manquait
n'était pas la plomberie mais une **IDENTITÉ** stable à quoi accrocher une
matière. ⚠️ Le profil est indexé par slot **ACTIF**, donc par une POSITION — et
la position n'est pas stable : `groupFacesByColor` trie les groupes par nombre
de triangles, si bien qu'un bâtiment aux proportions différentes les réordonne
et que chaque matière atterrit sur le mauvais slot. Il n'applique d'ailleurs
qu'**une** matière, au slot actif : pour seize slots, seize chargements.

La couleur, elle, est stable — c'est `fw_colorize` qui la pose, une par matière,
avec des valeurs constantes d'un export à l'autre. Chaque slot porte donc
désormais son `colorKey` (`'#rrggbb'`, persisté dans le projet), et
`js/materialLibrary.js` (**pur, testé**) tient une bibliothèque *couleur →
{nom, carte, réglages}* rangée **hors projet** (IndexedDB, comme le brouillon de
reprise : son intérêt est justement de traverser les projets).

- **Mémoriser** : bouton « Mémoriser les matières », à côté des deux boutons de
  profil. Il retient la matière de tous les slots porteurs d'une couleur.
- **Rejouer** : à l'arrivée d'un STEP coloré sur une ardoise vierge — le même
  garde que les auto-slots, jamais sur un re-export — chaque groupe retrouve sa
  matière **et son nom**. Toast : « N slots créés — M matière(s) reconnue(s) ».

⚠️ **La correspondance se fait au PLUS PROCHE, pas au premier sous le seuil** :
un glouton ferait dépendre le résultat de l'ordre de mémorisation, et il y a des
teintes voisines — `fw_colorize` découpe le bois en sous-couleurs de **direction
de fil**. Même leçon que la carte des fils côté FreeCAD.
⚠️ **Et le seuil est SERRÉ** (0.02, ~5/255 par canal) : il absorbe l'aller-retour
STEP, pas davantage. Les trois pierres de `fw_colorize` sont volontairement
CONTRASTÉES — un seuil large peindrait un chaînage en voussoir sans que rien ne
le signale.
⚠️ Une **copie** de slot n'hérite pas du `colorKey` : deux slots de même couleur
se disputeraient l'entrée, et la dernière mémorisée gagnerait, arbitrairement.
⚠️ La bibliothèque est un **CONFORT** : son échec (IndexedDB indisponible) ne doit
jamais empêcher les slots d'exister, qui sont le vrai résultat de l'import.

## Périmètre et fil du bois (FW « Coloriser », 13/08)

Côté FreeCAD, `fw_colorize.py` peint **une couleur par matière sur les seules
surfaces vues du dehors**, et une **sentinelle magenta pur `(1,0,1)`** sur tout
le reste. `stepImport.js` mappe la sentinelle sur le groupe **-1**, que
`groupFacesByColor` ignore : ces faces n'ont ni slot ni texture, et ne consomment
pas le cap.

Pourquoi une couleur réservée plutôt que « pas de couleur » — deux mesures :

- l'exportateur STEP de FreeCAD décide **par OBJET**. Sur un export GUI réel
  (`test/fixtures/freecad/interop_colored.step`, 308 faces / 34 solides) : 27
  solides stylés au solide, 7 stylés face par face — **et ces 7 sont
  monochromes**, éclatés seulement parce que leur objet ne l'était pas.
  **0 solide partiellement stylé.** Peindre une face peint donc tout l'objet ;
- `step/styles.js` fait **hériter** la couleur du solide à ses faces
  (`faceRaw.get(face.faceId) ?? sc`), donc même un style au solide crée un
  groupe.

**Le fil du bois.** `computeBeamFrame` fait une PCA **sur les faces du slot** :
un slot qui mélange poteaux et écharpes rend une direction moyenne, donc un fil
faux — et la PCA travaille sur la direction **3D**, donc deux traverses de murs
perpendiculaires (X et Y) ne peuvent pas partager un slot. Le bois est donc
découpé en sous-couleurs par direction, quantification adaptative aux directions
réellement présentes (budget réglable, erreur annoncée). Mesuré sur un colombage
réel de 134 barres : 9 directions à 10° de tolérance (erreur max 7.6°), 13 à 5°.
D'où le cap relevé de 6 à 16 — à 6, les groupes les plus petits étaient
abandonnés en silence.

Alternative non retenue (documentée, ~20 lignes) : calculer le `beamFrame` **par
coque connexe** (`getShellAssignments` existe déjà dans `meshValidation.js`) au
lieu de par slot. Chaque poutre aurait son fil exact avec **une seule** couleur
bois et 0° d'erreur — FW sort déjà chaque barre en solide séparé.

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

- `npm test` : contrat, matcher, import STEP, cross-pipeline, couleurs et
  **sentinelle** (fixtures réelles committées dans `test/fixtures/freecad/` ; le
  test de sentinelle repeint une couleur de la fixture en magenta plutôt que
  d'ajouter un binaire, et il a été prouvé vivant par neutralisation).
- `npm run test:interop:update` : régénère les fixtures via FreeCADCmd
  (`FW_Diorama_tools/fc_bumpforge_interop.py`).
- `npm run test:e2e` : chaîne complète ×2 pipelines dans la vraie app (GPU),
  y compris lien vif (écrasement du fichier → auto-reload → sélection intacte).
