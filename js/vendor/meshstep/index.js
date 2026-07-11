// SPDX-License-Identifier: AGPL-3.0-only
// meshStep — public API.
import { buildBrep } from "./brep/build.js";
import { tessellate } from "./mesh/tessellate.js";
import { remesh } from "./mesh/remesh.js";
import { orientConsistent } from "./mesh/orient.js";
import { makeSurface } from "./geom/surfaces.js";
import { meshDefects } from "./mesh/diag.js";
import { extractColors } from "./step/styles.js";
import { extractStructure } from "./step/structure.js";
import { collectMeasureGeometry } from "./brep/measure-geometry.js";
/** Move each part's vertices into its assembly world placement(s). Each vertex belongs to one solid
 * (bodies are welded independently), so the first instance transforms in place; a part used N times
 * in the assembly appends N-1 transformed copies of its vertices and triangles (each copy is its own
 * welded component, so watertightness is preserved per instance). Rigid transforms keep winding. */
function applyAssemblyPlacement(mesh, faceOfTri, solidOfTri, xf) {
    const unchanged = { mesh, faceOfTri, solidOfTri };
    if (xf.size === 0)
        return unchanged;
    const P = mesh.positions, I = mesh.indices;
    const nV = P.length / 3;
    const vSolid = new Int32Array(nV).fill(-1);
    for (let t = 0; t < solidOfTri.length; t++)
        for (let e = 0; e < 3; e++)
            vSolid[I[t * 3 + e]] = solidOfTri[t];
    const app = (f, out, o, x, y, z) => {
        out[o] = f.o[0] + f.x[0] * x + f.y[0] * y + f.z[0] * z;
        out[o + 1] = f.o[1] + f.x[1] * x + f.y[1] * y + f.z[1] * z;
        out[o + 2] = f.o[2] + f.x[2] * x + f.y[2] * y + f.z[2] * z;
    };
    // Extra instances first (they read the still-untransformed local coordinates), then instance 0.
    const extraV = [], extraI = [], extraF = [], extraS = [];
    for (const [sid, frames] of xf) {
        for (let k = 1; k < frames.length; k++) {
            const f = frames[k];
            const remap = new Map();
            const tmp = new Float64Array(3);
            for (let v = 0; v < nV; v++) {
                if (vSolid[v] !== sid)
                    continue;
                remap.set(v, nV + (extraV.length / 3));
                app(f, tmp, 0, P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
                extraV.push(tmp[0], tmp[1], tmp[2]);
            }
            for (let t = 0; t < solidOfTri.length; t++) {
                if (solidOfTri[t] !== sid)
                    continue;
                extraI.push(remap.get(I[t * 3]), remap.get(I[t * 3 + 1]), remap.get(I[t * 3 + 2]));
                extraF.push(faceOfTri[t]);
                extraS.push(sid);
            }
        }
    }
    for (let v = 0; v < nV; v++) {
        const f = xf.get(vSolid[v])?.[0];
        if (!f)
            continue;
        app(f, P, v * 3, P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
    }
    if (extraV.length === 0)
        return unchanged;
    const positions = new Float64Array(P.length + extraV.length);
    positions.set(P);
    positions.set(extraV, P.length);
    const indices = new Uint32Array(I.length + extraI.length);
    indices.set(I);
    indices.set(extraI, I.length);
    const fo = new Uint32Array(faceOfTri.length + extraF.length);
    fo.set(faceOfTri);
    fo.set(extraF, faceOfTri.length);
    const so = new Uint32Array(solidOfTri.length + extraS.length);
    so.set(solidOfTri);
    so.set(extraS, solidOfTri.length);
    return { mesh: { positions, indices }, faceOfTri: fo, solidOfTri: so };
}
/** Assemble the consolidated conversion verdict from the tessellation warnings and a final
 * edge-defect audit of the mesh actually returned (post remesh/placement). `ok` is strict: any
 * missing geometry, edge defect, or heuristic repair clears it — the consumer's cue to suggest
 * exporting a mesh directly from CAD (severity "error" / edge defects) or checking the preview
 * (only "warning"-severity repairs). */
function buildDiagnostics(result, mesh, solidOfTri) {
    const { openEdges, nonManifoldEdges } = meshDefects(mesh, solidOfTri, result.openSolids);
    const facesDropped = result.warnings.filter((w) => w.code === "face-dropped").length;
    const facesSkipped = Object.values(result.stats.skipped).reduce((s, n) => s + n, 0);
    const ok = openEdges === 0 && nonManifoldEdges === 0 && facesDropped === 0 && facesSkipped === 0
        && result.warnings.length === 0;
    return { ok, openEdges, nonManifoldEdges, facesDropped, facesSkipped, warnings: result.warnings };
}
export { writeBinarySTL, readSTL, isBinarySTL, indexSoup } from "./io/stl.js";
export { read3MF } from "./io/threemf.js";
export { parseStepHeader } from "./step/header.js";
export { meshDefects } from "./mesh/diag.js";
export { extractColors } from "./step/styles.js";
export { extractStructure } from "./step/structure.js";
export { estimateStepSize, autoTessellation } from "./step/measure.js";
/** Parse a STEP file (ISO-10303-21 text) and tessellate it into a uniform, watertight mesh. */
export function importStep(src, opts = {}) {
    const surfaceDev = opts.surfaceDeviation ?? 0.01;
    const maxEdge = opts.maxEdge ?? 1.0;
    const normalDevRad = (opts.normalDeviation ?? 15) * Math.PI / 180;
    const onProgress = opts.onProgress;
    onProgress?.({ phase: "parse", done: 0, total: 0 });
    const brep = buildBrep(src);
    const colors = extractColors(brep.table, brep.solids);
    const structure = extractStructure(brep.table, brep.solids);
    // Sample boundaries to the surface-deviation tolerance so feature edges (rims, holes) are fine
    // even without remeshing. The robust CDT handles the resulting dense/collinear boundaries.
    // maxEdge is a pure upper CAP on segment length — it must never loosen the chord tolerance
    // (a CAD-style export sets a huge max edge to mean "follow curvature", not "coarsen 20×").
    const tess = {
        chordTol: surfaceDev, targetEdge: maxEdge, normalDev: normalDevRad, trace: opts.trace,
        onProgress: onProgress && ((done, total) => onProgress({ phase: "tessellate", done, total })),
        collectEdgePolylines: opts.measureGeometry,
    };
    const result = tessellate(brep, tess);
    onProgress?.({ phase: "finalize", done: 0, total: 0 });
    // Assembly placements per solid (empty for a single part); applied to the final mesh below.
    // A part with N occurrences carries N frames and is replicated after meshing.
    const solidXf = new Map();
    for (const solid of brep.solids) {
        if (solid.instances)
            solidXf.set(solid.id, solid.instances);
        else if (solid.transform)
            solidXf.set(solid.id, [solid.transform]);
    }
    const measure = opts.measureGeometry && result.edgePolylines
        ? collectMeasureGeometry(brep, result.edgePolylines, solidXf) : undefined;
    delete result.edgePolylines; // consumed above — keep the raw polyline map out of the result
    // AP242 tessellated-geometry bodies have no analytic surfaces, so the curvature-adaptive remesh
    // can't project — return the (already watertight) faceted mesh as imported.
    if (opts.remesh !== true || brep.solids.length === 0) {
        orientConsistent(result.mesh, result.solidOfTri);
        const placed = applyAssemblyPlacement(result.mesh, result.faceOfTri, result.solidOfTri, solidXf);
        return { ...result, ...placed, diagnostics: buildDiagnostics(result, placed.mesh, placed.solidOfTri), units: brep.units.label, colors, structure, measure };
    }
    const surf = new Map();
    const solidOfFace = new Map();
    for (const solid of brep.solids) {
        for (const face of solid.faces) {
            surf.set(face.faceId, makeSurface(brep.table, face.surfaceId, solid.scale ?? brep.scale, brep.units.radPerAngle));
            solidOfFace.set(face.faceId, solid.id);
        }
    }
    const r = remesh(result.mesh, result.faceOfTri, surf, {
        surfaceDev, normalDev: normalDevRad, maxEdge, iterations: opts.remeshIterations,
    });
    const solidOfTri = Uint32Array.from(r.faceOfTri, (f) => solidOfFace.get(f) ?? 0);
    orientConsistent(r.mesh, solidOfTri); // fix any triangles flipped by smoothing
    const placed = applyAssemblyPlacement(r.mesh, r.faceOfTri, solidOfTri, solidXf);
    return { ...result, ...placed, diagnostics: buildDiagnostics(result, placed.mesh, placed.solidOfTri), units: brep.units.label, colors, structure, measure };
}
//# sourceMappingURL=index.js.map