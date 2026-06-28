# Audit — gestion des slots, mécanismes associés & persistance

Audit lecture-seule (juin 2026). Statut par point : **CONFIRMÉ** (tracé dans le
code) ou **SUSPECTÉ**. Références `main.js:ligne`.

## 🔴 Persistance

### 1. Écritures mortes `diorama-texture-slots` — CONFIRMÉ
Clé écrite 3× — sessionStorage en auto (`addTextureSlot`/`removeTextureSlot`,
main.js:106, :1072) **et** localStorage par le bouton « Sauver les slots »
(:2052) — mais **jamais relue** (aucun `getItem`). Le bouton « Sauver les slots »
et ces auto-saves ne servent à rien. La vraie persistance passe par
`bumpmesh-settings` (`PROJECT_STORAGE_KEY`) via `getSettingsSnapshot()`.
→ Supprimer la couche morte (clé + bouton + `serializeTextureSlots`).

### 2. Clé `bumpmesh-settings` surchargée — CONFIRMÉ
Sert de snapshot projet (payload `{version, ...getSettingsSnapshot()}`, :7355)
ET est relue en :1994 pour `.activeMapName` (auto-select de preset au démarrage).
Double usage fragile sur une même clé.

### 3. Dérive d'échelle au save/reload (cylindrique) — CONFIRMÉ
`applySettingsSnapshot` (:7244) restaure `scaleU` en passant par l'événement
`change` du champ → `_applyScaleU` (:1375), qui **re-snappe** en mode cylindrique
(`_snapScaleUForSeamlessWrap`, :1366). Or `applySettingsSnapshot` (:7829)
s'exécute **avant** le chargement des textures (`restoreProjectTextureSlots`,
:7847) → `_currentTextureAspectU()` lit un aspect erroné → snap vers une valeur
différente. **Triplanar n'est pas affecté** (le snap est gardé sur mode 3 only).
→ Ne pas snapper sur un restore programmatique (valeur sauvegardée = autoritaire).

## 🟠 Double-état global ↔ slot (cause-racine)

### 4. Globals miroir du slot actif — CONFIRMÉ (= refacto étape 3)
`excludedFaces` / `selectionMode` / `activeMapEntry` / `settings` miroitent le
slot actif, synchronisés **seulement** aux points `saveActiveSlotState` /
`restoreSlotState`. `slotHasContent` (:172) lit des sources différentes selon que
le slot est actif (globals) ou non (champs slot) → incohérences possibles.

## 🟠 Cycle de vie des slots

### 5. `clearTextureSlot` réinitialise la qualité GLOBALE — CONFIRMÉ
Pour le slot actif, `Object.assign(settings, defaultSettings)` (:258) où
`defaultSettings` (`DEFAULT_SETTINGS_SNAPSHOT`, :7388) inclut `refineLength` +
`maxTriangles`. → Vider un slot **remet la Résolution et le budget triangles aux
défauts** (1 mm / 750 k), alors que ce sont des réglages globaux.

### 6. `duplicateTextureSlot` — CONFIRMÉ
Force `selectionMode = true` en ignorant le mode source (:124) ; restore dans un
`requestAnimationFrame` (:136) avec double affectation de `activeTextureSlotId`
→ fenêtre de race.

### 7. `decimateEnabled` absent de `DEFAULT_SETTINGS_SNAPSHOT` — CONFIRMÉ (mineur)
Après clear/reset il devient `undefined` (traité « on » via `!== false`, mais
incohérent avec les autres réglages globaux).

## 🟡 Formats de sauvegarde divergents

### 8. Deux représentations d'« un slot » — CONFIRMÉ
`serializeTextureSlots` (couche morte) ne sauve que `excludedFaces` ;
`serializeProjectTextureSlots` sauve `excludedFaces` + `assignedFaces` +
`faceSignatures`.

## Lecture d'ensemble & ordre de correction

Deux racines : le **double-état** (#4 = étape 3) et une **persistance sédimentée**
(#1, #2, #3, #8). Ordre recommandé (rentabilité ↓ risque ↑) :

1. **#3** — bug d'échelle : ne pas snapper `scaleU` au restore. ✅ FAIT (scaleSnap.js + test)
2. **#1, #8** — supprimer la persistance morte. ✅ FAIT (serializeTextureSlots + handler mort + écritures `diorama-texture-slots` retirés ; `saveTextureSlotsToStorage`→`commitActiveSlotState` ; removeTextureSlot marque enfin le projet dirty)
3. **#5** — `clearTextureSlot` : ne réinitialiser que le per-slot. ✅ FAIT (`stripGlobalQuality` sur les défauts → la qualité globale n'est plus touchée)
4. **#7** — `decimateEnabled` ajouté à `DEFAULT_SETTINGS_SNAPSHOT`. ✅ FAIT
5. **#6** — `duplicate` : préserver `selectionMode` + sélection, sens de données corrigé, rAF retiré. ✅ FAIT
6. **#4** — source unique de vérité (étape 3). 🟡 EN COURS : accesseur unique
   `resolveSlotState` (slotState.js, testé) ; TOUS les lecteurs live (slotHasContent,
   getSlotFaceCount, getSlotOverlapCount, getSlotTooltip, renderTextureTabs) passent
   par `getSlotState` → plus aucune divergence active-vs-stocké. **Reste optionnel**
   (plus gros/risqué) : supprimer carrément les globals miroir
   (`excludedFaces`/`selectionMode`/`settings`/`activeMapEntry`) au profit de l'écriture
   directe dans le slot actif — non requis pour tuer le bug de divergence.
