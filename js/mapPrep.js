/**
 * mapPrep.js — préparation de la carte de déplacement, avant échantillonnage.
 *
 * POURQUOI
 * --------
 * La plupart des cartes utilisées ici sont des PHOTOS ou des RENDUS, pas des
 * cartes de hauteur. Deux consequences mesurees sur une texture de mur en
 * pierre generee par IA (1254 px) :
 *
 *   - la bande de detail la plus fine (< 2 px) porte 0.0905 d'amplitude, contre
 *     0.0714 pour TOUTE la mise en place des pierres. Autrement dit le grain
 *     pese plus lourd que les pierres elles-memes. Physiquement c'est absurde :
 *     sur un vrai mur les coups de ciseau font ~0.2 mm et le decrochement
 *     pierre/joint ~4 mm, soit un rapport de 0.05, pas 0.84. Le grain est
 *     sur-represente d'environ 17x, et c'est lui qu'on voit en sortie sous
 *     forme de mie de pain uniforme ;
 *   - le biais directionnel de ses gradients vaut 0.064, la valeur la plus
 *     elevee des 24 textures de la bibliotheque — les vraies cartes de hauteur
 *     (dots, bubble, knurling, voronoi, carbonFiber, leather2) tiennent toutes
 *     entre 0.000 et 0.010. L'eclairage est cuit dans l'image.
 *
 * CE QUE CE MODULE CORRIGE, ET CE QU'IL NE CORRIGE PAS
 * ---------------------------------------------------
 * Il rééquilibre les ECHELLES et retaille les NIVEAUX. Il ne dé-éclaire pas :
 * une pierre eclairee par le haut restera une rampe inclinee vers la lumiere
 * plutot qu'un bloc. Seule une vraie carte de hauteur — ou une reintegration
 * type shape-from-shading — corrige cela. Le rééquilibrage suffit neanmoins a
 * rendre leur forme aux masses, ce que le simple flou ne pouvait pas faire :
 * `textureSmoothing` ne sait que RETIRER les deux echelles a la fois, d'ou la
 * perte de detail qu'il provoque.
 *
 * ORDRE DES OPERATIONS
 * --------------------
 *   1. NIVEAUX  (point noir / point blanc / gamma) — definit ce que « hauteur »
 *      veut dire, donc vient en premier ;
 *   2. SEPARATION MACRO / MICRO — reequilibre les echelles de la carte corrigee.
 * Le flou artistique `textureSmoothing` reste en aval, inchange.
 *
 * NON-REGRESSION PAR CONSTRUCTION
 * -------------------------------
 * Aux valeurs par defaut, `prepareMap` est l'IDENTITE exacte :
 *   - niveaux (0, 1, 1) : t = (v - 0) / 1 = v, puis v^(1/1) = v ;
 *   - gains (1, 1) : moyenne + (bas - moyenne) + (image - bas) = image.
 * Et `isMapPrepActive` teste cette egalite, si bien qu'une carte non preparee
 * n'est meme pas recopiee — l'appelant rend l'entree d'origine telle quelle.
 */

/** Reglages neutres : `prepareMap` y est l'identite exacte. */
export const MAP_PREP_DEFAULTS = Object.freeze({
  black: 0,        // point noir des niveaux, en 0-1
  white: 1,        // point blanc
  gamma: 1,        // > 1 releve les tons moyens (convention Photoshop : v^(1/gamma))
  macroGain: 1,    // gain des grandes echelles (la mise en place)
  microGain: 1,    // gain des fines (le grain)
  splitMm: 1.0,    // frontiere macro/micro, en MILLIMETRES du modele
});

/**
 * Y a-t-il quelque chose à faire ?
 *
 * Test d'EGALITE aux valeurs neutres, pas un seuil : l'appelant s'en sert pour
 * renvoyer la carte d'origine sans la copier, donc le moindre faux positif
 * couterait une recopie inutile, et un faux negatif perdrait un reglage.
 */
export function isMapPrepActive(s = {}) {
  const d = MAP_PREP_DEFAULTS;
  return (s.black ?? d.black) !== d.black
      || (s.white ?? d.white) !== d.white
      || (s.gamma ?? d.gamma) !== d.gamma
      || (s.macroGain ?? d.macroGain) !== d.macroGain
      || (s.microGain ?? d.microGain) !== d.microGain;
  // splitMm ne compte pas : seul il ne change rien, tant que les gains sont a 1.
}

/**
 * Flou boîte à moyenne glissante, avec BOUCLAGE.
 *
 * Trois passes approchent une gaussienne (theoreme central limite) et le cout
 * est INDEPENDANT du rayon grace aux sommes prefixes — indispensable ici, ou
 * un sigma de 60 texels sur une carte 1280x1280 rendrait une convolution
 * directe inutilisable (~1.3 milliard d'operations).
 *
 * Le bouclage n'est pas un detail : une carte de deplacement se TUILE, et un
 * flou qui clamperait aux bords fabriquerait une couture visible sur le modele.
 */
function boxBlurWrap(src, w, h, radius, passes = 3) {
  if (radius < 1) return src.slice();
  let cur = src.slice();
  let tmp = new Float32Array(w * h);

  const runAxis = (inp, out, len, other, strideIn, strideOther) => {
    const win = 2 * radius + 1;
    const ext = new Float64Array(len + 2 * radius);
    const pre = new Float64Array(len + 2 * radius + 1);
    for (let o = 0; o < other; o++) {
      const base = o * strideOther;
      for (let i = 0; i < ext.length; i++) {
        // Indice source ramene dans [0, len) : c'est le bouclage.
        const k = ((i - radius) % len + len) % len;
        ext[i] = inp[base + k * strideIn];
      }
      pre[0] = 0;
      for (let i = 0; i < ext.length; i++) pre[i + 1] = pre[i] + ext[i];
      for (let x = 0; x < len; x++) {
        out[base + x * strideIn] = (pre[x + win] - pre[x]) / win;
      }
    }
  };

  for (let p = 0; p < passes; p++) {
    runAxis(cur, tmp, w, h, 1, w);   // horizontal
    runAxis(tmp, cur, h, w, w, 1);   // vertical
  }
  return cur;
}

/** Rayon de boîte équivalent à un sigma gaussien (r(r+1) ≈ sigma²). */
export function radiusForSigma(sigma) {
  if (!(sigma > 0)) return 0;
  return Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
}

/**
 * Applique niveaux + rééquilibrage macro/micro à une carte en niveaux de gris.
 *
 * @param {{data:Uint8ClampedArray, width:number, height:number}} imageData
 * @param {object} opts
 * @param {number} [opts.black] [opts.white] [opts.gamma]
 * @param {number} [opts.macroGain] [opts.microGain]
 * @param {number} opts.splitTexels  frontière macro/micro, en TEXELS. Le
 *        module ignore volontairement les millimètres : la conversion depend du
 *        mapping et vit chez l'appelant (`texPerMm`, source unique).
 * @returns {{data:Uint8ClampedArray, width:number, height:number}} nouvelle carte
 */
export function prepareMap(imageData, opts = {}) {
  const d = MAP_PREP_DEFAULTS;
  const black = opts.black ?? d.black;
  const white = opts.white ?? d.white;
  const gamma = opts.gamma ?? d.gamma;
  const macroGain = opts.macroGain ?? d.macroGain;
  const microGain = opts.microGain ?? d.microGain;
  const splitTexels = opts.splitTexels ?? 0;

  const { width: w, height: h, data: src } = imageData;
  const n = w * h;

  // ── 1. Niveaux ────────────────────────────────────────────────────────────
  // Un intervalle nul (point blanc <= point noir) rendrait une carte binaire
  // par division par zero : on le neutralise plutot que de rendre du NaN.
  const span = white - black;
  const invSpan = Math.abs(span) < 1e-6 ? 0 : 1 / span;
  const invGamma = gamma > 0 ? 1 / gamma : 1;
  const identityLevels = black === d.black && white === d.white && gamma === d.gamma;

  const lin = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = src[i * 4] / 255;
    if (!identityLevels) {
      v = invSpan === 0 ? 0 : (v - black) * invSpan;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      if (invGamma !== 1) v = Math.pow(v, invGamma);
    }
    lin[i] = v;
  }

  // ── 2. Séparation macro / micro ───────────────────────────────────────────
  let out = lin;
  if (macroGain !== d.macroGain || microGain !== d.microGain) {
    const radius = radiusForSigma(splitTexels);
    const low = boxBlurWrap(lin, w, h, radius);

    // Point fixe = la MOYENNE de la carte : rehausser le macro ne doit pas
    // faire monter ou descendre la surface en bloc, seulement l'amplifier
    // autour de son niveau moyen.
    let mean = 0;
    for (let i = 0; i < n; i++) mean += lin[i];
    mean /= n;

    out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const lo = low[i];
      out[i] = mean + macroGain * (lo - mean) + microGain * (lin[i] - lo);
    }
  }

  const dst = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    // Uint8ClampedArray borne et arrondit : les depassements dus a un gain > 1
    // s'ecretent proprement au lieu de reboucler.
    const g = out[i] * 255;
    dst[i * 4] = dst[i * 4 + 1] = dst[i * 4 + 2] = g;
    dst[i * 4 + 3] = 255;
  }
  return { data: dst, width: w, height: h };
}

/**
 * Plage REELLEMENT occupee par une carte, et les niveaux qui l'etireraient.
 *
 * POURQUOI. Une carte de hauteur qui n'occupe qu'une fraction de 0..255 rend
 * d'autant moins de relief : le moteur mappe le gris sur l'amplitude demandee,
 * donc une carte allant de 95 a 194 ne rend que 39 % de la hauteur reglee.
 * Mesure sur un projet reel : 0.097 mm obtenus pour 0.25 demandes, soit 1.2
 * couche a 0.08 mm — physiquement presque plat. Les autres cartes du meme
 * projet occupaient 99 a 100 % de leur plage : rien dans l'interface ne
 * distinguait les deux cas.
 *
 * ⚠️ ON LIT LE CANAL ROUGE, parce que c'est celui que le sampler lit
 * (`data[i * 4]` dans mipPyramid.js). Mesurer une luminance decrirait une AUTRE
 * image que celle qui produit le relief — juste sur une carte grise, faux sur
 * une carte couleur, et faux sans prevenir.
 *
 * ⚠️ ON PREND DES CENTILES, PAS LE MIN ET LE MAX. Quelques pixels parasites
 * — un liseré, un artefact de compression — suffiraient a rendre l'etirement
 * inutile en pretendant que la plage est deja pleine.
 *
 * @returns {{black:number, white:number, gain:number, used:number, ok:boolean}}
 *   `black`/`white` en 0..1, prets pour mapBlack/mapWhite ; `used` la fraction
 *   de plage occupee ; `gain` le facteur de relief a esperer ; `ok` faux quand
 *   la carte est trop plate pour qu'un etirement ait un sens.
 */
export function measureLevels(imageData, { low = 0.01, high = 0.99 } = {}) {
  const d = imageData && imageData.data;
  const n = d ? (d.length / 4) | 0 : 0;
  if (!n) return { black: 0, white: 1, gain: 1, used: 0, ok: false };

  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[d[i * 4]]++;

  const seuil = (frac) => {
    const cible = frac * n;
    let cum = 0;
    for (let v = 0; v < 256; v++) {
      cum += hist[v];
      if (cum >= cible) return v;
    }
    return 255;
  };
  const lo = seuil(low), hi = seuil(high);
  const span = hi - lo;

  // Une plage trop etroite ne se redresse pas : l'etirement amplifierait le
  // bruit de quantification au lieu du relief. On le DIT au lieu de rendre un
  // reglage absurde.
  if (!(span > 4)) {
    return { black: lo / 255, white: hi / 255, gain: 1, used: span / 255, ok: false };
  }
  return {
    black: lo / 255,
    white: hi / 255,
    used: span / 255,
    gain: 255 / span,
    ok: true,
  };
}

// ── Options de preparation, depuis les reglages ──────────────────────────────
//
// Extraites de main.js (_mapPrepOpts / _splitTexels) pour que l'export en ligne
// de commande prepare la carte EXACTEMENT comme l'application. Deux lectures des
// memes reglages divergeraient au premier ajout de champ, et le lot batch
// rendrait alors une autre matiere que la GUI — sans que rien ne le dise.
export function mapPrepOptsOf(settings) {
  return {
    black: settings.mapBlack, white: settings.mapWhite, gamma: settings.mapGamma,
    macroGain: settings.mapMacro, microGain: settings.mapMicro,
    splitMm: settings.mapSplitMm,
  };
}

/**
 * Frontiere macro/micro en TEXELS, depuis les millimetres regles.
 * @param texPerMm  la fonction de mipPyramid.js, INJECTEE : ce module n'a
 *                  aucune dependance, et les deux appelants l'importent deja.
 *                  C'est la MEME source que le prefiltre mip — les deux doivent
 *                  decrire la meme empreinte.
 */
export function splitTexelsOf(settings, w, h, texPerMm) {
  const tmax = Math.max(w, h, 1);
  const ss = { ...settings, textureAspectU: tmax / Math.max(w, 1), textureAspectV: tmax / Math.max(h, 1) };
  return Math.max(0, settings.mapSplitMm * texPerMm(ss, w, h));
}
