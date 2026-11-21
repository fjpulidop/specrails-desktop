# Analytics et suivi des coûts

Chaque fois que Specrails lance une CLI IA pour vous — un job de pipeline, une spec rapide, une session Explore, un affinage IA, un résumé de fichier — il consigne ce qui s'est passé : quel modèle a tourné, combien de tokens sont entrés et sortis, combien de temps cela a pris et combien cela a coûté. La section **Analytics** transforme tout cela en un tableau de bord unique, pour que vous sachiez toujours où part votre budget IA.

Ouvrez-la depuis la barre latérale droite (elle est intitulée **Analytics**). Tout ce que vous y voyez se rapporte au projet dans lequel vous vous trouvez actuellement — changez de projet et les chiffres suivent.

## Ce qui compte comme dépense

Chaque appel IA du projet compte : les jobs de pipeline et les étapes de loop, la rédaction de specs, les résumés de fichiers, les discussions annexes, le diagnostic d'échec, ainsi que les missions et les tours Intent que vous menez avec l'agent pendant qu'il est épinglé à ce projet. Les missions sur l'Accueil (sans projet épinglé) n'appartiennent à aucun projet et ne sont pas comptées ici.

Chaque appel est associé à la *surface* qui a engagé la dépense, et chaque surface appartient à l'une des cinq **catégories** qui disent *pourquoi* l'argent a été dépensé :

- **Implémentation** — construire des specs avec des rails, des loops et des jobs.
- **Missions** — discuter avec l'agent et le mode Intent (tours de mission, tours Intent et la réécriture de spec par Intent).
- **Specs** — rédiger et affiner des specs : specs Quick et Explore, affinage, découpage, le lanceur de specs, les propositions et le tri.
- **Code** — expliquer le code : résumés de fichiers et histoires de fichiers.
- **Support** — configuration, diagnostic et discussions annexes : analyse des échecs, configuration, Agent Studio et le panneau de chat latéral.

## Lire le tableau de bord

La page se lit de haut en bas : *combien → sur quoi et pourquoi → quand → avec quels modèles → les appels un par un*.

### Combien (Hero)

Le grand chiffre en haut représente votre dépense totale pour la période sélectionnée, avec un écart **vs préc.** qui vous permet de voir en un coup d'œil si la tendance est à la hausse ou à la baisse par rapport à la fenêtre précédente. Quand tous les moteurs sont sur un forfait d'abonnement, le chiffre est intitulé *Estimation équivalente en API* : ce que les appels coûteraient aux prix de l'API, pas de l'argent réellement facturé. Si vous venez tout juste de commencer à utiliser un projet, l'état vide vous indique quand le suivi a démarré.

### Où est passé l'argent

Une ligne par catégorie avec son coût, sa part du total, le nombre d'appels et de tokens, et une raison en une ligne. La partie hachurée d'une barre correspond au coût estimé (moteurs qui ne communiquent pas leur coût nativement). Ouvrez une catégorie pour voir les surfaces qui la composent, et cliquez sur l'une d'elles pour filtrer toute la page dessus. La catégorie Missions liste aussi vos conversations les plus coûteuses.

### Chronologie quotidienne

Un graphique à barres empilées de la dépense par jour, ventilée par surface, avec les missions dans leur propre couleur. Les jours sans activité s'affichent à zéro plutôt que d'être omis. C'est le moyen le plus rapide de voir *quand* un lot coûteux a tourné.

### Budget

Vos plafonds quotidien, hebdomadaire, mensuel et par exécution, la projection de fin de mois et la simulation de prix « et si » (voir plus bas).

### Moteurs et modèles

La dépense par moteur (sur les projets qui en ont plusieurs) et vos principaux modèles par dépense. Cliquez sur n'importe quel modèle pour filtrer l'ensemble du tableau de bord sur ce seul modèle.

### Top specs

Vos dix specs les plus coûteuses, toutes *surfaces* confondues, de sorte qu'une spec qui a coûté un peu en Explore et beaucoup dans un job affiche son vrai total. Les tours de mission ne portent pas de spec, ils n'apparaissent donc pas ici.

### Table des invocations brutes

La vérité de terrain : une ligne par appel. La colonne **Raison** affiche la surface et sa catégorie ; les lignes de mission et d'Intent indiquent la conversation à laquelle elles appartiennent. Ce bloc possède ses propres filtres secondaires qui n'affectent que la table.

### Plus de répartitions

Repliées par défaut : le délai jusqu'à la décision et au merge, l'économie des loops, le nuage de points coût vs tours et la comparaison Quick vs Explore.

## Filtrer

L'en-tête épinglé porte les filtres principaux — **période**, **catégorie** et (sur les projets à plusieurs moteurs) **moteur** — et tous sont enregistrés dans l'URL de la page, pour que vous puissiez mettre en favori ou partager une vue filtrée (« 30 derniers jours, missions uniquement »). Survolez une puce de catégorie pour voir ce qu'elle couvre. Une surface précise se sélectionne depuis la carte *Où est passé l'argent* (ou avec `?surface=` dans l'URL) ; une puce amovible dans l'en-tête l'indique. Les filtres de la table brute sont distincts et restent locaux à ce bloc.

Un mot sur la précision : les exécutions en échec ou interrompues sont exclues des *moyennes de coût* (elles fausseraient les chiffres par exécution) mais elles comptent tout de même dans votre nombre total d'exécutions et votre taux d'échec. Les moyennes restent ainsi propres tandis que le portrait de la fiabilité reste complet.

## Coût par spec

Pas besoin de passer par la page Analytics pour savoir ce qu'a coûté une spec. Ouvrez n'importe quelle spec et, si elle a une dépense rattachée, vous verrez un résumé sur une ligne juste sous le titre :

> $0.42 · 6 turns · 1m 12s active · breakdown

Cliquez dessus et vous arrivez sur la page Analytics déjà filtrée sur cette spec. C'est le chemin le plus court entre « combien cette fonctionnalité m'a-t-elle coûté ? » et le détail complet.

## Tous les projets {#all-projects}

Pour avoir la vue sur l'ensemble des projets, ouvrez **Analytics** depuis la barre latérale gauche ou la palette de commandes. La page affiche le coût total, les jobs et le taux de réussite, le coût dans le temps et une ligne par projet, avec les mêmes cinq catégories et couleurs que la page du projet. Les tours de mission et d'Intent comptent dans chaque chiffre. Les tours qui n'appartiennent à aucun projet chargé, comme les missions sur l'Accueil et les chats Blueprint ou Builder, sont regroupés dans une ligne **Accueil et Blueprint**, comptés en tours d'agent plutôt qu'en jobs. Le coût estimé est marqué d'un `~`, comme sur la page du projet.

## Exporter vos données

Quand vous avez besoin des chiffres en dehors de l'application — un tableur, un rapport financier, votre propre analyse — utilisez le menu déroulant **Export**. Il propose quatre formats :

- **CSV résumé** — un fichier multi-sections avec les totaux, la chronologie quotidienne, la ventilation par catégorie, par surface, par modèle et les top specs.
- **JSON résumé** — le même résumé, structuré.
- **CSV brut** — chaque ligne d'invocation (jusqu'à 10 000 ; il signale s'il a dû tronquer).
- **JSON brut** — les mêmes lignes brutes, structurées.

Les exports respectent les filtres de période, de catégorie et de surface actuellement appliqués, et les fichiers sont nommés de manière à se trier logiquement : `<project>-analytics-<period>-<date>.csv`. Le bouton est désactivé quand il n'y a rien à exporter, et un message d'erreur clair s'affiche si un téléchargement échoue.

## Toujours à jour

Pas besoin d'actualiser. Quand une nouvelle invocation est enregistrée n'importe où dans le projet, le tableau de bord ouvert se recharge discrètement un instant plus tard, pour que la jauge de consommation suive le rythme du travail à mesure qu'il se termine.

## Budgets quotidiens {#daily-budget}

Définissez un budget quotidien pour plafonner ce qu’une journée peut coûter. Tous les plafonds (quotidien, hebdomadaire, mensuel et par exécution) se modifient au même endroit : **Analyses → Budget**. **Réglages → Avancé** et **Réglages du projet → Budget** n’affichent que le plafond quotidien actuel, avec un bouton **Ouvrir Budget** qui y mène.

Quand la dépense enregistrée du jour atteint un budget, la file se met en pause d’elle-même, les rails et les exécutions de loops refusent de démarrer avec *Budget quotidien atteint*, et une exécution de loop en cours s’arrête entre deux étapes, en pause à cause du budget. Augmentez ou supprimez le budget, ou attendez la réinitialisation quotidienne, puis reprenez. Une exécution de loop bloquée uniquement par le budget quotidien reprend d’elle-même quand la journée se réinitialise (à minuit heure locale pour le budget d’un projet, à minuit UTC pour celui de toute l’app), dès qu’il y a de la capacité, et l’indique dans son journal ; cela vaut aussi pour une exécution bloquée pendant que l’app était fermée à minuit, qui reprend au démarrage de l’app. Une exécution que vous avez mise en pause, ou que son propre plafond par exécution (ou un plafond hebdomadaire ou mensuel) bloque encore, continue de vous attendre. Désactivez ce comportement dans **Réglages → Avancé → Reprendre les exécutions bloquées par le plafond quotidien quand la journée se réinitialise**.

Les deux budgets comptent votre journée locale, et tous deux incluent la dépense des missions : le budget d’un projet compte les tours épinglés à ce projet, celui de toute l’app compte chaque tour. « Aujourd’hui » désigne votre journée locale partout dans l’app : dans la barre de statut, dans Analytics et dans les budgets. L’alerte de coût par job est un réglage distinct.

**Plafonds hebdomadaires, mensuels et par exécution.** Les plafonds plus longs fonctionnent de la même façon. Ouvrez **Analyses → Budget** pour définir un plafond **hebdomadaire** et un plafond **mensuel**, par projet et pour toute l’app, ainsi qu’un **plafond souple par exécution** (*mettre en pause et demander à X $*). Les semaines commencent le lundi et les mois le 1er, à l’heure locale. Un plafond hebdomadaire ou mensuel met les files en pause, refuse les lancements et suspend les loops en cours exactement comme le budget quotidien ; relevez-le ou supprimez-le là, ou attendez la réinitialisation. Une étape commencée ne peut pas être arrêtée : le plafond par exécution est donc vérifié **avant chaque étape d’IA**, par rapport à ce que cette étape coûte d’habitude : ce qu’elle a coûté plus tôt dans la même exécution, sinon la médiane de ses exécutions récentes dans le projet avec le même modèle, sinon une estimation d’une étape typique de ce genre d’après la grille tarifaire. Quand l’étape suivante ne tient pas dans le plafond, l’exécution se met en pause avant elle et l’explique (*En pause avant Developer : cette étape coûte en général environ 0,45 $, et il reste 0,12 $ du plafond de 0,40 $ par exécution*) ; **Reprendre** propose alors d’**exécuter cette étape une fois** (le plafond s’applique de nouveau ensuite), de continuer sans le plafond ou de le relever. Une exécution dont le coût communiqué atteint le plafond se met en pause de la même façon. Ce sont des estimations : une étape qui coûte bien plus que d’habitude peut encore dépasser le plafond. Atteindre un plafond ajoute aussi un élément **Relever le plafond** à la boîte de réception.

Le panneau Budget montre aujourd’hui, cette semaine et ce mois face à chaque plafond. Sa **projection** de fin de mois est une estimation (la moyenne des 14 derniers jours complets multipliée par les jours restants, plus ce que vous avez déjà dépensé), jamais ajoutée à la dépense facturée. **Et si** recalcule les 30 derniers jours d’usage de tokens enregistré avec un autre modèle, d’après la grille de prix de l’app, et indique *Pas de tarif* pour un modèle sans prix. Avec un forfait d’abonnement, il n’y a pas de coût en dollars par usage : le panneau affiche alors les tours et les limites du forfait.
