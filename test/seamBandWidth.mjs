// Quelle LARGEUR de bande le lissage de normale produit-il reellement ?
//
// LE MECANISME EXISTANT. `blendNormalSmoothing` (32 par defaut) applique k
// iterations de lissage laplacien a la normale qui sert a choisir la
// projection. Pres d'une arete vive, la normale lissee balaie progressivement
// de +X vers +Y, ce qui donne enfin prise au melange de couture — lequel est
// autrement INERTE sur des murs plats (mesure : 0.0 % a Seam Blend maximum).
//
// CE QU'ON SOUPCONNE. Un lissage laplacien est une DIFFUSION : apres k
// iterations, la portee croit en racine(k), pas en k. Le reglage etant compte
// en ITERATIONS et non en millimetres, la largeur reelle de la bande depend
// alors de la finesse du maillage — et RETRECIT quand on augmente la
// resolution. L'utilisateur qui affine son export verrait donc sa couture
// redevenir franche, sans rien avoir touche.
//
// CE FICHIER MESURE, il ne corrige rien. Il repond a deux questions chiffrees :
//   1. la largeur suit-elle bien racine(k) ?
//   2. la largeur en mm depend-elle du pas du maillage a k constant ?
// La reponse dimensionne le correctif : si oui, le reglage doit s'exprimer en
// MILLIMETRES et deriver k du pas reel.

import * as THREE from 'three';
import { subdivide } from '../js/subdivision.js';

let pass = 0, fail = 0;
const ok = (m) => { console.log('  ok   ' + m); pass++; };
const ko = (m) => { console.log('  FAIL ' + m); fail++; };

const TAILLE = 40;

/**
 * Replique FIDELE du lissage de js/displacement.js : graphe d'adjacence en CSR
 * sur les positions DEDUPLIQUEES (les deux cotes d'une arete vive partagent
 * donc un noeud, et la diffusion traverse bien le coin), moyenne des voisins
 * puis renormalisation, k fois.
 */
function lisser(geo, k) {
  const p = geo.attributes.position, nr = geo.attributes.normal;
  const count = p.count;
  const q = 1e-4, ids = new Map();
  const vertexId = new Uint32Array(count);
  let uniqueCount = 0;
  for (let i = 0; i < count; i++) {
    const key = [Math.round(p.getX(i) / q), Math.round(p.getY(i) / q), Math.round(p.getZ(i) / q)].join(',');
    let id = ids.get(key);
    if (id === undefined) { id = uniqueCount++; ids.set(key, id); }
    vertexId[i] = id;
  }
  // Normale moyenne par position dedupliquee.
  const X = new Float64Array(uniqueCount), Y = new Float64Array(uniqueCount), Z = new Float64Array(uniqueCount);
  for (let i = 0; i < count; i++) {
    const id = vertexId[i];
    X[id] += nr.getX(i); Y[id] += nr.getY(i); Z[id] += nr.getZ(i);
  }
  for (let id = 0; id < uniqueCount; id++) {
    const L = Math.hypot(X[id], Y[id], Z[id]) || 1;
    X[id] /= L; Y[id] /= L; Z[id] /= L;
  }

  const degree = new Uint32Array(uniqueCount);
  const arete = (a, b) => { if (a !== b) { degree[a]++; degree[b]++; } };
  for (let t = 0; t < count; t += 3) {
    const a = vertexId[t], b = vertexId[t + 1], c = vertexId[t + 2];
    arete(a, b); arete(b, c); arete(c, a);
  }
  const csr = new Uint32Array(uniqueCount + 1);
  for (let id = 0; id < uniqueCount; id++) csr[id + 1] = csr[id] + degree[id];
  const nb = new Uint32Array(csr[uniqueCount]);
  const cur = new Uint32Array(uniqueCount);
  const pose = (a, b) => { if (a !== b) { nb[csr[a] + cur[a]++] = b; nb[csr[b] + cur[b]++] = a; } };
  for (let t = 0; t < count; t += 3) {
    const a = vertexId[t], b = vertexId[t + 1], c = vertexId[t + 2];
    pose(a, b); pose(b, c); pose(c, a);
  }

  let cx = new Float64Array(X), cy = new Float64Array(Y), cz = new Float64Array(Z);
  let nx = new Float64Array(uniqueCount), ny = new Float64Array(uniqueCount), nz = new Float64Array(uniqueCount);
  for (let it = 0; it < k; it++) {
    for (let id = 0; id < uniqueCount; id++) {
      const s = csr[id], e = csr[id + 1];
      if (e === s) { nx[id] = cx[id]; ny[id] = cy[id]; nz[id] = cz[id]; continue; }
      let sx = 0, sy = 0, sz = 0;
      for (let m = s; m < e; m++) { sx += cx[nb[m]]; sy += cy[nb[m]]; sz += cz[nb[m]]; }
      const L = Math.hypot(sx, sy, sz);
      if (L > 1e-12) { nx[id] = sx / L; ny[id] = sy / L; nz[id] = sz / L; }
      else { nx[id] = cx[id]; ny[id] = cy[id]; nz[id] = cz[id]; }
    }
    [cx, nx] = [nx, cx]; [cy, ny] = [ny, cy]; [cz, nz] = [nz, cz];
  }
  return { vertexId, X: cx, Y: cy, Z: cz };
}

/**
 * Largeur de la bande, en mm : plus grande distance a l'arete verticale a
 * laquelle la normale lissee devie encore de plus de SEUIL degres de la normale
 * de face. C'est la zone ou le melange de couture a effectivement prise.
 */
function largeurBande(geo, lisse, seuilDeg = 5) {
  const p = geo.attributes.position;
  const h = TAILLE / 2;
  const cos = Math.cos(seuilDeg * Math.PI / 180);
  // ⚠️ ON RESTREINT A UNE BANDE A MI-HAUTEUR. Premiere version : maximum sur
  // toute la face laterale — elle rendait 20.00 mm (exactement la demi-arete)
  // a TOUS les k, parce qu'elle attrapait les sommets voisins des aretes
  // HORIZONTALES du haut et du bas, dont la normale est lissee elle aussi. La
  // metrique saturait donc a son plafond et ne mesurait plus rien. Le compteur
  // de sommets concernes, lui, grandissait bien avec k : c'est ce desaccord
  // qui a revele que la sonde, et non le code, etait en cause.
  const MI = 2.0;          // demi-hauteur de la bande consideree
  const MARGE = 8.0;       // distance mini aux aretes horizontales
  if (h - MI < MARGE) throw new Error('bande de mesure trop proche des aretes horizontales');
  let large = 0, n = 0, vus = 0;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    if (Math.abs(z) > MI) continue;                        // mi-hauteur seulement
    const surX = Math.abs(Math.abs(x) - h) < 1e-6;
    const surY = Math.abs(Math.abs(y) - h) < 1e-6;
    if (surX === surY) continue;                           // ni l'un ni l'autre, ou l'arete meme
    vus++;
    const fx = surX ? Math.sign(x) : 0, fy = surY ? Math.sign(y) : 0;
    const id = lisse.vertexId[i];
    const d = lisse.X[id] * fx + lisse.Y[id] * fy;
    if (d < cos) {
      const dist = surX ? Math.min(Math.abs(y - h), Math.abs(y + h))
                        : Math.min(Math.abs(x - h), Math.abs(x + h));
      if (dist > large) large = dist;
      n++;
    }
  }
  return { large, n, vus };
}

async function main() {
  console.log('\n1. La portee suit-elle racine(k) ?');
  const PAS = 1.0;
  const cube = new THREE.BoxGeometry(TAILLE, TAILLE, TAILLE, 1, 1, 1).toNonIndexed();
  cube.computeVertexNormals();
  const { geometry: sub } = await subdivide(cube, PAS, null, null);
  console.log(`       cube ${TAILLE} mm, pas de maillage vise ${PAS} mm, ${sub.attributes.position.count} sommets`);

  const mesures = [];
  for (const k of [8, 32, 128, 512]) {
    const l = lisser(sub, k);
    const b = largeurBande(sub, l);
    mesures.push({ k, ...b });
    console.log(`       k=${String(k).padStart(4)}  bande ${b.large.toFixed(2)} mm   (${b.n} sommets sur ${b.vus} dans la bande de mesure)`);
  }
  const vide = mesures.filter((m) => m.n === 0);
  if (vide.length === mesures.length) {
    ko('aucune bande detectee a aucun k : la mesure est VIDE');
  } else {
    const r = [];
    for (let i = 1; i < mesures.length; i++) {
      if (mesures[i - 1].large > 1e-9) r.push(mesures[i].large / mesures[i - 1].large);
    }
    console.log(`       rapports d'une mesure a la suivante (k x4) : ${r.map((v) => v.toFixed(2)).join(', ')}`);
    console.log(`       x2 = diffusion en racine(k)   |   x4 = portee lineaire en k`);
    const moy = r.reduce((s, v) => s + v, 0) / (r.length || 1);
    if (moy < 3) ok(`la portee croit en racine(k) (rapport moyen ${moy.toFixed(2)} pour k x4)`);
    else ok(`la portee croit lineairement (rapport moyen ${moy.toFixed(2)})`);
  }

  console.log('\n2. A k CONSTANT, la bande depend-elle de la finesse du maillage ?');
  const K = 32;
  const parPas = [];
  for (const pas of [2.0, 1.0, 0.5]) {
    const c = new THREE.BoxGeometry(TAILLE, TAILLE, TAILLE, 1, 1, 1).toNonIndexed();
    c.computeVertexNormals();
    const { geometry: s } = await subdivide(c, pas, null, null);
    const b = largeurBande(s, lisser(s, K));
    parPas.push({ pas, large: b.large, sommets: s.attributes.position.count });
    console.log(`       pas ${pas.toFixed(1)} mm  ->  bande ${b.large.toFixed(2)} mm   (${s.attributes.position.count} sommets)`);
  }
  const a = parPas[0].large, z = parPas[parPas.length - 1].large;
  if (a > 1e-9 && z / a < 0.7) {
    ok(`la bande RETRECIT quand le maillage s'affine (${a.toFixed(2)} -> ${z.toFixed(2)} mm)`);
    console.log('       => le reglage compte des ITERATIONS, pas des millimetres :');
    console.log('          affiner l\'export resserre la couture sans qu\'on ait rien touche.');
  } else {
    ok(`la bande est stable avec la finesse (${a.toFixed(2)} -> ${z.toFixed(2)} mm)`);
  }

  console.log(`\nVERDICT: ${fail ? 'FAIL' : 'PASS'}  (${pass} ok, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
