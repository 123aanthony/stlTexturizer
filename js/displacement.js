import * as THREE from 'three';
import { computeUV, getDominantCubicAxis, getCubicBlendWeights, scaleMmToRelative } from './mapping.js';
import { QuantizedPointMap } from './meshIndex.js';
import { computeBeamFrame, triMaskFromExcludeWeight } from './beamAxis.js';
import { getMipPyramid, lodForFootprint, sampleBilinear, sampleFiltered, texPerMm } from './mipPyramid.js';
import { isPieceVariationActive, buildPieceXforms } from './pieceVariation.js';
import { buildDedupAdjacency, spreadSeamWeights } from './seamBlend.js';

/**
 * Apply displacement to every vertex of a non-indexed BufferGeometry.
 *
 * For each vertex:
 *   1. Compute UV with the same math used in the GLSL preview shader (mapping.js).
 *   2. Bilinear-sample the greyscale ImageData at that UV.
 *   3. Move the vertex along its normal by:  (grey − 0.5) × 2 × amplitude
 *      so 50% grey = no displacement, white = outward, black = inward.
 *
 * @param {THREE.BufferGeometry} geometry  – non-indexed (from subdivide())
 * @param {ImageData}            imageData – raw pixel data from Canvas2D
 * @param {number}               imgWidth
 * @param {number}               imgHeight
 * @param {object}               settings  – { mappingMode, scaleU, scaleV, amplitude, offsetU, offsetV }
 * @param {object}               bounds    – { min, max, center, size } (THREE.Vector3)
 * @param {function}             [onProgress]
 * @returns {THREE.BufferGeometry}  new non-indexed geometry with displaced positions
 */
export function applyDisplacement(geometry, imageData, imgWidth, imgHeight, settings, bounds, onProgress) {
  const posAttr = geometry.attributes.position;
  const nrmAttr = geometry.attributes.normal;
  const count   = posAttr.count;
const faceMask = settings.faceMask || null;
  const newPos = new Float32Array(count * 3);
  const newNrm = new Float32Array(count * 3);

  const tmpPos  = new THREE.Vector3();
  const tmpNrm  = new THREE.Vector3();
  const vA      = new THREE.Vector3();
  const vB      = new THREE.Vector3();
  const vC      = new THREE.Vector3();
  const edge1   = new THREE.Vector3();
  const edge2   = new THREE.Vector3();
  const faceNrm = new THREE.Vector3();

  // Texture aspect correction so non-square textures keep their proportions.
  // The shorter axis gets aspect > 1 so it tiles faster, making each tile
  // proportionally shorter in world-space to match the texture's content.
  const tmax = Math.max(imgWidth, imgHeight, 1);
  const aspectU = tmax / Math.max(imgWidth, 1);
  const aspectV = tmax / Math.max(imgHeight, 1);
  const settingsWithAspect = { ...settings, textureAspectU: aspectU, textureAspectV: aspectV };

  // BumpForge multi-slot export support.
  // settings.multiSlots lets Export All Slots compute all textures in ONE displacement pass.
  // A single owner is chosen per unique vertex so all triangle copies of that position
  // land at the exact same displaced point, avoiding cracks/non-manifold boundaries.
  const multiSlots = Array.isArray(settings.multiSlots) && settings.multiSlots.length
    ? settings.multiSlots
    : null;
  const multiSlotCount = multiSlots ? multiSlots.length : 0;

  // Wood Auto (mode 7) projects along the piece's own long axis. The frame is the
  // PCA of the slot's OWN faces (a beam is a selection inside the model — using
  // the whole mesh would give the building's axis). computeUV reads it from
  // settings.beamFrame; all export paths go through here, so no per-call-site wiring.
  const woodAutoFrame = (ss, mask) =>
    ss.mappingMode === 7 && !ss.beamFrame ? computeBeamFrame(posAttr.array, mask || null) : (ss.beamFrame ?? null);

  if (!multiSlots) {
    // Single-slot exports carry the selection as exclude-weights, not as a
    // faceMask — derive the PCA mask from them, else the frame comes from the
    // whole mesh (building axis, not the beam's).
    const ew = geometry.attributes.excludeWeight;
    const pcaMask = faceMask || (ew ? triMaskFromExcludeWeight(ew, posAttr.count) : null);
    const f = woodAutoFrame(settings, pcaMask);
    if (f) settingsWithAspect.beamFrame = f;
  }

  const multiSlotAspect = multiSlots
    ? multiSlots.map(slot => {
        const w = slot.width || 1;
        const h = slot.height || 1;
        const m = Math.max(w, h, 1);
        const ss = slot.settings || settings;
        return {
          aspectU: m / Math.max(w, 1),
          aspectV: m / Math.max(h, 1),
          settingsWithAspect: {
            ...ss,
            textureAspectU: m / Math.max(w, 1),
            textureAspectV: m / Math.max(h, 1),
            beamFrame: woodAutoFrame(ss, slot.faceMask),
          }
        };
      })
    : null;

  // Préfiltre d'antialiasing : actif sauf refus explicite, pour que les projets
  // existants en bénéficient sans être ré-enregistrés. Le décocher reproduit
  // exactement le sampler historique.
  const antialias = settings.textureAntialias !== false;

  // ── Variation par PIÈCE ───────────────────────────────────────────────────
  // Active seulement si un identifiant de pièce PAR TRIANGLE est fourni ET
  // qu'un réglage a bougé. Sinon rien n'est alloué, rien n'est calculé, et la
  // passe 2 n'ajoute pas `pieceXform` aux settings — `computeUV` execute alors
  // la meme ligne qu'avant (cf. js/pieceVariation.js).
  const pieceOfTri = settings.pieceOfTri || null;
  const pieceVar = !!pieceOfTri && isPieceVariationActive(settings);

  // Table des transformations, calculee par la SOURCE UNIQUE que partage aussi
  // l'apercu GPU (js/pieceVariation.js). La recalculer ici la ferait diverger
  // du shader au premier detail — ponderation, arrondi, ordre de parcours — et
  // l'apercu montrerait alors un bois different de celui qu'on exporte.
  const pieceData = pieceVar
    ? buildPieceXforms(posAttr.array, pieceOfTri, settings) : null;
  const pieceIndex = pieceData ? pieceData.index : null;
  const pieceXforms = pieceData ? pieceData.table : null;


  // ── Antialiasing : facteur texels/mm, par slot ────────────────────────────
  // L'empreinte texel d'un sommet vaut arête_mm × (texels/mm). La période monde
  // et les dimensions de la carte sont constantes PAR SLOT : tout ce qui ne
  // dépend pas du sommet est donc calculé ICI une fois, et la boucle par sommet
  // ne garde qu'une division, une multiplication et un log2.
  const texPerMmDefault = antialias ? texPerMm(settingsWithAspect, imgWidth, imgHeight) : 0;
  const pyrDefault      = antialias ? getMipPyramid(imageData) : null;
  const multiSlotFilter = (antialias && multiSlots)
    ? multiSlots.map((slot, i) => ({
        texPerMm: texPerMm(multiSlotAspect[i].settingsWithAspect, slot.width, slot.height),
        pyr:      getMipPyramid(slot.imageData),
      }))
    : null;

  // 10 µm vertex-dedup cells. Must match subdivision.js QUANTISE so the
  // displacement pipeline sees the same vertex-uniqueness that subdivision
  // produced — coarser cells (1e4) collapsed real fillet vertices on small
  // models, creating needle artifacts and non-manifold edges.
  const QUANT = 1e5;

  // ── WHY GAPS HAPPEN ───────────────────────────────────────────────────────
  // The mesh is non-indexed (unrolled): every triangle has its own copy of
  // each vertex.  At a shared edge two triangles have the same position but
  // different face normals.  Displacing each copy along its own face normal
  // moves them to DIFFERENT final positions → crack / gap.
  //
  // THE FIX: every copy of the same position must arrive at the exact same
  // displaced point.  We achieve this by computing a single *smooth* (area-
  // weighted average) normal per unique position and using that both for the
  // texture UV lookup and for the displacement direction.  All copies of the
  // same position then move by the same vector → watertight result.
  //
  // The tradeoff is that displaced normals are smooth at hard edges, but the
  // underlying geometry is still faceted (the subdivision didn't change it),
  // so printed edges remain sharp.

  // ── Vertex dedup pass: position → numeric ID via one-time string-map pass ─
  // idPos{X,Y,Z} are only populated when boundary falloff is enabled, since
  // they're only consumed by the falloff distance field. Pre-sized to `count`
  // (upper bound on uniqueCount); read by ID, so extra tail slots stay unused.
  // Les positions par identifiant servent au retrait de bord ET a la mesure de
  // distance geodesique de l'etalement de couture (js/seamBlend.js).
  const _seamWidthOf = (st) => (st && st.mappingMode === 6 ? Math.max(0, st.seamBlendWidthMm || 0) : 0);
  const _seamWidth = Math.max(
    _seamWidthOf(settings),
    ...(multiSlots ? multiSlots.map((sl) => _seamWidthOf((sl && sl.settings) || settings)) : [0]));
  const needIdPositions = (settings.boundaryFalloff ?? 0) > 0 || _seamWidth > 0;
  // Typed-array point map: avoids V8's Map maximum-size limit on very dense exports.
  const _dedupMap = new QuantizedPointMap(QUANT, Math.min(count, 1 << 22));
  let _nextId = 0;
  const vertexId = new Uint32Array(count);
  const idPosX = needIdPositions ? new Float64Array(count) : null;
  const idPosY = needIdPositions ? new Float64Array(count) : null;
  const idPosZ = needIdPositions ? new Float64Array(count) : null;
  for (let i = 0; i < count; i++) {
    const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
    const id = _dedupMap.getOrSet(x, y, z, _nextId);
    if (_dedupMap.inserted) {
      _nextId++;
      if (needIdPositions) {
        idPosX[id] = x; idPosY[id] = y; idPosZ[id] = z;
      }
    }
    vertexId[i] = id;
  }
  const uniqueCount = _nextId;

  // ── Pass 1: accumulate area-weighted smooth normals per unique position ───
  // Flat arrays indexed by vertex dedup ID (replaces Map<string, ...>)
  const smoothNrmX = new Float64Array(uniqueCount);
  const smoothNrmY = new Float64Array(uniqueCount);
  const smoothNrmZ = new Float64Array(uniqueCount);

  // zoneArea: per-axis face area for cubic mapping (replaces zoneAreaMap)
  const zoneAreaX = new Float64Array(uniqueCount);
  const zoneAreaY = new Float64Array(uniqueCount);
  const zoneAreaZ = new Float64Array(uniqueCount);

  // maskedFrac: [maskedArea, totalArea] per unique vertex (replaces maskedFracMap)
  const maskedFracMasked = new Float64Array(uniqueCount);
  const maskedFracTotal  = new Float64Array(uniqueCount);

  // Optional per-vertex exclusion weights threaded through by subdivision.js.
  // A face's user-exclusion flag = average of its 3 vertex weights > 0.99.
  const ewAttr = geometry.attributes.excludeWeight || null;
  // Per-face user-exclusion flag: stored separately from maskedFrac so that
  // user-excluded faces do NOT bleed reduced displacement into adjacent faces
  // via shared vertices (maskedFrac is only for angle-based blending).
  const userExcludedFaces = ewAttr ? new Uint8Array(count / 3) : null;
  // Positions that belong to at least one user-excluded face (replaces excludedPosSet).
  const excludedPos = ewAttr ? new Uint8Array(uniqueCount) : null;

  // Displacement cache: one sample per unique vertex (replaces dispCache Map)
  const dispCacheVal = new Float64Array(uniqueCount);
  const dispCacheSet = new Uint8Array(uniqueCount);

  // ── Antialiasing : intervalle d'échantillonnage local ─────────────────────
  // Longueur d'arête RMS autour de chaque sommet unique, pondérée par l'aire.
  // C'est l'INTERVALLE auquel la texture est échantillonnée à cet endroit, donc
  // exactement ce qui décide du niveau de mip. Mesurée par sommet et non prise
  // sur `refineLength` : la subdivision rend des arêtes inégales, et le mélange
  // triplanaire/cubique fait varier l'empreinte sur un même export.
  // Normalisée plus bas par `maskedFracTotal`, qui est déjà la somme des aires
  // incidentes — pas de second compteur à porter.
  const edgeLenAcc = antialias ? new Float32Array(uniqueCount) : null;

  // Proprietaire d'un sommet unique = la piece du plus GRAND triangle incident.
  // Un seul proprietaire par position => toutes les copies d'un sommet partage
  // recoivent la MEME UV, donc le meme deplacement : aucune fissure possible,
  // et sans avoir a APLATIR la jonction comme le fait la frontiere multi-slot
  // (la, deux slots portent deux textures differentes ; ici c'est la meme, seul
  // le decalage change, donc la surface reste continue).
  // ⚠️ declare ICI et non plus haut : `uniqueCount` n'existe qu'apres la passe
  // de soudure des sommets — un `const` reste en zone morte jusqu'a sa ligne.
  const pieceOwner = pieceVar ? new Int32Array(uniqueCount).fill(-1) : null;
  const pieceBest  = pieceVar ? new Float64Array(uniqueCount) : null;

  for (let t = 0; t < count; t += 3) {
    vA.fromBufferAttribute(posAttr, t);
    vB.fromBufferAttribute(posAttr, t + 1);
    vC.fromBufferAttribute(posAttr, t + 2);
    edge1.subVectors(vB, vA);
    edge2.subVectors(vC, vA);
    faceNrm.crossVectors(edge1, edge2); // length = 2× triangle area → natural area weighting

    // Determine if this face is masked (used to build the per-vertex blend weight).
    // Combines angle-based masking with optional user-painted exclusion.
    const faceArea   = faceNrm.length();                               // ∝ 2× triangle area
    // RMS des 3 arêtes. Une seule racine par triangle (les carrés suffisent au
    // reste), et légèrement conservatrice vs la moyenne — ce qui va dans le bon
    // sens pour une largeur de filtre.
    let rmsEdge = 0;
    if (edgeLenAcc) {
      const dx = edge2.x - edge1.x, dy = edge2.y - edge1.y, dz = edge2.z - edge1.z;
      rmsEdge = Math.sqrt((edge1.lengthSq() + edge2.lengthSq() + dx*dx + dy*dy + dz*dz) / 3);
    }
    const faceNzNorm = faceArea > 1e-12 ? faceNrm.z / faceArea : 0;  // unit-normal Z component
    const faceAngle  = Math.acos(Math.abs(faceNzNorm)) * (180 / Math.PI);
    const angleMasked = faceNzNorm < 0
      ? (settings.bottomAngleLimit > 0 && faceAngle <= settings.bottomAngleLimit)
      : (settings.topAngleLimit    > 0 && faceAngle <= settings.topAngleLimit);
    // Threshold >0.99 (not 0.5) prevents shared-vertex MAX-propagation from
    // accidentally marking adjacent faces as excluded on closed meshes (e.g. a
    // cube): adjacent faces have 2/3 vertices at weight 1.0 → avg ≈ 0.67 which
    // would wrongly trigger the old 0.5 threshold.
    const userExcluded = ewAttr
      ? (ewAttr.getX(t) + ewAttr.getX(t + 1) + ewAttr.getX(t + 2)) / 3 > 0.99
      : false;
    // maskedFracMap is ONLY used for angle-based blending at surface boundaries.
    // User exclusion is tracked per-face in userExcludedFaces and applied
    // directly in Pass 3, so excluded faces don't reduce displacement on their
    // neighbours through shared boundary vertices.
    const faceMasked = angleMasked;
    if (userExcluded && userExcludedFaces) userExcludedFaces[t / 3] = 1;

    // For cubic mapping: distribute this face's area across projection zones
    // proportionally to its blend weights.  When blend=0, getCubicBlendWeights
    // returns a one-hot vector (same as the old argmax), preserving sharp seams.
    // When blend>0, faces near a zone boundary contribute partial area to
    // adjacent zones, creating a smooth multi-vertex-wide gradient that matches
    // the preview shader.  The old single-zone approach only blended at the
    // one-vertex-wide boundary, leaving an abrupt seam in the export.
    let czX = 0, czY = 0, czZ = 0;
    if (settings.mappingMode === 6 && faceArea > 1e-12) {
      const cubicBlend = settings.mappingBlend ?? 0;
      const cubicBandWidth = settings.seamBandWidth ?? 0.35;
      const unitFaceNrm = { x: faceNrm.x / faceArea, y: faceNrm.y / faceArea, z: faceNrm.z / faceArea };
      const w = getCubicBlendWeights(unitFaceNrm, cubicBlend, cubicBandWidth);
      czX = w.x * faceArea;
      czY = w.y * faceArea;
      czZ = w.z * faceArea;
    }

    for (let v = 0; v < 3; v++) {
      const vid = vertexId[t + v];
      if (userExcluded && excludedPos) excludedPos[vid] = 1;
      // Use the buffer normal (from subdivision) weighted by face area.
      // The subdivision pipeline splits indexed vertices at sharp dihedral
      // edges (>30°), so the interpolated buffer normals are smooth across
      // soft edges (cylinder, sphere) but sharp across hard edges (cube).
      // This eliminates visible faceting steps on round surfaces while still
      // preserving hard edges.
      tmpNrm.fromBufferAttribute(nrmAttr, t + v);
      smoothNrmX[vid] += tmpNrm.x * faceArea;
      smoothNrmY[vid] += tmpNrm.y * faceArea;
      smoothNrmZ[vid] += tmpNrm.z * faceArea;
      if (czX > 1e-12 || czY > 1e-12 || czZ > 1e-12) {
        zoneAreaX[vid] += czX;
        zoneAreaY[vid] += czY;
        zoneAreaZ[vid] += czZ;
      }
      if (faceMasked) maskedFracMasked[vid] += faceArea;
      maskedFracTotal[vid] += faceArea;
      if (edgeLenAcc) edgeLenAcc[vid] += rmsEdge * faceArea;
      if (pieceVar) {
        const pid = pieceIndex[t / 3];
        // Départage DÉTERMINISTE à aire égale (id le plus petit) : sans lui,
        // deux triangles de meme aire feraient dependre le resultat de l'ordre
        // de parcours.
        if (faceArea > pieceBest[vid]
            || (faceArea === pieceBest[vid] && (pieceOwner[vid] < 0 || pid < pieceOwner[vid]))) {
          pieceBest[vid] = faceArea;
          pieceOwner[vid] = pid;
        }
      }
    }
  }

  // Normalise each accumulated normal — also remember the pre-normalisation
  // magnitude relative to the total face area at that position. A ratio near
  // 1 means all neighbouring face normals point the same way (the smooth
  // normal is a reliable surface direction); near 0 means opposing normals
  // cancelled out (knife-edge / thin plate). The cubic sampler uses the ratio
  // to decide whether the smooth normal can drive blend weights or whether
  // the per-face zoneArea fallback is needed.
  const smoothNrmReliability = new Float64Array(uniqueCount);
  for (let id = 0; id < uniqueCount; id++) {
    const len = Math.sqrt(smoothNrmX[id]*smoothNrmX[id] + smoothNrmY[id]*smoothNrmY[id] + smoothNrmZ[id]*smoothNrmZ[id]);
    const tA  = maskedFracTotal[id];
    smoothNrmReliability[id] = (len > 0 && tA > 0) ? len / tA : 0;
    const inv = len > 0 ? 1 / len : 1;
    smoothNrmX[id] *= inv; smoothNrmY[id] *= inv; smoothNrmZ[id] *= inv;
  }

  // ── Pass 1.5: Laplacian-smoothed BLEND normal ─────────────────────────────
  // The displacement direction (Pass 3) must remain the accurate per-vertex
  // smooth normal — otherwise watertight copies of the same position move
  // differently and you get cracks. But the normal used to derive
  // *projection-direction blend weights* only needs to vary slowly across
  // the surface. On organic / sculpted meshes the smooth normal still has
  // high-frequency jitter (a few degrees vertex-to-vertex). Inside the
  // blend band (where ∂w/∂n is largest) that jitter multiplies the
  // difference between two unrelated heightmap samples (hA - hB), producing
  // visible seam noise even when the underlying texture is not at fault.
  //
  // Smoothing the blend normal kills this amplification at the source. On a
  // sphere the smoothing is a no-op (already smooth); on a noisy surface it
  // damps the jitter that drives ∂w. Direction info is preserved because we
  // re-normalise after each iteration.
  const blendNrmIters = Math.max(0, Math.floor(settings.blendNormalSmoothing ?? 0));
  let blendNrmX = smoothNrmX, blendNrmY = smoothNrmY, blendNrmZ = smoothNrmZ;
  if (blendNrmIters > 0) {
    // Build dedup-graph adjacency in CSR form: each triangle contributes
    // 3 directed edges; we build a multigraph (duplicates keep their natural
    // weight from how often two positions share an edge — i.e., shared
    // surfaces accumulate higher coupling, which is what we want).
    // For each unique-vertex id, neighbors[csrStart[id]..csrStart[id+1])
    // is the contiguous slice of neighbour ids.
    const degree = new Uint32Array(uniqueCount);
    for (let t = 0; t < count; t += 3) {
      const a = vertexId[t], b = vertexId[t + 1], c = vertexId[t + 2];
      if (a !== b) { degree[a]++; degree[b]++; }
      if (b !== c) { degree[b]++; degree[c]++; }
      if (c !== a) { degree[c]++; degree[a]++; }
    }
    const csrStart = new Uint32Array(uniqueCount + 1);
    for (let id = 0; id < uniqueCount; id++) csrStart[id + 1] = csrStart[id] + degree[id];
    const totalEdges = csrStart[uniqueCount];
    const neighbors = new Uint32Array(totalEdges);
    const cursor = new Uint32Array(uniqueCount);
    for (let t = 0; t < count; t += 3) {
      const a = vertexId[t], b = vertexId[t + 1], c = vertexId[t + 2];
      if (a !== b) { neighbors[csrStart[a] + cursor[a]++] = b; neighbors[csrStart[b] + cursor[b]++] = a; }
      if (b !== c) { neighbors[csrStart[b] + cursor[b]++] = c; neighbors[csrStart[c] + cursor[c]++] = b; }
      if (c !== a) { neighbors[csrStart[c] + cursor[c]++] = a; neighbors[csrStart[a] + cursor[a]++] = c; }
    }

    // Laplacian smoothing on a writable copy. Read from current, write to
    // next, swap. Each iteration: average over neighbours, re-normalise.
    let curX = new Float64Array(smoothNrmX);
    let curY = new Float64Array(smoothNrmY);
    let curZ = new Float64Array(smoothNrmZ);
    let nxtX = new Float64Array(uniqueCount);
    let nxtY = new Float64Array(uniqueCount);
    let nxtZ = new Float64Array(uniqueCount);

    for (let iter = 0; iter < blendNrmIters; iter++) {
      for (let id = 0; id < uniqueCount; id++) {
        const s = csrStart[id], e = csrStart[id + 1];
        if (e === s) {
          nxtX[id] = curX[id]; nxtY[id] = curY[id]; nxtZ[id] = curZ[id];
          continue;
        }
        let sx = 0, sy = 0, sz = 0;
        for (let k = s; k < e; k++) {
          const nb = neighbors[k];
          sx += curX[nb]; sy += curY[nb]; sz += curZ[nb];
        }
        const inv = 1 / (e - s);
        sx *= inv; sy *= inv; sz *= inv;
        const len = Math.sqrt(sx*sx + sy*sy + sz*sz);
        if (len > 1e-12) {
          const r = 1 / len;
          nxtX[id] = sx * r; nxtY[id] = sy * r; nxtZ[id] = sz * r;
        } else {
          // Neighbour normals cancelled (knife-edge) — keep current.
          nxtX[id] = curX[id]; nxtY[id] = curY[id]; nxtZ[id] = curZ[id];
        }
      }
      const tx = curX, ty = curY, tz = curZ;
      curX = nxtX; curY = nxtY; curZ = nxtZ;
      nxtX = tx;   nxtY = ty;   nxtZ = tz;
    }
    blendNrmX = curX; blendNrmY = curY; blendNrmZ = curZ;
  }

  // ── Boundary falloff distance field ──────────────────────────────────────────
  // When boundaryFalloff > 0, identify boundary positions (vertices adjacent to
  // both masked and unmasked faces, or on the user-exclusion seam) and compute
  // the Euclidean distance from every fully-textured vertex to its nearest
  // boundary position.  The result is falloffArr: Float64Array[uniqueCount]
  // where 0 means "at the boundary" and 1 means "at or beyond the falloff distance".
  const boundaryFalloff = settings.boundaryFalloff ?? 0;
  let falloffArr = null;

  if (boundaryFalloff > 0) {
    // Collect boundary positions in a single pass, using upper-bound-sized
    // Float64Arrays and subarray() views to avoid double-iteration over uniqueCount.
    const bpXFull = new Float64Array(uniqueCount);
    const bpYFull = new Float64Array(uniqueCount);
    const bpZFull = new Float64Array(uniqueCount);
    let bpCount = 0;
    let gMinX = Infinity, gMinY = Infinity, gMinZ = Infinity;
    let gMaxX = -Infinity, gMaxY = -Infinity, gMaxZ = -Infinity;
    for (let id = 0; id < uniqueCount; id++) {
      const mfTotal = maskedFracTotal[id];
      const maskedFrac = mfTotal > 0 ? maskedFracMasked[id] / mfTotal : 0;
      const isOnExclBoundary = excludedPos && excludedPos[id] === 1;
      if (isOnExclBoundary || (maskedFrac > 0 && maskedFrac < 1)) {
        const x = idPosX[id], y = idPosY[id], z = idPosZ[id];
        bpXFull[bpCount] = x; bpYFull[bpCount] = y; bpZFull[bpCount] = z;
        if (x < gMinX) gMinX = x; if (x > gMaxX) gMaxX = x;
        if (y < gMinY) gMinY = y; if (y > gMaxY) gMaxY = y;
        if (z < gMinZ) gMinZ = z; if (z > gMaxZ) gMaxZ = z;
        bpCount++;
      }
    }

    if (bpCount > 0) {
      const bpX = bpXFull.subarray(0, bpCount);
      const bpY = bpYFull.subarray(0, bpCount);
      const bpZ = bpZFull.subarray(0, bpCount);

      const gPad = boundaryFalloff + 1e-3;
      gMinX -= gPad; gMinY -= gPad; gMinZ -= gPad;
      gMaxX += gPad; gMaxY += gPad; gMaxZ += gPad;

      const gRes = Math.max(4, Math.min(128, Math.ceil(Math.cbrt(bpCount) * 2)));
      const gDx = (gMaxX - gMinX) / gRes || 1;
      const gDy = (gMaxY - gMinY) / gRes || 1;
      const gDz = (gMaxZ - gMinZ) / gRes || 1;
      const invDx = 1 / gDx, invDy = 1 / gDy, invDz = 1 / gDz;
      const gridSize = gRes * gRes * gRes;
      const gResMax = gRes - 1;

      // CSR-style spatial grid: cellStart/cellIdx give each cell a contiguous
      // slice of boundary indices. Replaces per-cell JS arrays with flat typed
      // arrays — no per-cell allocations, tight inner loop, better prefetching.
      const cellCount = new Uint32Array(gridSize);
      const bpCell = new Uint32Array(bpCount);
      for (let i = 0; i < bpCount; i++) {
        let ix = (bpX[i] - gMinX) * invDx | 0; if (ix < 0) ix = 0; else if (ix > gResMax) ix = gResMax;
        let iy = (bpY[i] - gMinY) * invDy | 0; if (iy < 0) iy = 0; else if (iy > gResMax) iy = gResMax;
        let iz = (bpZ[i] - gMinZ) * invDz | 0; if (iz < 0) iz = 0; else if (iz > gResMax) iz = gResMax;
        const ck = (ix * gRes + iy) * gRes + iz;
        bpCell[i] = ck;
        cellCount[ck]++;
      }
      const cellStart = new Uint32Array(gridSize + 1);
      for (let c = 0; c < gridSize; c++) cellStart[c + 1] = cellStart[c] + cellCount[c];
      const cursor = new Uint32Array(gridSize);
      const cellIdx = new Uint32Array(bpCount);
      for (let i = 0; i < bpCount; i++) {
        const ck = bpCell[i];
        cellIdx[cellStart[ck] + cursor[ck]++] = i;
      }

      // How many grid cells to search in each direction to cover boundaryFalloff distance
      const searchX = Math.ceil(boundaryFalloff * invDx);
      const searchY = Math.ceil(boundaryFalloff * invDy);
      const searchZ = Math.ceil(boundaryFalloff * invDz);
      const maxDist2 = boundaryFalloff * boundaryFalloff;
      const invFalloff = 1 / boundaryFalloff;
      // Courbe de transition de la rampe 0→1 — miroir d'applyFalloffCurve
      // (main.js) et du fragment shader (previewMaterial.js).
      const falloffCurve = settings.boundaryFalloffCurve ?? 'linear';

      falloffArr = new Float64Array(uniqueCount);
      falloffArr.fill(1); // default: full displacement
      for (let id = 0; id < uniqueCount; id++) {
        const mfTotal = maskedFracTotal[id];
        const maskedFrac = mfTotal > 0 ? maskedFracMasked[id] / mfTotal : 0;
        const isOnExclBoundary = excludedPos && excludedPos[id] === 1;
        // Only compute falloff for fully-textured, non-boundary positions
        if (maskedFrac > 0 || isOnExclBoundary) continue;

        const px = idPosX[id], py = idPosY[id], pz = idPosZ[id];
        let cix = (px - gMinX) * invDx | 0; if (cix < 0) cix = 0; else if (cix > gResMax) cix = gResMax;
        let ciy = (py - gMinY) * invDy | 0; if (ciy < 0) ciy = 0; else if (ciy > gResMax) ciy = gResMax;
        let ciz = (pz - gMinZ) * invDz | 0; if (ciz < 0) ciz = 0; else if (ciz > gResMax) ciz = gResMax;

        const nixLo = Math.max(0, cix - searchX), nixHi = Math.min(gResMax, cix + searchX);
        const niyLo = Math.max(0, ciy - searchY), niyHi = Math.min(gResMax, ciy + searchY);
        const nizLo = Math.max(0, ciz - searchZ), nizHi = Math.min(gResMax, ciz + searchZ);

        let minDist2 = maxDist2;
        for (let nix = nixLo; nix <= nixHi; nix++) {
          const baseX = nix * gRes;
          for (let niy = niyLo; niy <= niyHi; niy++) {
            const baseXY = (baseX + niy) * gRes;
            for (let niz = nizLo; niz <= nizHi; niz++) {
              const ck = baseXY + niz;
              const end = cellStart[ck + 1];
              for (let k = cellStart[ck]; k < end; k++) {
                const idx = cellIdx[k];
                const dx = px - bpX[idx], dy = py - bpY[idx], dz = pz - bpZ[idx];
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 < minDist2) minDist2 = d2;
              }
            }
          }
        }
        if (minDist2 < maxDist2) {
          const t = Math.sqrt(minDist2) * invFalloff;
          falloffArr[id] = falloffCurve === 'scurve' ? t * t * (3 - 2 * t)
                         : falloffCurve === 'ease'   ? t * t
                         : t;
        }
      }
    }
  }


  // ── Multi-slot ownership ──────────────────────────────────────────────────
  let multiOwner = null;
  if (multiSlots) {
    const scores = new Float64Array(uniqueCount * multiSlotCount);

    for (let t = 0; t < count; t += 3) {
      const triIdx = t / 3;
      let owner = -1;

      for (let s = 0; s < multiSlotCount; s++) {
        const mask = multiSlots[s].faceMask;
        if (mask && mask[triIdx]) {
          owner = s;
          break;
        }
      }

      if (owner < 0) continue;

      vA.fromBufferAttribute(posAttr, t);
      vB.fromBufferAttribute(posAttr, t + 1);
      vC.fromBufferAttribute(posAttr, t + 2);
      edge1.subVectors(vB, vA);
      edge2.subVectors(vC, vA);
      faceNrm.crossVectors(edge1, edge2);
      const areaWeight = Math.max(faceNrm.length(), 1e-12);

      scores[vertexId[t] * multiSlotCount + owner] += areaWeight;
      scores[vertexId[t + 1] * multiSlotCount + owner] += areaWeight;
      scores[vertexId[t + 2] * multiSlotCount + owner] += areaWeight;
    }

    multiOwner = new Int16Array(uniqueCount);
    multiOwner.fill(-1);

    // Boundary vertices touch triangles from multiple slots.
    // Pinning them prevents cross-slot height bleeding / comb artifacts.
    var multiBoundary = new Uint8Array(uniqueCount);

    for (let vid = 0; vid < uniqueCount; vid++) {
      let bestSlot = -1;
      let bestScore = 0;

      let positiveSlots = 0;

      for (let s = 0; s < multiSlotCount; s++) {
        const score = scores[vid * multiSlotCount + s];
        if (score > 0) positiveSlots++;
        if (score > bestScore) {
          bestScore = score;
          bestSlot = s;
        }
      }

      multiOwner[vid] = bestSlot;
      if (positiveSlots > 1) multiBoundary[vid] = 1;
    }
  }

  // Enveloppes MUTABLES des settings : on ne peut pas construire un objet par
  // sommet (des millions d'allocations), et on ne doit pas polluer les objets
  // partages. Une copie par slot, dont on ne change que `pieceXform`.
  const uvWrap = pieceVar ? { ...settingsWithAspect } : null;
  const uvWrapSlots = (pieceVar && multiSlots)
    ? multiSlotAspect.map(a => ({ ...a.settingsWithAspect })) : null;

  // ── Etalement des coutures sur une largeur en MILLIMETRES ────────────────
  // Le melange de couture est pilote par la NORMALE, or a une arete vive celle-ci
  // saute de 90 degres sans valeur intermediaire : mesure, il vaut 0.0 % sur un
  // mur plat meme a reglage maximum. Le lissage laplacien existant contourne
  // cela, mais sa portee croit en racine(k) ET proportionnellement au pas du
  // maillage : a 0.15 mm de resolution les 32 iterations par defaut ne couvrent
  // que ~0.65 mm, et affiner l'export RESSERRE encore la couture.
  //
  // On mesure donc la distance reelle a la couture et l'on etale les poids sur
  // la largeur demandee (js/seamBlend.js porte les mesures qui motivent ce
  // choix). Largeur nulle => on n'entre pas ici du tout : l'ancien comportement
  // est conserve a l'octet, ce que les goldens verifient.
  let seamWX = null, seamWY = null, seamWZ = null;
  if (_seamWidth > 0 && idPosX) {
    seamWX = new Float32Array(uniqueCount);
    seamWY = new Float32Array(uniqueCount);
    seamWZ = new Float32Array(uniqueCount);
    const vus = new Uint8Array(uniqueCount);
    for (let i = 0; i < count; i++) {
      const vid = vertexId[i];
      if (vus[vid]) continue;
      vus[vid] = 1;
      const os = multiOwner ? multiOwner[vid] : -1;
      const st = (multiSlots && os >= 0 && multiSlots[os] && multiSlots[os].settings)
        ? multiSlots[os].settings : settings;
      if (st.mappingMode !== 6) continue;
      // MEME resolution que la boucle d'echantillonnage : normale lissee si elle
      // est fiable, repli sur les aires de zone sinon. Deux calculs du meme poids
      // qui divergeraient produiraient une couture differente de l'apercu.
      if (smoothNrmReliability[vid] > 0.5) {
        const w = getCubicBlendWeights(
          { x: blendNrmX[vid], y: blendNrmY[vid], z: blendNrmZ[vid] },
          st.mappingBlend ?? 0, st.seamBandWidth ?? 0.35);
        seamWX[vid] = w.x; seamWY[vid] = w.y; seamWZ[vid] = w.z;
      } else {
        const tot = zoneAreaX[vid] + zoneAreaY[vid] + zoneAreaZ[vid];
        if (tot > 0) {
          seamWX[vid] = zoneAreaX[vid] / tot;
          seamWY[vid] = zoneAreaY[vid] / tot;
          seamWZ[vid] = zoneAreaZ[vid] / tot;
        }
      }
    }
    const { csrStart, neighbors } = buildDedupAdjacency(vertexId, count, uniqueCount);
    // ⚠️ Une SEULE largeur pilote le parcours : la plus grande demandee. Les
    // POIDS restent calcules avec les reglages propres a chaque slot ; seule
    // l'etendue de la bande est mise en commun. En pratique les slots partagent
    // ce reglage, et le cas contraire elargit la bande des plus modestes plutot
    // que de tronquer celle des autres — le sens le moins surprenant.
    const stat = spreadSeamWeights({
      wX: seamWX, wY: seamWY, wZ: seamWZ, uniqueCount, csrStart, neighbors,
      posX: idPosX, posY: idPosY, posZ: idPosZ, widthMm: _seamWidth,
    });
    if (stat.seeds === 0) {
      // Aucune couture reperee : il n'y a rien a etaler, et surtout rien a
      // substituer aux poids d'origine. On relache les tableaux pour reprendre
      // le chemin historique tel quel.
      seamWX = seamWY = seamWZ = null;
    }
  }

  // ── Pass 2: sample displacement texture once per unique position ──────────

  for (let i = 0; i < count; i++) {
    const vid = vertexId[i];
    if (dispCacheSet[vid]) continue;
    dispCacheSet[vid] = 1;

    tmpPos.fromBufferAttribute(posAttr, i);

    const ownerSlot = multiOwner ? multiOwner[vid] : -1;
    const sampleSlot = multiSlots && ownerSlot >= 0 ? multiSlots[ownerSlot] : null;
    const sampleSettings = sampleSlot ? (sampleSlot.settings || settings) : settings;
    const sampleSettingsWithAspect = sampleSlot
      ? multiSlotAspect[ownerSlot].settingsWithAspect
      : settingsWithAspect;
    const sampleImageData = sampleSlot ? sampleSlot.imageData : imageData;
    const sampleWidth = sampleSlot ? sampleSlot.width : imgWidth;
    const sampleHeight = sampleSlot ? sampleSlot.height : imgHeight;
    const sampleAspectU = sampleSlot ? multiSlotAspect[ownerSlot].aspectU : aspectU;
    const sampleAspectV = sampleSlot ? multiSlotAspect[ownerSlot].aspectV : aspectV;

    if (multiSlots && ownerSlot < 0) {
      dispCacheVal[vid] = 0;
      continue;
    }

    // Transformation de la pièce à laquelle appartient CE sommet.
    let uvSettings = sampleSettingsWithAspect;
    if (pieceVar) {
      const pid = pieceOwner[vid];
      const xf = pid >= 0 ? pieceXforms[pid] : null;
      uvSettings = (sampleSlot ? uvWrapSlots[ownerSlot] : uvWrap);
      uvSettings.pieceXform = xf;
    }

    // Niveau de mip de CE sommet = log2 de son empreinte texel. lod <= 0 (la
    // maille échantillonne au texel ou plus fin : rien à corriger) renvoie
    // `sampleFiltered` sur le sampler d'origine, aux octets d'origine.
    let lod = 0;
    let pyr = null;
    if (antialias) {
      const areaTot = maskedFracTotal[vid];
      if (areaTot > 0) {
        const meanEdge = edgeLenAcc[vid] / areaTot;
        const f = sampleSlot ? multiSlotFilter[ownerSlot] : null;
        lod = lodForFootprint(meanEdge * (f ? f.texPerMm : texPerMmDefault));
        if (lod > 0) pyr = f ? f.pyr : pyrDefault;
      }
    }

    if (sampleSettings.mappingMode === 6 /* MODE_CUBIC */) {
      const md = Math.max(bounds.size.x, bounds.size.y, bounds.size.z, 1e-6);
      // scaleU/scaleV sont des mm absolus — le chemin rapide cubique fait sa
      // propre division par l'échelle (_cubicUV), donc conversion ICI aussi
      // (miroir de computeUV).
      const relScale = scaleMmToRelative(6, sampleSettings, bounds);
      // ⚠️ Ce chemin COURT-CIRCUITE computeUV (`continue` plus bas) : sans y
      // reporter la variation, le mode cubique l'ignorerait EN SILENCE a
      // l'export tout en marchant a l'apercu.
      const cpx = pieceVar ? (pieceOwner[vid] >= 0 ? pieceXforms[pieceOwner[vid]] : null) : null;
      const rotRad = ((sampleSettings.rotation ?? 0) + (cpx?.rotDeg ?? 0)) * Math.PI / 180;
      const cubicBlend = sampleSettings.mappingBlend ?? 0;
      const cubicBandWidth = sampleSettings.seamBandWidth ?? 0.35;

      let wX = 0, wY = 0, wZ = 0;
      if (seamWX) {
        // Poids deja resolus ET etales autour des coutures (voir plus haut).
        wX = seamWX[vid]; wY = seamWY[vid]; wZ = seamWZ[vid];
      } else if (smoothNrmReliability[vid] > 0.5) {
        const sn = { x: blendNrmX[vid], y: blendNrmY[vid], z: blendNrmZ[vid] };
        const w = getCubicBlendWeights(sn, cubicBlend, cubicBandWidth);
        wX = w.x; wY = w.y; wZ = w.z;
      } else {
        const zaX = zoneAreaX[vid], zaY = zoneAreaY[vid], zaZ = zoneAreaZ[vid];
        const total = zaX + zaY + zaZ;
        if (total > 0) { wX = zaX/total; wY = zaY/total; wZ = zaZ/total; }
      }

      if (wX + wY + wZ > 0) {
        let grey = 0;
        if (wX > 0) {
          let rawU = (tmpPos.y-bounds.min.y)/md;
          if (smoothNrmX[vid] < 0) rawU = -rawU;
          const uv = _cubicUV(rawU, (tmpPos.z-bounds.min.z)/md, sampleSettings, rotRad, sampleAspectU, sampleAspectV, relScale, cpx);
          grey += sampleFiltered(pyr, sampleImageData.data, sampleWidth, sampleHeight, uv.u, uv.v, lod) * wX;
        }
        if (wY > 0) {
          let rawU = (tmpPos.x-bounds.min.x)/md;
          if (smoothNrmY[vid] > 0) rawU = -rawU;
          const uv = _cubicUV(rawU, (tmpPos.z-bounds.min.z)/md, sampleSettings, rotRad, sampleAspectU, sampleAspectV, relScale, cpx);
          grey += sampleFiltered(pyr, sampleImageData.data, sampleWidth, sampleHeight, uv.u, uv.v, lod) * wY;
        }
        if (wZ > 0) {
          let rawU = (tmpPos.x-bounds.min.x)/md;
          if (smoothNrmZ[vid] < 0) rawU = -rawU;
          const uv = _cubicUV(rawU, (tmpPos.y-bounds.min.y)/md, sampleSettings, rotRad, sampleAspectU, sampleAspectV, relScale, cpx);
          grey += sampleFiltered(pyr, sampleImageData.data, sampleWidth, sampleHeight, uv.u, uv.v, lod) * wZ;
        }
        dispCacheVal[vid] = grey;
        continue;
      }
    }

    tmpNrm.set(blendNrmX[vid], blendNrmY[vid], blendNrmZ[vid]);

    const uvResult = computeUV(tmpPos, tmpNrm, sampleSettings.mappingMode, uvSettings, bounds);
    let grey;
    if (uvResult.triplanar) {
      grey = 0;
      for (const s of uvResult.samples) {
        grey += sampleFiltered(pyr, sampleImageData.data, sampleWidth, sampleHeight, s.u, s.v, lod) * s.w;
      }
    } else {
      grey = sampleFiltered(pyr, sampleImageData.data, sampleWidth, sampleHeight, uvResult.u, uvResult.v, lod);
    }
    dispCacheVal[vid] = grey;
  }

  // ── Pass 3: displace every vertex copy by the same vector ─────────────────
  // Using the smooth normal for the displacement direction ensures all copies
  // of the same position land at exactly the same 3-D point.

  const REPORT_EVERY = 5000;

  for (let i = 0; i < count; i++) {
    const triIdx = Math.floor(i / 3);
    tmpPos.fromBufferAttribute(posAttr, i);
    tmpNrm.fromBufferAttribute(nrmAttr, i);

    const vid  = vertexId[i];
    const ownerSlot = multiOwner ? multiOwner[vid] : -1;
    const vertexSettings = multiSlots && ownerSlot >= 0
      ? (multiSlots[ownerSlot].settings || settings)
      : settings;
    const maskedOut = multiSlots
      ? ownerSlot < 0
      : (faceMask && faceMask[triIdx] === 0);
    const grey = dispCacheVal[vid];

    // User-excluded faces get zero displacement; only angle-based masking uses
    // the smooth per-vertex blend so neighbours are never unintentionally dimmed.
    const isFaceExcluded = userExcludedFaces && userExcludedFaces[Math.floor(i / 3)];
    // Pin included-face vertices that share a position with an excluded face.
    // This seals the open crack at the mask boundary so the mesh stays watertight
    // and the decimator cannot collapse the excluded patch to zero faces.
    const isSealedBoundary = !isFaceExcluded && excludedPos && excludedPos[vid] === 1;
    const mfTotal = maskedFracTotal[vid];
    const maskedFrac = mfTotal > 0 ? maskedFracMasked[vid] / mfTotal : 0;
    const centeredGrey = vertexSettings.symmetricDisplacement ? (grey - 0.5) : grey;
    const falloffFactor = falloffArr ? falloffArr[vid] : 1.0;
    let disp =
  falloffFactor *
  (1 - maskedFrac) *
  centeredGrey *
  vertexSettings.amplitude;

// Multi-slot seam guard:
// vertices adjacent to more than one slot are pinned to the original surface.
// This avoids a shared boundary vertex being pulled by the wrong texture.
if (multiSlots && multiBoundary && multiBoundary[vid]) {
  disp = 0;
}

if (maskedOut || isFaceExcluded || isSealedBoundary) {
  disp = 0;
}

    const newX = tmpPos.x + smoothNrmX[vid] * disp;
    const newY = tmpPos.y + smoothNrmY[vid] * disp;
    let   newZ = tmpPos.z + smoothNrmZ[vid] * disp;

    // Prevent boundary vertices from poking through the masked surface in Z.
    // Only triggers for vertices that are partly masked (maskedFrac > 0) and
    // whose displacement would push them toward the masked surface direction.
    if (maskedFrac > 0) {
      if (vertexSettings.bottomAngleLimit > 0 && newZ < tmpPos.z) newZ = tmpPos.z;
      if (vertexSettings.topAngleLimit    > 0 && newZ > tmpPos.z) newZ = tmpPos.z;
    }

    // Overhang protection: never move a vertex below its original Z. X/Y
    // displacement is preserved so surface texture detail still appears,
    // it just gets pushed sideways instead of creating a new overhang.
    if (vertexSettings.noDownwardZ && newZ < tmpPos.z) newZ = tmpPos.z;

    // Bottom-plane flat clamp: with overhang protection on, also clamp
    // upward motion when the original vertex sat on the print bottom plane.
    // Without this, a downward-facing face (smoothNrm ≈ (0,0,-1)) pulls UP
    // when the texture sample is below mid-grey (centeredGrey < 0 makes
    // smoothNrm × disp positive in Z), so adjacent bottom-face vertices
    // end up at slightly different heights and slicers render the now-
    // tilted triangles with visibly varying shading. The clamp keeps the
    // bed-contact surface a single Z value while leaving any vertex above
    // the bottom plane (side fillets, etc.) free to follow texture detail.
    if (vertexSettings.noDownwardZ && tmpPos.z <= bounds.min.z + 1e-5) {
      newZ = tmpPos.z;
    }

    newPos[i*3]   = newX;
    newPos[i*3+1] = newY;
    newPos[i*3+2] = newZ;

    // Keep per-face normal for shading (recomputed below anyway)
    newNrm[i*3]   = tmpNrm.x;
    newNrm[i*3+1] = tmpNrm.y;
    newNrm[i*3+2] = tmpNrm.z;

    if (onProgress && i % REPORT_EVERY === 0) onProgress(i / count);
  }

  // Compute exact per-face normals from the displaced positions.
  // Using computeVertexNormals() would average across shared positions, which
  // can flip normals on excluded faces whose neighbours were displaced outward.
  // A direct cross-product per triangle is unambiguous and matches winding order.
  const eA = new THREE.Vector3();
  const eB = new THREE.Vector3();
  const fn = new THREE.Vector3();
  for (let t = 0; t < count; t += 3) {
    const ax = newPos[t*3],   ay = newPos[t*3+1],   az = newPos[t*3+2];
    const bx = newPos[t*3+3], by = newPos[t*3+4],   bz = newPos[t*3+5];
    const cx = newPos[t*3+6], cy = newPos[t*3+7],   cz = newPos[t*3+8];
    eA.set(bx - ax, by - ay, bz - az);
    eB.set(cx - ax, cy - ay, cz - az);
    fn.crossVectors(eA, eB).normalize();
    for (let v = 0; v < 3; v++) {
      newNrm[(t + v) * 3]     = fn.x;
      newNrm[(t + v) * 3 + 1] = fn.y;
      newNrm[(t + v) * 3 + 2] = fn.z;
    }
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(newPos, 3));
  out.setAttribute('normal',   new THREE.BufferAttribute(newNrm, 3));
  return out;
}

/** Apply scale/offset/rotation to raw UV for cubic projection.
 *  Mirrors the private applyTransform helper in mapping.js. */
export function _cubicUV(rawU, rawV, settings, rotRad, aspectU, aspectV, relScale, px) {
  // relScale = scaleMmToRelative(...) — settings.scaleU/scaleV sont des mm.
  // `px` (transformation de pièce) est optionnel : absent, les `?? 0` rendent
  // 0 et le miroir vaut 1, donc les deux lignes sont IDENTIQUES au legacy.
  const mir = (px && px.mirrorU) ? -1 : 1;
  let u = (rawU * aspectU) / (relScale.u * mir) + settings.offsetU + (px?.du ?? 0);
  let v = (rawV * aspectV) / relScale.v + settings.offsetV + (px?.dv ?? 0);
  if (rotRad !== 0) {
    const c = Math.cos(rotRad), s = Math.sin(rotRad);
    u -= 0.5; v -= 0.5;
    const ru = c*u - s*v, rv = s*u + c*v;
    u = ru + 0.5; v = rv + 0.5;
  }
  return { u: u - Math.floor(u), v: v - Math.floor(v) };
}
