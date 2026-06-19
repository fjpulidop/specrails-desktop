# Batch implement et multi-fonctionnalité

Une spec à la fois, c'est très bien, mais beaucoup de travail réel arrive par grappes — une fonctionnalité plus ses tests plus sa migration, ou un backlog que vous voulez vider d'une traite. Cette page couvre l'exécution de plusieurs specs ensemble : le mode Batch, les vagues de dépendances, et comment le pipeline empêche le travail concurrent d'entrer en collision.

## Exécuter plusieurs specs à la fois

La façon la plus simple de lancer une pile de specs depuis un seul rail, c'est le mode **Batch** :

1. **Glissez toutes les specs** que vous voulez sur un même rail. Elles s'empilent dans la liste de specs de ce rail.
2. **Basculez le mode du rail sur Batch** (le sélecteur segmenté dans l'en-tête du rail).
3. **Appuyez sur ▶ Play.**

Le rail lance **un** job `/specrails:batch-implement` qui traite chaque spec assignée. Suivez-le comme n'importe quel autre job sur la page Jobs — c'est un seul job couvrant tout l'ensemble, pas un job par spec.

C'est important à cause de la **file d'attente d'un job par projet**. Puisqu'un projet n'exécute qu'un job de rail à la fois, le mode Batch est aussi le moyen le plus propre d'*enchaîner* une liste de specs sans jongler avec plusieurs rails ni attendre que chacun se vide.

### Implement vs Batch — quel mode ?

| | **Implement** | **Batch** |
|---|---|---|
| Commande | `/specrails:implement` | `/specrails:batch-implement` |
| Specs par job | Toutes celles du rail, traitées comme une seule unité de travail | Toutes celles du rail, traitées **séquentiellement** |
| Idéal pour | Un changement fortement couplé | Plusieurs fonctionnalités distinctes que vous voulez traiter dans l'ordre |
| Ordonnancement | s/o | Vagues tenant compte des dépendances (voir ci-dessous) |

Si les specs ne forment réellement qu'un seul changement, utilisez **Implement**. Si c'est une liste de fonctionnalités séparées, utilisez **Batch** et laissez-le les séquencer.

## Vagues de dépendances

Le mode Batch ne se contente pas d'exécuter les specs de haut en bas — il calcule un **ordre d'exécution tenant compte des dépendances** et regroupe les specs en *vagues*. L'orchestrateur (`/specrails:batch-implement`) détermine quelles specs dépendent de quelles autres, puis les planifie de sorte que rien ne s'exécute avant le travail sur lequel il s'appuie.

Conceptuellement :

```
Vague 1 :  #2 (modèle de données)   ← aucune dépendance, s'exécute en premier
Vague 2 :  #4 (API sur le modèle)   ← attend #2
           #5 (CLI sur le modèle)   ← attend #2
Vague 3 :  #7 (docs sur l'ensemble) ← attend #4 et #5
```

Au sein du job, les specs de chaque vague sont implémentées avant que la vague suivante ne commence. Vous ne configurez rien à la main — l'orchestrateur déduit les vagues à partir des specs elles-mêmes. Regardez-le se dérouler dans la [vue détaillée du job](the-job-detail-view) : le log en streaming raconte sur quelle spec le batch travaille, et l'en-tête de ticket affiche chaque spec touchée par le job.

## Isolation par worktree

Lorsque plusieurs specs sont implémentées en une seule exécution, le pipeline garde chaque unité de travail isolée pour que les changements concurrents ou séquentiels ne piétinent pas les fichiers des autres. L'orchestrateur de batch exécute l'implémentation de chaque spec dans son propre contexte de travail propre, puis intègre les résultats — ainsi une spec à moitié finie ne laisse jamais votre arbre dans un état intermédiaire cassé et visible par la suivante.

En pratique, cela signifie :

- Chaque spec part d'une page blanche pour son implémentation, plutôt que d'hériter des modifications en cours de la spec précédente.
- Les relectures et les étapes de ship opèrent sur un instantané cohérent, pas sur une cible mouvante.
- Un échec dans une vague est contenu — il ne corrompt pas silencieusement les specs déjà livrées.

L'application enregistre, par job, exactement quels fichiers ont été touchés et quel ticket les a touchés (vous verrez cela apparaître sous forme de puces de provenance dans la section **Code** et de liste « Fichiers touchés par ce ticket » dans la fenêtre de détail de chaque spec). Cette attribution est ce qui vous permet de faire confiance à une exécution multi-spec : vous pouvez toujours remonter d'une modification de fichier jusqu'à la spec qui l'a provoquée.

## Multi-fonctionnalité entre projets

Si vous voulez un vrai parallélisme — deux grosses fonctionnalités qui se construisent en même temps — répartissez-les **entre projets**, pas entre rails d'un même projet. Chaque projet possède sa propre file d'attente indépendante, donc :

```
Projet A   ▶ Rail exécutant la fonctionnalité X   ┐
                                                  ├─ s'exécutent simultanément
Projet B   ▶ Rail exécutant la fonctionnalité Y   ┘
```

Il n'y a aucune limite globale de concurrence et aucune contention entre projets. Ouvrez les deux, lancez un rail dans chacun, et ils progressent ensemble. Le seul régulateur partagé est votre plafond de budget, qui met les files en pause par projet ou pour toute l'application dès que la dépense du jour atteint la limite.

## Conseils pour les gros batchs

- **Regroupez les specs liées sur un seul rail** avant de basculer en Batch — les vagues de dépendances ne voient que ce qui se trouve sur ce rail.
- **Définissez un budget quotidien** avant un gros batch pour qu'une exécution inopinément coûteuse se mette en pause automatiquement au lieu de s'emballer. Configurez-le sous [Budget](../settings/customizing).
- **Utilisez le bouton Comparer** sur la page Jobs ensuite pour comparer deux exécutions de batch côte à côte.
- **Exportez un diagnostic** (si la télémétrie était active) pour obtenir l'instantané exact du profil et des plugins de tout le batch.

## Où aller ensuite

- [Rails et jobs](rails-and-jobs) — le modèle de file d'attente en détail.
- [La vue détaillée du job](the-job-detail-view) — regarder un batch s'exécuter en direct.
- [Choisir un moteur par rail](picking-an-engine-per-rail) — notez que Batch fonctionne sur n'importe quel fournisseur ; Ultra est réservé à Claude.
