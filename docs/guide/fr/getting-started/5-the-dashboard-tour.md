# La visite du tableau de bord

Un projet ajouté, vous voilà devant votre **tableau de bord de projet** — votre camp de base pour transformer les specs en code livré. Voici comment vous y retrouver.

## La vue d'ensemble

La fenêtre comporte trois zones :

- **Barre latérale gauche** — la liste de vos projets. Cliquez sur n'importe quel projet pour y basculer instantanément ; tout le reste de la fenêtre se met à jour pour correspondre. Le bouton **Ajouter un projet** se trouve ici aussi.
- **Zone principale** — le tableau de bord du projet actif : vos specs et le pipeline qui les exécute.
- **Barre latérale droite** — la navigation entre les sections du projet courant.

## Le tableau de bord principal

C'est là que le travail se fait. Le tableau de bord affiche :

- **Vos specs** — les specs que vous avez créées, organisés par statut (Backlog/À faire jusqu'à Terminé). Vous pouvez les visualiser sous forme de liste, de grille ou de cartes type post-it, selon votre préférence.
- **Un moyen d'ajouter une spec** — démarrez un nouveau morceau de travail. Vous pouvez rédiger une spec rapide directement, ou ouvrir un chat **Explore** guidé qui vous aide à la façonner par la conversation et rédige la spec pour vous.
- **Les rails** — ce sont les couloirs où les specs se construisent. Déposez une spec sur un rail et lancez-la pour la faire passer dans le pipeline Architect → Developer → Reviewer → Ship. Plusieurs rails peuvent tourner en même temps, vous pouvez donc travailler sur plusieurs choses en parallèle.

Quand une spec s'exécute, vous voyez la progression de son pipeline et ses logs en direct — la sortie en temps réel de l'IA pendant qu'elle conçoit, code et relit votre modification.

## La barre latérale droite : les sections du projet

La barre latérale droite est votre tableau d'aiguillage pour le projet courant. Survolez-la pour la déplier, ou épinglez-la ouverte. Les sections que vous y trouverez :

- **Tableau de bord** — le tableau des specs et les rails (là d'où vous venez).
- **Jobs** — chaque exécution de pipeline pour ce projet, passée et présente, avec son statut, sa durée et la possibilité de plonger dans le détail et les logs de n'importe quelle exécution.
- **Intégrations** — des extensions facultatives, comme connecter vos specs à un tableau **Jira** ou activer des outils supplémentaires pour l'IA.
- **Paramètres** — les options par projet (télémétrie, budgets, configuration des fournisseurs, et plus encore).

## La barre de statut

Un fin bandeau court tout en bas de la fenêtre. Il est identique en mode Mission et en mode Tableau, et il reste discret : quand il n'y a rien à signaler, un emplacement reste simplement vide.

- **Connexion** (à gauche) — vide tant que tout va bien. Il affiche *Reconnexion…* (ambre) ou *Hors ligne* (rouge) seulement quand l'application perd son serveur local, et *Synchronisation…* un court instant après la reconnexion.
- **Mise à jour** (à droite) — apparaît quand une nouvelle version est prête et que l'application est inactive depuis environ une demi-minute. Cliquez dessus pour ouvrir la carte de mise à jour (voir [Mises à jour](../settings/6-updates.md)).
- **Utilisation du forfait** (à droite) — un seul indicateur, pour le fournisseur le plus proche de sa limite. Il reste neutre jusqu'à 80 %, passe à l'ambre avec le nom du fournisseur à partir de 80 % et au rouge à partir de 90 %, et affiche *limite · réinit. 15:00* quand le fournisseur refuse les requêtes. Survolez-le ou cliquez dessus pour voir les fenêtres de chaque fournisseur et la dépense du jour dans ce projet.
- **Ressources de l'app** (à droite) — une icône et le nombre de processus, seulement pendant que du travail tourne. Cliquez dessus pour voir le CPU et la mémoire, l'évolution de la mémoire et la répartition par source : missions et chats, rails, boucles et tâches, processus en arrière-plan, terminaux, CLI d'agents, MCP et runners, Git et le serveur Specrails lui-même. Dépliez une source pour voir ses processus. Sous les sources, **Ports des worktrees d'exécution** liste les ports servis par le serveur de développement ou de test de chaque rail (rail, spec, projet et processus) et avertit quand un autre processus occupe les ports attribués à un rail. Dans l'app de bureau, **Garder l’ordinateur éveillé** se trouve aussi ici ; tant que l'option est active, une icône de tasse dans la barre de statut le signale (cliquez dessus pour autoriser de nouveau la mise en veille).
- **Bascule du terminal** (tout à droite) — ouvre le panneau de terminal intégré. Appuyez sur **Cmd+J** (macOS) ou **Ctrl+J** (Windows/Linux) pour l'afficher ou le masquer à tout moment. C'est un vrai shell, ouvert directement dans le dossier de votre projet.

## Des fenêtres à part entière

Dans l'application de bureau, certains écrans s'ouvrent dans de vraies fenêtres plutôt que dans des panneaux de la fenêtre principale : les **Paramètres**, le détail d'un job ouvert depuis une mission, ainsi que **Loops** et **Plugins** en mode Mission. Vous pouvez les déplacer sur un autre écran et continuer à travailler dans la fenêtre principale. Chacune utilise les contrôles de fenêtre du système ; les Paramètres et la fenêtre du job se ferment aussi avec **Échap**. Les changements que vous y faites, comme le thème ou la langue, s'appliquent immédiatement à la fenêtre principale. Dans la version navigateur, ces écrans s'ouvrent en panneaux.

## Les notifications de ce qui vous attend {#attention}

Specrails vous prévient quand quelque chose vous attend : une question ou la réponse d'une mission, une revue prête à décider, une exécution qui a échoué, s'est bloquée ou n'avance plus, une limite de dépense et un job terminé. La manière dépend de l'endroit où vous êtes :

- **Hors de l'app** — une notification système qui nomme le projet et la cause. Dans l'app de bureau, on ne peut pas cliquer dessus : à votre retour, un toast résume (**3 éléments vous attendent**) et ouvre l'élément, ou la boîte **À traiter** s'il y en a plusieurs. Les toasts qui arrivent pendant que **Reprendre là où vous vous étiez arrêté** ou la visite de la plateforme est ouvert attendent que vous le fermiez, puis arrivent en un seul.
- **Ailleurs dans l'app** — un petit toast avec **Ouvrir**.
- **Vous le regardez déjà** — rien. Une mission que vous suivez ne signale pas ses propres réponses ; une exécution bloquée fait exception et alerte toujours.

Chaque nouvel état d'un élément de la boîte est annoncé une seule fois ; après un redémarrage, rien d'ancien n'est annoncé de nouveau. Dans la boîte, les éléments que vous n'avez pas encore vus portent un point ; **Marquer comme non lu** et **Marquer comme lu** le changent. Dans l'app de bureau, l'icône du Dock (le lanceur sous Linux) indique combien d'éléments vous n'avez pas vus.

Choisissez ce qui vous est signalé dans **Réglages ▸ Notifications** : tout couper, choisir les catégories (questions et réponses, revues, échecs, limites de dépense, jobs terminés), ajouter un son, masquer le badge du Dock ou désactiver un projet. La cloche à côté du nom d'un projet dans la boîte le coupe aussi ; ses éléments restent dans la boîte.

## Le tableau en direct {#live-board}

Le **tableau en direct** réunit toutes les exécutions de tous vos projets : rails, boucles, sessions Intent et jobs. Ouvrez-le depuis **Tableau en direct** dans la barre latérale gauche, avec **Cmd+Shift+B** (**Ctrl+Shift+B** sous Windows et Linux) ou avec **Ouvrir le tableau en direct** dans la palette de commandes. C'est aussi un lien (`?live=1`) : **Retour** le ferme.

Choisissez comment le lire avec le sélecteur de son en-tête (votre choix est mémorisé) :

- **Par état** : quatre colonnes. **Vous attend** reprend exactement la boîte de réception (questions, échecs, exécutions bloquées, limites de dépense, mises à jour Jira), le plus ancien en haut. **En cours** contient ce qui s'exécute, puis ce qui attend dans la file. **À décider** contient le travail prêt pour votre revue. **Terminé aujourd'hui** contient ce qui s'est terminé, a été fusionné ou arrêté aujourd'hui, et se vide à minuit. Une exécution n'est jamais dans deux colonnes.
- **Par mission** : une ligne par mission avec toutes les exécutions qu'elle a lancées, son projet, son moteur, le nombre d'exécutions et ce qu'elle a dépensé aujourd'hui. Les missions qui vous attendent passent en premier ; les exécutions qu'aucune mission n'a lancées ferment la liste sous **Hors mission**.

Chaque carte indique l'état de l'exécution, le projet, le rail ou le type, le titre, ce qu'elle fait en ce moment, ses étapes quand elle en a, le moteur, depuis combien de temps elle tourne ou attend, et son coût quand il est connu. Une question affiche son texte. Le bouton de la carte est la même action que partout ailleurs : **Répondre**, **Ouvrir la revue**, **Reprendre**, **Réessayer**, **Relever le plafond** ou **Ouvrir**, qui ouvre la mission qui a lancé l'exécution, ou l'exécution elle-même. Filtrez par projet, par type (Rails, Boucles, Intent, Jobs) ou par moteur ; l'en-tête résume combien vous attendent, combien sont en cours et ce que vous avez dépensé aujourd'hui.

Dans l'application de bureau, le tableau s'ouvre toujours dans sa propre fenêtre, pour un second écran : chaque façon de l'ouvrir ramène cette fenêtre au premier plan, et **Cmd+Shift+B** l'affiche ou la masque. Ses boutons agissent dans la fenêtre principale, qui passe au premier plan.

## Quelques raccourcis bien pratiques {#shortcuts}

- **Cmd/Ctrl+B** — épingler ou replier la barre latérale gauche ; **Option+Cmd+B** (**Ctrl+Alt+B**) fait de même pour la droite.
- **Cmd/Ctrl+J** — afficher ou masquer le panneau de terminal.
- **Cmd/Ctrl+K** — la palette de commandes : recherchez missions, projets et jobs, et **lancez des actions**. Tapez un verbe (« nouvelle », « lancer », « déplacer », « changer ») ou commencez par **>** pour lister les actions : Nouvelle spec (aussi en Explorer), Lancer ou Déplacer une spec, Ouvrir sa revue, Transmettre ou mettre en pause un Intent, Nouvelle mission, Changer de thème, Passer du mode Mission au mode Tableau, Ouvrir les réglages de l'app ou du projet sur une section, Exécuter un loop, afficher/masquer les barres latérales, Revenir ou avancer, Annuler le dernier changement et Supprimés récemment. Les actions qui demandent un choix (un rail, un statut, un thème, une section) ouvrent une seconde page ; **Retour arrière** sur une recherche vide revient en arrière. Chaque action affiche son raccourci clavier : la palette vous apprend les touches. Elle ne propose que ce qui fonctionne là où vous êtes et respecte les mêmes règles que les boutons (une spec qui ne peut pas être lancée n'est pas proposée). Avec une recherche vide, elle liste vos **Actions récentes** et **Lieux récents**.
- **Cmd+[ / Cmd+]** (**Alt+← / Alt+→** sous Windows/Linux), les boutons **←  →** de la barre de titre ou les boutons précédent/suivant de la souris — reculent ou avancent parmi les lieux visités : specs, missions, tâches, projets et panneaux plein écran. Un clic droit (ou un appui long) sur un bouton affiche les derniers lieux.
- **Cmd+Maj+I** (**Ctrl+Alt+I** sous Windows et Linux) ou le bouton **À traiter** de la barre de titre — la liste **À traiter** : tout ce qui vous attend dans tous vos projets, dans une seule liste groupée par projet. Elle réunit les revues prêtes à décider, les questions qu'un agent attend, les exécutions en échec ou bloquées, les exécutions en pause à cause du budget quotidien et les mises à jour Jira qui n'ont pas pu se synchroniser. Chaque ligne porte son action principale (**Ouvrir la revue**, **Répondre**, **Reprendre**, **Réessayer**) ainsi que **Reporter** (1 heure ou jusqu'à demain) et **Terminé**. Un élément reporté ou terminé revient tout seul si son état change. Le bouton indique combien d'éléments attendent, et une notification de limite du fournisseur ouvre la liste. La liste est aussi un lien (`?inbox=1`) et une action de la palette de commandes.
- **M** — avec une carte de spec ciblée dans le tableau, ouvre un sélecteur pour la déplacer vers un statut ou un rail, l'équivalent clavier du glisser-déposer. Cela fonctionne aussi sur une sélection multiple, et la palette le propose sous **Déplacer la spec ciblée…**.
- **?** — l’aide-mémoire des raccourcis. Saisissez dans son champ de recherche pour filtrer les raccourcis et trouver les pages et sections de ce guide, qui s’ouvrent dans le guide sans quitter votre écran. Les petites icônes **ⓘ** et les liens **En savoir plus** à côté des réglages, des rails, d’Intent, du curseur de contexte et des budgets ouvrent le guide à la section correspondante de la même façon.

## Et maintenant ?

Voilà pour le tour du propriétaire. À partir d'ici, le réflexe naturel est d'**ajouter une spec** et de la lancer sur un rail — regardez le pipeline se dérouler de bout en bout, puis consultez **Analytics** pour voir ce que ça a coûté. Bienvenue à bord.
