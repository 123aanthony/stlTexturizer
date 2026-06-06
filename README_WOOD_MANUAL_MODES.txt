BumpForge Wood manual modes patch

This patch adds manual wood beam projection modes:
- Wood Auto (Beam) = existing mode 7
- Wood X (manual) = mode 8
- Wood Y (manual) = mode 9
- Wood Z (manual) = mode 10

Files to replace from project root:
- index.html
- js/mapping.js
- js/previewMaterial.js

It does not touch js/main.js or the slot workflow.

Recommended test:
1. git checkout -b feature/wood-manual-modes
2. Copy files into place.
3. npm start
4. Test the same 5x5x20 and 4x4x70 beams with Wood X/Y/Z.
