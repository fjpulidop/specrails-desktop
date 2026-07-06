# Batch implement et multi-fonctionnalité

Une spec à la fois, c'est très bien, mais beaucoup de travail réel arrive par grappes — une fonctionnalité plus ses tests plus sa migration, ou un backlog que vous voulez vider d'une traite. Cette page couvre l'exécution de plusieurs specs ensemble : le mode Batch, les vagues de dépendances, et comment le pipeline empêche le travail concurrent d'entrer en collision.

## Exécuter plusieurs specs à la fois

La façon la plus simple de lancer une pile de specs depuis un seul rail, c'est le mode **Batch** :

1. **Glissez toutes les specs** que vous voulez sur un même rail. Elles s'empilent dans la liste de specs de ce rail.
2. **Basculez le mode du rail sur Batch** (le sélecteur segmenté dans l'en-tête du rail).
3. **Appuyez sur ▶ Play.**

Le rail lance **un** job `/specrails:batch-implement` qui traite chaque spec assignée. Suivez-le comme n'importe quel autre job sur la page Jobs — c'est un seul job couvrant tout l'ensemble, pas un job par spec.

Le mode Batch reste le moyen le plus propre de *séquencer* des specs liées, car il garde leur ordre de dépendances dans un seul rail. Si les specs sont indépendantes, vous pouvez aussi les répartir sur plusieurs rails : les rails adossés à git s'exécutent en parallèle et chacun reçoit son propre worktree isolé.

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

## Isolation par worktree et livraison du travail

Lorsque plusieurs specs sont implémentées en une seule exécution, le pipeline garde chaque unité de travail isolée pour que les changements concurrents ou séquentiels ne piétinent pas les fichiers des autres. L'implémentation de chaque spec s'exécute dans son propre **worktree git** propre — un checkout séparé qui partage l'historique de votre dépôt mais ne touche jamais votre arbre de travail pendant que l'IA travaille.

Lorsque l'exécution se termine, **rien n'est poussé et aucune pull request n'est encore ouverte**. Le travail reste commité en sécurité sur ses branches isolées, les specs passent à un nouveau statut **En relecture**, et specrails **vous demande d'abord** : une barre de décision persistante apparaît sur le rail avec **Créer la PR** — une seule pull request en brouillon à partir de la branche d'intégration désignée de votre projet (définissez-la dans **Réglages → Branche d'intégration** ; par défaut, c'est la branche par défaut de votre dépôt), combinée à travers toutes les specs du rail — et **Abandonner**. specrails **ne fusionne jamais, et ne commite jamais directement sur votre branche d'intégration** — c'est vous qui décidez si une PR existe tout court, et c'est un humain qui décide de la fusion. C'est le passage de relais sûr : specrails produit la pull request seulement quand vous le décidez, et vos ingénieurs la relisent et la fusionnent dans GitHub comme ils le font déjà.

Si vous relancez une spec déjà en relecture avec une pull request ouverte, Specrails traite cela comme un travail de suivi. Il détecte la PR active depuis son propre registre de livraison ou depuis les références GitHub/Jira, checkout la branche head de cette PR, y commite les nouveaux changements et réaffiche la même carte de PR. Le nouveau travail continue de partir de la branche d'intégration.

En pratique, cela signifie :

- Chaque spec part d'une page blanche pour son implémentation, plutôt que d'hériter des modifications en cours de la spec précédente.
- Votre arbre de travail n'est jamais modifié pendant que l'exécution est en cours — rien n'est intégré tant que vous ne l'avez pas décidé.
- Lorsque l'exécution est terminée, les specs affichent un badge **En relecture** et le rail vous pose la question : **Créer la PR** pour ouvrir la pull request en brouillon combinée, ou **Abandonner** pour nettoyer les branches et renvoyer les specs au backlog. Si vous avez lancé le rail depuis le chat de l'agent, la même question apparaît sous forme de carte dans cette conversation — répondez à l'un ou l'autre endroit, les deux restent synchronisés.
- Une fois créée, **Ouvrir la PR** permet de la consulter, **Publier** l'ouvre à la relecture et la confie au processus de relecture GitHub habituel de votre équipe, et **Vérifier le merge** fait passer les specs à Terminé dès que votre équipe l'a fusionnée.
- Si les branches isolées ne peuvent pas être combinées proprement au moment de créer la PR, specrails s'arrête en toute sécurité et laisse les branches à un humain — il ne force jamais une fusion cassée sur votre branche de base. Vous pouvez réessayer ou abandonner depuis la même barre.

> Créer ou continuer une PR nécessite un dépôt git, le CLI GitHub (`gh`) authentifié et un dépôt distant configuré. Sans `gh` ou sans remote, specrails garde quand même le travail commité sur une branche à partir de laquelle vous pouvez ouvrir une pull request vous-même — rien n'est perdu, et la barre de décision vous permet de réessayer. Sans git du tout, il n'existe pas de graphe de branches à continuer : le rail s'exécute dans le dossier partagé et aucune carte de PR n'apparaît. Pour revenir à l'ancien comportement (intégrer en local au lieu de demander), définissez `SPECRAILS_RAIL_DELIVER_PR=0`.

## Multi-fonctionnalité entre projets

Si vous voulez un vrai parallélisme, utilisez plusieurs rails pour des specs indépendantes dans le même projet adossé à git, ou répartissez le travail entre projets. Chaque rail actif reçoit son propre worktree isolé, donc :

```
Projet A   ▶ Rail exécutant la fonctionnalité X   ┐
                                                  ├─ s'exécutent simultanément
Projet B   ▶ Rail exécutant la fonctionnalité Y   ┘
```

Il n'y a aucune limite globale de concurrence à régler. Ouvrez les projets ou rails dont vous avez besoin, lancez-les, et ils progressent ensemble. Le seul régulateur partagé est votre plafond de budget, qui met les files en pause par projet ou pour toute l'application dès que la dépense du jour atteint la limite.

## Conseils pour les gros batchs

- **Regroupez les specs liées sur un seul rail** avant de basculer en Batch — les vagues de dépendances ne voient que ce qui se trouve sur ce rail.
- **Définissez un budget quotidien** avant un gros batch pour qu'une exécution inopinément coûteuse se mette en pause automatiquement au lieu de s'emballer. Configurez-le sous [Budget](../settings/customizing).
- **Utilisez le bouton Comparer** sur la page Jobs ensuite pour comparer deux exécutions de batch côte à côte.
- **Exportez un diagnostic** (si la télémétrie était active) pour obtenir l'instantané exact du profil et des plugins de tout le batch.

## Où aller ensuite

- [Rails et jobs](rails-and-jobs) — le modèle de file d'attente en détail.
- [La vue détaillée du job](the-job-detail-view) — regarder un batch s'exécuter en direct.
- [Choisir un moteur par rail](picking-an-engine-per-rail) — notez que Batch fonctionne sur n'importe quel fournisseur ; Freestyle est réservé à Claude.
