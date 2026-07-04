# Le Loop Builder

Un **rail exécute un Loop**. Les loops intégrés (`Implement`, `Batch`, `Freestyle`) couvrent les cas du quotidien, mais le **Loop Builder** vous laisse concevoir les vôtres — un éditeur visuel, de style n8n, pour de l'automatisation qui se répète jusqu'à ce qu'un objectif soit atteint. Cette page explique ce qu'est un loop, comment en construire un, et comment l'exécuter sur un rail.

## Loops et rails — la relation

Un **loop** est la *recette* du travail ; un **rail** est la *voie* qui l'exécute contre vos specs.

```
   Loop Builder (barre latérale gauche)    Rails (droite)
   ───────────────────────────             ─────────────
   Implement   (intégré)                   Rail 1
   Batch       (intégré)      choisir ►       Loop: Verify-until-green
   Freestyle   (intégré)                      ▶ Play
   Verify-until-green (le vôtre)
```

- Les loops vivent dans la section **Loops** (barre latérale gauche, à côté de vos projets) — ils sont **globaux**, partagés entre tous les projets.
- Un rail **choisit un loop** dans son en-tête (le sélecteur de Loop) et l'exécute quand vous appuyez sur Play.
- Le **rail** décide du provider, du modèle et de l'effort de raisonnement — *pas* les étapes du loop. Le même loop tourne sur Claude, Codex ou Gemini selon le rail.

Donc : construisez un loop une fois, puis choisissez-le sur n'importe quel rail dans n'importe quel projet.

## Ouvrir le builder

Cliquez sur **Loops** dans la barre latérale gauche pour voir la bibliothèque : les trois loops intégrés plus les vôtres. Ouvrez-en un pour le visualiser, ou cliquez sur **New loop** pour partir d'un canevas vierge.

Vous ne pouvez pas facilement éditer un intégré directement — à la place, faites un **Fork**. Cela vous donne une copie éditable d'un graphe fonctionnel pour démarrer, ce qui est la façon la plus simple d'apprendre.

## De quoi un loop est constitué

Un loop est un graphe de **nœuds** reliés par des **arêtes** (les flèches). Chaque nœud est une étape :

| Nœud | Ce qu'il fait |
|------|--------------|
| **Start** | Là où l'exécution commence. Exactement un par loop. |
| **AI Step** | Exécute un tour d'IA — un prompt que vous écrivez, ou une *commande magique* comme `{{cmd:implement}}`, `{{cmd:verify}}`, `{{cmd:fix}}`. C'est là que le vrai travail se fait. |
| **Shell** | Exécute une commande shell (par ex. `npm test`) et capture sa sortie pour les étapes suivantes. |
| **Loop Decider** | Le cerveau d'un loop. À chaque passage, il lit un **objectif** que vous écrivez et décide **continue** (boucler en arrière et réessayer) ou **stop** (sortir). C'est ce qui alimente *verify → fix → verify jusqu'au vert*. |
| **End** | Un nœud terminal. Marque l'exécution comme réussie ou échouée. |

Les arêtes relient les étapes dans l'ordre. Le **Loop Decider** a deux sorties étiquetées — **continue** et **stop** — donc vous câblez « pas encore fini » de retour vers le travail et « fini » vers un End.

### Écrire le texte d'une étape

À l'intérieur de n'importe quel AI Step ou Decider, vous pouvez référencer :

- **Données de spec** — `{{spec.title}}`, `{{spec.description}}`, `{{spec.ids}}` (les IDs de ticket du rail). Remplis à partir du ou des specs du rail au moment de l'exécution.
- **Commandes magiques** — `{{cmd:implement}}` et consorts se développent en la commande de pipeline correspondante.
- **Constantes** — `{{const:NAME}}` puise dans la **bibliothèque de constantes** globale (glissez-les depuis la palette). Les sentinelles intégrées comme les marqueurs de vérification PASS/FAIL sont toujours disponibles ; vous pouvez ajouter les vôtres et les réutiliser dans tous vos loops.

## Garder un loop borné

Un loop qui ne s'arrête jamais brûlerait de l'argent indéfiniment, donc chaque exécution a trois garde-fous (définis dans la barre d'outils du builder) :

| Garde-fou | Ce qu'il fait |
|-------|--------------|
| **Max iterations** | Plafond strict sur le nombre de fois où le Decider peut boucler en arrière, quel que soit son verdict. |
| **Timeout (min)** | Limite en temps réel pour toute l'exécution. |
| **Max cost ($)** | *Optionnel.* Arrête le loop une fois que le coût accumulé dépasse votre budget. Vérifié **entre les étapes** (le coût d'une étape n'est connu qu'une fois qu'elle est terminée), donc il peut dépasser d'une étape. Sur Claude le coût est exact ; sur Codex et Gemini c'est une estimation. Laissez-le vide pour ne pas avoir de plafond. |

## Construire en confiance

Le builder vous aide à mettre un loop au point avant même qu'il s'exécute :

- **Validation en direct** — les problèmes (pas de Start, une étape orpheline, un prompt vide, un Decider avec des branches manquantes) sont signalés sur le canevas et dans un panneau de problèmes.
- **Aperçu en dry-run** — résout le texte exact de chaque étape (données de spec, constantes, commandes toutes développées) **sans rien démarrer**, pour que vous voyiez précisément ce que chaque étape enverrait.
- **Auto-arrange** — rangez le canevas verticalement, horizontalement ou en grille ; votre choix est sauvegardé par loop.
- **Copier / coller** — `Cmd/Ctrl + C` / `V` pour copier des étapes au sein d'un loop ou entre loops.
- **Import / export** — sauvegardez les loops dans un fichier `.json` et réimportez-les (les noms en doublon sont ignorés, le reste est importé).
- **Renommer les étapes** — donnez à chaque nœud une étiquette personnalisée pour que le graphe se lise clairement.

## Publier et exécuter

Un loop démarre en tant que **Draft**. Quand le graphe est valide, faites-en un **Publish** — les loops publiés sont ceux qui apparaissent dans le sélecteur de Loop d'un rail. (Faites un Unpublish pour le retirer de la circulation sans le supprimer.)

Pour exécuter un loop personnalisé :

1. Ouvrez un projet et glissez un spec sur un rail.
2. Dans l'en-tête du rail, ouvrez le **sélecteur de Loop** et choisissez votre loop publié.
3. Appuyez sur **▶ Play**.

L'exécution se diffuse en direct dans la vue **Jobs** avec les mêmes métriques et le même suivi des coûts que n'importe quel job de rail — et son log gagne un **explorateur d'étapes** dédié : une carte en direct de votre graphe avec une boîte repliable par étape, qui suit l'étape en cours à mesure que le loop avance (voir [La vue détaillée du job](the-job-detail-view)). Sur Claude, chaque **Étape IA** est aussi une session en direct : envoyez-lui des messages depuis le composeur de la vue détaillée du job pour la piloter en cours d'étape (entre les étapes, le composeur patiente brièvement, et **Régler cette étape** fait avancer le loop avec ce que l'étape a produit). Un loop qui s'arrête parce qu'il a atteint son plafond d'itérations ou de coût est rapporté avec ce résultat plutôt qu'un simple succès.

> **À savoir pendant qu'un loop s'exécute.** Vous ne pouvez pas éditer ni supprimer un loop pendant qu'une de ses exécutions est en cours — arrêtez d'abord l'exécution.

## Où aller ensuite

- [Rails et jobs](rails-and-jobs) — lancer des rails et la file d'attente des jobs.
- [La vue détaillée du job](the-job-detail-view) — suivre une exécution en direct.
- [Choisir un moteur par rail](picking-an-engine-per-rail) — c'est le rail (pas le loop) qui choisit le provider.
