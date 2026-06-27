# Golden-master test harness

Characterization tests for the geometry pipeline (`js/subdivision.js`,
`js/displacement.js`). They pin the **current** behavior so the planned
`main.js` refactor can be done in small, reversible, verifiable steps: if a
change leaves every fingerprint identical, the displaced mesh is the exact same
shape; if one changes, the diff names the property that moved.

These are *characterization* tests, not *correctness* tests — they assert "same
as before", not "correct". A golden can therefore encode a known bug (see the
`real-fillets` note below); the harness's job is to make sure a refactor doesn't
*silently change* behavior, good or bad.

## Run

```bash
npm run fixtures            # (re)generate the reference STL models
npm run test:golden         # compare current pipeline output to goldens -> PASS/FAIL
npm run test:golden:update  # rewrite goldens from current output (after an INTENDED change)
```

Requires `three@0.170.0` (pinned to match the production CDN version). Runs in
plain Node — no DOM, no Electron.

## What each case targets

| Case | Model | Exercises |
|---|---|---|
| `cube-triplanar` | cube | hard dihedral edges → sharp-edge split (`SHARP_COS`), triplanar |
| `cube-cubic` | cube | cubic projection seam / blend weights |
| `cube-woodz` | cube | Wood Z mapping mode |
| `sphere-triplanar` | icosphere | smooth curvature → area-weighted smooth normals |
| `cylinder-cubic` | cylinder | smooth+hard caps, `smoothNrmReliability` fallback |
| `plate-noDownZ` | thin plate | thin walls, overhang/bottom-plane clamp |
| `real-fillets` | `cubeWithSmallFillets.stl` | real CAD mesh with small fillets |
| `real-laserplate` | `laserPlate.stl` | real flat plate mesh |
| `cube-multislot` | cube | **multi-slot**: ownership, boundary pinning, exclusive masks |

## Fingerprint

Per case: triangle count, unique vertex count, bounding box, open-edge /
non-manifold counts (watertight flag), and a SHA-256 of all quantized positions
(exact shape). Positions quantized to 1e-4 mm.

## Known finding (baseline, NOT yet fixed)

`real-fillets` is **watertight on input but non-watertight after the pipeline** —
the displacement opens a closed mesh on the small-fillet model. The golden
records this as the current state. It is a latent bug to investigate separately,
likely related to the sub-µm sliver propagation documented in `subdivision.js`.
