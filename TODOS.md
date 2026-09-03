# TODOS — BumpForge

- [ ] **DESIGN.md** — formaliser les conventions UI (palette sombre, accent
  violet #7c6aff, patterns encart/toast/badge de statut, typo, i18n fr/en).
  **Pourquoi** : chaque feature UI et chaque revue re-déduit les conventions du
  code ; le badge de statut (spec Tileable) est le 1ᵉʳ composant d'un
  vocabulaire jamais écrit. **Pros** : revues plus rapides, cohérence.
  **Cons** : ~1 session ; non urgent (fork solo). **Contexte** : proposé par la
  revue design de SPEC_TILEABLE.md (2026-07-19) ; `/design-consultation` peut le
  générer. **Dépend de** : rien.

- [x] **Les 3 divergences aperçu↔export sont corrigées** (03/09), relevées par
  `npm run test:parity:modes` à sa pose :
  1. **Cylindrique, 4.4e-2** — `capW` était une rampe LINÉAIRE côté CPU
     (`mapping.js:364`) et un SMOOTHSTEP côté shader : mêmes bornes, courbe
     différente, donc **9.62 %** de poids d'écart au milieu de la bande de fondu,
     à 37.3° de l'axe, **aux réglages d'usine**. La seule des trois qui se voyait.
  2. **Triplanaire, 2.2e-4** — epsilon de garde `+1e-6` (CPU) contre `+1e-4` (GLSL).
  3. **Cubique, ~1e-6** — normalisation finale `somme + eps` côté shader contre
     somme EXACTE côté CPU → remplacée par `max(somme, eps)`.
  **Décision PO : le shader s'aligne sur le CPU** — l'export ne bouge pas, golden
  **bit-identique**. Les 12 modes sont désormais à ~1e-14.
  ⚠️ **Reste à valider en GUI** : un cylindre avec « Mapping blend » à ~0.6.
  L'aperçu du fondu de calotte a CHANGÉ — c'est voulu : il montre enfin ce que le
  fichier exporté contient.

- [ ] **`seamBlendWidthMm` n'a AUCUN miroir dans le shader** : le réglage « Seam
  Blend » ne change rien à l'aperçu, seulement à l'export. Relevé en écrivant
  `test/mappingParity.mjs` (§4, limites publiées). **Décision** : porter les poids
  étalés en attribut de sommet côté aperçu, ou l'assumer et le DIRE dans l'UI —
  un réglage sans effet visible vaut moins qu'un réglage absent.

- [ ] **Resserrer la borne d'amincissement avec le creux RÉEL des cartes.**
  `printAudit.inwardBudget` accepte déjà `greyMin` par slot (mesuré, testé), mais
  `main.js` ne le fournit pas : l'audit annonce donc un **majorant** (il le dit).
  **Pourquoi** : à amplitude 0.5 symétrique il suppose 0.50 mm retirés là où une
  carte qui ne descend jamais sous 0.2 n'en retire que 0.30 — donc des alertes
  qui n'ont pas lieu d'être, et un avertissement qu'on cesse de lire.
  **Comment** : `greyMinOf(imageData)` sur l'ImageData que le chemin d'export a
  déjà en main (`getSlotImageData`). **Dépend de** : rien.

- [ ] **Vérifier À LA MAIN, une fois, que l'audit d'impression se déclenche.**
  Il est câblé sur les deux chemins d'export (contrôlé par lecture du source),
  mais le déclenchement réel passe par la boîte de dialogue native `saveBlob`
  qu'un e2e ne peut pas franchir. Exporter une pièce, regarder la console
  (`Audit impression — …`) et, sur une pièce mince, le toast.
