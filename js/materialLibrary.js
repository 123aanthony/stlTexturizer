// BIBLIOTHEQUE DE MATIERES, INDEXEE PAR COULEUR FreeCAD.
//
// LE PROBLEME
// -----------
// Un STEP colore qui arrive sur une ardoise vierge cree deja un slot par
// groupe de couleur (faceGroups.groupFacesByColor + _autoSlotsFromColorGroups).
// Mais la couleur ne sert qu'a GROUPER : elle est jetee juste apres. Le slot
// arrive donc sans carte et sans reglages, nomme d'apres sa PIECE dominante
// ("FW_Storey"), qui ne dit rien de la matiere. Sur un batiment reel de seize
// groupes, c'est seize matieres a re-choisir — a chaque batiment.
//
// Le transfert de matiere EXISTE pourtant deja (.stltprofile,
// serializeMaterialProfile / applyMaterialProfile) : ce qui manquait n'etait
// pas la plomberie, c'etait une IDENTITE stable a quoi accrocher une matiere.
// Le profil, lui, est indexe par slot ACTIF — donc par une POSITION, et la
// position n'est pas stable : groupFacesByColor trie les groupes par nombre de
// triangles, si bien qu'un batiment aux proportions differentes les reordonne
// et que chaque matiere atterrit sur le mauvais slot.
//
// La couleur, elle, est stable : c'est fw_colorize qui la pose, une par
// matiere, avec des valeurs constantes d'un export a l'autre.
//
// CE QUE CE MODULE EST, ET N'EST PAS
// ----------------------------------
// Il est PUR : aucun DOM, aucun IndexedDB, aucune image. Il decide, il ne
// stocke pas. L'appelant lui donne des couleurs et des matieres deja
// SERIALISEES (la forme exacte du .stltprofile, cf. `serializeMaterialProfile`)
// et il rend la bibliotheque suivante ou le plan d'application. Le va-et-vient
// avec le disque, les canevas et les entrees de carte reste dans main.js, comme
// pour le profil.
//
// ⚠️ LA CORRESPONDANCE SE FAIT AU PLUS PROCHE, PAS AU PREMIER SOUS LE SEUIL.
// Un glouton "premier trouve" ferait dependre le resultat de l'ordre
// d'insertion : deux teintes voisines — et il y en a, fw_colorize decoupe le
// bois en sous-couleurs de DIRECTION DE FIL — se voleraient leur matiere selon
// l'ordre ou elles ont ete memorisees. Meme lecon que la carte des fils cote
// FreeCAD, ou l'affectation se fait au centre le plus proche.
//
// ⚠️ ET LE SEUIL EST SERRE PAR DEFAUT (0.02, soit ~5/255 par canal). Il est la
// pour absorber l'aller-retour STEP (quantification, arrondis d'ecriture), PAS
// pour rapprocher deux matieres distinctes : les trois pierres de fw_colorize
// sont volontairement CONTRASTEES, un seuil large les confondrait et peindrait
// un chainage en voussoir sans que rien ne le signale.

export const LIBRARY_VERSION = 1;

/** Seuil de correspondance par defaut, en distance euclidienne RGB [0,1]. */
export const DEFAULT_TOLERANCE = 0.02;

// ── Cle de couleur ───────────────────────────────────────────────────────────

const _clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Normalise une couleur vers [0,1]^3.
 * Accepte les deux conventions rencontrees : flottants 0..1 (ce que rend
 * meshStep, donc le STEP) et octets 0..255 (ce que rendent les outils DOM).
 * ⚠️ La detection se fait sur le MAXIMUM des trois canaux, jamais canal par
 * canal : (255, 0, 0) est du rouge en octets, et (1, 0, 0) le meme rouge en
 * flottants — tester "> 1" sur chaque canal separement rendrait la conversion
 * dependante du canal le plus sombre.
 */
export function normalizeRgb(rgb) {
  if (!rgb || rgb.length < 3) return null;
  const r = Number(rgb[0]), g = Number(rgb[1]), b = Number(rgb[2]);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  const div = Math.max(r, g, b) > 1.0001 ? 255 : 1;
  return [_clamp01(r / div), _clamp01(g / div), _clamp01(b / div)];
}

/**
 * Cle canonique d'une couleur : '#rrggbb', quantifie sur 8 bits.
 * 8 bits parce que c'est la precision a laquelle la couleur EXISTE vraiment
 * dans la chaine (l'oeil, la GUI, le STEP colore) — aller plus fin ne ferait
 * que fabriquer des cles qui ne se retrouvent jamais.
 */
export function colorKey(rgb) {
  const n = normalizeRgb(rgb);
  if (!n) return null;
  const h = n.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  return '#' + h;
}

/** '#rrggbb' -> [r,g,b] dans [0,1]. Rend null sur une cle malformee. */
export function keyToRgb(key) {
  if (typeof key !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(key)) return null;
  return [
    parseInt(key.slice(1, 3), 16) / 255,
    parseInt(key.slice(3, 5), 16) / 255,
    parseInt(key.slice(5, 7), 16) / 255,
  ];
}

/** Distance euclidienne entre deux couleurs [0,1]^3. */
export function colorDistance(a, b) {
  const x = normalizeRgb(a), y = normalizeRgb(b);
  if (!x || !y) return Infinity;
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

// ── La bibliotheque ──────────────────────────────────────────────────────────
//
// Forme : { version, entries: { '#rrggbb': { name, material } }, maps: { cle: dataUrl } }
//
// `material` a EXACTEMENT la forme d'un slot de .stltprofile, moins la
// selection : { activeMapType, presetName, customMapName, customMapKey,
// settings }. Les octets des cartes personnalisees vivent dans `maps`, une
// seule fois par contenu — la meme deduplication que le format projet, et pour
// la meme raison : une carte de 1024 px pese plusieurs Mo en data URL, et la
// bibliotheque est relue a chaque import de STEP colore.

export function emptyLibrary() {
  return { version: LIBRARY_VERSION, entries: {}, maps: {} };
}

/**
 * Relecture TOLERANTE d'une bibliotheque venant du disque.
 * Tout ce qui est malforme est ECARTE, jamais propage : une entree sans cle
 * valide ou sans matiere ne peut rien peindre de juste, et une bibliotheque
 * a moitie fausse est pire qu'une bibliotheque vide — elle poserait la mauvaise
 * matiere sans qu'on la lui demande.
 */
export function normalizeLibrary(raw) {
  const lib = emptyLibrary();
  if (!raw || typeof raw !== 'object') return lib;
  const entries = raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
  for (const [k, v] of Object.entries(entries)) {
    const key = typeof k === 'string' ? k.toLowerCase() : null;
    if (!keyToRgb(key)) continue;
    if (!v || typeof v !== 'object' || !v.material || typeof v.material !== 'object') continue;
    lib.entries[key] = {
      name: typeof v.name === 'string' ? v.name : '',
      material: {
        activeMapType: v.material.activeMapType || null,
        presetName: v.material.presetName || null,
        customMapName: v.material.customMapName || null,
        customMapKey: v.material.customMapKey || null,
        settings: (v.material.settings && typeof v.material.settings === 'object')
          ? { ...v.material.settings } : {},
      },
    };
  }
  const maps = raw.maps && typeof raw.maps === 'object' ? raw.maps : {};
  for (const [k, v] of Object.entries(maps)) {
    if (typeof k === 'string' && typeof v === 'string' && v) lib.maps[k] = v;
  }
  return lib;
}

/** Nombre de matieres memorisees. */
export function librarySize(lib) {
  return lib && lib.entries ? Object.keys(lib.entries).length : 0;
}

/**
 * Memorise une matiere pour une couleur. PURE : rend une NOUVELLE
 * bibliotheque, l'entree existante etant remplacee (memoriser, c'est dire
 * "voila desormais la matiere de cette couleur").
 *
 * @param mapDataUrl octets de la carte personnalisee, s'il y en a une ; ranges
 *                   sous `material.customMapKey`, une seule fois par contenu.
 */
export function putMaterial(lib, rgb, { name = '', material, mapDataUrl = null } = {}) {
  const key = colorKey(rgb);
  const base = normalizeLibrary(lib);
  if (!key || !material) return base;
  const next = {
    version: LIBRARY_VERSION,
    entries: { ...base.entries },
    maps: { ...base.maps },
  };
  next.entries[key] = {
    name: typeof name === 'string' ? name : '',
    material: {
      activeMapType: material.activeMapType || null,
      presetName: material.presetName || null,
      customMapName: material.customMapName || null,
      customMapKey: material.customMapKey || null,
      settings: { ...(material.settings || {}) },
    },
  };
  if (mapDataUrl && material.customMapKey) next.maps[material.customMapKey] = mapDataUrl;
  return pruneMaps(next);
}

/** Oublie la matiere d'une couleur. PURE. */
export function removeMaterial(lib, rgb) {
  const key = typeof rgb === 'string' ? rgb.toLowerCase() : colorKey(rgb);
  const next = normalizeLibrary(lib);
  if (!key || !next.entries[key]) return next;
  delete next.entries[key];
  return pruneMaps(next);
}

/**
 * Ecarte les octets de carte que plus aucune matiere ne reclame.
 * Sans ca la bibliotheque ne ferait que GROSSIR : remplacer la matiere d'une
 * couleur y laisserait pour toujours l'image de l'ancienne, et c'est le poste
 * lourd (plusieurs Mo par carte).
 */
export function pruneMaps(lib) {
  const used = new Set();
  for (const e of Object.values(lib.entries || {})) {
    if (e.material && e.material.customMapKey) used.add(e.material.customMapKey);
  }
  const maps = {};
  for (const [k, v] of Object.entries(lib.maps || {})) if (used.has(k)) maps[k] = v;
  return { version: LIBRARY_VERSION, entries: { ...lib.entries }, maps };
}

/**
 * Matiere memorisee la PLUS PROCHE d'une couleur, sous le seuil.
 *
 * @returns {{key, name, material, mapDataUrl, distance}|null}
 */
export function lookupMaterial(lib, rgb, tolerance = DEFAULT_TOLERANCE) {
  const base = normalizeLibrary(lib);
  const target = normalizeRgb(rgb);
  if (!target) return null;
  let best = null;
  // Cles TRIEES : a egalite de distance — deux couleurs symetriques autour de
  // la cible, cas rare mais atteignable — le resultat ne doit pas dependre de
  // l'ordre d'insertion dans l'objet.
  for (const key of Object.keys(base.entries).sort()) {
    const d = colorDistance(keyToRgb(key), target);
    if (d > tolerance) continue;
    if (!best || d < best.distance) {
      const e = base.entries[key];
      best = {
        key,
        name: e.name,
        material: e.material,
        mapDataUrl: e.material.customMapKey ? (base.maps[e.material.customMapKey] || null) : null,
        distance: d,
      };
    }
  }
  return best;
}

/**
 * Plan d'application pour une liste de groupes de couleur.
 * Rend UN element par groupe, dans le meme ordre — `null` quand la couleur
 * n'est pas connue, pour que l'appelant puisse compter et le DIRE ("3 matieres
 * reconnues sur 16") plutot que d'appliquer en silence ce qu'il a trouve.
 *
 * @param groups [{ rgb }] — la couleur de chaque groupe, dans l'ordre des slots
 */
export function planFromGroups(lib, groups, tolerance = DEFAULT_TOLERANCE) {
  const base = normalizeLibrary(lib);
  return (groups || []).map(g => lookupMaterial(base, g && g.rgb, tolerance));
}

// ── Identite d'une carte ─────────────────────────────────────────────────────
//
// Empreinte FNV-1a du contenu, longueur comprise. DEPLACEE ICI depuis main.js
// (verbatim) parce que le format projet ET la bibliotheque designent tous deux
// une carte par son contenu : deux fonctions qui decrivent la meme identite
// doivent etre la MEME fonction, sans quoi une carte partagee par un projet
// cesserait un jour de l'etre par la bibliotheque, en silence.

export function mapContentKey(dataUrl) {
  let h = 0x811c9dc5;
  for (let i = 0; i < dataUrl.length; i++) {
    h ^= dataUrl.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 'm' + (h >>> 0).toString(36) + '-' + dataUrl.length.toString(36);
}
