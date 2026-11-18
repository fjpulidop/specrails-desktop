# La vue détaillée du job

Cliquez sur n'importe quelle carte de job de la page **Jobs** et vous arrivez ici : le poste de pilotage d'une exécution de rail unique. Tout repose sur une promesse — **les chiffres en direct que vous voyez sont réels, jamais des estimations.** Cette page parcourt les phases, les métriques en direct, les cartes de spec — et le composeur qui vous permet de **parler au job en cours**.

## La disposition

L’en-tête compact conserve statut, durée, phase, actions et puces du pipeline. Juste en dessous, **une seule ligne de navigation** réunit tout ce que vous pouvez consulter :

- **Causes de l’échec** — présent pour une exécution échouée ou annulée avec diagnostic, et sélectionné en premier. Une question en attente à laquelle on peut répondre le rend aussi disponible : cliquez sur le bouton de question de l’en-tête pour y aller et répondre, même sans diagnostic.
- **Graphe d’exécution** et **Détail du journal** — pour les exécutions de loop, le graphe du workflow et le journal étape par étape.
- **Journal** — pour les jobs simples, le log en streaming.

À côté des onglets n’apparaissent que les puces que l’exécution a méritées : **Vérification** (avec le nombre de contrôles, dans la couleur de son état) quand l’exécution a enregistré des preuves de vérification — cliquez pour voir les contrôles et leur sortie — et un bouton **Détails** (icône d’histogramme) quand il y a des chiffres réels à montrer. Les deux s’ouvrent en popover, le journal garde donc toujours toute la hauteur. La dernière section du journal choisie est mémorisée séparément pour la page et la fenêtre de mission ; l’onglet sélectionné est réinitialisé à chaque visite.

### Instructions d’exécution

Tant qu’une exécution peut encore les lire, un compositeur d’une ligne est ancré en bas du journal : écrivez ce dont l’agent doit tenir compte et appuyez sur le bouton d’envoi ou **⌘↵** (**Ctrl+Entrée**). **Entrée** ajoute une ligne. Le **ⓘ** explique la règle : les instructions sont appliquées au prochain tour compatible de l’agent ; elles ne répondent pas à une question et n’accordent pas d’approbation. Ce que vous avez envoyé apparaît en puce à côté du compositeur — *1 en attente*, *2 appliquées* — qui liste chaque message et son statut. Une fois l’exécution terminée, le compositeur disparaît ; une exécution passée qui a reçu des instructions garde la puce, en lecture seule, à côté des onglets.

Dans l’application de bureau, un job ouvert depuis une mission s’affiche dans **sa propre fenêtre**, une fenêtre par job. Appuyez sur **Échap** ou fermez la fenêtre pour revenir ; la version navigateur affiche le même contenu dans une modale.

## Les phases du pipeline

Pour les jobs `Implement`, l'exécution traverse les phases définies par la slash command — par défaut :

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

Quel agent gère chaque phase est décidé par le **profil d'agent** du projet. Le trio de base (`sr-architect`, `sr-developer`, `sr-reviewer`) est toujours présent ; les règles de routage d'un profil peuvent ajouter des agents ou changer celui qui exécute une phase. La barre de progression des phases n'apparaît que lorsque la commande définit réellement des phases — les jobs qui contournent le pipeline (comme un loop Freestyle de la galerie) n'en affichent pas.

## Métriques en direct — honnêtes par conception

L’en-tête compact affiche statut, durée, activité, étapes et actions. Les chiffres réels et les notes de reprise s’ouvrent depuis le bouton **Détails** à côté des onglets :

| Métrique | Quand vous voyez la vraie valeur |
|--------|------------------------------|
| **Durée** | **En direct.** Un compteur d'une seconde s'incrémente pendant l'exécution du job — c'est le seul chiffre véritablement en direct. |
| **Tours** | Dérivés de façon incrémentale des événements d'assistant streamés à mesure qu'ils arrivent. |
| **Tokens** | Agrégés de façon incrémentale depuis ce même flux (tolérant aux événements dépourvus de champs d'usage). |
| **Coût** | Affiché comme `—` jusqu'à la sortie du job, puis révélé comme le `total_cost_usd` faisant autorité. |

Le principe de conception : **aucun chiffre approximatif ou estimé en cours d'exécution.** La durée est réelle car ce n'est qu'une horloge. Les tours et les tokens sont accumulés à partir d'une activité réellement streamée. Le coût n'est délibérément *pas* estimé pendant l'exécution — il s'affiche comme en attente et ne se résout en son chiffre final et faisant autorité que lorsque le fournisseur le rapporte à la sortie du job. Si un chiffre semble en attente, c'est intentionnel — on vous montre la vérité, pas une projection.

Le libellé et l'icône de l'en-tête correspondent au statut du job, et le panneau s'affiche aussi bien pour les jobs `running`, `completed` que `failed` — ainsi la vue détaillée d'un job terminé montre les mêmes métriques figées sur leurs valeurs finales.

## Les cartes de spec

L'**en-tête de spec** se trouve entre l'en-tête de statut et le log. C'est une carte d'identité premium qui affiche une puce pour chaque spec touchée par le job — issues de la commande lancée, donc elle reflète exactement quelles specs concernait cette exécution.

- **2 à 3 specs** — affichés sous forme de liste de puces.
- **4 ou plus** — repliés en un mode compact `+ N de plus` avec un chevron de dépliage, pour que l'en-tête reste net.

Cliquer sur une puce ouvre le détail de cette spec **par-dessus la page du job** — vous ne perdez pas votre place et ne changez pas de route. C'est un moyen rapide de relire ce qu'un job est censé livrer pendant que vous le regardez travailler. (Sur les écrans de largeur tablette, vous pouvez même glisser une fenêtre de spec sur le côté pour comparer deux specs côte à côte.)

## Le log en streaming

Ouvrez **Journal** (jobs simples) ou **Détail du journal** (exécutions de loop) pour le log en streaming, ou choisissez Story si la narration est activée. La sortie brute arrive en temps réel via WebSocket :

- **L'auto-défilement** garde la sortie la plus récente en vue (faites défiler vers le haut et il se met en pause pour vous laisser lire).
- **Recherche** pour sauter à une expression.
- **Copier** pour récupérer tout le log.

C'est la vérité brute de ce que fait l'IA — chaque appel d'outil, chaque modification de fichier, chaque exécution de test.

## Exécutions de loop : le graphe et le journal des étapes

Pour une **exécution de loop** (voir [Le Loop Builder](the-loop-builder)), deux onglets montrent les éléments de preuve.

**Graphe d’exécution** est le workflow tel qu’il a tourné. Il est toujours déplié et suit l’étape en cours, ou celle qui a échoué :

- **Le chemin suivi est en trait plein.** Les étapes par lesquelles l’exécution est passée sont tracées en plein ; celles jamais atteintes sont en pointillés et estompées. Activez **Seulement le chemin suivi** pour masquer le reste. Une légende figure à côté.
- **Inspecter une étape.** Sélectionnez un nœud pour lister ses tentatives avec leur état et leur durée. Cliquez sur une tentative pour ouvrir son journal dans Détail du journal. **Reprendre à partir d’ici** figure sur la ligne de chaque tentative terminée, pour qu’une exécution liée démarre exactement à la tentative choisie. Les identifiants techniques sont sous **Trace**.

**Détail du journal** contient la piste des étapes et le journal, et s’ouvre sur l’étape qui a échoué :

- **Le bandeau des étapes** en haut ne liste que les étapes atteintes par l’exécution, dans l’ordre, avec un compteur d’itérations (`Itération 3/10`) à droite. Les pastilles sont estompées en attente, pulsent pendant l’exécution, puis affichent une coche ou une croix ; la pastille d’un Décideur affiche aussi le verdict qu’il a suivi. Cliquez sur une pastille pour sauter à cette étape.
- **Une boîte repliable par étape.** Chaque passage sur un nœud devient sa propre section, avec le numéro de l'étape, son nom, un badge d'itération, sa durée une fois terminée — et son propre bouton de copie, pour récupérer exactement la sortie d'une étape. (La copie de la barre d'outils emporte toujours le log entier.) Tout ce qui s'affiche avant la première étape — la bannière de lancement, l'avis de worktree — est rangé dans une section **Préparation**.
- **Le mode suivi** est actif par défaut : l'étape en cours reste ouverte et défile automatiquement pendant que les précédentes se replient. Dès que vous remontez ou ouvrez une étape plus ancienne, le suivi se met en pause pour vous laisser lire — une pastille flottante **Reprendre le suivi** vous ramène au direct. **Tout développer / Tout réduire** vivent dans la barre d'outils, et la recherche parcourt toutes les étapes à la fois.
- **Les étapes interrompues aussi sont honnêtes.** Une étape qui n'a jamais pu rapporter son issue — l'exécution a été annulée ou l'app s'est arrêtée en pleine étape — est marquée **Interrompue** avec une bordure en pointillés, plutôt que de faire semblant d'avoir fini.

Story, si la narration est activée, est proposé dans Détail du journal. L’exploration du graphe et un défilement du journal en pause sont conservés en changeant d’onglet.

## Parlez au job en cours

Chaque job Claude s'exécute par défaut comme une **session en direct** : un composeur de chat se trouve donc en bas de cette page — et de la modale de job en mode mission. Utilisez-le pour poser une question à l'agent en cours (« pourquoi ce test a-t-il échoué ? ») ou pour le réorienter en pleine exécution (« saute le refactoring, concentre-toi sur le correctif »).

Quelques points à connaître :

- **Les messages sont mis en file, ils n'interrompent rien.** Envoyez pendant que l'agent streame et votre message attend son tour — il s'exécute comme le prompt suivant, et le job continue de suivre son plan. Un petit compteur indique combien de messages sont en attente.
- **La ligne de totaux est réelle.** Le composeur affiche un résumé en direct `N tours · $X`, sommé à partir de l'usage réel de chaque tour terminé — cohérent avec la promesse de cette page de ne rien deviner.
- **Deux façons de terminer une session.** La plupart des jobs **se terminent tout seuls** : dès qu'un tour se conclut sans message en attente, la session se règle et le job se termine — vos messages sont un pilotage optionnel, jamais une obligation. Une action discrète **Conclure maintenant** l'arrête plus tôt avec tout ce qui a été produit. Les anciens jobs **Freestyle** (antérieurs au passage de Freestyle en loop de la galerie) sont l'exception : ils patientent entre les tours jusqu'à ce que vous cliquiez sur **Finalize** — c'est leur conception, une session d'aller-retour que vous fermez quand vous avez fini.
- **Dans un loop, les messages vont à l'étape active.** Sur un loop intégré ou personnalisé, votre message atteint **l'étape IA en cours d'exécution**. Entre les étapes (pendant que le Loop Decider réfléchit ou qu'une commande shell tourne), le composeur affiche un bref état *« En attente de la prochaine étape… »* — votre brouillon est conservé, et l'envoi se réactive au démarrage de la prochaine étape IA. **Régler cette étape** termine l'étape en cours plus tôt et laisse le loop avancer avec ce qu'elle a produit.

## Export de diagnostic

Si la [télémétrie](../settings/pipeline-telemetry-and-diagnostics) était activée pour le job, un bouton **Exporter le diagnostic** apparaît dans l'en-tête. Il télécharge un ZIP contenant :

- `job-metadata.json` — commande, statut, profil, plugins.
- `telemetry.ndjson` — signaux OTLP/JSON non compressés.
- `logs.txt` — le log en streaming complet.
- `summary.md` — points saillants en clair.
- `profile.json`, `plugins.json` — instantanés exacts de ce qui s'est exécuté (lorsque présents).

Pratique pour partager une exécution avec un coéquipier, ou pour déposer un rapport de bug précis.

## Quand une exécution échoue

Pour un job échoué ou annulé avec diagnostic, **Causes de l’échec** s’ouvre sur la **carte de diagnostic**, qui explique la cause et, si on le sait, pourquoi c’est arrivé. Quand l’exécution a enregistré quelle étape a échoué, la carte le dit : l’étape, la tentative, l’itération et l’heure. Les causes :

- **Tests échoués** : les vérifications échouent encore après les tours de correction.
- **Limite du fournisseur** — la limite d'utilisation du fournisseur d'IA a été atteinte. La carte indique la réinitialisation à votre heure locale quand le fournisseur a donné l'heure exacte, sinon avec ses propres mots. Une exécution encore en pause à la limite affiche sa propre carte : quand elle reprend seule, **Reprendre maintenant** et **Continuer maintenant avec** un autre fournisseur. Voir [Limites d'utilisation](1-rails-and-jobs.md#usage-limits).
- **Environnement** : la machine ne peut pas exécuter les vérifications (identifiants, outil manquant, commande de préparation en échec). *Réparer l'environnement* montre précisément quoi exécuter ou changer.
- **Port déjà utilisé** : la vérification ou le serveur de l'exécution n'a pas pu démarrer parce qu'un autre processus occupait déjà son port (`EADDRINUSE`). Ce n'est pas compté comme des tests en échec. Chaque worktree d'exécution reçoit ses propres ports via `PORT` et `SPECRAILS_RUN_PORT_RANGE_START`/`_END` ; un projet qui lit `PORT` n'entre jamais en collision. Arrêtez l'autre processus, ou faites lire `PORT` au projet, puis **Relancer**.
- **Bloquée**, **à court de temps**, **silencieuse** et **arrêtée de façon inattendue** désignent la limite ou le processus qui a arrêté l'exécution.
- **Cause inconnue** : l'app ne devine pas. Elle affiche la fin du journal pour que vous le lisiez vous-même.

Sous le diagnostic, jusqu'à trois remèdes classés, et seulement ceux qui peuvent fonctionner ici : **Reprendre depuis** la phase arrêtée, **Relancer**, **Modifier la spec et relancer** (les addenda de la spec portent votre changement à l'exécution suivante), **Réparer l'environnement** et **Ouvrir le journal à l'échec**. La même cause apparaît en une ligne dans la [liste À traiter](../getting-started/the-dashboard-tour), et la carte d'exécution de la mission montre la même carte.

### Analyse IA {#ai-failure-analysis}

Sous la carte, une **Analyse IA** lit le journal et explique pourquoi l’exécution s’est arrêtée : la cause, **Que faire**, et les lignes **Extrait du journal** sur lesquelles elle s’appuie, citées mot pour mot. Elle tourne avec le même fournisseur et le même modèle que le job, pour que votre compte puisse toujours l’exécuter. Elle démarre d’elle-même, sauf quand la limite du fournisseur était la cause ; appuyez alors sur **Analyser avec l’IA**. L’analyse est enregistrée avec le job. Si le journal change ensuite, elle le signale et propose **Analyser à nouveau**.

L’analyse est présentée comme une lecture de l’IA et ne remplace jamais la carte : le diagnostic, sa cause et ses remèdes restent ce que l’app a enregistré. Vérifiez les lignes qu’elle cite avant d’agir. Son coût est compté dans **Support** dans [Analytics](../insights/analytics-and-cost-tracking).

## Où aller ensuite

- [Rails et jobs](rails-and-jobs) — lancement et mise en file.
- [Analytics et suivi des coûts](../insights/analytics-and-cost-tracking) — transformer les coûts par job en analytics de projet.

## Après le redémarrage d’un workflow

Après un arrêt brutal, reprenez le workflow enregistré avec sa configuration et ses dépôts d’origine. Une écriture interrompue exige de sélectionner la tentative exacte après avoir examiné le diff du worktree. Les étapes terminées sont conservées. Un appel au fournisseur dont la réponse a été perdue reste comptabilisé comme interrompu, avec une consommation inconnue ; il n’est jamais présenté comme gratuit. Si les données enregistrées ne permettent pas de prouver la livraison d’origine, la récupération affiche une erreur et conserve le worktree.

Quand une étape de décision pose une question, la reprise réutilise la décision enregistrée et transmet la réponse humaine à l’étape suivante. Elle ne rappelle pas le modèle pour cette même décision. Un prompt en pause peut nécessiter un nouveau tour du modèle pour appliquer votre réponse.

## Conservation de l’historique

Les exécutions enregistrées sont conservées indéfiniment par défaut. Dans **Exécutions enregistrées → Conservation de l’historique**, un projet peut les conserver de 1 à 3650 jours. Rien n’est supprimé en arrière-plan : enregistrez la politique, choisissez **Aperçu du nettoyage** et examinez chaque exécution et sa raison avant **Supprimer les historiques expirés**. Une exécution reste protégée tant qu’elle est active, attend votre réponse ou approbation, a une écriture interrompue, une livraison ouverte ou un fork qui en dépend encore. Seul l’historique d’exécution dans le stockage Specrails du projet est supprimé ; votre dépôt, les worktrees, le journal du job et les coûts sont conservés. Une exécution expirée apparaît comme **Expiré** et ne peut plus être reprise ni forkée. Les versions de Core encore utilisées par une exécution conservée sont toujours gardées.
