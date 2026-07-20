// T0 — Pilote d'impression du système de dalles (SPEC_TILEABLE / SPEC_FW_DALLE).
//
// Génère DEUX dalles texturées « à la main » (le mode Tileable n'existe pas
// encore) pour choisir le joint par défaut sur pièce réelle :
//   pilote_continu.stl — relief organique continu (pierre érodée), bords
//                        identiques par construction (heightmap périodique)
//   pilote_rainure.stl — pavés de 25,4 mm (la case D&D !) avec joint de mortier
//                        aux frontières → demi-rainure sur chaque bord
//
// Sémantique = celle des specs : déplacement STRICTEMENT axial (+Z du dessus),
// heightmap périodique (h(0,y) = h(W,y)), parois planes, watertight. Export
// DEBOUT (posé sur le chant Y-min, convention partagée), prêt à slicer.
//
//   node scripts/make-pilot-tiles.mjs
//
// Sortie : C:\Users\geton\OneDrive\Bureau\CAD\DOOR\PILOTE_DALLES\

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'C:/Users/geton/OneDrive/Bureau/CAD/DOOR/PILOTE_DALLES';
const W = 50.8;        // largeur/profondeur de dalle (2×2 cases de 25,4)
const TH = 6.5;        // épaisseur de corps (défaut rue, spec FW_Dalle)
const STEP = 0.25;     // pas de la grille du dessus (relief net à buse 0,4)
const AMP = 0.6;       // amplitude par défaut du mode (spec Tileable)

// ── PRNG déterministe (reproductible d'un run à l'autre) ─────────────────────
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Bruit de valeur PÉRIODIQUE (période = la dalle → seamless par construction)
function periodicNoise(period, seed) {
  const rnd = mulberry32(seed);
  const grid = Array.from({ length: period * period }, () => rnd());
  const at = (ix, iy) => grid[((iy % period + period) % period) * period + ((ix % period + period) % period)];
  const smooth = (t) => t * t * (3 - 2 * t);
  return (u, v) => { // u,v ∈ [0,1), lattice period×period
    const x = u * period, y = v * period;
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = smooth(x - ix), fy = smooth(y - iy);
    const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

// ── Heightmap « continu » : 3 octaves périodiques → pierre érodée ────────────
function makeContinu() {
  const o1 = periodicNoise(4, 101), o2 = periodicNoise(8, 202), o3 = periodicNoise(16, 303);
  return (x, y) => {
    const u = (((x / W) % 1) + 1) % 1, v = (((y / W) % 1) + 1) % 1;
    const n = 0.55 * o1(u, v) + 0.30 * o2(u, v) + 0.15 * o3(u, v);
    return n * AMP;
  };
}

// ── v2 « continu contrasté » : bruit RIDGÉ (crêtes vives, façon roche taillée)
// Verdict T0 : 0,6 doux = « beaucoup trop subtile » → amp 0,9, fréquences
// moyennes dominantes, crêtes anguleuses (1-|2n-1| plie le bruit en arêtes).
function makeContinuV2() {
  const o1 = periodicNoise(6, 111), o2 = periodicNoise(12, 222), o3 = periodicNoise(24, 333);
  const ridge = (n) => 1 - Math.abs(2 * n - 1);
  return (x, y) => {
    const u = (((x / W) % 1) + 1) % 1, v = (((y / W) % 1) + 1) % 1;
    const n = 0.5 * ridge(o1(u, v)) + 0.35 * ridge(o2(u, v)) + 0.15 * o3(u, v);
    return Math.pow(n, 1.4) * 0.9; // gamma > 1 creuse les vallées, garde les crêtes
  };
}

// ── Heightmap « rainure » : pavés 25,4 + mortier aux frontières ──────────────
// Le joint (0,9 de large, plein creux) tombe sur les bords de dalle → chaque
// bord porte une DEMI-rainure ; deux dalles côte à côte = un joint complet.
// Bonus : la ligne médiane dessine la grille de jeu 25,4.
function makeRainure() {
  const CASE = 25.4, GROUT = 0.9, R = 2.2; // largeur joint, congé d'épaule
  const micro = periodicNoise(16, 404);    // grain de pierre sur les pavés
  const jitter = mulberry32(505);
  const heights = [[0, 0], [0, 0]].map(r => r.map(() => 0.42 + jitter() * 0.14));
  return (x, y) => {
    const u = (((x / W) % 1) + 1) % 1 * W, v = (((y / W) % 1) + 1) % 1 * W;
    const cx = Math.floor(u / CASE), cy = Math.floor(v / CASE);        // pavé 0/1
    const lx = u - cx * CASE, ly = v - cy * CASE;                       // local au pavé
    // distance au bord du pavé (le joint mange GROUT/2 de chaque côté)
    const d = Math.min(lx, CASE - lx, ly, CASE - ly) - GROUT / 2;
    if (d <= 0) return 0;                                               // fond de joint
    const plateau = heights[cy % 2][cx % 2];
    const shoulder = d < R ? (1 - Math.cos((d / R) * Math.PI)) / 2 : 1; // épaule douce
    const grain = micro(u / W, v / W) * 0.12;
    return (plateau + grain) * shoulder;
  };
}

// ── v3 « briques » : appareil en panneresses (running bond), joints PROFONDS ─
// Verdict v2 (slicer) : le bruit même ridgé reste illisible → unités
// STRUCTURÉES. Briques 12,7 × 6,35 (4 × 8 par dalle, décalage demi-brique un
// rang sur deux → périodique), joint 1,0 de large, relief ~1,0 mm.
function makeBriques() {
  const BW = 12.7, BH = 6.35, GROUT = 1.0, SHOULDER = 0.5;
  const jit = mulberry32(606);
  const jitter = Array.from({ length: 8 }, () => Array.from({ length: 4 }, () => jit() * 0.18));
  const micro = periodicNoise(24, 707);
  return (x, y) => {
    const u = ((x % W) + W) % W, v = ((y % W) + W) % W;
    const row = Math.floor(v / BH);                       // 0..7
    const off = (row % 2) * (BW / 2);                     // décalage demi-brique
    const uu = ((u + off) % W + W) % W;
    const col = Math.floor(uu / BW);                      // 0..3
    const lx = uu - col * BW, ly = v - row * BH;
    const d = Math.min(lx, BW - lx, ly, BH - ly) - GROUT / 2;
    if (d <= 0) return 0;                                 // fond de joint
    const plateau = 0.85 + jitter[row % 8][col % 4];
    const shoulder = d < SHOULDER ? (1 - Math.cos((d / SHOULDER) * Math.PI)) / 2 : 1;
    return (plateau + micro(u / W, v / W) * 0.1) * shoulder;
  };
}

// ── v3 « pavés » : galets bombés 12,7 (4 × 4), joints larges, dômes marqués ──
function makePaves() {
  const CS = 12.7, GROUT = 1.2;
  const jit = mulberry32(808);
  const jitter = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => jit() * 0.25));
  return (x, y) => {
    const u = ((x % W) + W) % W, v = ((y % W) + W) % W;
    const cx = Math.floor(u / CS), cy = Math.floor(v / CS);
    const lx = u - cx * CS, ly = v - cy * CS;
    const dx = Math.min(lx, CS - lx) - GROUT / 2, dy = Math.min(ly, CS - ly) - GROUT / 2;
    if (dx <= 0 || dy <= 0) return 0;                     // fond de joint
    const half = (CS - GROUT) / 2;
    // COUSSIN bombé : profil séparable (produit par axe) — min(dx,dy) donnerait
    // des pyramides (isolignes carrées), vécu au rendu v3.
    const fx = Math.sin((Math.min(dx / half, 1) * Math.PI) / 2) ** 0.55;
    const fy = Math.sin((Math.min(dy / half, 1) * Math.PI) / 2) ** 0.55;
    return (0.75 + jitter[cy % 4][cx % 4]) * fx * fy;
  };
}

// ── v4 « dallage médiéval » : pierres IRRÉGULIÈRES, inclinées, ébréchées ─────
// Verdict v3 : « un peu mieux » = grille d'usine, trop régulière. Les leviers
// du réalisme (cf. tuiles commerciales) : tailles de pierres VARIÉES par rang,
// INCLINAISON aléatoire par pierre (le n°1), hauteurs dispersées, arêtes
// ébréchées. Tout reste périodique : les motifs de rangs somment à W exact.
function makeDallage() {
  const rnd = mulberry32(909);
  // hauteurs de rangs irrégulières sommant à W (50,8)
  const ROWS = [8.9, 11.4, 7.6, 12.7, 10.2];
  // largeurs de pierres par rang (chaque motif somme à W), décalées d'un rang à l'autre
  const WIDTHS = [
    [14.0, 9.6, 15.2, 12.0],
    [10.4, 16.0, 11.2, 13.2],
    [15.6, 10.8, 13.6, 10.8],
    [12.4, 14.8, 9.2, 14.4],
    [11.6, 13.2, 15.6, 10.4],
  ];
  const GROUT = 1.1;
  // par pierre : hauteur de base + inclinaison (gx, gy) + ébréchures de bord
  const stones = ROWS.map((_, r) => WIDTHS[r].map(() => ({
    h: 0.75 + rnd() * 0.45,
    gx: (rnd() - 0.5) * 0.055,          // pente mm/mm → ±0,35 sur une pierre
    gy: (rnd() - 0.5) * 0.045,
  })));
  const chip = periodicNoise(32, 1010); // ébréchures le long des joints
  const micro = periodicNoise(20, 1111);
  const rowY = [0]; for (const h of ROWS) rowY.push(rowY[rowY.length - 1] + h);
  return (x, y) => {
    const u = ((x % W) + W) % W, v = ((y % W) + W) % W;
    let r = 0; while (v >= rowY[r + 1]) r++;
    const ly = v - rowY[r], RH = ROWS[r];
    const ws = WIDTHS[r];
    let cx = 0, sx = 0; while (u >= sx + ws[cx]) { sx += ws[cx]; cx++; }
    const lx = u - sx, SW = ws[cx];
    // ébréchure : la largeur d'épaule varie le long du joint
    const rag = 0.45 + chip(u / W, v / W) * 0.75;
    const d = Math.min(lx, SW - lx, ly, RH - ly) - GROUT / 2;
    // v5 (verdict pilote peint) : chaque joint INTERNE porte un V central de
    // -0,3 identique au chanfrein du joint de dalle → le joint entre dalles
    // devient un joint parmi les autres (même profondeur, même profil).
    if (d <= 0) {
      const dj = Math.min(lx, SW - lx, ly, RH - ly);      // distance au centre du joint... approx
      const t = Math.max(0, 1 - dj / (GROUT / 2));        // 1 au centre du joint, 0 à l'épaule
      return -0.3 * t;
    }
    const s = stones[r][cx];
    const shoulder = d < rag ? (1 - Math.cos((Math.min(d / rag, 1)) * Math.PI)) / 2 : 1;
    const tilt = s.gx * (lx - SW / 2) + s.gy * (ly - RH / 2);
    const surf = micro(u / W, v / W) * 0.16;
    return Math.max(0, (s.h + tilt + surf) * shoulder);
  };
}

// ── v6 « bordure » : le joint de dalle devient un ÉLÉMENT D'ARCHITECTURE ─────
// Verdict v5 (slicer) : uniformiser la profondeur ne suffit pas — l'artefact
// d'impression (arrondi buse ~0,2) reste visible dans un joint de 1,1. Parade
// Dwarven Forge : un COURS DE PIERRES DE BORDURE sur les 4 côtés, le joint de
// dalle tombe entre deux bordures = un joint de mortier parmi d'autres, et
// l'arrondi disparaît dans une rigole voulue. Bonus : 4 bords IDENTIQUES →
// le raccord à 90° devient propre aussi (la limite v1 tombe pour ces dalles).
function makeBordure() {
  const field = makeDallage();
  const G = 1.1, CURB = 5.4, BAND = G / 2 + CURB + G;   // demi-joint + pierre + joint interne
  const SEGS = [13.4, 11.8, 14.2, 11.4];                 // longueurs de bordure (somme = W)
  const segB = [0]; for (const s of SEGS) segB.push(segB[segB.length - 1] + s);
  const rnd = mulberry32(1212);
  const curbH = Array.from({ length: 4 }, () => SEGS.map(() => 0.8 + rnd() * 0.3));
  const micro = periodicNoise(20, 1313);
  const V = (t) => -0.3 * Math.max(0, t);                // V central uniforme (v5)
  return (x, y) => {
    const u = ((x % W) + W) % W, v = ((y % W) + W) % W;
    const ex = Math.min(u, W - u), ey = Math.min(v, W - v);
    const dmin = Math.min(ex, ey);
    if (dmin >= BAND) return field(u, v);                // champ intérieur (dallage v5)
    if (dmin < G / 2) return V(1 - dmin / (G / 2));      // demi-joint du bord de dalle
    const inner = (G / 2 + CURB + G / 2) ;               // centre du joint interne
    if (dmin > G / 2 + CURB) return V(1 - Math.abs(dmin - inner) / (G / 2));
    // pierre de bordure : édge la plus proche → coordonnée le long du bord
    const edge = ex <= ey ? (u <= W - u ? 0 : 1) : (v <= W - v ? 2 : 3);
    const s = (edge < 2 ? v : u);
    let seg = 0; while (s >= segB[seg + 1]) seg++;
    const ds = Math.min(s - segB[seg], segB[seg + 1] - s);        // joint transversal
    if (ds < G / 2) return V(1 - ds / (G / 2));
    const dm = Math.abs(ex - ey);                                 // onglet de coin
    if (ex < BAND && ey < BAND && dm < G / 2) return V(1 - dm / (G / 2));
    // plateau de la pierre (taillée : épaule nette 0,5, pas d'ébréchure)
    const dEdge = Math.min(dmin - G / 2, G / 2 + CURB - dmin, ds - G / 2,
                           (ex < BAND && ey < BAND) ? dm - G / 2 : Infinity);
    const sh = dEdge < 0.5 ? (1 - Math.cos((Math.max(dEdge, 0) / 0.5) * Math.PI)) / 2 : 1;
    return (curbH[edge][seg] + micro(u / W, v / W) * 0.1) * sh;
  };
}

// ── v6 « caniveau » : rigole d'égout sur la PAIRE MOLLE seulement ────────────
// L'autre stratégie : ne traiter QUE les bords à problème. Les chants X
// (verticaux à l'impression, arêtes molles) portent une DEMI-rigole creuse
// (0,9 de profond) — assemblées : un caniveau de rue de 6,8 de large qui
// avale l'arrondi de buse. Les chants Y (paire vive) restent des joints nus
// (quasi invisibles, vécu v1/v4). Réaliste pour des dalles de RUE (l'eau
// coule le long des façades) ; le raccord en X double le caniveau = voulu.
function makeCaniveau() {
  const field = makeDallage();
  const CHAN = 3.4, DEPTH = 0.9;
  const micro = periodicNoise(20, 1414);
  return (x, y) => {
    const u = ((x % W) + W) % W, v = ((y % W) + W) % W;
    const ex = Math.min(u, W - u);
    const h = field(u, v);
    if (ex >= CHAN) return h;
    const t = 1 - ex / CHAN;                              // 1 au bord de dalle
    const sm = (1 - Math.cos(Math.PI * t)) / 2;           // C1 aux deux bouts
    return h * (1 - sm) - DEPTH * sm + micro(u / W, v / W) * 0.06 * sm;
  };
}

// ── Maillage : height-field box (dessus déplacé AXIALEMENT, parois planes) ───
// softChamfer (pilote v2) : micro-chanfrein 0,3 sur la PAIRE MOLLE (les 2
// chants VERTICAUX à l'impression = X-min/X-max, la dalle étant debout sur
// Y-min) — verdict T0 : la buse arrondit ces coins, 2 arrondis = gap en V ;
// 2 chanfreins définis = ligne de joint voulue. Implémenté en atténuant le
// relief vers 0 sur la largeur du chanfrein + biseau du bord supérieur.
function buildTile(hmap, softChamfer = 0) {
  const N = Math.round(W / STEP);                 // cellules par côté
  const vTop = [], vBot = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const x = (i / N) * W, y = (j / N) * W;
      // échantillonner à x mod W : la colonne i=N relit EXACTEMENT i=0 → bords
      // identiques par construction (le contrat du mode Tileable)
      let h = hmap(x % W, y % W);
      if (softChamfer > 0) {
        const dEdge = Math.min(x, W - x);         // distance aux chants X (paire molle)
        if (dEdge < softChamfer) {
          const t = dEdge / softChamfer;
          h = h * t - softChamfer * (1 - t);      // relief → 0 puis biseau sous le nu
        }
      }
      vTop.push([x, y, TH + h]);
      vBot.push([x, y, 0]);
    }
  }
  const idx = (i, j) => j * (N + 1) + i;
  const tris = [];
  const quad = (a, b, c, d) => { tris.push([a, b, c], [a, c, d]); };
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = idx(i, j), b = idx(i + 1, j), c = idx(i + 1, j + 1), d = idx(i, j + 1);
      quad(vTop[a], vTop[b], vTop[c], vTop[d]);           // dessus (+Z)
      quad(vBot[a], vBot[d], vBot[c], vBot[b]);           // dessous (−Z)
    }
  }
  for (let i = 0; i < N; i++) {                           // parois
    quad(vBot[idx(i, 0)], vBot[idx(i + 1, 0)], vTop[idx(i + 1, 0)], vTop[idx(i, 0)]);             // y=0
    quad(vBot[idx(i + 1, N)], vBot[idx(i, N)], vTop[idx(i, N)], vTop[idx(i + 1, N)]);             // y=W
    quad(vBot[idx(0, i + 1)], vBot[idx(0, i)], vTop[idx(0, i)], vTop[idx(0, i + 1)]);             // x=0
    quad(vBot[idx(N, i)], vBot[idx(N, i + 1)], vTop[idx(N, i + 1)], vTop[idx(N, i)]);             // x=W
  }
  return tris;
}

// ── Export DEBOUT : rotation +90° autour de X → le chant Y-min touche le
// plateau (convention partagée FW_Dalle/Tileable), la texture regarde devant.
function upright(tris) {
  return tris.map(t => t.map(([x, y, z]) => [x, -z + TH + AMP, y]));
}

function signedVolume(tris) {
  let v = 0;
  for (const [p0, p1, p2] of tris) {
    v += p0[0] * (p1[1] * p2[2] - p1[2] * p2[1])
       - p0[1] * (p1[0] * p2[2] - p1[2] * p2[0])
       + p0[2] * (p1[0] * p2[1] - p1[1] * p2[0]);
  }
  return v / 6;
}

function writeSTL(tris, path) {
  const buf = Buffer.alloc(84 + 50 * tris.length);
  buf.write('BumpForge tile pilot (T0)', 0, 'ascii');
  buf.writeUInt32LE(tris.length, 80);
  let o = 84;
  for (const [p0, p1, p2] of tris) {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    buf.writeFloatLE(nx / l, o); buf.writeFloatLE(ny / l, o + 4); buf.writeFloatLE(nz / l, o + 8);
    let p = o + 12;
    for (const pt of [p0, p1, p2]) {
      buf.writeFloatLE(pt[0], p); buf.writeFloatLE(pt[1], p + 4); buf.writeFloatLE(pt[2], p + 8);
      p += 12;
    }
    buf.writeUInt16LE(0, o + 48);
    o += 50;
  }
  writeFileSync(path, buf);
}

// ── Oracle du pilote : bords opposés identiques (le contrat, vérifié) ────────
function edgeOracle(hmap) {
  let worst = 0;
  for (let k = 0; k <= 200; k++) {
    const t = (k / 200) * W;
    worst = Math.max(worst,
      Math.abs(hmap(0, t % W) - hmap(W % W, t % W)),
      Math.abs(hmap(t % W, 0) - hmap(t % W, W % W)));
  }
  return worst;
}

// ── Plaque pilote « plateau à rebord » : bac 2×2 dalles ──────────────────────
// Les dalles pilotes n'ont pas de poches → la plaque de positionnement est un
// BAC : creux de 102,0 (2×50,8 + 0,4 de jeu), rebord de 4, les dalles se
// posent BORD À BORD dedans (aucune paroi entre elles — le joint reste pur).
// La vraie plaque plots+clips (SPEC_FW_DALLE) viendra avec le proto T3.
// STL = 6 boîtes fermées en contact coplanaire (union par le slicer).
function makePlate() {
  const INNER = 2 * W + 0.4, LIP = 4, BASE_T = 2.4, LIP_H = 2.0;
  const OUTERD = INNER + 2 * LIP;
  const box = (x0, y0, z0, x1, y1, z1) => {
    const v = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ];
    const q = (a, b, c, d) => [[v[a], v[b], v[c]], [v[a], v[c], v[d]]];
    return [
      ...q(0, 3, 2, 1), ...q(4, 5, 6, 7),   // dessous, dessus
      ...q(0, 1, 5, 4), ...q(2, 3, 7, 6),   // avant, arrière
      ...q(1, 2, 6, 5), ...q(3, 0, 4, 7),   // droite, gauche
    ];
  };
  const z0 = BASE_T, z1 = BASE_T + LIP_H;
  return [
    ...box(0, 0, 0, OUTERD, OUTERD, BASE_T),                       // socle
    ...box(0, 0, z0, OUTERD, LIP, z1),                             // rebord Y-min
    ...box(0, OUTERD - LIP, z0, OUTERD, OUTERD, z1),               // rebord Y-max
    ...box(0, LIP, z0, LIP, OUTERD - LIP, z1),                     // rebord X-min
    ...box(OUTERD - LIP, LIP, z0, OUTERD, OUTERD - LIP, z1),       // rebord X-max
  ];
}

mkdirSync(OUT, { recursive: true });
{
  const plate = makePlate();
  writeSTL(plate, join(OUT, 'pilote_plaque_2x2.stl'));
  console.log(`pilote_plaque_2x2.stl : ${plate.length} tris (bac 110×110, creux 102, s'imprime À PLAT)`);
}
// v1 : continu doux / rainure — v2 (post-verdict T0) : texture contrastée +
// micro-chanfrein 0,3 sur la paire molle, en continu ET en rainure.
const TILES = [
  ['continu', makeContinu(), 0],
  ['rainure', makeRainure(), 0],
  ['v2_continu', makeContinuV2(), 0.3],
  ['v2_rainure', makeRainure(), 0.3],
  ['v3_briques', makeBriques(), 0.3],
  ['v3_paves', makePaves(), 0.3],
  ['v4_dallage', makeDallage(), 0.3],
  ['v6_bordure', makeBordure(), 0],   // le bord EST le décor — pas de chanfrein
  ['v6_caniveau', makeCaniveau(), 0], // idem : la rigole avale l'arrondi
];
for (const [name, hmap, chamfer] of TILES) {
  const oracleGap = edgeOracle(hmap);
  const flat = buildTile(hmap, chamfer);
  const up = upright(flat);
  const vol = signedVolume(up);
  writeSTL(up, join(OUT, `pilote_${name}.stl`));
  console.log(`pilote_${name}.stl : ${up.length} tris, volume ${vol.toFixed(0)} mm³, oracle bords = ${oracleGap.toExponential(1)} mm, chanfrein paire molle = ${chamfer}`);
  if (oracleGap > 1e-9) throw new Error(`bords non identiques (${name})`);
  if (vol < W * W * (TH - 0.5) * 0.9) throw new Error(`volume suspect (${name})`);
}
console.log(`\nSortie : ${OUT}`);
