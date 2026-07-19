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
3. **Bords coïncidents PAR CONSTRUCTION** (décisions n°10 + eng n°5) — en deux
   temps, car clamper les sommets ne suffit pas (les SEGMENTS entre sommets
   divergeraient — piège de la revue eng) :
   (a) **raffinement de bord** : après la subdivision standard (`subdivision.js`,
   qui tourne déjà avant tout displacement), chaque bord garanti reçoit les
   breakpoints du bord opposé → distributions de sommets IDENTIQUES ;
   (b) **clamp** : hauteur du bord u=1 forcée à celle de u=0 → polylignes
   identiques segment par segment.
4. **Oracle partagé anti-tautologie** (décisions n°3 + eng n°1/5) : UN module
   (`tileability.js`, pur — il héberge aussi le *sampler clampé* appelé par
   `displacement.js` en mode 11). Deux niveaux :
   - **in-app (badge, instantané)** : vérifie la CHAÎNE AMONT sur la heightmap —
     périodicité post-blur-torique + snap entier actif + clamp actif. Suffisant
     car la garantie est par construction ; aucun displacement de fond (le vrai
     pipeline ne tourne qu'à l'export/bake/aperçu 3D).
   - **mesh (tests headless + e2e + export)** : pour tout sommet d'un bord
     activé, écart à la **POLYLIGNE du bord opposé** ≤ ε (jamais « au profil
     source du clamp » — ce serait mesurer ce que le clamp vient de faire).
     L'écart mm affiché est mesuré à l'export.
5. **Blur torique** (décision n°11a) : en Tileable, « Texture Smoothing »
   applique un blur *wrap-around* (sinon il désaccorde silencieusement les bords
   après vérification). Seam Blend / Transition masqués (non pertinents).
6. **Miroir GLSL** (eng n°3) : le mode 11 existe AUSSI dans le shader de preview
   (`previewMaterial.js`) — projection planaire + repeat, synchronisé au CPU
   (piège Wood Auto vécu : CPU ≠ GLSL = heures de debug).

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

## Export (décision n°8b — idée PO ; règle de chant UNIFIÉE eng n°2/8)

- Coche **« Exporter debout (prêt à imprimer) »**, **ON par défaut** en mode
  Tileable : le STL sort pivoté 90°, posé sur un chant — le slicer le reçoit
  déjà dans la bonne orientation (le conseil devient un acte).
- **Règle de chant — UNE seule autorité** (convention partagée avec
  SPEC_FW_DALLE) : dalle **avec poches** (corps FW_Dalle) → chant d'appui =
  **Y-min OBLIGATOIRE** (c'est le chant pour lequel les toits 45° des poches
  sont orientés ; override possible avec warning « ≠ chant des poches ») ;
  modèle tiers **sans poches** → auto = un bord NON garanti (le pied d'éléphant
  sacrifie un bord qui ne se raccorde pas), sinon l'avant ; override par select.
- **Check « assise intacte »** (eng n°8) : à l'export en mode Tileable, vérifier
  qu'aucun sommet sous le plan d'assise (dessous/poches) n'a été déplacé →
  warning si l'interface clips a été touchée par une sélection maladroite.
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

## Rotation 90° — encadrement de la promesse (eng n°6)

La poche universelle (SPEC_FW_DALLE) permet la rotation **mécanique** à 90° ;
le raccord **visuel** d'une dalle tournée n'est PAS garanti en v1 (translation
seule : un bord gauche tourné rencontre un bord bas — paires non garanties
entre elles). À écrire dans la doc UI du mode. Textures rotation-safe = v2.

## Pilote d'impression (eng n°6 — AVANT P1)

Avant d'implémenter : **2 dalles texturées à la main** (heightmap préparée
manuellement, joint continu sur l'une, rainure sur l'autre), imprimées debout et
assemblées — valide à l'œil l'effet physique du joint (ombre ~0,1 mm, chanfrein
du chant) et **calibre le défaut de joint sur du plastique**, pas sur une
intuition. ~1 journée d'impression, dé-risque des semaines de dev.

### Résultats T0 (verdict PO, 2026-07-19)

1. **L'anisotropie d'arête domine tout** : les deux chants HORIZONTAUX à
   l'impression (couches qui s'arrêtent net) donnent des arêtes VIVES →
   assemblage régulier ; les deux chants VERTICAUX (la buse arrondit le coin à
   chaque couche, rayon ~0,2) donnent des arêtes MOLLES → gap en V visible.
   Le pied d'éléphant du chant plateau n'était PAS le problème dominant.
2. **Conséquences intégrées** : (a) règle d'orientation — les bords RÉPÉTÉS
   doivent être la paire nette : en répétable mono-axe, `chant_impression` ⊥
   axe de répétition (cas résolu à 100 %) ; (b) en X+Y, **micro-chanfrein
   0,3 mm sur la paire molle uniquement** (côté FW_Dalle, orienté par
   `chant_impression`) — deux chanfreins définis remplacent deux arrondis
   flous, le joint devient une ligne voulue.
3. **Texture** : amplitude 0,6 en bruit doux = « beaucoup trop subtile » sur
   pièce réelle → défaut du mode relevé à **0,8** et le CONTRASTE (fréquences
   moyennes, crêtes) importe plus que l'amplitude.
4. **Joint par défaut : penchant PO = `continu`** (réalisme), sous réserve que
   le micro-chanfrein dissimule le gap de la paire molle — **pilote v2**
   (texture contrastée + chanfrein paire molle) tranche définitivement.

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
- [ ] **T11 (P1)** — e2e Tileable : fixture dalle → badge vert visible → export
  → **oracle sur le STL EXPORTÉ** (le vrai fichier) + orientation debout
  vérifiée. Surfacé par : eng review §tests (3 gaps e2e).
- [ ] **T12 (P2)** — grille de jeu gravée : couche heightmap composite (lignes
  en creux au pas de 25,4 mm alignées sur les bords via le snap — les cases se
  raccordent entre dalles). Surfacé par : eng review n°8 (F3 — promise par
  FW_Dalle, tombée entre les deux specs).
- [ ] **T0 (AVANT tout)** — pilote d'impression : 2 dalles texturées à la main
  (continu vs rainure), imprimées debout, assemblées → choix du joint par
  défaut sur pièce réelle. Surfacé par : eng review n°6 (voix externe F9).

La fixture dalle (T1) est committée dans `test/fixtures/tile/` et partagée par
unit/golden/e2e.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | (codex non installé) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 9 issues (2 archi + 3 qualité + gaps tests + 4 voix ext.), 8 décisions, 0 gap critique restant |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean | score : 6/10 → 9/10, 13 décisions, voix externe [single-model] 17 findings intégrés |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CROSS-MODEL :** voix externe eng [single-model] 10 findings — 9 intégrés
(breakpoints anti-tautologie, pilote, grille gravée orpheline, chant unifié,
réserve de relief, coupon debout…) ; 1 corrigé factuellement (la subdivision
existe : `subdivision.js` tourne avant tout displacement).

**VERDICT :** DESIGN + ENG CLEARED — prêt à implémenter. Ordre : T0 (pilote
d'impression) → P1 (T1-T5, T11) → P2. Phasage validé (complexity check).

NO UNRESOLVED DECISIONS
