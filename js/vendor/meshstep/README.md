# meshstep (vendored)

Build `tsc` du dépôt https://github.com/CNCKitchen/meshStep (commit 67cf8db),
JS ESM uniquement (pas de .d.ts/.map). Licence AGPL-3.0 (fichier LICENSE ci-joint) —
ce dépôt étant public sur GitHub, la clause source est satisfaite.

Utilisé par `js/stepImport.js` (import STEP direct → maillage watertight +
mapping triangles→faces BREP `faceOfTri`). Pour mettre à jour : cloner l'amont,
`npm install && npm run build`, recopier les .js de `dist/` ici.

⚠️ Piège connu (v0.1.0) : `autoTessellation()` renvoie des options nulles qui
font échouer toutes les faces — toujours passer des options EXPLICITES
(voir stepImport.js).
