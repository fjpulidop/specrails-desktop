# Rails et jobs

Vous avez des specs sur le tableau. C'est ici qu'ils se transforment en code. Un **rail** est la voie qui conduit un spec à travers tout le pipeline — Architect → Developer → Reviewer → Ship — en exécutant de vrais agents IA à l'intérieur du répertoire de votre projet. Cette page couvre le lancement d'un rail, la file d'attente des jobs et le suivi du travail en direct.

## Ce qu'est un rail

Imaginez votre écran divisé en deux :

```
SpecsBoard (gauche)         Rails (droite)
─────────────────            ─────────────────
#1 Login flow      ─┐
#2 Webhook retry    │  glisser sur
#3 Cost limits      │ ────────────►   Rail 1   ▶ Play
#4 Audit log        │
                    └────────────►   Rail 2   ▶ Play
```

Un rail est une **voie d'exécution**. Vous glissez une carte de spec depuis le SpecsBoard sur un rail, puis vous appuyez sur **▶ Play**. Le rail lance le pipeline et travaille le spec de bout en bout, directement dans le répertoire de travail de votre projet — en éditant des fichiers, en lançant des tests, tout y passe.

Vous pouvez avoir plusieurs rails pour organiser le travail en voies nommées (une pour la fonctionnalité sur laquelle vous êtes concentré, une autre en attente derrière). Plus de détails sur le multi-rail et le batching dans [Batch implement et multi-fonctionnalité](batch-implement-and-multi-feature).

## Lancer un rail sur un spec

1. **Glissez une carte de spec** depuis le SpecsBoard sur un rail. L'ID du spec apparaît dans la liste de specs du rail. (Vous préférez ne pas glisser ? Utilisez le popover **Move to rail** sur la carte de spec — il affiche un point de statut par rail pour que vous ne déposiez pas de travail sur une voie occupée.)
2. **Choisissez un Loop** dans l'en-tête du rail. Un rail exécute un **Loop** — c'est le travail qu'il effectue. Par défaut, c'est le Loop intégré `Implement` ; vous pouvez aussi choisir `Batch`, `Ultracode`, ou un loop personnalisé que vous avez construit vous-même. Voir [Le Loop Builder](the-loop-builder).
3. **Appuyez sur ▶ Play.**

Voilà. Le rail démarre un processus AI CLI dans votre projet et lance le pipeline.

### Ce que contient l'en-tête d'un rail

| Contrôle | Ce qu'il fait |
|---------|--------------|
| **Pastille de statut** | `idle`, `running`, ou `failed`. Il n'y a pas de « completed » séparé — un rail revient à `idle` quand son job se termine proprement. |
| **Liste de specs** | Les IDs assignés à ce rail. Glissez-en d'autres, retirez-les pour les détacher. |
| **Sélecteur de Loop** | Le Loop que ce rail exécute — un intégré (`Implement` / `Batch` / `Ultracode`) ou un loop personnalisé. Voir le tableau ci-dessous. Persisté par rail. |
| **Sélecteur de profil** | Quel profil d'agent s'exécute (rails Claude uniquement). N'apparaît que lorsque le projet a au moins un profil. |
| **Sélecteur de moteur** | Quel provider installé exécute ce rail — Claude, Codex, ou Gemini. Ne s'affiche que lorsque le projet a plus d'un provider. Voir [Choisir un moteur par rail](picking-an-engine-per-rail). |
| **▶ Play / ■ Stop** | Démarrer ou annuler. |

### Ce qu'un rail exécute : les Loops

Un rail exécute un **Loop** — la recette du travail. Trois loops sont **intégrés** et couvrent les cas courants :

| Loop intégré | Commande | Ce qu'il fait |
|------|---------|--------------|
| **Implement** | `/specrails:implement` | Un seul job couvrant tous les specs du rail. Exécute tout le pipeline Architect → Developer → Reviewer → Ship. Le choix par défaut au quotidien. |
| **Batch** | `/specrails:batch-implement` | Un seul job qui traite les specs du rail séquentiellement, en vagues tenant compte des dépendances. Idéal pour plusieurs specs liés. |
| **Ultracode** | Ultracode | Claude implémente chaque spec de manière autonome, en **contournant** le pipeline. Un job indépendant par spec. Claude uniquement. |

Ultracode est le cas à part : il saute la chaîne d'agents et confie le spec brut à Claude pour qu'il travaille avec ses outils natifs. C'est ouvert, donc appuyer sur Play ouvre d'abord une confirmation, et un sélecteur de modèle par rail vous laisse choisir Haiku / Sonnet / Opus. Il n'apparaît que lorsque le moteur du rail est Claude.

Au-delà des intégrés, vous pouvez **construire vos propres loops** — répéter un cycle verify → fix → verify jusqu'à ce qu'un objectif soit atteint, enchaîner des commandes shell entre les étapes IA, et plus encore. Ces loops personnalisés apparaissent dans le même sélecteur de Loop. C'est la prochaine grande idée : [Le Loop Builder](the-loop-builder).

## La file d'attente des jobs

Chaque fois que vous appuyez sur Play, l'exécution du rail devient un **job**. La règle la plus importante à intégrer :

> **Un seul job à la fois, par projet.** Chaque projet a une file d'attente unique. Au sein d'un projet, un seul job de rail s'exécute à la fois — les autres font la queue derrière et démarrent automatiquement à mesure que des créneaux se libèrent.

Cela surprend ceux qui ajoutent trois rails en s'attendant à ce qu'ils s'exécutent en parallèle. Ils ne le feront pas — pas à l'intérieur du même projet. Ajouter des rails *organise* votre travail en voies ; cela ne fait pas tourner ces voies simultanément.

**Le vrai parallélisme se fait entre projets.** Chaque projet a sa propre file d'attente indépendante, donc un rail dans le Projet A et un rail dans le Projet B s'exécutent en même temps sans se disputer les ressources. Vous voulez plus de débit ? Ouvrez plus de projets.

Il n'y a pas de réglage de concurrence global à ajuster. Le seul frein automatique est basé sur le budget : si vous avez défini un budget quotidien (par projet ou pour toute l'app), la file s'auto-suspend dès que la dépense du jour atteint le plafond.

## Suivre l'exécution

Retrouvez chaque job sous **Jobs** dans la barre latérale droite du projet — une liste de cartes, la plus récente en premier. Chaque carte affiche un badge de statut, le badge de profil, un badge de priorité, la durée, le coût et la commande lancée. Au-dessus de la liste :

- **Pastilles de filtre par statut** — n'affichent que les jobs dans un statut donné.
- **Filtre par plage de dates** — restreint à une fenêtre temporelle.
- **Compare** — choisissez deux jobs et affichez-les côte à côte.

Cliquez sur n'importe quelle carte pour ouvrir la **vue détaillée du job**, où se trouvent le log en streaming en direct et les métriques en direct. C'est la page suivante : [La vue détaillée du job](the-job-detail-view).

## Annuler un job

Cliquez sur **■ Stop** dans l'en-tête du rail. L'app envoie `SIGTERM` au sous-processus, attend **5 secondes** une sortie propre, puis le `SIGKILL`. Rien ne reste à moitié démarré.

## Si un rail ne se lance pas

Si vous choisissez un moteur dont le CLI n'est pas installé sur votre machine, le lancement **échoue immédiatement** au lieu de démarrer un job cassé — rien ne démarre. Installez le CLI du provider manquant ([Utiliser Codex](../integrations/using-codex), [Utiliser Gemini](../integrations/using-gemini)) et relancez. Un Claude ou Codex manquant donne un message précis « *&lt;provider&gt; CLI not found* » ; un Gemini manquant fait apparaître une erreur de lancement générique aujourd'hui, mais le résultat est le même.

## Tout arrêter

Si quelque chose semble anormal :

- **Un seul rail** — cliquez sur **■ Stop** dans son en-tête.
- **Auto-suspension sur budget** — définissez un budget quotidien et la file se suspend d'elle-même quand la dépense du jour atteint le plafond.
- **Tout** — quittez l'application desktop, ou lancez `specrails-desktop stop`.

## Où aller ensuite

- [Le Loop Builder](the-loop-builder) — ce qu'un rail exécute, et comment construire vos propres loops.
- [La vue détaillée du job](the-job-detail-view) — phases, métriques en direct, cartes de ticket.
- [Batch implement et multi-fonctionnalité](batch-implement-and-multi-feature) — exécutez plusieurs specs à la fois.
- [Choisir un moteur par rail](picking-an-engine-per-rail) — Claude vs Codex vs Gemini.
