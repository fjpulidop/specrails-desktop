# Rails et jobs

Vos specs sont sur le tableau. C'est ici qu'elles deviennent du code. Un **rail** est la voie qui fait passer une spec à travers tout le pipeline — Architect → Developer → Reviewer → Ship — en exécutant de vrais agents IA directement dans le répertoire de votre projet. Cette page couvre le lancement d'un rail, la file d'attente des jobs, et la possibilité de regarder le travail se dérouler en direct.

## Ce qu'est un rail

Imaginez votre écran coupé en deux :

```
SpecsBoard (gauche)         Rails (droite)
─────────────────            ─────────────────
#1 Login flow      ─┐
#2 Webhook retry    │  glisser sur
#3 Cost limits      │ ────────────►   Rail 1   ▶ Play
#4 Audit log        │
                    └────────────►   Rail 2   ▶ Play
```

Un rail est une **voie d'exécution**. Vous glissez une carte de spec depuis le SpecsBoard sur un rail, puis vous appuyez sur **▶ Play**. Le rail lance le pipeline et traite la spec de bout en bout, directement dans le répertoire de travail de votre projet — en modifiant des fichiers, en lançant des tests, et tout le reste.

Vous pouvez avoir plusieurs rails pour organiser votre travail en voies nommées (une pour la fonctionnalité sur laquelle vous êtes concentré, une autre en attente derrière). Plus de détails sur le multi-rail et le traitement par lots dans [Batch implement et multi-fonctionnalité](batch-implement-and-multi-feature).

## Lancer un rail sur une spec

1. **Glissez une carte de spec** depuis le SpecsBoard sur un rail. L'ID de la spec apparaît dans la liste des specs du rail. (Vous préférez ne pas glisser ? Utilisez la fenêtre **Déplacer vers un rail** sur la carte de spec — elle affiche un point de statut par rail pour que vous ne déposiez pas votre travail sur une voie occupée.)
2. **Choisissez un mode** si vous voulez autre chose que celui par défaut — le sélecteur segmenté dans l'en-tête du rail propose `Implement`, `Batch`, et (rails Claude uniquement) `Ultra`.
3. **Appuyez sur ▶ Play.**

C'est tout. Le rail démarre un processus de CLI IA dans votre projet et lance le pipeline.

### Ce que contient un en-tête de rail

| Contrôle | Ce qu'il fait |
|---------|--------------|
| **Pastille de statut** | `idle`, `running` ou `failed`. Il n'y a pas d'état « completed » distinct — un rail revient à `idle` lorsque son job se termine proprement. |
| **Liste de specs** | Les ID assignés à ce rail. Glissez-en d'autres dedans, glissez-les dehors pour les détacher. |
| **Contrôle de mode** | `Implement` / `Batch` / `Ultra` — voir le tableau ci-dessous. Mémorisé par rail. |
| **Sélecteur de profil** | Quel profil d'agent s'exécute (rails Claude uniquement). N'apparaît qu'une fois que le projet possède au moins un profil. |
| **Sélecteur de moteur** | Quel fournisseur installé exécute ce rail — Claude, Codex ou Gemini. Ne s'affiche que lorsque le projet possède plus d'un fournisseur. Voir [Choisir un moteur par rail](picking-an-engine-per-rail). |
| **▶ Play / ■ Stop** | Démarrer ou annuler. |

### Les trois modes de rail

| Mode | Commande | Ce qu'il fait |
|------|---------|--------------|
| **Implement** | `/specrails:implement` | Un seul job couvrant toutes les specs du rail. Exécute le pipeline complet Architect → Developer → Reviewer → Ship. Le choix par défaut au quotidien. |
| **Batch** | `/specrails:batch-implement` | Un seul job qui traite les specs du rail de manière séquentielle, en vagues tenant compte des dépendances. Idéal pour plusieurs specs liées. |
| **Ultra** | Ultracode | Claude implémente chaque spec de façon autonome, en **contournant** le pipeline. Un job indépendant par spec. Claude uniquement. |

Ultra fait bande à part : il saute la chaîne d'agents et confie à Claude la spec brute pour qu'il la traite avec ses outils natifs. C'est ouvert et sans contraintes, donc appuyer sur Play ouvre d'abord une confirmation, et un sélecteur de modèle par rail vous laisse choisir Haiku / Sonnet / Opus. Il n'apparaît que lorsque le moteur du rail est Claude.

## La file d'attente des jobs

Chaque fois que vous appuyez sur Play, l'exécution du rail devient un **job**. La règle la plus importante à intégrer :

> **Un job à la fois, par projet.** Chaque projet a une seule file d'attente. Au sein d'un même projet, un seul job de rail s'exécute à la fois — les autres attendent derrière et démarrent automatiquement à mesure que des créneaux se libèrent.

Cela surprend les gens qui ajoutent trois rails en s'attendant à ce qu'ils s'exécutent en parallèle. Ce ne sera pas le cas — pas au sein du même projet. Ajouter des rails *organise* votre travail en voies ; cela ne rend pas ces voies concurrentes.

**Le vrai parallélisme se fait entre projets.** Chaque projet possède sa propre file d'attente indépendante, donc un rail dans le Projet A et un rail dans le Projet B s'exécutent en même temps sans se gêner. Vous voulez plus de débit ? Ouvrez plus de projets.

Il n'y a aucun réglage global de concurrence à ajuster. Le seul régulateur automatique est basé sur le budget : si vous avez défini un budget quotidien (par projet ou pour toute l'application), la file se met automatiquement en pause dès que la dépense du jour atteint le plafond.

## Regarder l'exécution

Retrouvez chaque job sous **Jobs** dans la barre latérale droite du projet — une liste de cartes, les plus récentes en premier. Chaque carte affiche un badge de statut, le badge de profil, un badge de priorité, la durée, le coût et la commande lancée. Au-dessus de la liste :

- **Puces de filtre par statut** — n'affichent que les jobs dans un statut donné.
- **Filtre par plage de dates** — restreint à une fenêtre temporelle.
- **Comparer** — choisissez deux jobs et affichez-les côte à côte.

Cliquez sur n'importe quelle carte pour ouvrir la **vue détaillée du job**, où vivent le log en streaming et les métriques en direct. C'est la page suivante : [La vue détaillée du job](the-job-detail-view).

## Annuler un job

Cliquez sur **■ Stop** dans l'en-tête du rail. L'application envoie `SIGTERM` au sous-processus, attend **5 secondes** une sortie propre, puis le `SIGKILL`. Rien n'est laissé à moitié démarré.

## Si un rail refuse de se lancer

Si vous choisissez un moteur dont la CLI n'est pas installée sur votre machine, le lancement **échoue immédiatement** au lieu de démarrer un job cassé — rien ne démarre. Installez la CLI du fournisseur manquant ([Utiliser Codex](../integrations/using-codex), [Utiliser Gemini](../integrations/using-gemini)) et relancez. Une CLI Claude ou Codex manquante donne un message précis « *&lt;provider&gt; CLI not found* » ; une CLI Gemini manquante affiche aujourd'hui une erreur de lancement générique, mais le résultat est le même.

## Tout arrêter

Si quelque chose semble anormal :

- **Un seul rail** — cliquez sur **■ Stop** dans son en-tête.
- **Pause auto sur budget** — définissez un budget quotidien et la file se met elle-même en pause lorsque la dépense du jour atteint le plafond.
- **Tout** — quittez l'application desktop, ou exécutez `specrails-desktop stop`.

## Où aller ensuite

- [La vue détaillée du job](the-job-detail-view) — phases, métriques en direct, cartes de ticket.
- [Batch implement et multi-fonctionnalité](batch-implement-and-multi-feature) — exécuter plusieurs specs à la fois.
- [Choisir un moteur par rail](picking-an-engine-per-rail) — Claude vs Codex vs Gemini.
