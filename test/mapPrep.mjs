// Preparation de la carte de deplacement (js/mapPrep.js).
//
// Le defaut vise : la plupart des cartes sont des PHOTOS ou des RENDUS, ou le
// grain fin pese autant que la mise en place des masses. MESURE sur une texture
// de mur en pierre : la bande < 2 px porte 0.0905 d'amplitude contre 0.0714
// pour TOUTE la disposition des pierres — le grain pese plus lourd que les
// pierres. Physiquement le rapport devrait etre ~0.05 (ciseau 0.2 mm contre
// decrochement 4 mm), pas 0.84.
//
// Ce que ce fichier prouve :
//   1. aux valeurs par defaut, la preparation est l'IDENTITE exacte ;
//   2. les niveaux se comportent comme des niveaux (bornes, gamma monotone) ;
//   3. la separation macro/micro separe VRAIMENT — sur une maquette « blocs +
//      grain », couper le micro effondre le grain en gardant le contraste des
//      blocs, ce qu'un flou global ne peut pas faire (oracle par COMPARAISON
//      avec le flou, pas par seuil absolu) ;
//   4. le flou BOUCLE, donc la carte reste tuilable ;
//   5. les cas degeneres ne rendent ni NaN ni carte binaire.

import assert from 'node:assert/strict';
import { prepareMap, isMapPrepActive, radiusForSigma, MAP_PREP_DEFAULTS } from '../js/mapPrep.js';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; }
}

const img = (w, h, fn) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = fn(x, y);
    data[i + 3] = 255;
  }
  return { data, width: w, height: h };
};
const grey = (m, i) => m.data[i * 4] / 255;

/** Ecart-type du detail plus fin que `s` texels — l'amplitude que cette echelle demanderait. */
function bandSd(m, s) {
  const { width: w, height: h } = m;
  const a = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = grey(m, i);
  // Moyenne glissante bouclee, carree, de cote ~s.
  const r = Math.max(1, Math.round(s / 2));
  const lo = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0, cnt = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      sum += a[(((y + dy) % h + h) % h) * w + (((x + dx) % w + w) % w)]; cnt++;
    }
    lo[y * w + x] = sum / cnt;
  }
  const hi = a.map((v, i) => v - lo[i]);
  const m2 = hi.reduce((s2, v) => s2 + v, 0) / hi.length;
  return Math.sqrt(hi.reduce((s2, v) => s2 + (v - m2) * (v - m2), 0) / hi.length);
}

/**
 * Contraste des MASSES, mesure au CENTRE de chaque bloc.
 *
 * ⚠️ Une fenetre glissante ne convient pas : large, elle moyenne les blocs
 * entre eux et effondre la mesure ; etroite, elle rattrape le grain. On
 * echantillonne donc la valeur au centre de chaque bloc — loin de ses bords,
 * que toute separation frequentielle adoucit forcement — et on mesure leur
 * dispersion. C'est exactement la question posee : deux pierres voisines
 * gardent-elles des hauteurs distinctes ?
 */
function macroSd(m, block) {
  const { width: w, height: h } = m;
  const vals = [];
  for (let by = 0; by < h; by += block) for (let bx = 0; bx < w; bx += block) {
    // moyenne d'un petit carre au centre du bloc : neutralise le grain sans
    // approcher les bords.
    const cx = bx + (block >> 1), cy = by + (block >> 1);
    let sum = 0, cnt = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      sum += grey(m, ((cy + dy) % h) * w + ((cx + dx) % w)); cnt++;
    }
    vals.push(sum / cnt);
  }
  const mu = vals.reduce((a2, v) => a2 + v, 0) / vals.length;
  return Math.sqrt(vals.reduce((a2, v) => a2 + (v - mu) * (v - mu), 0) / vals.length);
}

console.log('\n1. Identite aux valeurs par defaut');

check('isMapPrepActive est faux sur les defauts, et sur un objet vide', () => {
  assert.equal(isMapPrepActive({}), false);
  assert.equal(isMapPrepActive({ ...MAP_PREP_DEFAULTS }), false);
  // splitMm seul ne fait rien tant que les gains valent 1 : il ne doit pas
  // declencher une preparation inutile.
  assert.equal(isMapPrepActive({ splitMm: 7 }), false);
});

check('chaque reglage non neutre le declenche', () => {
  for (const k of ['black', 'white', 'gamma', 'macroGain', 'microGain']) {
    const s = { ...MAP_PREP_DEFAULTS, [k]: MAP_PREP_DEFAULTS[k] + 0.25 };
    assert.equal(isMapPrepActive(s), true, `${k} non detecte`);
  }
});

check('prepareMap aux defauts rend la carte a l\'octet pres', () => {
  const m = img(37, 23, (x, y) => (x * 7 + y * 13) % 256);   // dimensions impaires exprès
  const out = prepareMap(m, { ...MAP_PREP_DEFAULTS, splitTexels: 4 });
  assert.deepEqual(Array.from(out.data), Array.from(m.data));
});

console.log('\n2. Niveaux');

check('le point noir et le point blanc etirent puis BORNENT', () => {
  const m = img(16, 16, (x) => x * 16);          // rampe 0 -> 240
  const out = prepareMap(m, { black: 0.25, white: 0.75, splitTexels: 2 });
  assert.equal(grey(out, 0), 0, 'sous le point noir doit tomber a 0');
  const last = 16 * 16 - 1;
  assert.equal(grey(out, last), 1, 'au-dessus du point blanc doit saturer a 1');
  // Le milieu de l'intervalle reste au milieu.
  const mid = prepareMap(img(1, 1, () => 0.5 * 255), { black: 0.25, white: 0.75 });
  assert.ok(Math.abs(grey(mid, 0) - 0.5) < 0.01, grey(mid, 0));
});

check('le gamma releve les tons moyens sans toucher les extremes', () => {
  const m = img(8, 8, (x, y) => (x + y * 8) * 4);
  const g2 = prepareMap(m, { gamma: 2, splitTexels: 2 });
  const g05 = prepareMap(m, { gamma: 0.5, splitTexels: 2 });
  for (let i = 0; i < 64; i++) {
    const v = grey(m, i);
    if (v > 0.02 && v < 0.98) {
      assert.ok(grey(g2, i) > v - 1e-6, `gamma 2 aurait du eclaircir (${v})`);
      assert.ok(grey(g05, i) < v + 1e-6, `gamma 0.5 aurait du assombrir (${v})`);
    }
  }
  // Extremes preserves : 0 et 1 sont des points fixes de v^k.
  assert.equal(grey(prepareMap(img(1,1,()=>0), { gamma: 3 }), 0), 0);
  assert.equal(grey(prepareMap(img(1,1,()=>255), { gamma: 3 }), 0), 1);
});

console.log('\n3. Separation macro / micro — le coeur');

// Maquette du probleme : de grandes MASSES (blocs de 32 px, comme des pierres)
// portant un GRAIN fin de forte amplitude (damier 1 px, comme le ciseau).
//
// ⚠️ Les blocs doivent etre GRANDS devant la frontiere macro/micro, sinon leurs
// propres BORDS tombent dans la bande fine et se font couper avec le grain —
// ce n'est pas un defaut du filtre, c'est la nature d'une separation
// frequentielle. A 16 px de bloc pour une frontiere a 4, la moitie du contraste
// de masse partait ainsi. Cas reel : pierres ~200 px, grain < 8 px, soit un
// rapport de 25 ; ici 32 contre 4, rapport 8, deja franc.
const N = 128, BLOCK = 32;
const blocks = (x, y) => (((x / BLOCK | 0) + (y / BLOCK | 0)) & 1) ? 200 : 90;
const wall = img(N, N, (x, y) => blocks(x, y) + (((x + y) & 1) ? 45 : -45));

{
  const grainBefore = bandSd(wall, 3);
  const macroBefore = macroSd(wall, BLOCK);
  const damped = prepareMap(wall, { macroGain: 1, microGain: 0.15, splitTexels: 4 });
  const grainAfter = bandSd(damped, 3);
  const macroAfter = macroSd(damped, BLOCK);
  console.log(`       grain : ${grainBefore.toFixed(4)} -> ${grainAfter.toFixed(4)}`
            + `   |   masses : ${macroBefore.toFixed(4)} -> ${macroAfter.toFixed(4)}`);

  check('couper le micro effondre le grain', () => {
    assert.ok(grainAfter < grainBefore * 0.25,
      `${grainAfter.toFixed(4)} n'est pas nettement sous ${grainBefore.toFixed(4)}`);
  });

  check('...en GARDANT le contraste des masses', () => {
    // C'est toute la difference avec un flou : lui emporterait les deux.
    assert.ok(macroAfter > macroBefore * 0.9,
      `les masses ont perdu du contraste : ${macroAfter.toFixed(4)} vs ${macroBefore.toFixed(4)}`);
  });

  check('ORACLE PAR COMPARAISON : un flou seul ne sait pas faire ca', () => {
    // Le flou est simule par microGain = 0 ET macroGain = 0 sur la bande fine,
    // c'est-a-dire en poussant la frontiere assez loin pour qu'il avale les
    // blocs — exactement ce que fait `textureSmoothing` a sigma comparable.
    const blurred = prepareMap(wall, { macroGain: 1, microGain: 0, splitTexels: 48 });
    const macroBlur = macroSd(blurred, BLOCK);
    assert.ok(macroBlur < macroAfter * 0.9,
      `le flou aurait du coûter du contraste de masse (${macroBlur.toFixed(4)} vs ${macroAfter.toFixed(4)})`);
  });

  check('monter le macro amplifie les masses', () => {
    const boosted = prepareMap(wall, { macroGain: 1.6, microGain: 0.15, splitTexels: 4 });
    assert.ok(macroSd(boosted, BLOCK) > macroAfter * 1.2,
      `${macroSd(boosted, BLOCK).toFixed(4)} n'amplifie pas ${macroAfter.toFixed(4)}`);
  });

  check('le rehaussement du macro ne DEPLACE pas la surface', () => {
    // Point fixe = la moyenne : amplifier ne doit pas faire monter la carte en
    // bloc, sinon l'amplitude reglee par l'utilisateur changerait de sens.
    // C'est un resultat d'ALGEBRE, pas une approximation : le flou boucle
    // conserve la somme exactement (chaque pixel pese dans exactement `win`
    // fenetres), donc mean(bas) = mean, et
    //   mean(sortie) = mean + gm*(mean - mean) + gu*(mean - mean) = mean.
    //
    // ⚠️ Sauf ECRETAGE. Sur la maquette a fort contraste, macroGain 1.6 pousse
    // les blocs clairs au-dela de 1 : ils saturent, les sombres non, et la
    // moyenne descend de 0.011. Ce n'est pas un defaut — l'ecretage est teste
    // comme correct plus bas — mais l'invariant ne vaut QUE hors saturation.
    // On le verifie donc sur une maquette qui ne sature pas, et on le PROUVE
    // en exigeant qu'aucun pixel n'ait touche les bornes.
    const soft = img(N, N, (x, y) =>
      ((((x / BLOCK | 0) + (y / BLOCK | 0)) & 1) ? 170 : 120) + (((x + y) & 1) ? 20 : -20));
    const mean = (m) => {
      let s = 0; for (let i = 0; i < N * N; i++) s += grey(m, i); return s / (N * N);
    };
    const boosted = prepareMap(soft, { macroGain: 1.6, microGain: 1, splitTexels: 4 });
    for (let i = 0; i < N * N; i++) {
      const v = grey(boosted, i);
      assert.ok(v > 0 && v < 1, `la maquette sature en ${i} (${v}) : l'invariant n'y vaut pas`);
    }
    assert.ok(Math.abs(mean(boosted) - mean(soft)) < 0.002,
      `moyenne ${mean(boosted).toFixed(4)} vs ${mean(soft).toFixed(4)}`);
  });
}

console.log('\n4. Le flou BOUCLE (la carte se tuile)');

check('une carte uniforme le reste, bords compris', () => {
  const m = img(32, 32, () => 128);
  const out = prepareMap(m, { macroGain: 1.5, microGain: 0.5, splitTexels: 8 });
  for (let i = 0; i < 32 * 32; i++) {
    assert.ok(Math.abs(grey(out, i) - 128 / 255) < 2 / 255, `derive au pixel ${i}: ${grey(out, i)}`);
  }
});

check('un motif periodique reste periodique — bord compris', () => {
  // Rayures de PERIODE 16 sur 64 : 4 periodes entieres, donc le motif se
  // raccorde a lui-meme par tuilage. Si le flou boucle, le resultat garde
  // exactement la meme periode ; s'il clampait aux bords, les colonnes proches
  // de 0 et de 63 devieraient de leurs homologues du milieu.
  //
  // ⚠️ Comparer deux colonnes choisies a la main est un piege : un premier jet
  // opposait les colonnes 0 et 8 d'un motif de periode 8 — donc deux rayures
  // OPPOSEES. Le test echouait sur sa propre arithmetique, pas sur le code. On
  // verifie donc la periodicite pour TOUTES les colonnes.
  const P = 16;
  const m = img(64, 64, (x) => (Math.floor(x / P) % 2) ? 220 : 40);
  const out = prepareMap(m, { macroGain: 1, microGain: 0.3, splitTexels: 6 });
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const a = grey(out, y * 64 + x);
    const b = grey(out, y * 64 + ((x + 2 * P) % 64));   // meme phase
    assert.ok(Math.abs(a - b) < 0.01,
      `periodicite rompue en x=${x}: ${a.toFixed(3)} vs ${b.toFixed(3)}`);
  }
});

console.log('\n5. Cas degeneres');

check('point blanc <= point noir : pas de division par zero, pas de NaN', () => {
  const m = img(8, 8, (x) => x * 32);
  for (const [b, w] of [[0.5, 0.5], [0.8, 0.2]]) {
    const out = prepareMap(m, { black: b, white: w, splitTexels: 2 });
    for (let i = 0; i < 64; i++) assert.ok(Number.isFinite(grey(out, i)), `NaN a ${i}`);
  }
});

check('gamma nul ou negatif : ignore plutot que NaN', () => {
  const m = img(8, 8, (x) => x * 32);
  for (const g of [0, -1]) {
    const out = prepareMap(m, { gamma: g, splitTexels: 2 });
    for (let i = 0; i < 64; i++) assert.ok(Number.isFinite(grey(out, i)), `NaN a ${i} (gamma ${g})`);
  }
});

check('gain > 1 : ecretage propre, jamais de rebouclage', () => {
  // Un depassement qui reboucle transformerait une bosse en creux — le pire
  // artefact possible sur une carte de hauteur.
  const m = img(16, 16, (x, y) => (x + y) % 2 ? 250 : 5);
  const out = prepareMap(m, { macroGain: 1, microGain: 4, splitTexels: 4 });
  for (let i = 0; i < 256; i++) {
    const v = grey(out, i);
    assert.ok(v >= 0 && v <= 1, `hors bornes: ${v}`);
  }
});

check('radiusForSigma est monotone et vaut 0 a sigma 0', () => {
  assert.equal(radiusForSigma(0), 0);
  assert.equal(radiusForSigma(-3), 0);
  let prev = 0;
  for (const s of [1, 2, 4, 8, 16, 32]) {
    const r = radiusForSigma(s);
    assert.ok(r >= prev, `non monotone a sigma ${s}`);
    prev = r;
  }
});

console.log(`\nVERDICT: ${fail ? 'FAIL' : 'PASS'}  (${pass} ok, ${fail} failed)`);
process.exit(fail ? 1 : 0);
