# BumpForge

*Fork de [CNCKitchen/stlTexturizer](https://github.com/CNCKitchen/stlTexturizer)
(BumpMesh, Stefan Hermann) — voir « Amont et licence » en bas. English speakers:
this is a French-documented fork; the upstream project is at the link above.*

Application **Electron** de **texturisation par displacement** pour maquettes et
dioramas imprimés en **FDM**. On charge un modèle nu, on lui grave des reliefs à
partir de cartes de hauteur (pierre, bois, tuile, torchis…), et on exporte un STL
déplacé prêt à trancher.

Ce que le fork ajoute à l'amont, et pourquoi :

| | |
|---|---|
| **Multi-slots** | Un bâtiment n'a pas *une* matière. Un slot = une carte + une sélection de faces ; l'export les applique en une passe, sans double déplacement aux frontières. |
| **Wood mapping orienté** | Le fil du bois suit l'axe **propre de la pièce** (PCA par slot), pas un axe du monde — une poutre inclinée n'a plus un veinage de travers. |
| **Interop FreeCAD** | Import **STEP direct**, sélections ancrées aux **faces BREP** (elles survivent aux re-exports), lien vif, slots créés depuis les couleurs, matières mémorisées par couleur. |
| **Audit d'impression** | Avant écriture : topologie du maillage exporté et épaisseur de paroi restante après creusement. |
| **Export sans interface** | `npm run export -- projet.bforge` — un projet, ou un lot. |
| **Electron** | Fichiers sur disque, lien vif avec FreeCAD, récupération après crash. |

## Démarrer

```bash
npm install
npm start
```

Node ≥ 20 et une machine avec WebGL. L'app est en JS **vanilla**, sans framework
ni bundler : `index.html` charge `js/` en modules ES.

## Le flux FreeCAD, en un geste

C'est le cœur du fork et il tient en une boucle :

1. **FreeCAD** — commande *FW Coloriser*, puis *Lier à BumpForge* : la sélection
   et le fichier `.step` cible sont mémorisés dans le document.
2. **BumpForge** — déposer le `.step` une fois. Les slots sont créés depuis les
   couleurs, faces déjà assignées ; les matières déjà mémorisées reviennent avec
   leur nom.
3. **Ctrl+S dans FreeCAD** — le STEP se ré-exporte, BumpForge se recharge et
   ré-apparie les sélections tout seul.

Détail complet, contrat des clés de faces et pièges : **[INTEROP_FREECAD.md](INTEROP_FREECAD.md)**.

## Export en ligne de commande

```bash
npm run export -- projet.bforge                    # un projet
npm run export -- a.bforge b.bforge c.bforge       # un lot
```

Écrit `<nom>_all_slots.stl` à côté de chaque projet, avec l'audit d'impression en
sortie. Tout est partagé avec l'application, jusqu'aux octets du STL — le fichier
produit est celui qu'aurait écrit la GUI.

⚠️ Deux limites, dites plutôt qu'approximées : le **flou de texture**
(`textureSmoothing > 0`) est refusé — c'est un filtre Canvas2D qu'aucune
bibliothèque Node ne reproduit au pixel près ; et la **variation par pièce** est
ignorée, parce que l'application l'ignore aussi sur ce chemin d'export.

## Tests

```bash
npm test          # 36 harnais headless, golden-master compris
npm run test:e2e  # Playwright-Electron : l'app réelle
```

`npm test` tourne **sans DOM ni Electron** (Node + `three` épinglé) et est lancé
à chaque commit par `.githooks/pre-commit` — à activer une fois par clone :

```bash
git config core.hooksPath .githooks
```

La règle du dépôt : **toute empreinte golden qui change est une régression**,
sauf changement voulu — auquel cas `npm run test:golden:update`, avec la
justification dans le message de commit.

## Documentation

| | |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Architecture module par module, pièges mesurés, workflow de test. Le document à lire en premier. |
| [INTEROP_FREECAD.md](INTEROP_FREECAD.md) | Les deux pipelines FreeCAD, contrat des clés de faces, lien vif, auto-slots. |
| [REFACTOR.md](REFACTOR.md) | Méthode du refacto de `main.js`, journal des extractions. |
| [SAVE_AUDIT.md](SAVE_AUDIT.md) · [AUDIT.md](AUDIT.md) | Audits sauvegarde/persistance et slots. |
| [TODOS.md](TODOS.md) | Ce qui reste, avec les mesures qui le justifient. |

## Amont et licence

Ce dépôt est un fork de **stlTexturizer / BumpMesh**, de **Stefan Hermann**
(CNC Kitchen) — https://bumpmesh.com. Le moteur de displacement, la
subdivision adaptative, l'échelle absolue en millimètres et les courbes de
lissage du masque viennent de là ; le multi-slot, le Wood mapping orienté,
l'interop FreeCAD, l'audit d'impression et l'export en ligne de commande sont
des ajouts du fork.

**AGPL v3** (voir [LICENSE](LICENSE)) — Copyright (C) 2026 CNCKitchen
(Stefan Hermann). Le vendoring de [meshStep](https://github.com/CNCKitchen/meshStep)
dans `js/vendor/meshstep/` est sous la même licence.
