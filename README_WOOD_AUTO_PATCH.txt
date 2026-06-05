# BumpForge Wood Auto patch

Files to copy into your project:
- index.html
- js/mapping.js
- js/previewMaterial.js
- js/displacement.js (included unchanged from your provided version)

What it adds:
- Projection mode value 7: "Wood Auto (Beam)"
- CPU export mapping in js/mapping.js
- GPU preview mapping in js/previewMaterial.js
- UI option in index.html

Expected use:
1. Select "Wood Auto (Beam)" in Projection > Mode.
2. Use one slot for the top and side faces of a beam.
3. The texture U axis follows the longest bounding-box axis, so wood grain should stay aligned across faces.

Git workflow:
git checkout -b feature/wood-auto-mapping
copy the files
npm start
test on a simple 100x20x20 beam before using real diorama parts.
