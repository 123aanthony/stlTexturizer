# E2E tests (Playwright + Electron)

Covers the DOM/IPC-bound paths the headless golden/unit harness **can't** reach —
first and foremost: *does the real app still boot after a refactor?* `main.js` is
~8k lines and can't be imported headless, so a launched-app smoke test is the
only automatic guard against "the refactor broke startup".

## Run

```bash
npm run test:e2e
```

Playwright launches the actual Electron app (it uses Electron's own Chromium —
no browser download needed).

## ⚠️ Needs a real GPU / display

The Three.js viewer creates a **WebGL** context on boot. On a headless box with
no GPU the renderer process crashes before assertions run (you'll see
`renderer crashed during boot`). Run on a normal desktop, or on CI configured
with a GPU or ANGLE-SwiftShader. (The pure data round-trip — face selection
surviving save/load, including mesh re-indexing — is already covered headless and
GPU-free by `test/slotState.mjs`, so this layer is only for the genuinely
app-bound behavior.)

## Status

- `smoke.spec.mjs` — launches the app, asserts the window loads, the viewer
  canvas is present, and no uncaught errors / renderer crash on boot.

The launch mechanism is verified (Playwright starts the app and loads
`index.html`); a green assertion run requires a GPU-backed environment.

## Possible next E2E (not yet added)

A project **save→reload** round-trip through the real IPC path. The app's save/
open use native dialogs, so the robust way is to expose a tiny test API on
`window` under a `?e2e` flag and drive `serializeProjectTextureSlots` /
`restoreProjectTextureSlots` directly, asserting selections survive. To add once
the smoke test is confirmed green on your machine.
