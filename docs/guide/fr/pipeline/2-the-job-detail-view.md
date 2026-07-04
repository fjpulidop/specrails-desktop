# La vue détaillée du job

Cliquez sur n'importe quelle carte de job de la page **Jobs** et vous arrivez ici : le poste de pilotage d'une exécution de rail unique. Tout repose sur une promesse — **les chiffres en direct que vous voyez sont réels, jamais des estimations.** Cette page parcourt les phases, les métriques en direct, les cartes de ticket — et le composeur qui vous permet de **parler au job en cours**.

## La disposition

Deux panneaux se trouvent au-dessus du log en streaming complet ; sur un job Claude en cours, un composeur de chat se trouve en dessous :

```
┌─────────────────────────────────────────────┐
│  En-tête de statut (icône · durée en direct · …)  │
├─────────────────────────────────────────────┤
│  En-tête de ticket ( #12  #14  #15 )        │
├─────────────────────────────────────────────┤
│                                             │
│  Log en streaming (auto-défilement · recherche · …)  │
│                                             │
├─────────────────────────────────────────────┤
│  Composeur (envoyer un message au job · …)  │
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

Quel agent gère chaque phase est décidé par le **profil d'agent** du projet. Le trio de base (`sr-architect`, `sr-developer`, `sr-reviewer`) est toujours présent ; les règles de routage d'un profil peuvent ajouter des agents ou changer celui qui exécute une phase. La barre de progression des phases n'apparaît que lorsque la commande définit réellement des phases — les jobs Freestyle (qui contournent le pipeline) n'en affichent pas.

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

## Exécutions de loop : l'explorateur d'étapes

Quand le job est une **exécution de loop** (voir [Le Loop Builder](the-loop-builder)), le log à plat cède la place à un **explorateur d'étapes** qui épouse la forme réelle du loop :

- **Le bandeau de synthèse** en haut est la carte en direct du loop — une pastille par nœud (Étape IA, Shell, Décideur de boucle…), dans l'ordre où circule le graphe. Les pastilles s'allument au fil de l'exécution : estompées en attente, pulsantes pendant l'exécution, puis une coche ou une croix. La pastille d'un Décideur affiche aussi le verdict qu'il a suivi — reboucler ou passer à la suite — et un compteur d'itérations (`Itération 3/10`) tient le score à droite. Cliquez sur n'importe quelle pastille pour sauter directement à la dernière étape de ce nœud.
- **Une boîte repliable par étape.** Chaque passage sur un nœud devient sa propre section, avec le numéro de l'étape, son nom, un badge d'itération, sa durée une fois terminée — et son propre bouton de copie, pour récupérer exactement la sortie d'une étape. (La copie de la barre d'outils emporte toujours le log entier.) Tout ce qui s'affiche avant la première étape — la bannière de lancement, l'avis de worktree — est rangé dans une section **Préparation**.
- **Le mode suivi** est actif par défaut : l'étape en cours reste ouverte et défile automatiquement pendant que les précédentes se replient. Dès que vous remontez ou ouvrez une étape plus ancienne, le suivi se met en pause pour vous laisser lire — une pastille flottante **Reprendre le suivi** vous ramène au direct. **Tout développer / Tout réduire** vivent dans la barre d'outils, et la recherche parcourt toutes les étapes à la fois.
- **Les étapes interrompues aussi sont honnêtes.** Une étape qui n'a jamais pu rapporter son issue — l'exécution a été annulée ou l'app s'est arrêtée en pleine étape — est marquée **Interrompue** avec une bordure en pointillés, plutôt que de faire semblant d'avoir fini.

Tout le reste de cette page fonctionne à l'identique pour les exécutions de loop — les métriques en direct, les cartes de ticket, le composeur. Les jobs hors loop conservent le log en streaming classique ci-dessus.

## Parlez au job en cours

Chaque job Claude s'exécute par défaut comme une **session en direct** : un composeur de chat se trouve donc en bas de cette page — et de la modale de job en mode mission. Utilisez-le pour poser une question à l'agent en cours (« pourquoi ce test a-t-il échoué ? ») ou pour le réorienter en pleine exécution (« saute le refactoring, concentre-toi sur le correctif »).

Quelques points à connaître :

- **Les messages sont mis en file, ils n'interrompent rien.** Envoyez pendant que l'agent streame et votre message attend son tour — il s'exécute comme le prompt suivant, et le job continue de suivre son plan. Un petit compteur indique combien de messages sont en attente.
- **La ligne de totaux est réelle.** Le composeur affiche un résumé en direct `N tours · $X`, sommé à partir de l'usage réel de chaque tour terminé — cohérent avec la promesse de cette page de ne rien deviner.
- **Deux façons de terminer une session.** La plupart des jobs **se terminent tout seuls** : dès qu'un tour se conclut sans message en attente, la session se règle et le job se termine — vos messages sont un pilotage optionnel, jamais une obligation. Une action discrète **Conclure maintenant** l'arrête plus tôt avec tout ce qui a été produit. Les jobs **Freestyle** sont l'exception : ils patientent entre les tours jusqu'à ce que vous cliquiez sur **Finalize** — c'est leur conception, une session d'aller-retour que vous fermez quand vous avez fini.
- **Dans un loop, les messages vont à l'étape active.** Sur un loop intégré ou personnalisé, votre message atteint **l'étape IA en cours d'exécution**. Entre les étapes (pendant que le Loop Decider réfléchit ou qu'une commande shell tourne), le composeur affiche un bref état *« En attente de la prochaine étape… »* — votre brouillon est conservé, et l'envoi se réactive au démarrage de la prochaine étape IA. **Régler cette étape** termine l'étape en cours plus tôt et laisse le loop avancer avec ce qu'elle a produit.
- **Claude uniquement, pour l'instant.** Les jobs Codex et Gemini s'exécutent en un seul passage exactement comme avant — aucun composeur n'apparaît. (Les opérateurs du serveur peuvent désactiver toute la fonctionnalité avec `SPECRAILS_INTERACTIVE_JOBS=false`.)

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
