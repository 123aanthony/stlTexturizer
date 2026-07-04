// FreeCAD interop — BREP-face groups (contract v1, FW Diorama fw_export_bumpforge).
//
// The FreeCAD exporter writes, next to the STL, a sidecar
// `<name>.bumpforge-faces.json` describing each BREP face as a CONTIGUOUS
// triangle range plus a geometric KEY {centroid, mean normal, area}. Selections
// are anchored to those keys instead of raw triangle indices, so when the model
// is re-exported (retessellated, tweaked), we re-match keys → faces → triangles
// and rebuild the selection automatically. Pure data logic — testable headless.

/** Parse + validate a sidecar against the loaded mesh. Throws on mismatch. */
export function parseFaceSidecar(data, triCount) {
  if (!data || data.version !== 1 || !Array.isArray(data.faces)) {
    throw new Error('sidecar: unsupported format');
  }
  if (Number.isFinite(triCount) && data.triCount !== triCount) {
    throw new Error(`sidecar: triangle count mismatch (${data.triCount} vs mesh ${triCount})`);
  }
  let cursor = 0;
  for (const f of data.faces) {
    const [start, count] = f.range || [];
    if (start !== cursor || !(count > 0)) throw new Error('sidecar: ranges not contiguous');
    if (!f.key || !Array.isArray(f.key.c) || !(f.key.area > 0)) {
      throw new Error('sidecar: face key missing');
    }
    cursor += count;
  }
  if (cursor !== data.triCount) throw new Error('sidecar: ranges do not cover the mesh');
  return data;
}

/** Set of triangle indices covered by the given face indices. */
export function facesToTriangleSet(faceIndices, sidecar) {
  const out = new Set();
  for (const fi of faceIndices) {
    const f = sidecar.faces[fi];
    if (!f) continue;
    const [start, count] = f.range;
    for (let t = start; t < start + count; t++) out.add(t);
  }
  return out;
}

/**
 * Snap a triangle selection to BREP faces: a face is selected when the MAJORITY
 * of its triangles are in the set (the user paints whole faces; bucket-fill edges
 * can leave a few strays either way).
 * @returns {{ keys: Array<{c,n,area,id}>, faceIndices: number[] }}
 */
export function selectionToFaceKeys(selectedTris, sidecar, majority = 0.5) {
  const keys = [];
  const faceIndices = [];
  for (let fi = 0; fi < sidecar.faces.length; fi++) {
    const f = sidecar.faces[fi];
    const [start, count] = f.range;
    let hit = 0;
    for (let t = start; t < start + count; t++) if (selectedTris.has(t)) hit++;
    if (hit / count > majority) {
      keys.push({ c: f.key.c, n: f.key.n, area: f.key.area, id: f.id });
      faceIndices.push(fi);
    }
  }
  return { keys, faceIndices };
}

const _dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const _norm = (v) => Math.hypot(v[0], v[1], v[2]);

/**
 * Re-match stored face keys against a (new) sidecar.
 * Score per candidate = centroid distance (scale-normalised) + area ratio delta
 * + normal disagreement (only when both normals are meaningful — a zero mean
 * normal marks a CLOSED face like a cylinder wall and is skipped).
 * Greedy unique assignment (best scores first); keys above the threshold are
 * reported as orphans instead of being force-matched.
 * @returns {{ matches: Array<{key, faceIndex, score}>, orphans: Array<key> }}
 */
export function matchFaceKeys(storedKeys, sidecar, { threshold = 0.25 } = {}) {
  // Scene scale from face centroids, so the distance term is size-independent.
  let scale = 0;
  for (const f of sidecar.faces) scale = Math.max(scale, _norm(f.key.c));
  if (!(scale > 0)) scale = 1;

  const candidates = [];
  for (let ki = 0; ki < storedKeys.length; ki++) {
    const k = storedKeys[ki];
    for (let fi = 0; fi < sidecar.faces.length; fi++) {
      const fk = sidecar.faces[fi].key;
      const d = _dist(k.c, fk.c) / scale;
      if (d > threshold) continue; // cheap reject
      const aMax = Math.max(k.area, fk.area);
      const a = aMax > 0 ? Math.abs(k.area - fk.area) / aMax : 0;
      let n = 0;
      if (_norm(k.n) > 0.5 && _norm(fk.n) > 0.5) {
        n = 1 - Math.abs(k.n[0] * fk.n[0] + k.n[1] * fk.n[1] + k.n[2] * fk.n[2]);
      }
      const score = d * 2 + a + n * 0.5;
      if (score <= threshold) candidates.push({ ki, fi, score });
    }
  }

  candidates.sort((x, y) => x.score - y.score);
  const keyDone = new Set();
  const faceDone = new Set();
  const matches = [];
  for (const c of candidates) {
    if (keyDone.has(c.ki) || faceDone.has(c.fi)) continue;
    keyDone.add(c.ki);
    faceDone.add(c.fi);
    matches.push({ key: storedKeys[c.ki], faceIndex: c.fi, score: c.score });
  }
  const orphans = storedKeys.filter((_, ki) => !keyDone.has(ki));
  return { matches, orphans };
}
