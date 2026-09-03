#!/usr/bin/env node
// EXPORT D'UN PROJET .bforge SANS L'INTERFACE.
//
// POURQUOI
// --------
// Le pipeline d'export est deja SANS DOM (`exportPipeline.runMultiSlotExport`,
// extrait pour ca et couvert par le golden) : il ne manquait que de quoi lui
// donner un projet. Deux usages :
//   - LE LOT. Un diorama, c'est N batiments. Apres une modification FreeCAD, il
//     faut aujourd'hui rouvrir chaque projet et cliquer. Ici : une commande.
//   - L'ORACLE. Les treize cas du golden sont des cubes et deux STL simples ;
//     aucun ne traverse un `.bforge` a sept slots, c'est-a-dire precisement le
//     chemin ou vivent les defauts. `exportProject` est appelable depuis un
//     test, et rend la geometrie ET l'audit.
//
// CE QUI EST PARTAGE AVEC L'APPLICATION, ET POURQUOI CA COMPTE
// ------------------------------------------------------------
// Tout, sauf la lecture de fichier : `runMultiSlotExport` (l'orchestration),
// `restoreSlotFaces` (les selections), `prepareMap` + `mapPrepOptsOf` +
// `splitTexelsOf` (la preparation de carte), `buildSTLBuffer` (les octets
// ecrits), `printAudit` (le verdict). Une seconde ecriture de l'un d'eux
// divergerait un jour, et le lot batch rendrait alors autre chose que la GUI
// sans que rien ne le dise.
//
// ⚠️ LIMITES, MESUREES ET DITES — un outil de lot qui rendrait "presque" le bon
// fichier serait pire qu'aucun outil.
//   1. `textureSmoothing > 0` : le flou artistique est un `filter: blur()` de
//      Canvas2D, qu'aucune bibliotheque Node ne reproduit au pixel pres. On
//      REFUSE, on n'approxime pas. (Mesure sur le projet reel `housev2.bforge` :
//      0 slot sur 7 l'utilise, et le defaut d'usine est 0.)
//   2. La variation par PIECE est ignoree — non par choix, mais parce que
//      l'application l'ignore aussi sur ce chemin : MESURE, `pieceOffset`/
//      `pieceRotate` ne changent RIEN a « Export All Slots » (0 sommet
//      different sur 633 312). La CLI reproduit donc la GUI, defaut compris ;
//      quand ce defaut sera corrige cote app, il le sera ici par le meme code.
//   3. Le mode mono-slot de l'app (`handleExport`) a son propre chemin ; ici
//      tout passe par le pipeline multi-slot, y compris a un seul slot — c'est
//      ce que fait aussi l'app des qu'il y a plus d'un slot pret.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import * as THREE from 'three';

import { runMultiSlotExport } from '../js/exportPipeline.js';
import { restoreSlotFaces, withGlobalQuality, GLOBAL_EXPORT_QUALITY_KEYS } from '../js/slotState.js';
import { prepareMap, isMapPrepActive, mapPrepOptsOf, splitTexelsOf } from '../js/mapPrep.js';
import { texPerMm } from '../js/mipPyramid.js';
import { buildSTLBuffer } from '../js/exporter.js';
import { auditEdges, minWallThickness, inwardBudget, auditReport, greyMinOf } from '../js/printAudit.js';
import { IMAGE_PRESETS } from '../js/presetTextures.js';

// ── Lecture du modele ────────────────────────────────────────────────────────

/** STL binaire -> BufferGeometry non indexee (positions + normales de facette). */
export function geometryFromSTL(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triCount = view.getUint32(80, true);
  const pos = new Float32Array(triCount * 9);
  const nor = new Float32Array(triCount * 9);
  for (let i = 0; i < triCount; i++) {
    const o = 84 + i * 50;
    const nx = view.getFloat32(o, true), ny = view.getFloat32(o + 4, true), nz = view.getFloat32(o + 8, true);
    for (let v = 0; v < 3; v++) {
      const p = o + 12 + v * 12, d = i * 9 + v * 3;
      pos[d]     = view.getFloat32(p, true);
      pos[d + 1] = view.getFloat32(p + 4, true);
      pos[d + 2] = view.getFloat32(p + 8, true);
      nor[d] = nx; nor[d + 1] = ny; nor[d + 2] = nz;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return g;
}

function boundsOf(geometry) {
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const min = bb.min.clone(), max = bb.max.clone();
  return {
    min, max,
    size: new THREE.Vector3().subVectors(max, min),
    center: new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5),
  };
}

// ── Lecture des cartes ───────────────────────────────────────────────────────
//
// PNG et JPEG couvrent tout ce que l'app accepte (presets et cartes
// personnalisees). Le format rendu est celui d'un ImageData : `data` en RGBA
// 8 bits, ce que le sampler de deplacement attend.

function decodeImage(bytes, hint = '') {
  const isJpeg = bytes[0] === 0xFF && bytes[1] === 0xD8;
  if (isJpeg) {
    const r = jpeg.decode(bytes, { useTArray: true });
    return { data: new Uint8ClampedArray(r.data), width: r.width, height: r.height };
  }
  if (!(bytes[0] === 0x89 && bytes[1] === 0x50)) {
    throw new Error(`format d'image non reconnu${hint ? ' (' + hint + ')' : ''} — PNG ou JPEG attendus`);
  }
  const png = PNG.sync.read(Buffer.from(bytes));
  return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
}

const dataUrlBytes = (url) =>
  new Uint8Array(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));

/** Carte d'un slot : personnalisee (dans le projet) ou preset (dans textures/). */
function loadSlotMap(saved, payload, root) {
  const cle = saved.customMapKey;
  const url = saved.customMapDataUrl || (cle && payload.mapLibrary ? payload.mapLibrary[cle] : null);
  if (url) return decodeImage(dataUrlBytes(url), saved.customMapName || saved.id);

  const nom = saved.presetName || saved.activeMapName;
  if (!nom) return null;
  // ⚠️ Le nom AFFICHE n'est pas le nom de fichier. La correspondance vit dans
  // `IMAGE_PRESETS` (js/presetTextures.js) et se lit LA : une table recopiee
  // ici se perimerait au premier preset ajoute, et le lot batch echouerait sur
  // une texture que la GUI sait pourtant charger.
  const entree = IMAGE_PRESETS.find(e => e.name === nom);
  if (!entree) throw new Error(`preset inconnu : "${nom}"`);
  return decodeImage(new Uint8Array(readFileSync(join(root, entree.url))), nom);
}

// ── Export ───────────────────────────────────────────────────────────────────

/**
 * Ouvre un `.bforge` et rend la geometrie deplacee + l'audit d'impression.
 *
 * @param file    chemin du projet
 * @param opts.root         racine du depot (pour les textures de preset)
 * @param opts.onProgress   (fraction, label) => void
 * @returns {{geometry, audit, slots, warnings}}
 */
export async function exportProject(file, { root = join(dirname(fileURLToPath(import.meta.url)), '..'), onProgress = () => {} } = {}) {
  const zip = unzipSync(new Uint8Array(readFileSync(file)));
  if (!zip['settings.json']) throw new Error('archive sans settings.json — est-ce bien un .bforge ?');
  if (!zip['model.stl']) throw new Error('archive sans model.stl — projet enregistre sans modele ?');

  const payload = JSON.parse(strFromU8(zip['settings.json']));
  const geometry = geometryFromSTL(zip['model.stl']);
  const bounds = boundsOf(geometry);
  const warnings = [];

  // Reglages GLOBAUX d'export : ils vivent a la racine du payload, comme dans
  // l'app (GLOBAL_EXPORT_QUALITY_KEYS est la source unique de ce partage).
  const qualitySettings = {};
  for (const k of GLOBAL_EXPORT_QUALITY_KEYS) qualitySettings[k] = payload[k];

  const saved = payload.textureSlots || [];
  if (!saved.length) throw new Error('projet sans slot de texture');

  const readySlots = [];
  for (const s of saved) {
    const settings = { ...(s.settings || {}) };
    const st = settings.textureSmoothing ?? payload.textureSmoothing ?? 0;
    if (st > 0) {
      // ⚠️ REFUS, pas approximation : le flou est un filtre Canvas2D, et rendre
      // un fichier « presque » juste serait pire que ne rien rendre.
      throw new Error(
        `slot "${s.name || s.id}" : textureSmoothing = ${st}. Le flou artistique ` +
        `est un filtre Canvas2D que Node ne reproduit pas au pixel pres — ` +
        `l'export en ligne de commande le refuse. Remede : le remettre a 0 dans ` +
        `l'app, ou exporter ce projet depuis la GUI.`);
    }

    const img = loadSlotMap(s, payload, root);
    if (!img) { warnings.push(`slot "${s.name || s.id}" sans carte : ignore`); continue; }

    const { excludedFaces, assignedFaces } = restoreSlotFaces(s, geometry);
    if (!assignedFaces.size && !excludedFaces.size) {
      warnings.push(`slot "${s.name || s.id}" sans selection restauree : ignore`);
      continue;
    }
    readySlots.push({
      id: s.id, name: s.name || s.id,
      settings,
      selectionMode: s.selectionMode !== false,
      excludedFaces, assignedFaces,
      _image: img,
    });
  }
  if (!readySlots.length) throw new Error('aucun slot exploitable (ni carte, ni selection)');

  const geometryOut = await runMultiSlotExport({
    geometry, bounds, readySlots, qualitySettings,
    getSlotImageData: (slot, slotSettings) => {
      const img = slot._image;
      // MEME preparation que l'app (getEffectiveMapEntry) : les niveaux
      // d'abord, le flou ensuite — et le flou est refuse plus haut, donc il ne
      // reste que les niveaux, qui sont purs.
      const opts = mapPrepOptsOf(slotSettings);
      if (!isMapPrepActive(opts)) return { imageData: img, width: img.width, height: img.height };
      const prepped = prepareMap(img, {
        ...opts, splitTexels: splitTexelsOf(slotSettings, img.width, img.height, texPerMm),
      });
      return { imageData: prepped, width: img.width, height: img.height };
    },
    onProgress,
  });

  // Audit d'impression : la topologie sur la SORTIE, l'epaisseur sur l'ENTREE
  // (cf. js/printAudit.js).
  const edges = auditEdges(geometryOut);
  const thickness = minWallThickness(geometry);
  const inward = inwardBudget(readySlots.map(s => ({
    settings: s.settings,
    greyMin: greyMinOf(s._image),   // creux REEL : la borne cesse d'etre un majorant
  })));
  const audit = auditReport({ edges, thickness, inward });

  return { geometry: geometryOut, audit, edges, thickness, inward, slots: readySlots, warnings };
}

// ── Ligne de commande ────────────────────────────────────────────────────────

const AIDE = `
bumpforge-export — exporte un projet .bforge en STL, sans interface

  node scripts/bumpforge-export.mjs <projet.bforge> [-o sortie.stl]
  node scripts/bumpforge-export.mjs a.bforge b.bforge c.bforge      (lot)

Sans -o, chaque projet ecrit son STL a cote de lui (<nom>_all_slots.stl).
`;

async function main(argv) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = [], opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-o' || argv[i] === '--out') opts.out = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') { console.log(AIDE); return 0; }
    else files.push(argv[i]);
  }
  if (!files.length) { console.log(AIDE); return 2; }
  if (opts.out && files.length > 1) {
    console.error('-o ne vaut que pour UN projet : en lot, chaque STL est ecrit a cote du sien.');
    return 2;
  }

  let echecs = 0;
  for (const f of files) {
    const t0 = Date.now();
    try {
      process.stdout.write(`${basename(f)} … `);
      let dernier = -1;
      const { geometry, audit, edges, thickness, inward, warnings } =
        await exportProject(f, {
          root,
          onProgress: (p) => {
            const pct = Math.round(p * 10) * 10;
            if (pct !== dernier) { dernier = pct; process.stdout.write(`${pct}% `); }
          },
        });

      const out = opts.out || f.replace(new RegExp(`${extname(f)}$`), '') + '_all_slots.stl';
      writeFileSync(out, Buffer.from(buildSTLBuffer(geometry)));

      console.log(`\n  -> ${basename(out)} : ${edges.triCount.toLocaleString()} triangles`);
      console.log(`     topologie : ${edges.open} arete(s) ouverte(s), ${edges.nonManifold} non-manifold` +
                  (edges.watertight ? ' (etanche)' : ''));
      if (Number.isFinite(thickness.p01)) {
        console.log(`     paroi ${thickness.p01.toFixed(2)} mm (min strict ${thickness.min.toFixed(3)})` +
                    ` | creusement max ${(2 * inward.mm).toFixed(2)} mm` +
                    (inward.exact ? ' (mesure)' : ' (majorant)'));
      }
      for (const w of warnings) console.log(`     note : ${w}`);
      // ⚠️ Les constats de l'audit sont des CODES : le texte vit dans les
      // paquets i18n de l'app, que la CLI ne charge pas. On rend le code et ses
      // MESURES, qui sont l'information utile ici.
      for (const c of audit.findings) {
        console.log(`     ${c.level === 'warn' ? 'ALERTE' : 'info  '} ${c.code} ${JSON.stringify(c.params)}`);
      }
      console.log(`     ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    } catch (err) {
      echecs++;
      console.error(`\n  ECHEC ${basename(f)} : ${err.message}`);
    }
  }
  return echecs ? 1 : 0;
}

// Execute seulement en ligne de commande — importe, le module ne fait rien.
if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  main(process.argv.slice(2)).then(c => process.exit(c));
}
