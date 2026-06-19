# La vue détaillée du job

Cliquez sur n'importe quelle carte de job de la page **Jobs** et vous arrivez ici : le poste de pilotage d'une exécution de rail unique. Tout repose sur une promesse — **les chiffres en direct que vous voyez sont réels, jamais des estimations.** Cette page parcourt les phases, les métriques en direct et les cartes de ticket.

## La disposition

Deux panneaux se trouvent au-dessus du log en streaming complet :

```
┌─────────────────────────────────────────────┐
│  En-tête de statut (icône · durée en direct · …)  │
├─────────────────────────────────────────────┤
│  En-tête de ticket ( #12  #14  #15 )        │
├─────────────────────────────────────────────┤
│                                             │
│  Log en streaming (auto-défilement · recherche · …)  │
│                                             │
└─────────────────────────────────────────────┘
```

## Les phases du pipeline

Pour les jobs `Implement` et `Batch`, l'exécution traverse les phases définies par la slash command — par défaut :

```
Architect ──► Developer ──► Reviewer ──► Ship
```

Chaque phase est un agent spécialisé que le moteur du rail invoque dans le répertoire de votre projet :

| Phase | Agent | Ce qu'il fait |
|-------|-------|--------------|
| **Architect** | `sr-architect` | Planifie l'implémentation. |
| **Developer** | `sr-developer` | Écrit le code. |
| **Reviewer** | `sr-reviewer` | Relit le résultat. |
| **Ship** | (variable) | Finalisation : tests, commit, brouillon de PR. |

Quel agent gère chaque phase est décidé par le **profil d'agent** du projet. Le trio de base (`sr-architect`, `sr-developer`, `sr-reviewer`) est toujours présent ; les règles de routage d'un profil peuvent ajouter des agents ou changer celui qui exécute une phase. La barre de progression des phases n'apparaît que lorsque la commande définit réellement des phases — les jobs Ultracode (qui contournent le pipeline) n'en affichent pas.

## Métriques en direct — honnêtes par conception

L'en-tête de statut est la vedette. Il affiche une icône de statut, une ligne d'activité décrivant ce que le job fait *en ce moment même*, un compteur des étapes effectuées, et une ligne de métriques :

| Métrique | Quand vous voyez la vraie valeur |
|--------|------------------------------|
| **Durée** | **En direct.** Un compteur d'une seconde s'incrémente pendant l'exécution du job — c'est le seul chiffre véritablement en direct. |
| **Tours** | Dérivés de façon incrémentale des événements d'assistant streamés à mesure qu'ils arrivent. |
| **Tokens** | Agrégés de façon incrémentale depuis ce même flux (tolérant aux événements dépourvus de champs d'usage). |
| **Coût** | Affiché comme `—` jusqu'à la sortie du job, puis révélé comme le `total_cost_usd` faisant autorité. |

Le principe de conception : **aucun chiffre approximatif ou estimé en cours d'exécution.** La durée est réelle car ce n'est qu'une horloge. Les tours et les tokens sont accumulés à partir d'une activité réellement streamée. Le coût n'est délibérément *pas* estimé pendant l'exécution — il s'affiche comme en attente et ne se résout en son chiffre final et faisant autorité que lorsque le fournisseur le rapporte à la sortie du job. Si un chiffre semble en attente, c'est intentionnel — on vous montre la vérité, pas une projection.

Le libellé et l'icône de l'en-tête correspondent au statut du job, et le panneau s'affiche aussi bien pour les jobs `running`, `completed` que `failed` — ainsi la vue détaillée d'un job terminé montre les mêmes métriques figées sur leurs valeurs finales.

## Les cartes de ticket

L'**en-tête de ticket** se trouve entre l'en-tête de statut et le log. C'est une carte d'identité premium qui affiche une puce pour chaque spec touchée par le job — issues de la commande lancée, donc elle reflète exactement quels tickets concernait cette exécution.

- **2 à 3 tickets** — affichés sous forme de liste de puces.
- **4 ou plus** — repliés en un mode compact `+ N de plus` avec un chevron de dépliage, pour que l'en-tête reste net.

Cliquer sur une puce ouvre le détail de cette spec **par-dessus la page du job** — vous ne perdez pas votre place et ne changez pas de route. C'est un moyen rapide de relire ce qu'un job est censé livrer pendant que vous le regardez travailler. (Sur les écrans de largeur tablette, vous pouvez même glisser une fenêtre de ticket sur le côté pour comparer deux specs côte à côte.)

## Le log en streaming

Sous les panneaux se trouve le log complet de l'exécution, streamé en temps réel via le WebSocket :

- **L'auto-défilement** garde la sortie la plus récente en vue (faites défiler vers le haut et il se met en pause pour vous laisser lire).
- **Recherche** pour sauter à une expression.
- **Copier** pour récupérer tout le log.

C'est la vérité brute de ce que fait l'IA — chaque appel d'outil, chaque modification de fichier, chaque exécution de test.

## Export de diagnostic

Si la [télémétrie](../settings/customizing) était activée pour le job, un bouton **Exporter le diagnostic** apparaît dans l'en-tête. Il télécharge un ZIP contenant :

- `job-metadata.json` — commande, statut, profil, plugins.
- `telemetry.ndjson` — signaux OTLP/JSON non compressés.
- `logs.txt` — le log en streaming complet.
- `summary.md` — points saillants en clair.
- `profile.json`, `plugins.json` — instantanés exacts de ce qui s'est exécuté (lorsque présents).

Pratique pour partager une exécution avec un coéquipier, ou pour déposer un rapport de bug précis.

## Où aller ensuite

- [Rails et jobs](rails-and-jobs) — lancement et mise en file.
- [Batch implement et multi-fonctionnalité](batch-implement-and-multi-feature) — plusieurs specs, vagues de dépendances.
- [Suivre le coût](../analytics/tracking-cost) — transformer les coûts par job en analytics de projet.
