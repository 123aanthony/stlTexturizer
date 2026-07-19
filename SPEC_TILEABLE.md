# SPEC — Tileable Displacement Mode (BumpForge)

Statut : **REVUE DESIGN TERMINÉE** (2026-07-19, /plan-design-review, 13 décisions).
Origine : spec fonctionnelle PO + analyse technique + revue croisée (sous-agent
indépendant, 17 findings intégrés).

## Objectif

Créer des **dalles modulaires** (sols, murs, routes, trottoirs, pavés) dont une
même STL imprimée N fois s'assemble **sans rupture visible du relief**.

## Contrat fonctionnel

> **Garantie** : continuité géométrique du relief aux bords du modèle exporté —
> les sommets des bords opposés *activés* ont le même profil de déplacement
> (ε = 0,01 mm).

- **Répétabilité PAR AXE** (décision n°5) : `X et Y` (champ : sol, pavage) |
  `X seulement` (rangée : trottoir le long d'une rue) | `Y seulement`.
  Seules les paires de bords activées sont garanties/vérifiées.
- **Multi-slots et sélections AUTORISÉS — l'oracle est la loi** : la
  vérification porte sur la géométrie finale (tous slots confondus) ; un curb en
  slot séparé passe au vert tant qu'il ne viole pas un bord garanti. Pas
  d'interdictions arbitraires : le badge dit la vérité.
- Périmètre v1 : assemblage par **translation** (même orientation). Rotations
  90° = extension (bords identiques entre eux + symétriques).

### Cas d'usage
1. **Dalle simple** 50×50 : répétable X+Y, une texture → sol infini.
2. **Tuile de trottoir** : répétable X ; centre = slot A (dalles béton), bordure
   curb = slot B (pierre) le long du bord Y libre → se répète le long de la rue.
   (Le raccord *inter-types* rue↔trottoir = profils de bord nommés, v2.)

## Exigences techniques

1. **Snap à répétitions entières** (généralise `scaleSnap.js`) : arrondi au plus
   proche, **min 1 répétition**, U et V indépendants ; la distorsion d'aspect
   résiduelle est AFFICHÉE (« aspect 1:1.04 »). Snap non débrayable en Tileable
   (le débrayer casserait la garantie) et VISIBLE (décision n°6).
2. **Déplacement AXIAL** : selon l'axe de projection strictement (pas la normale
   lissée) → l'empreinte XY ne bouge jamais, parois planes, watertight préservé.
3. **Clamp de bord — garantie PAR CONSTRUCTION** (décision n°10) : la hauteur
   des sommets du bord u=1 est forcée à la valeur interpolée du profil u=0
   (idem v=0/v=1, pour les axes activés). L'oracle devient un filet, plus un
   espoir : il vérifie, le clamp garantit.
4. **Oracle partagé** (décision n°3) : UN module (`tileability.js`, pur) appelé
   (a) par la suite headless et (b) **in-app après chaque displacement** en mode
   Tileable → badge. Critère : pour tout sommet d'un bord activé, écart de
   hauteur au profil du bord opposé ≤ ε.
5. **Blur torique** (décision n°11a) : en Tileable, « Texture Smoothing »
   applique un blur *wrap-around* (sinon il désaccorde silencieusement les bords
   après vérification). Seam Blend / Transition masqués (non pertinents).

### Contrat de maillage d'entrée (décision n°10b)
Dalle = emprise ≈ boîte ; face à texturer plane (ε plan 0,05 mm) ; parois
latérales verticales. Les bords opposés n'ont PAS besoin de sommets appariés
(le clamp s'en charge) mais une subdivision régulière donne le meilleur résultat.
**Fixture** : une dalle de référence committée (`test/fixtures/tile/`) — le mode
est testable sans attendre `FW_Dalle`.

## Interface (panneau Projection)

Mode ajouté au `<select>` existant : **« Tileable »**, index 11, positionné sous
Triplanar. Encart dans l'ordre de lecture (décision n°1 — badge d'abord) :

```
Projection : [ Tileable ▾ ]
┌─ Tileable ─────────────────────────────────┐
│ ✓ Tuile vérifiée (écart max 0,003 mm)      │ ← badge PERSISTANT vert/rouge/gris
│ Répétable : [X et Y ▾]                     │ ← X+Y | X seul | Y seul
│ Répétitions : 4 × 4 — 12,5 mm/rep          │ ← snap visible (aspect si ≠ 1:1)
│ ⚠ Texture non raccordable                  │ ← inline persistant (si applicable)
│ Joint : [Continu ▾]  prof 0,3  larg 0,4 mm │ ← continu | rainure (mm réglables)
│ Axe : [Auto (Z) ▾]                         │ ← auto (normale majoritaire) + XY/XZ/YZ
│ ☐ Aperçu répétition (3×3)                  │ ← instances fantômes viewport
└────────────────────────────────────────────┘
```

### Tableau d'états (décisions n°3, 4, 6)

| Élément | Calcul | Non applicable | Échec | Succès |
|---|---|---|---|---|
| Badge | « Vérification… » | gris « Non applicable (pas une dalle) » | rouge « Bord gauche ≠ droit : 0,4 mm à v=0,62 » | vert « Tuile vérifiée (écart max 0,003 mm) » |
| Détection dalle | — | bandeau info **non bloquant** (l'app informe, n'empêche jamais) | — | silencieux |
| Warning seamless | — | — | **inline persistant** tant que la texture fautive est active ; informatif (géométrie tileable ≠ texture seamless : notions séparées) | absent |
| Snap | — | — | — | « Échelle ajustée : 12,5 → 12,0 mm (4 × 4) » |

- Vérif seamless : checkbox « Vérifier la texture » cochée par défaut (pattern
  `cylinder-snap-toggle`).
- **A11y** : badge = icône ✓/✗/— + texte + valeur (jamais la couleur seule) ;
  contrastes AA ≥ 4,5:1.
- **i18n** : toutes les chaînes en clés fr+en (`interop.*` pattern) —
  `tile.verified`, `tile.mismatch`, `tile.notSlab`, `tile.textureNotSeamless`,
  `tile.reps`, `tile.exportUpright`, …

## Aperçu répétition 3×3 (décision n°7)

Toggle dans l'encart : 8 instances fantômes de la dalle déplacée autour de la
vraie (même buffer, instancié — coût quasi nul). En répétable X seul → rangée
1×3. Désactivé pendant la peinture de faces (raycast). C'est l'étape qui tue le
doute AVANT l'impression.

## Export (décision n°8b — idée PO)

- Coche **« Exporter debout (prêt à imprimer) »**, **ON par défaut** en mode
  Tileable : le STL sort pivoté 90°, posé sur un chant — le slicer le reçoit
  déjà dans la bonne orientation (le conseil devient un acte).
- **Chant d'appui AUTO** : un bord NON garanti quand il en existe (répétable X
  seul → chant avant/arrière ; le pied d'éléphant sacrifie un bord qui ne se
  raccorde pas), sinon l'avant ; **override** par select.
- Toast de confirmation : « Exporté debout — chant avant au plateau ».
- Conseils résiduels (z-seam sur un coin, brim) : encart au 1ᵉʳ export Tileable,
  dismissible.

## Valeurs par défaut (décision n°9 — tout en mm absolus)

| Paramètre | Valeur | Note |
|---|---|---|
| ε oracle | 0,01 mm | 10× sous la résolution FDM |
| Seuil texture non-seamless | écart > 2 % de dynamique sur > 1 % des texels bord-à-bord | |
| Amplitude par défaut du mode | 0,6 mm | warning > 0,8 (autoportant en vertical) |
| Demi-rainure | 0,4 larg × 0,3 prof mm | réglable |
| Joint par défaut | continu | pas de détection « maçonnée » magique |
| Snap | arrondi au plus proche, min 1 rep | U/V indépendants, aspect affiché |
| ε plan (détection dalle) | 0,05 mm | |

## Joints — propriété (décision n°11b)

- `continu` / `rainure` (traitement de bord de la **heightmap**) → **BumpForge**.
- Chanfrein d'assemblage + chanfrein chant plateau (0,3 mm) → **FW_Dalle**
  (corps de la dalle, spec FreeCAD séparée : dimensions, poches d'aimants,
  plaque de base à alvéoles — l'alignement vient d'en dessous, les chants
  restent purs).

## Répartition BumpForge / FreeCAD

- **BumpForge** : mode Tileable complet (ce document).
- **FW Diorama** : générateur `FW_Dalle` (SPEC à écrire) ; la dalle arrive par
  le pont STEP existant (couleurs → slots, lien vif). Non bloquant : la fixture
  de référence rend le mode livrable seul.

## Garanties & limites

- **Garantit** : la continuité géométrique du relief aux bords activés du modèle
  exporté (vérifiée in-app, chiffrée).
- **Ne garantit pas** : peinture/filament, défauts d'impression, z-seam,
  l'ombre physique ~0,1 mm entre deux objets imprimés (→ options de joint),
  ni le rendu esthétique de la répétition (→ aperçu 3×3 pour en juger).

## NOT in scope (v1, explicitement différé)

| Différé | Raison |
|---|---|
| Profils de bord NOMMÉS (raccord inter-types rue↔trottoir) | système complet d'interfaces — v2 après usage réel |
| Rotation-safe (assemblage 90°) | contrainte plus forte (bords identiques + symétriques) |
| Variants A/B/C mêmes bords / Tile Sets | génération de heightmap (bande verrouillée + seed) — séparable |
| Multi-textures par répétition (motifs différents par copie) | contredit « une STL répétée » |
| Hauteurs de corps différentes (rue vs trottoir) | FW_Dalle (corps), pas displacement |

## What already exists (leviers)

`scaleSnap.js` (snap) · toasts + i18n fr/en · pattern encart panneau + checkbox
snap cylindrique · bandeau diagnostic (famille visuelle du badge) · suite
headless + hook pre-commit (l'oracle s'y branche) · viewport three.js
(instances pour l'aperçu 3×3) · pont FreeCAD (STEP, couleurs→slots, lien vif).

## Extensions futures

Variants (bande de bord verrouillée + intérieur seedé) → Tile Sets Floor_01..N →
profils de bord nommés (Wang-tiles : interfaces « curb », « rue », « pelouse »)
→ rotation-safe.

## Implementation Tasks

Synthétisées de la revue — cocher en livrant. P1 = cœur livrable, P2 = même
version, P3 = suite.

- [ ] **T1 (P1)** — `js/tileability.js` : module pur partagé — clamp de bord par
  construction + oracle (ε 0,01) + fixture dalle de référence + tests headless
  (l'oracle du contrat). Surfacé par : décisions n°3/10.
- [ ] **T2 (P1)** — mode 11 « Tileable » : projection planaire sur emprise, axe
  auto (normale majoritaire) + override XY/XZ/YZ, répétable X/Y/XY. Surfacé
  par : décisions n°2/5.
- [ ] **T3 (P1)** — snap entier U/V (généraliser `scaleSnap.js`) + affichage
  répétitions/aspect. Surfacé par : exigence 1, décision n°6.
- [ ] **T4 (P1)** — déplacement axial en Tileable (`displacement.js`) — golden
  obligatoire. Surfacé par : exigence 2.
- [ ] **T5 (P1)** — encart panneau (badge états complets, warning inline,
  joint, i18n, a11y). Surfacé par : passes 1-2.
- [ ] **T6 (P2)** — blur torique + masquage Seam Blend en Tileable. Surfacé
  par : décision n°11a (F14).
- [ ] **T7 (P2)** — aperçu répétition 3×3 (instances viewport). Surfacé par :
  décision n°7 (F10).
- [ ] **T8 (P2)** — export debout (rotation, chant auto/override, toast,
  encart conseils 1ᵉʳ export). Surfacé par : décision n°8b (idée PO).
- [ ] **T9 (P2)** — traitement de bord `rainure` (heightmap). Surfacé par :
  décision n°11b.
- [ ] **T10 (P3)** — vérification seamless de texture (seuil 2 %/1 %) +
  checkbox. Surfacé par : contrainte texture.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | (codex non installé) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean | score : 6/10 → 9/10, 13 décisions, voix externe [single-model] 17 findings intégrés |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**VERDICT :** DESIGN CLEARED — spec prête à implémenter ; eng review required
avant de shipper l'implémentation.

NO UNRESOLVED DECISIONS
