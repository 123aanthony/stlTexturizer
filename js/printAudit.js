// AUDIT D'IMPRIMABILITE DU MAILLAGE EXPORTE.
//
// POURQUOI CE MODULE EXISTE
// -------------------------
// L'app dit « FDM sans support, parois >= ~0.8 mm » et n'a jamais rien mesure de
// tel. Deux trous, tous deux MUETS :
//
// 1. LA TOPOLOGIE. `isWatertight` existait, mais uniquement comme GARDE DE
//    DECIMATION (exportPipeline) : rien ne regardait le maillage effectivement
//    ecrit. MESURE sur une fixture du depot, `cubeWithSmallFillets.stl` :
//    watertight en entree (0 arete ouverte, 0 non-manifold) et **2489 aretes
//    NON-MANIFOLD** apres le pipeline. Le golden l'enregistre en
//    `OK  real-fillets  watertight=false` — donc vert pour toujours. Une
//    baseline qui note un defaut le rend permanent et silencieux.
//
// 2. L'EPAISSEUR. Aucune occurrence de "thickness" dans tout js/ avant ce
//    fichier. Or c'est BumpForge qui AMINCIT les murs : un deplacement
//    symetrique creuse des DEUX cotes d'une paroi, et rien ne disait quand le
//    resultat passait sous la buse.
//
// CE QUI EST MESURE, ET SUR QUOI
// ------------------------------
// - La TOPOLOGIE sur le maillage EXPORTE (une passe O(n), le meme cout que le
//   garde de decimation qui existait deja).
// - L'EPAISSEUR sur le maillage D'ENTREE, pas sur le maillage exporte. Ce n'est
//   pas un pis-aller : le maillage d'entree fait quelques milliers de triangles
//   la ou l'exporte peut en faire des dizaines de millions, et surtout
//   l'amincissement se DEDUIT exactement des reglages (voir `inwardBudget`).
//   Auditer 30 M de triangles pour retrouver un chiffre qu'on peut borner par le
//   calcul serait payer tres cher une reponse moins sure.
//
// ⚠️ LA BORNE D'AMINCISSEMENT EST UN MAJORANT, ET C'EST VOULU. Un garde
// d'imprimabilite qui sous-estime ne sert a rien : il laisserait passer la piece
// qu'il est cense arreter. Il peut en revanche etre RESSERRE par une mesure —
// d'ou `greyMin` : sans lui on suppose le noir absolu (le pire), avec lui on
// prend le creux REEL de la carte, ce qui evite d'alarmer sur une texture qui ne
// descend jamais si bas.

// Cosinus minimal pour qu'une face soit consideree comme LA PAROI D'EN FACE.
// 0.1 (~84 degres) : assez large pour une paroi oblique, assez etroit pour
// exclure une facette voisine du meme mur, dont le cosinus vaut ~ -1.
const FACING_MIN = 0.1;

// Fraction d'aire sous laquelle une epaisseur compte comme une PAROI (et non
// comme une pointe de biseau). Voir minWallThickness.
const PAROI_FRACTION = 0.01;

/** Seuils FDM. La buse est le mur du son ; 0.8 est la zone confortable. */
export const NOZZLE_MM = 0.4;
export const COMFORT_MM = 0.8;

// ── Topologie ────────────────────────────────────────────────────────────────

/**
 * Compte les aretes du maillage par nombre de faces incidentes.
 *
 * Quantification a 1e-4 mm, identique a celle qu'utilisait `isWatertight` : les
 * sommets sont dupliques par triangle (maillage non indexe), deux positions
 * egales doivent donc se recoller. Les aretes DEGENEREES (deux bouts au meme
 * point apres quantification) sont comptees a part et ecartees, exactement comme
 * avant — les compter pour des trous ferait crier au defaut sur un sliver.
 *
 * @returns {{edgeCount, open, nonManifold, degenerate, watertight, triCount}}
 */
export function auditEdges(geometry) {
  const pos = geometry.attributes ? geometry.attributes.position.array : geometry;
  const triCount = (pos.length / 9) | 0;
  const vid = new Map();
  const idOf = (o) => {
    const k = Math.round(pos[o] * 1e4) + ',' + Math.round(pos[o + 1] * 1e4) + ',' + Math.round(pos[o + 2] * 1e4);
    let v = vid.get(k);
    if (v === undefined) { v = vid.size; vid.set(k, v); }
    return v;
  };
  const edges = new Map();
  let degenerate = 0;
  const addEdge = (a, b) => {
    if (a === b) { degenerate++; return; }
    const k = a < b ? (a + '_' + b) : (b + '_' + a);
    edges.set(k, (edges.get(k) || 0) + 1);
  };
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const a = idOf(o), b = idOf(o + 3), c = idOf(o + 6);
    addEdge(a, b); addEdge(b, c); addEdge(c, a);
  }
  let open = 0, nonManifold = 0;
  for (const cnt of edges.values()) {
    if (cnt === 1) open++;
    else if (cnt > 2) nonManifold++;
  }
  return {
    triCount,
    edgeCount: edges.size,
    open,
    nonManifold,
    degenerate,
    watertight: open === 0 && nonManifold === 0,
  };
}

// ── Epaisseur de paroi ───────────────────────────────────────────────────────

/**
 * Grille uniforme d'index de triangles, parcourue en DDA le long d'un rayon.
 * Ecrite ici plutot qu'importee : `meshIndex.js` indexe des POINTS (recollement
 * de sommets), pas des triangles, et un rayon ne se resout pas avec.
 */
function buildGrid(pos, triCount) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < triCount * 9; i += 3) {
    if (pos[i] < minX) minX = pos[i];       if (pos[i] > maxX) maxX = pos[i];
    if (pos[i+1] < minY) minY = pos[i+1];   if (pos[i+1] > maxY) maxY = pos[i+1];
    if (pos[i+2] < minZ) minZ = pos[i+2];   if (pos[i+2] > maxZ) maxZ = pos[i+2];
  }
  const sx = Math.max(maxX - minX, 1e-6);
  const sy = Math.max(maxY - minY, 1e-6);
  const sz = Math.max(maxZ - minZ, 1e-6);
  // ~8 triangles par cellule en moyenne : au-dela la cellule coute cher a
  // tester, en deca la grille coute cher a parcourir.
  const target = Math.max(1, Math.cbrt(triCount / 8));
  const cell = Math.max(Math.max(sx, Math.max(sy, sz)) / (target * 2), 1e-4);
  const nx = Math.max(1, Math.ceil(sx / cell));
  const ny = Math.max(1, Math.ceil(sy / cell));
  const nz = Math.max(1, Math.ceil(sz / cell));
  const cells = new Map();
  const put = (ix, iy, iz, t) => {
    const k = (ix * ny + iy) * nz + iz;
    let a = cells.get(k);
    if (!a) cells.set(k, a = []);
    a.push(t);
  };
  const clampI = (v, n) => (v < 0 ? 0 : v >= n ? n - 1 : v);
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    let a0 = Infinity, a1 = Infinity, a2 = Infinity, b0 = -Infinity, b1 = -Infinity, b2 = -Infinity;
    for (let v = 0; v < 3; v++) {
      const x = pos[o + v*3], y = pos[o + v*3 + 1], z = pos[o + v*3 + 2];
      if (x < a0) a0 = x; if (x > b0) b0 = x;
      if (y < a1) a1 = y; if (y > b1) b1 = y;
      if (z < a2) a2 = z; if (z > b2) b2 = z;
    }
    const ix0 = clampI(Math.floor((a0 - minX) / cell), nx);
    const ix1 = clampI(Math.floor((b0 - minX) / cell), nx);
    const iy0 = clampI(Math.floor((a1 - minY) / cell), ny);
    const iy1 = clampI(Math.floor((b1 - minY) / cell), ny);
    const iz0 = clampI(Math.floor((a2 - minZ) / cell), nz);
    const iz1 = clampI(Math.floor((b2 - minZ) / cell), nz);
    for (let ix = ix0; ix <= ix1; ix++)
      for (let iy = iy0; iy <= iy1; iy++)
        for (let iz = iz0; iz <= iz1; iz++) put(ix, iy, iz, t);
  }
  return { cells, cell, nx, ny, nz, minX, minY, minZ };
}

/** Moller-Trumbore, rayon a sens unique (t > eps). */
function rayTri(px, py, pz, dx, dy, dz, pos, o) {
  const ax = pos[o],   ay = pos[o+1], az = pos[o+2];
  const bx = pos[o+3], by = pos[o+4], bz = pos[o+5];
  const cx = pos[o+6], cy = pos[o+7], cz = pos[o+8];
  const e1x = bx-ax, e1y = by-ay, e1z = bz-az;
  const e2x = cx-ax, e2y = cy-ay, e2z = cz-az;
  const hx = dy*e2z - dz*e2y, hy = dz*e2x - dx*e2z, hz = dx*e2y - dy*e2x;
  const det = e1x*hx + e1y*hy + e1z*hz;
  if (det > -1e-12 && det < 1e-12) return -1;
  const inv = 1 / det;
  const sx = px-ax, sy = py-ay, sz = pz-az;
  const u = (sx*hx + sy*hy + sz*hz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = sy*e1z - sz*e1y, qy = sz*e1x - sx*e1z, qz = sx*e1y - sy*e1x;
  const v = (dx*qx + dy*qy + dz*qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  return (e2x*qx + e2y*qy + e2z*qz) * inv;
}

/**
 * Epaisseur de paroi la plus faible, MESUREE.
 *
 * Pour un echantillon de triangles : depuis le centroide, un rayon part le long
 * de −n (donc DANS la matiere) ; la premiere intersection est la paroi d'en
 * face, et la distance parcourue est l'epaisseur locale.
 *
 * ⚠️ L'echantillon est REGULIER (un triangle sur k), pas aleatoire : un audit
 * doit rendre le meme chiffre deux fois de suite, sinon on ne peut pas dire si
 * un reglage a ameliore quoi que ce soit.
 * ⚠️ Un rayon qui ne touche RIEN n'est pas une paroi infinie : c'est un maillage
 * ouvert a cet endroit, ou une normale retournee. On le COMPTE (`misses`) au
 * lieu de l'ignorer — un audit qui n'aurait touche nulle part rendrait
 * `Infinity` et passerait pour un satisfecit.
 *
 * @returns {{min, samples, misses, hits, at}} `min` = Infinity si aucun tir n'a
 *          abouti ; `at` = centroide du pire point (pour pouvoir le montrer).
 */
export function minWallThickness(geometry, { samples = 3000 } = {}) {
  const pos = geometry.attributes ? geometry.attributes.position.array : geometry;
  const triCount = (pos.length / 9) | 0;
  if (triCount === 0) return { min: Infinity, p01: Infinity, samples: 0, misses: 0, hits: 0, at: null, p01At: null, area: 0 };

  const g = buildGrid(pos, triCount);
  const stepTri = Math.max(1, Math.floor(triCount / Math.max(1, samples)));
  let min = Infinity, misses = 0, hits = 0, tried = 0, at = null;
  const mesures = [];   // {t: epaisseur, a: aire du triangle, c: centroide}

  for (let t = 0; t < triCount; t += stepTri) {
    const o = t * 9;
    const ax = pos[o], ay = pos[o+1], az = pos[o+2];
    const bx = pos[o+3], by = pos[o+4], bz = pos[o+5];
    const cx = pos[o+6], cy = pos[o+7], cz = pos[o+8];
    const ux = bx-ax, uy = by-ay, uz = bz-az;
    const vx = cx-ax, vy = cy-ay, vz = cz-az;
    let nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
    const nl = Math.hypot(nx, ny, nz);
    if (!(nl > 1e-12)) continue;                 // sliver : pas de normale utile
    nx /= nl; ny /= nl; nz /= nl;
    tried++;

    // Depart LEGEREMENT en retrait dans la matiere, sinon le rayon retouche son
    // propre triangle au parametre 0.
    const eps = 1e-4;
    const ox = (ax+bx+cx)/3 - nx*eps, oy = (ay+by+cy)/3 - ny*eps, oz = (az+bz+cz)/3 - nz*eps;
    const dx = -nx, dy = -ny, dz = -nz;

    // Marche DDA de cellule en cellule ; on s'arrete des que le meilleur coup
    // trouve est plus proche que la sortie de la cellule courante.
    let ix = Math.floor((ox - g.minX) / g.cell);
    let iy = Math.floor((oy - g.minY) / g.cell);
    let iz = Math.floor((oz - g.minZ) / g.cell);
    if (ix < 0) ix = 0; else if (ix >= g.nx) ix = g.nx - 1;
    if (iy < 0) iy = 0; else if (iy >= g.ny) iy = g.ny - 1;
    if (iz < 0) iz = 0; else if (iz >= g.nz) iz = g.nz - 1;
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = Math.abs(dx) > 1e-12 ? Math.abs(g.cell / dx) : Infinity;
    const tDeltaY = Math.abs(dy) > 1e-12 ? Math.abs(g.cell / dy) : Infinity;
    const tDeltaZ = Math.abs(dz) > 1e-12 ? Math.abs(g.cell / dz) : Infinity;
    const bx0 = g.minX + (ix + (dx > 0 ? 1 : 0)) * g.cell;
    const by0 = g.minY + (iy + (dy > 0 ? 1 : 0)) * g.cell;
    const bz0 = g.minZ + (iz + (dz > 0 ? 1 : 0)) * g.cell;
    let tMaxX = Math.abs(dx) > 1e-12 ? (bx0 - ox) / dx : Infinity;
    let tMaxY = Math.abs(dy) > 1e-12 ? (by0 - oy) / dy : Infinity;
    let tMaxZ = Math.abs(dz) > 1e-12 ? (bz0 - oz) / dz : Infinity;

    let best = Infinity;
    for (let guard = 0; guard < 4096; guard++) {
      const arr = g.cells.get((ix * g.ny + iy) * g.nz + iz);
      if (arr) {
        for (let i = 0; i < arr.length; i++) {
          const tt = arr[i];
          if (tt === t) continue;
          const d = rayTri(ox, oy, oz, dx, dy, dz, pos, tt * 9);
          if (!(d > 1e-4 && d < best)) continue;
          // ⚠️ N'ACCEPTER QUE LES FACES QUI NOUS FONT FACE.
          // Sans ce filtre, une paroi COURBE FACETTEE vue de son cote CONCAVE
          // (le dedans d'un percage) donne des epaisseurs absurdes : la facette
          // VOISINE penche vers le rayon et le coupe a quelques microns du
          // depart. MESURE sur laserPlate.stl — une plaque de 2.000 mm — la
          // premiere version rendait **0.0024 mm**, sur deux facettes distantes
          // de 1.4 degres. Le critere est exact et non un seuil bricole : la
          // vraie paroi d'en face tourne sa normale SORTANTE vers nous, donc
          // dans le sens du rayon (produit scalaire > 0), tandis qu'une voisine
          // du MEME mur a la meme normale que la source, donc l'oppose (-1).
          const q = tt * 9;
          const e1x = pos[q+3]-pos[q],   e1y = pos[q+4]-pos[q+1], e1z = pos[q+5]-pos[q+2];
          const e2x = pos[q+6]-pos[q],   e2y = pos[q+7]-pos[q+1], e2z = pos[q+8]-pos[q+2];
          const hnx = e1y*e2z - e1z*e2y, hny = e1z*e2x - e1x*e2z, hnz = e1x*e2y - e1y*e2x;
          const hl = Math.hypot(hnx, hny, hnz);
          if (!(hl > 1e-12)) continue;
          if ((hnx*dx + hny*dy + hnz*dz) / hl <= FACING_MIN) continue;
          best = d;
        }
      }
      const tExit = Math.min(tMaxX, Math.min(tMaxY, tMaxZ));
      if (best <= tExit) break;                 // rien de plus proche au-dela
      if (tMaxX <= tMaxY && tMaxX <= tMaxZ) { ix += stepX; tMaxX += tDeltaX; }
      else if (tMaxY <= tMaxZ)              { iy += stepY; tMaxY += tDeltaY; }
      else                                  { iz += stepZ; tMaxZ += tDeltaZ; }
      if (ix < 0 || iy < 0 || iz < 0 || ix >= g.nx || iy >= g.ny || iz >= g.nz) break;
    }

    if (best === Infinity) { misses++; continue; }
    hits++;
    mesures.push({ t: best, a: nl / 2, c: [(ax+bx+cx)/3, (ay+by+cy)/3, (az+bz+cz)/3] });
    if (best < min) { min = best; at = [(ax+bx+cx)/3, (ay+by+cy)/3, (az+bz+cz)/3]; }
  }

  // ⚠️ LE MINIMUM STRICT MESURE LES ARETES VIVES, PAS LES PAROIS.
  // La ou deux parois se rejoignent en biseau, l'epaisseur perpendiculaire tend
  // vers ZERO en approchant de l'arete — c'est de la geometrie, pas un defaut.
  // MESURE sur `laserPlate.stl`, une plaque de 2.000 mm : le minimum vaut
  // **0.0024 mm**, sur une facette de 0.00135 mm2 qui touche sa voisine
  // d'en face. Fonder le verdict la-dessus, c'est alarmer sur toutes les pieces.
  // Le chiffre utile est une epaisseur qui couvre une SURFACE : `p01` est
  // l'epaisseur sous laquelle vit 1 % de l'aire echantillonnee. Une vraie paroi
  // mince est une SURFACE mince ; une pointe de biseau n'en est pas une.
  // `min` reste rendu — il informe, il ne juge pas.
  mesures.sort((u, v) => u.t - v.t);
  let aireTot = 0;
  for (const m of mesures) aireTot += m.a;
  let p01 = Infinity, p01At = null, cumul = 0;
  for (const m of mesures) {
    cumul += m.a;
    if (cumul >= aireTot * PAROI_FRACTION) { p01 = m.t; p01At = m.c; break; }
  }
  if (mesures.length && p01 === Infinity) { p01 = mesures[mesures.length - 1].t; }

  return { min, p01, at, p01At, area: aireTot, samples: tried, misses, hits };
}

// ── Ce que le deplacement retire a une paroi ─────────────────────────────────

/**
 * Enfoncement MAXIMAL d'une surface, en mm, d'apres les reglages des slots.
 *
 * `disp = falloff × (1 − maskedFrac) × centeredGrey × amplitude`, avec
 * `centeredGrey = grey − 0.5` en mode symetrique et `grey` sinon
 * (js/displacement.js). Donc :
 *   - NON symetrique : `grey >= 0` ⇒ le deplacement est toujours SORTANT, une
 *     paroi ne peut pas maigrir. Zero.
 *   - symetrique : l'enfoncement vaut `(0.5 − greyMin) × amplitude`, borne par
 *     `0.5 × amplitude` quand on ignore le contenu de la carte.
 *
 * @param slots [{ settings:{amplitude, symmetricDisplacement}, greyMin? }]
 * @returns {{mm, exact}} `exact` = true si TOUTES les cartes ont fourni leur
 *          creux reel ; sinon c'est un majorant, et il faut le dire.
 */
export function inwardBudget(slots) {
  let mm = 0, exact = true;
  for (const s of slots || []) {
    const st = (s && s.settings) || {};
    if (!st.symmetricDisplacement) continue;
    const amp = Number(st.amplitude) || 0;
    if (amp <= 0) continue;
    const gm = s.greyMin;
    if (typeof gm === 'number' && Number.isFinite(gm)) {
      mm = Math.max(mm, Math.max(0, 0.5 - gm) * amp);
    } else {
      exact = false;
      mm = Math.max(mm, 0.5 * amp);
    }
  }
  return { mm, exact };
}

/** Creux d'une carte en niveaux [0,1] — resserre la borne ci-dessus. */
export function greyMinOf(imageData) {
  const d = imageData && (imageData.data || imageData);
  if (!d || !d.length) return null;
  let min = 255;
  // Canal rouge uniquement : c'est celui que lit le sampler de deplacement.
  for (let i = 0; i < d.length; i += 4) if (d[i] < min) min = d[i];
  return min / 255;
}

// ── Verdict ──────────────────────────────────────────────────────────────────

/**
 * Rend des CONSTATS, pas des phrases : {code, level, params}. Le texte vit dans
 * les huit paquets i18n, comme tout ce que l'app dit — un module qui rendrait
 * du francais en dur parlerait francais dans sept autres langues, et le gate
 * i18n ne pourrait meme pas le voir. Les  portent les MESURES, ce qui
 * rend aussi les tests plus surs : ils epinglent des chiffres, pas de la prose.
 * Chaque message doit porter mesure ET remede — un « attention » sans chiffre
 * Ne refuse rien — c'est la piece de l'utilisateur, et un audit qui bloquerait
 * l'export serait contourne des la premiere fausse alerte.
 *
 * @returns {{level:'ok'|'info'|'warn', messages:string[], thicknessAfter:number}}
 */
export function auditReport({ edges, thickness = null, inward = null,
                              nozzle = NOZZLE_MM, comfort = COMFORT_MM } = {}) {
  const findings = [];
  let level = 'ok';
  const raise = (l) => { if (l === 'warn' || (l === 'info' && level === 'ok')) level = l; };

  if (edges && !edges.watertight) {
    findings.push({ code: 'audit.notWatertight', level: 'warn', params: {
      open: edges.open, nm: edges.nonManifold, edges: edges.edgeCount } });
    raise('warn');
  }

  let after = null;
  // ⚠️ p01 (l'epaisseur qui couvre 1 % de l'aire), PAS le minimum strict : celui-ci
  // mesure les pointes de biseau et alarmerait sur toutes les pieces. Voir
  // minWallThickness. Le minimum reste AFFICHE, a titre d'information.
  const paroi = thickness ? (Number.isFinite(thickness.p01) ? thickness.p01 : thickness.min) : null;
  if (thickness && Number.isFinite(paroi) && inward) {
    // Les DEUX faces d'une paroi peuvent s'enfoncer : le budget compte double.
    after = paroi - 2 * inward.mm;
    const p = {
      wall: paroi.toFixed(2),
      cut: (2 * inward.mm).toFixed(2),
      after: after.toFixed(2),
      limit: String(after < nozzle ? nozzle : comfort),
      // Remede CHIFFRE : l'amplitude symetrique qui laisse exactement la buse.
      amp: Math.max(0, paroi - nozzle).toFixed(2),
      bound: inward.exact ? 0 : 1,      // 1 = majorant, a annoncer comme tel
    };
    if (after < nozzle) { findings.push({ code: 'audit.underNozzle', level: 'warn', params: p }); raise('warn'); }
    else if (after < comfort) { findings.push({ code: 'audit.thin', level: 'info', params: p }); raise('info'); }
  }

  if (thickness && thickness.hits === 0 && thickness.samples > 0) {
    findings.push({ code: 'audit.notMeasurable', level: 'info',
                    params: { samples: thickness.samples } });
    raise('info');
  }

  return { level, findings, thicknessAfter: after };
}
