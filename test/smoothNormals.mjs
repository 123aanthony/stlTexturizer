// Normales lissees pour l'affichage (js/smoothNormals.js).
//
// Le defaut : `applyDisplacement` rend une normale PAR FACE, recopiee sur les 3
// sommets. L'apercu All-Slots demande pourtant `flatShading: false` — mais avec
// des normales deja plates il rend plat quand meme, et la surface se couvre de
// chevrons qui suivent la triangulation. La FORME est lisse ; c'est l'eclairage
// qui ment.
//
// Ce que ce fichier prouve :
//   1. une sphere se lisse (le facettage tombe), un cube garde ses aretes ;
//   2. le seuil se lit bien comme un angle entre FACES ;
//   3. une discontinuite franche — le cas qui avait fait renoncer
//      displacement.js a `computeVertexNormals()` — n'est PAS moyennee ;
//   4. sur le VRAI pipeline, un plat deplace voit son facettage s'effondrer,
//      sans qu'aucune POSITION ne bouge (donc rien ne change a l'impression) ;
//   5. les cas degeneres retombent sur le plat au lieu de rendre du NaN.

import * as THREE from 'three';
import assert from 'node:assert/strict';
import { computeSmoothNormals, DEFAULT_CREASE_DEG } from '../js/smoothNormals.js';
import { proceduralTexture } from './lib/texture.mjs';
import { runSingle } from './lib/pipeline.mjs';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

/** Normales de face plates, telles que les rend applyDisplacement. */
function flatNormals(geo) {
  const pos = geo.attributes.position.array;
  const tri = (pos.length / 9) | 0;
  const out = new Float32Array(pos.length);
  for (let t = 0; t < tri; t++) {
    const a = t * 9;
    const ux = pos[a+3]-pos[a],   uy = pos[a+4]-pos[a+1], uz = pos[a+5]-pos[a+2];
    const vx = pos[a+6]-pos[a],   vy = pos[a+7]-pos[a+1], vz = pos[a+8]-pos[a+2];
    let nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (let v = 0; v < 3; v++) { const i = (t*3+v)*3; out[i]=nx; out[i+1]=ny; out[i+2]=nz; }
  }
  return out;
}

/**
 * MESURE DU FACETTAGE : ecart angulaire moyen, en degres, entre les normales
 * des sommets COINCIDENTS de triangles voisins. C'est exactement ce que l'oeil
 * lit comme un chevron — deux copies du meme point eclairees differemment.
 * A zero, la surface s'ombre continument.
 */
function facetingDeg(geo, nrm, keep = null) {
  const pos = geo.attributes.position.array;
  const n = (pos.length / 3) | 0;
  const byPoint = new Map();
  for (let i = 0; i < n; i++) {
    const x = pos[i*3], y = pos[i*3+1], z = pos[i*3+2];
    if (keep && !keep(x, y, z)) continue;
    const k = `${Math.round(x*1e5)}_${Math.round(y*1e5)}_${Math.round(z*1e5)}`;
    (byPoint.get(k) || byPoint.set(k, []).get(k)).push(i);
  }
  let sum = 0, cnt = 0;
  for (const idx of byPoint.values()) {
    for (let a = 0; a < idx.length; a++) for (let b = a + 1; b < idx.length; b++) {
      const i = idx[a] * 3, j = idx[b] * 3;
      const d = Math.min(1, Math.max(-1,
        nrm[i]*nrm[j] + nrm[i+1]*nrm[j+1] + nrm[i+2]*nrm[j+2]));
      sum += Math.acos(d) * 180 / Math.PI; cnt++;
    }
  }
  return cnt ? sum / cnt : 0;
}

console.log('\n1. Aretes vives vs surfaces courbes');

check('une sphere se lisse : le facettage s\'effondre', () => {
  const geo = new THREE.SphereGeometry(10, 24, 16).toNonIndexed();
  const flat = facetingDeg(geo, flatNormals(geo));
  const smooth = facetingDeg(geo, computeSmoothNormals(geo));
  console.log(`       sphere : facettage ${flat.toFixed(2)}° -> ${smooth.toFixed(2)}°`);
  assert.ok(flat > 5, `la sphere n'est pas assez facettee au depart (${flat.toFixed(2)}°)`);
  // Seuil au-dessus du PLANCHER DE BRUIT float32, pas colle dessus : les
  // normales sont stockees en f32 (eps ~ 1.2e-7), et pres de dot = 1 l'arc
  // cosinus amplifie — angle ~ sqrt(2*eps) ~ 0.028°. Un seuil a 0.01° mesurait
  // la precision de stockage, pas la forme.
  assert.ok(smooth < 0.1, `reste ${smooth.toFixed(3)}° de facettage`);
});

check('un cube GARDE ses aretes (le lissage ne doit pas arrondir un angle droit)', () => {
  const geo = new THREE.BoxGeometry(10, 10, 10).toNonIndexed();
  const nrm = computeSmoothNormals(geo);
  // Chaque normale doit rester un axe pur : une moyenne de coin donnerait
  // (±1,±1,±1)/sqrt(3), dont aucune composante ne vaut 1.
  const n = geo.attributes.position.count;
  for (let i = 0; i < n; i++) {
    const m = Math.max(Math.abs(nrm[i*3]), Math.abs(nrm[i*3+1]), Math.abs(nrm[i*3+2]));
    assert.ok(Math.abs(m - 1) < 1e-6, `normale de cube arrondie au sommet ${i} (max composante ${m.toFixed(4)})`);
  }
});

console.log('\n2. Le seuil se lit comme un angle entre FACES');

check('un pli de 60° reste vif a 40°, et se lisse a 90°', () => {
  // Deux quads partageant une arete, formant un diedre de 60°.
  const t = 60 * Math.PI / 180;
  const dx = Math.cos(t), dz = Math.sin(t);
  const P = [
    // face 1, dans le plan z = 0
    0,0,0,  10,0,0,  10,10,0,
    0,0,0,  10,10,0,  0,10,0,
    // face 2, repliee de 60° autour de l'axe y (arete x = 0)
    0,0,0,  0,10,0,  -10*dx,10,10*dz,
    0,0,0,  -10*dx,10,10*dz,  -10*dx,0,10*dz,
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(P), 3));

  const vif = facetingDeg(geo, computeSmoothNormals(geo, { creaseDeg: 40 }));
  const lisse = facetingDeg(geo, computeSmoothNormals(geo, { creaseDeg: 90 }));
  console.log(`       pli 60° : seuil 40° -> ${vif.toFixed(1)}° d'ecart (vif), seuil 90° -> ${lisse.toFixed(2)}° (lisse)`);
  assert.ok(vif > 30, `le pli aurait du rester vif, ecart ${vif.toFixed(1)}°`);
  assert.ok(lisse < 0.1, `le pli aurait du se lisser, ecart ${lisse.toFixed(2)}°`);
});

console.log('\n3. Le cas qui avait fait renoncer displacement.js');

check('une face restee au nu contre une face poussee dehors n\'est PAS moyennee', () => {
  // Reproduction du scenario cite dans displacement.js : la moyenne aveugle
  // « peut retourner les normales des faces exclues dont les voisines ont ete
  // deplacees vers l'exterieur ». Un gradin franc : dessus plat, puis mur
  // vertical. Le seuil doit garder les deux distincts.
  const P = [
    -10,0,0,  0,0,0,  0,10,0,          // dessus, normale +z
    -10,0,0,  0,10,0,  -10,10,0,
    0,0,0,   0,0,5,   0,10,5,          // mur vertical, normale +x
    0,0,0,   0,10,5,  0,10,0,
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(P), 3));
  const nrm = computeSmoothNormals(geo);
  const n = geo.attributes.position.count;
  for (let i = 0; i < n; i++) {
    const m = Math.max(Math.abs(nrm[i*3]), Math.abs(nrm[i*3+1]), Math.abs(nrm[i*3+2]));
    assert.ok(Math.abs(m - 1) < 1e-6, `le gradin a ete moyenne au sommet ${i} (${m.toFixed(4)})`);
  }
});

console.log('\n4. Pipeline reel — un plat deplace');

{
  const geo = await runSingle(
    new THREE.BoxGeometry(40, 40, 2, 20, 20, 1).toNonIndexed(),
    {
      refineLength: 1.5,
      texture: proceduralTexture(128, 128, 'sine'),
      settings: {
        mappingMode: 5, scaleUnit: 'mm', scaleU: 20, scaleV: 20,
        offsetU: 0, offsetV: 0, rotation: 0,
        amplitude: 1.5, symmetricDisplacement: false,
        topAngleLimit: 0, bottomAngleLimit: 0,
        mappingBlend: 0, seamBandWidth: 0.35, blendNormalSmoothing: 0,
        boundaryFalloff: 0, noDownwardZ: false, textureAntialias: true,
      },
    });

  const before = geo.attributes.normal.array;
  const posBefore = Float32Array.from(geo.attributes.position.array);
  const after = computeSmoothNormals(geo);

  // ⚠️ MESURER LA BONNE POPULATION. Un facettage moyenne sur TOUT le maillage
  // melange deux choses opposees : la surface deplacee, qui doit devenir lisse,
  // et les rebords de la plaque (dessus/flanc, 90°), qui doivent RESTER vifs.
  // Le total ne bougeait donc que de 14.75° a 4.34° et donnait l'impression
  // d'un lissage a moitie fait, alors que les deux populations font exactement
  // ce qu'on leur demande. Meme piege que la bbox : mesurer la forme reelle.
  const onSurface = (x, y, z) => z > 0.5 && Math.abs(x) < 18 && Math.abs(y) < 18;
  const onRim     = (x, y, z) => z > 0.5 && (Math.abs(x) > 19.9 || Math.abs(y) > 19.9);

  const fBefore = facetingDeg(geo, before, onSurface);
  const fAfter  = facetingDeg(geo, after,  onSurface);
  const rimAfter = facetingDeg(geo, after, onRim);
  console.log(`       surface deplacee : ${fBefore.toFixed(2)}° -> ${fAfter.toFixed(2)}°`);
  console.log(`       rebords (doivent rester vifs) : ${rimAfter.toFixed(2)}°`);

  check('ORACLE VIVANT : la sortie du pipeline EST facettee', () => {
    // Prouve que le defaut existe vraiment sur le chemin de production, et pas
    // seulement sur une fixture fabriquee pour l'occasion.
    assert.ok(fBefore > 3, `${fBefore.toFixed(2)}° seulement : le defaut ne se reproduit plus`);
  });

  check('le lissage l\'efface sur la surface deplacee', () => {
    assert.ok(fAfter < 0.5, `${fAfter.toFixed(2)}° de facettage residuel`);
  });

  check('mais les rebords de la plaque RESTENT vifs', () => {
    // La contrepartie indispensable : un lissage qui arrondirait aussi les
    // aretes franches serait une regression, pas une amelioration.
    assert.ok(rimAfter > 20, `les rebords ont ete arrondis (${rimAfter.toFixed(2)}°)`);
  });

  check('AUCUNE position ne bouge — donc rien ne change a l\'impression', () => {
    assert.deepEqual(Array.from(geo.attributes.position.array), Array.from(posBefore));
  });

  check('toutes les normales restent unitaires et du bon cote', () => {
    const n = geo.attributes.position.count;
    let flipped = 0;
    for (let i = 0; i < n; i++) {
      const x = after[i*3], y = after[i*3+1], z = after[i*3+2];
      const len = Math.hypot(x, y, z);
      assert.ok(Math.abs(len - 1) < 1e-5, `normale non unitaire au sommet ${i} (${len})`);
      // Meme hemisphere que la normale plate d'origine : le lissage reoriente
      // legerement, il ne RETOURNE jamais.
      if (x*before[i*3] + y*before[i*3+1] + z*before[i*3+2] < 0) flipped++;
    }
    assert.equal(flipped, 0, `${flipped} normales retournees`);
  });
}

console.log('\n5. Cas degeneres');

check('geometrie vide ou sans positions : null, pas une exception', () => {
  assert.equal(computeSmoothNormals(null), null);
  assert.equal(computeSmoothNormals({}), null);
  assert.equal(computeSmoothNormals(new THREE.BufferGeometry()), null);
});

check('triangle degenere : normale plate, jamais de NaN', () => {
  const geo = new THREE.BufferGeometry();
  // Un triangle sain, puis un triangle d'aire nulle (3 points confondus).
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array([
    0,0,0,  10,0,0,  0,10,0,
    5,5,0,  5,5,0,   5,5,0,
  ]), 3));
  const nrm = computeSmoothNormals(geo);
  for (let i = 0; i < nrm.length; i++) {
    assert.ok(Number.isFinite(nrm[i]), `NaN/Inf a l'indice ${i}`);
  }
});

check('le defaut de pli est celui annonce', () => {
  assert.equal(DEFAULT_CREASE_DEG, 40);
});

console.log(`\nVERDICT: ${fail ? 'FAIL' : 'PASS'}  (${pass} ok, ${fail} failed)`);
process.exit(fail ? 1 : 0);
