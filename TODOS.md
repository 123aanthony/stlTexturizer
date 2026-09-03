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

- [ ] **La variation par PIÈCE ne fait RIEN sur « Export All Slots ».**
  MESURÉ : `pieceOffset` / `pieceRotate` actifs ⇒ **0 sommet différent sur
  633 312** par rapport aux mêmes réglages désactivés. Cause : `main.js` passe
  `pieceOfTri` à `applyDisplacement` sur le chemin **mono-slot** (`:8537`) mais
  `exportPipeline.runMultiSlotExport` ne le passe pas — le moteur teste
  `settings.pieceOfTri` et se désactive donc en silence. Le réglage marche à
  l'aperçu et sur l'export d'un seul slot : c'est cette asymétrie qui le rend
  invisible. **Trouvé en écrivant la CLI**, qui reproduit fidèlement la GUI —
  donc le même défaut. **Comment** : injecter `pieceOfTri` (via `faceParentId`,
  comme `pieceOfTriFor`) dans `runMultiSlotExport`. ⚠️ La sortie CHANGERA sur
  tout projet qui utilise la variation ⇒ golden à rebaseliner, avec mesure.

- [ ] **Desserrer `main.js` : les candidats mesurés.** Le cliquet
  (`npm run test:size`) empêche la croissance ; le faire MAIGRIR demande des
  extractions. Fonctions de premier niveau **sans DOM ni global** (donc pures,
  donc déplaçables sans risque), mesurées le 03/09 : `updateFaceMask` (74),
  `addSmoothNormals` (60), `distSqPointToTri` (46), `_paintSingleHit` (41),
  `linkSlider` (38) — **418 lignes sur 10 fonctions** au total. Les grosses
  fonctions (`wireEvents` 979, `handleExport` 222,
  `computeBoundaryFalloffAttr` 211) touchent toutes le DOM ou l'état global :
  elles se découpent, elles ne se déplacent pas telles quelles.

- [ ] **L'affichage de l'échelle dérive après un RE-import de projet.** Après
  avoir ouvert un projet **par-dessus un projet déjà ouvert**, le panneau montre
  l'échelle du slot ACTIF pour tous les onglets — mesuré : 6 slots sur 7
  affichent 51.7 (la valeur du slot actif) au lieu de 25 / 105 / 49.7.
  **Le fichier, lui, est intact** (7/7 identiques, test permanent) : c'est un
  défaut d'affichage, pas de données — mais il se lit comme « mon échelle a
  changé », et c'est très probablement l'origine du ticket qui dormait dans
  `REFACTOR.md`. **Intermittent** (6 fois sur 8 lancements), donc pas de test
  dans la batterie. Repro : `npx playwright test scaleRoundTrip` en rétablissant
  le cas « AFFICHAGE » commenté en tête du fichier.
  ⚠️ **Piste déjà réfutée** : le `isRestoringProject = false` du `finally` de
  `handleModelFile` (appelée au milieu de l'import) — le restaurer ne change
  rien. Chercher ailleurs : un autre écrivain de `saveActiveSlotState`, ou un
  `restoreSlotState` non rejoué quand les onglets sont recréés à l'identique.

- [x] **~~Les e2e ne tiennent plus quand la machine est chargée~~ — c'était FAUX,
  et la vraie cause est trouvée** (04/09). Trois cas échouaient par expiration ;
  j'ai accusé la charge machine (mesures à l'appui : 14 s au repos contre 3,6 min
  le soir) et élargi les délais. **Le diagnostic était faux.** Les tests ne
  ralentissaient pas : ils **bloquaient à la FERMETURE**. `electron-main.js`
  intercepte `close` et ouvre, projet sale, un dialogue NATIF modal
  « Enregistrer / Ne pas enregistrer / Annuler » — personne ne clique en e2e,
  `app.close()` ne rend jamais la main. MESURÉ : app vide fermée en **0,2 s**,
  app avec un modèle chargé **jamais**. `launchApp` répond désormais « Ne pas
  enregistrer ». Suite complète : **12/15 en 21 min → 15/15 en 2,6 min**, et le
  cas à deux phases passe de 600 s d'expiration à **3,5 s**. Délais remis à leurs
  valeurs d'origine.
  ⚠️ **Le symptôme trompait deux fois** : Playwright impute le blocage au test qui
  vient de finir, donc à sa dernière assertion ; et le temps perdu au teardown
  gonfle la durée du test SUIVANT, ce qui fabrique une fausse impression de
  lenteur générale. C'est ce qui m'a fait conclure « machine chargée » alors que
  le corps de chaque test s'exécutait en quelques secondes.
