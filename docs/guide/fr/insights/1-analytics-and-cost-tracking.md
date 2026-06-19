# Analytics et suivi des coûts

Chaque fois que Specrails lance une CLI IA pour vous — un job de pipeline, une spec rapide, une session Explore, un affinage IA, un résumé de fichier — il consigne ce qui s'est passé : quel modèle a tourné, combien de tokens sont entrés et sortis, combien de temps cela a pris et combien cela a coûté. La section **Analytics** transforme tout cela en un tableau de bord unique, pour que vous sachiez toujours où part votre budget IA.

Ouvrez-la depuis la barre latérale droite (elle est intitulée **Analytics**). Tout ce que vous y voyez se rapporte au projet dans lequel vous vous trouvez actuellement — changez de projet et les chiffres suivent.

## Ce qui compte comme dépense

Specrails suit cinq types d'activité IA, appelés *surfaces*. Chacune dispose d'un code couleur cohérent sur tous les graphiques, pour que vous puissiez la repérer d'un coup d'œil :

- **Job** — un rail de pipeline qui enchaîne Architect → Developer → Reviewer → Ship.
- **Quick spec** — une spec générée par la voie rapide d'Add Spec.
- **Explore spec** — une conversation Explore où vous façonnez une spec en discutant.
- **AI edit** — un affinage assisté par l'IA sur un agent ou un fichier.
- **File summary** — les résumés en langage clair qui alimentent le Code explorer.

Deux activités ne sont délibérément *pas* suivies : le panneau de chat latéral et l'assistant de configuration lancent tous deux des CLI IA, mais ils n'apparaissent jamais dans vos dépenses. Le tableau de bord reflète ainsi un travail réel et reproductible plutôt que des échanges anecdotiques.

## Lire le tableau de bord

La page est constituée d'une série de blocs, de haut en bas :

### La jauge de consommation (Hero)

Le grand chiffre en haut représente votre dépense totale pour la période sélectionnée, avec un écart **vs préc.** qui vous permet de voir en un coup d'œil si la tendance est à la hausse ou à la baisse par rapport à la fenêtre précédente. Si vous venez tout juste de commencer à utiliser un projet, l'état vide vous indique quand le suivi a démarré (« Suivi démarré le YYYY-MM-DD ») — il n'y a pas de récupération rétroactive de l'historique, donc la jauge ne connaît que les exécutions survenues alors que vous étiez sur cette version.

### Chronologie quotidienne

Un graphique à barres empilées de la dépense par jour, ventilée par surface. Les jours sans activité s'affichent à zéro plutôt que d'être omis, pour que la silhouette de votre semaine reste honnête. C'est le moyen le plus rapide de voir *quand* un lot coûteux a tourné.

### Quick vs Explore

Une carte côte à côte comparant vos deux styles de création de spec. Si vous avez lancé moins de cinq sessions Explore, elle affiche un appel à l'action tout en douceur plutôt que des moyennes trompeuses — les petits échantillons ne font pas de bonnes comparaisons.

### Par modèle

Vos principaux modèles par dépense (jusqu'à dix). Cliquez sur n'importe quel modèle pour filtrer l'ensemble du tableau de bord sur ce seul modèle — pratique quand vous voulez savoir combien vous coûte vraiment un modèle haut de gamme en particulier.

### Nuage de points coût vs tours

Chaque point représente une invocation, avec le coût en fonction du nombre de tours. Les valeurs aberrantes — les exécutions coûteuses à nombreux tours — sautent aux yeux. (Le nuage affiche vos 500 points les plus récents pour rester fluide.)

### Top tickets

Vos dix tickets les plus coûteux, toutes *surfaces* confondues, de sorte qu'un ticket qui a coûté un peu en Explore et beaucoup dans un job affiche son vrai total. Les tickets supprimés et les exécutions non attribuées disposent de leurs propres catégories, pour que rien ne disparaisse silencieusement des totaux.

### Table des invocations brutes

La vérité de terrain : une ligne par invocation. Ce bloc possède ses propres filtres secondaires qui n'affectent que la table, pour que vous puissiez creuser sans perturber les graphiques au-dessus.

## Filtrer

L'en-tête épinglé en haut porte les deux filtres principaux — **période** et **surface** — et tous deux sont enregistrés dans l'URL de la page. Cela signifie que vous pouvez mettre en favori ou partager une vue filtrée (« 30 derniers jours, jobs uniquement ») et elle se rouvrira exactement comme vous l'aviez laissée. Les filtres de la table brute sont distincts et restent locaux à ce bloc.

Un mot sur la précision : les exécutions en échec ou interrompues sont exclues des *moyennes de coût* (elles fausseraient les chiffres par exécution) mais elles comptent tout de même dans votre nombre total d'exécutions et votre taux d'échec. Les moyennes restent ainsi propres tandis que le portrait de la fiabilité reste complet.

## Coût par ticket

Pas besoin de passer par la page Analytics pour savoir ce qu'a coûté une spec. Ouvrez n'importe quel ticket et, s'il a une dépense rattachée, vous verrez un résumé sur une ligne juste sous le titre :

> $0.42 · 6 turns · 1m 12s active · breakdown

Cliquez dessus et vous arrivez sur la page Analytics déjà filtrée sur ce ticket. C'est le chemin le plus court entre « combien cette fonctionnalité m'a-t-elle coûté ? » et le détail complet.

## Exporter vos données

Quand vous avez besoin des chiffres en dehors de l'application — un tableur, un rapport financier, votre propre analyse — utilisez le menu déroulant **Export**. Il propose quatre formats :

- **CSV résumé** — un fichier multi-sections avec les totaux, la chronologie quotidienne, la ventilation par surface, par modèle et les top tickets.
- **JSON résumé** — le même résumé, structuré.
- **CSV brut** — chaque ligne d'invocation (jusqu'à 10 000 ; il signale s'il a dû tronquer).
- **JSON brut** — les mêmes lignes brutes, structurées.

Les exports respectent les filtres de période et de surface actuellement appliqués, et les fichiers sont nommés de manière à se trier logiquement : `<project>-analytics-<period>-<date>.csv`. Le bouton est désactivé quand il n'y a rien à exporter, et un message d'erreur clair s'affiche si un téléchargement échoue.

## Toujours à jour

Pas besoin d'actualiser. Quand une nouvelle invocation est enregistrée n'importe où dans le projet, le tableau de bord ouvert se recharge discrètement un instant plus tard, pour que la jauge de consommation suive le rythme du travail à mesure qu'il se termine.
