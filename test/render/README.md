# Headless mapping renders

Renders a beam with the **real** `js/mapping.js` projection to a PNG, so the
wood-grain / projection direction can be judged without the live GPU app
(software rasterizer, no GPU, no native deps — pure JS + pngjs).

```bash
npm run render -- wood-x          # straight beam (grain should run along length)
npm run render -- wood-x 35       # rafter inclined 35° about Y (exposes world-axis projection)
npm run render -- wood-z          # other modes: wood-y / wood-z / triplanar / cubic
```

Output: `test/render/render-<mode>[-incl<deg>].png` (gitignored — regenerate any time).

The grain texture is a directional line pattern (lines run along texture-U). If
the projection is correct, the lines follow the beam's long axis. On an inclined
beam with a world-axis Wood mode, they visibly cross the beam — that's the known
"inclined timber" limitation (roadmap), the thing this render is for.

## Why this exists

The live app needs WebGL/GPU; the agent's sandbox can't drive it. This pipeline
computes UVs with the production `computeUV` and rasterizes them on the CPU, so
the agent can SEE the mapping result and iterate on projection code with visual
feedback. Pairs with the headless `npm test` (which checks geometry/logic).
