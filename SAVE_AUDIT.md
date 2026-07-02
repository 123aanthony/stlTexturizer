# Audit — Sauvegarde / persistance / UX

Audit lecture-seule (juin 2026), centré sur l'expérience autour de la sauvegarde.
Chaque point : **constat** (ancré `main.js:ligne`) → **écart aux bonnes pratiques**
→ **reco**. Priorité = rentabilité ↓ risque ↑.

## Ce qui est déjà bon (à garder)
- Garde « unsaved changes » sur New / Open / charger un modèle (`confirmDiscardUnsavedChanges`,
  appelée en :2938, :2954, :2960, :7589, :7668). ✅
- Indicateur *dirty* : `*` dans le titre + chip, bascule de classe (:7158-7172). ✅
- `beforeunload` bloque la fermeture si sale (:7705). ✅
- Raccourcis Ctrl+S / Ctrl+Shift+S / Ctrl+O (:7690). ✅
- `isRestoringProject` / `_undoApplyDepth` gardent le *dirty* pendant les restores
  programmatiques (:7176). ✅

---

## 🔴 P1 — Forte valeur

### A. L'« auto-save » n'est PAS une récupération après crash — ✅ CORRIGÉ
> Récupération durable ajoutée : brouillon projet COMPLET (modèle+slots+réglages,
> `buildProjectBytes`) écrit en **IndexedDB** (`idbStore.js`), débouncé 6 s sur
> changement, en idle. À la réouverture, bannière « Projet non enregistré récupéré »
> → Restaurer (via `importProject`) / Ignorer. Effacé sur save explicite / New. Logique
> de décision pure et testée (`recovery.js` + `test/recovery.mjs`).

_Constat d'origine :_
`_autoSaveSettings` (:7359) écrit dans **sessionStorage** (:7366) et ne sérialise que
`getSettingsSnapshot()` — **ni le modèle, ni les faces des slots**. sessionStorage est
**effacé à la fermeture de l'app**. Donc après un crash/fermeture, on récupère au mieux
des réglages **posés sur le cube par défaut** (`_restoreSessionSettings` :7371 n'a pas le
modèle) → état incohérent.
- **Bonne pratique** : récupération = snapshot **complet** (modèle + slots + réglages) en
  stockage **durable** (IndexedDB, pas sessionStorage), proposé à la réouverture
  (« Reprendre le projet non sauvegardé ? »).
- **Reco** : auto-save périodique du **payload projet complet** (`buildProjectPayload`,
  déjà existant !) dans IndexedDB, débouncé (~2–5 s). À l'ouverture, si un brouillon plus
  récent que le dernier `.bforge` existe → bannière de récupération. Garder sessionStorage
  comme repli réglages-seuls.

### B. Aucun retour visuel après une sauvegarde réussie — CONFIRMÉ
`saveProjectToPath` (:7534) appelle `markProjectClean` (le `*` disparaît) mais **aucun
toast / confirmation**. Pour le profil matériau, seulement `console.log` (:2149). L'utilisateur
clique « Save » et ne sait pas si ça a marché (surtout en export navigateur où c'est un
download silencieux).
- **Bonne pratique** : feedback non bloquant (toast « Projet enregistré » + chemin), 2–3 s.
- **Reco** : un petit système de toast réutilisable (succès/erreur), branché sur save /
  export / load. Remplace aussi les `alert()` d'erreur (point D).

### C. Pas de garde « sauvegarde en cours » — CONFIRMÉ
Aucun `disabled`/`isSaving` autour de `saveProject` (recherche vide). Double Ctrl+S ou
double-clic → deux `zipSync` + écritures concurrentes sur le même fichier.
- **Bonne pratique** : sérialiser les opérations d'I/O ; désactiver le bouton + curseur
  d'attente pendant l'écriture.
- **Reco** : verrou `_saveInProgress` (early-return), bouton désactivé + état « Enregistrement… »
  le temps du `await`.

---

## 🟠 P2 — Valeur moyenne, risque contenu

### D. Dialogues natifs `confirm()` / `alert()` partout — CONFIRMÉ
`confirmDiscardUnsavedChanges` = `confirm()` (:7201) ; erreurs = `alert()` (:7675-7702).
Bloquants, non stylés, hors charte ; en Electron ça fait « page web », pas « app ».
- **Bonne pratique (desktop)** : à la fermeture/New/Open avec modifs → dialogue **3 voies**
  « Enregistrer / Ne pas enregistrer / Annuler », pas un OK/Cancel « on jette ? ».
- **Reco** : dialogue applicatif 3 boutons (modale stylée ou `dialog` Electron natif via IPC).
  Le « Annuler » évite la perte par réflexe.

### E. `beforeunload` ne peut pas proposer d'enregistrer — CONFIRMÉ
:7705 ne fait que déclencher l'avertissement générique du navigateur. L'utilisateur doit
annuler, enregistrer à la main, re-fermer.
- **Bonne pratique (Electron)** : intercepter `close` côté main process → dialogue 3 voies →
  enregistrer puis fermer si demandé.
- **Reco** : si l'IPC Electron est dispo, gérer la fermeture par le main process (point D) ;
  garder `beforeunload` comme filet pour le mode navigateur.

### F. Fenêtre aveugle de 2 s au démarrage — CONFIRMÉ
`projectDirtyTrackingEnabled` passe à `true` après **2000 ms** fixes (:7130). Toute édition
avant 2 s **ne marque pas le projet sale** → risque de perte silencieuse (modèle lourd =
init > 2 s, ou utilisateur rapide).
- **Bonne pratique** : borner explicitement l'init (drapeau autour de la séquence de boot),
  pas un délai magique.
- **Reco** : activer le tracking à la **fin** de la séquence d'init (après le 1er render /
  restore), pas sur un timer.

### G. Trois systèmes de persistance qui se chevauchent — CONFIRMÉ
(1) auto-save sessionStorage réglages-seuls ; (2) projet `.bforge` (modèle+slots+réglages) ;
(3) « Save/Load Material » profil **par slot** (:2136/:2385). Payloads différents, périmètres
différents, noms proches → confusion (« j'ai sauvé mon matériau mais pas mon projet »).
- **Bonne pratique** : un modèle mental clair — *Projet* (tout) vs *Préréglage/Matériau*
  (réutilisable) vs *récupération* (invisible). Vocabulaire et emplacements UI distincts.
- **Reco** : regrouper visuellement « Projet : New/Open/Save/Save As » d'un côté ; « Matériau :
  Save/Load » clairement étiqueté « préréglage réutilisable » ; la récupération reste invisible.

---

## 🟡 P3 — Finitions

### H. `markProjectDirty` rafraîchit le chrome à chaque tick — CONFIRMÉ
:7175 fait `projectDirty = true; updateProjectChrome();` sans garde « déjà sale ». Pendant un
drag de slider, chaque `input` ré-écrit `document.title` **et** un IPC `setWindowTitle`
(:7164) → bavard.
- **Reco** : early-return si `projectDirty` est déjà vrai (le chrome ne change pas).

### I. `PROJECT_VERSION = 1` sans échafaudage de migration — CONFIRMÉ
:7122 ; les loaders lisent le payload sans aiguillage par version.
- **Reco** : prévoir un `migrate(payload)` par version dès maintenant (peu coûteux, évite la
  dette quand le format évoluera).

### J. Détails
- `getSettingsSnapshot` exclut `useDisplacement` (transient) — OK, mais documenter pourquoi
  certains champs sont persistés et d'autres non (liste `PERSISTED_KEYS` :7205).
- Le download navigateur (`_downloadBlob`, :7549) fait `markProjectClean(null)` → le projet
  est « propre » mais sans chemin → un Ctrl+S suivant redéclenche « Save As ». Cohérent mais
  à signaler dans l'UI (« téléchargé, non lié à un fichier »).

---

## Ordre de correction conseillé
1. **B + C** (toast succès + verrou save) — petits, gros confort, base pour D. ✅ FAIT
   (showToast + #toast-stack ; verrou `_saveInProgress` ; toasts succès/erreur sur save)
2. **H + F** (early-return dirty ; fin-d'init au lieu du timer) — robustesse, peu de risque. ✅ FAIT
3. **A** (récupération IndexedDB du projet complet) — le plus utile, plus de travail. ✅ FAIT
4. **D + E** (dialogue 3 voies + close Electron) — qualité « app ». ✅ FAIT
   (D : modal stylé Enregistrer/Ne pas/Annuler pour New/Open, `confirmDiscardUnsavedChanges`
   enchaîne le save. E : `electron-main` intercepte `close` → dialogue natif 3 voies →
   demande au renderer de sauver puis ferme ; `beforeunload` neutralisé en Electron pour
   éviter le double prompt. IPC set-dirty/set-close-prompt/app-save-request/app-save-done.)
5. **G + I + J** — clarté & dette.
