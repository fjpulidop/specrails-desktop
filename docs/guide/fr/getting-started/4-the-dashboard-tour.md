# La visite du tableau de bord

Un projet ajouté, vous voilà devant votre **tableau de bord de projet** — votre camp de base pour transformer les specs en code livré. Voici comment vous y retrouver.

## La vue d'ensemble

La fenêtre comporte trois zones :

- **Barre latérale gauche** — la liste de vos projets. Cliquez sur n'importe quel projet pour y basculer instantanément ; tout le reste de la fenêtre se met à jour pour correspondre. Le bouton **Ajouter un projet** se trouve ici aussi.
- **Zone principale** — le tableau de bord du projet actif : vos specs et le pipeline qui les exécute.
- **Barre latérale droite** — la navigation entre les sections du projet courant.

## Le tableau de bord principal

C'est là que le travail se fait. Le tableau de bord affiche :

- **Vos specs** — les tickets que vous avez créés, organisés par statut (Backlog/À faire jusqu'à Terminé). Vous pouvez les visualiser sous forme de liste, de grille ou de cartes type post-it, selon votre préférence.
- **Un moyen d'ajouter une spec** — démarrez un nouveau morceau de travail. Vous pouvez rédiger une spec rapide directement, ou ouvrir un chat **Explore** guidé qui vous aide à la façonner par la conversation et rédige le ticket pour vous.
- **Les rails** — ce sont les couloirs où les specs se construisent. Déposez une spec sur un rail et lancez-la pour la faire passer dans le pipeline Architect → Developer → Reviewer → Ship. Plusieurs rails peuvent tourner en même temps, vous pouvez donc travailler sur plusieurs choses en parallèle.

Quand une spec s'exécute, vous voyez la progression de son pipeline et ses logs en direct — la sortie en temps réel de l'IA pendant qu'elle conçoit, code et relit votre modification.

## La barre latérale droite : les sections du projet

La barre latérale droite est votre tableau d'aiguillage pour le projet courant. Survolez-la pour la déplier, ou épinglez-la ouverte. Les sections que vous y trouverez :

- **Tableau de bord** — le tableau des specs et les rails (là d'où vous venez).
- **Jobs** — chaque exécution de pipeline pour ce projet, passée et présente, avec son statut, sa durée et la possibilité de plonger dans le détail et les logs de n'importe quelle exécution.
- **Intégrations** — des extensions facultatives, comme connecter vos specs à un tableau **Jira** ou activer des outils supplémentaires pour l'IA.
- **Paramètres** — les options par projet (télémétrie, budgets, configuration des fournisseurs, et plus encore).

## La barre de statut

Un fin bandeau court tout en bas de la fenêtre. Discret mais bien pratique :

- **Indicateur de connexion** (à gauche) — un point coloré et un libellé qui montrent que l'application est en ligne : vert pour *connecté*, ambre pendant la *reconnexion*, bleu pendant la *synchronisation* juste après une reconnexion. Vous en aurez rarement besoin, mais c'est rassurant le moment venu.
- **Dépense totale** (à droite) — un cumul en temps réel de ce que vous avez dépensé, pour que le coût soit toujours à portée de regard.
- **Bascule du terminal** (tout à droite) — ouvre le panneau de terminal intégré. Appuyez sur **Cmd+J** (macOS) ou **Ctrl+J** (Windows/Linux) pour l'afficher ou le masquer à tout moment. C'est un vrai shell, ouvert directement dans le dossier de votre projet.

## Quelques raccourcis bien pratiques {#shortcuts}

- **Cmd/Ctrl+B** — épingler ou replier la barre latérale gauche ; **Option+Cmd+B** (**Ctrl+Alt+B**) fait de même pour la droite.
- **Cmd/Ctrl+J** — afficher ou masquer le panneau de terminal.
- **Cmd/Ctrl+K** — la palette de commandes : recherchez missions, projets et jobs, et **lancez des actions**. Tapez un verbe (« nouvelle », « lancer », « déplacer », « changer ») ou commencez par **>** pour lister les actions : Nouvelle spec (aussi en Explorer), Lancer ou Déplacer une spec, Ouvrir sa revue, Transmettre ou mettre en pause un Flow, Nouvelle mission, Changer de thème, Passer du mode Mission au mode Tableau, Ouvrir les réglages de l'app ou du projet sur une section, Exécuter un loop, afficher/masquer les barres latérales, Revenir ou avancer, Annuler le dernier changement et Supprimés récemment. Les actions qui demandent un choix (un rail, un statut, un thème, une section) ouvrent une seconde page ; **Retour arrière** sur une recherche vide revient en arrière. Chaque action affiche son raccourci clavier : la palette vous apprend les touches. Elle ne propose que ce qui fonctionne là où vous êtes et respecte les mêmes règles que les boutons (une spec qui ne peut pas être lancée n'est pas proposée). Avec une recherche vide, elle liste vos **Actions récentes** et **Lieux récents**.
- **Cmd+[ / Cmd+]** (**Alt+← / Alt+→** sous Windows/Linux), les boutons **←  →** de la barre de titre ou les boutons précédent/suivant de la souris — reculent ou avancent parmi les lieux visités : specs, missions, tâches, projets et panneaux plein écran. Un clic droit (ou un appui long) sur un bouton affiche les derniers lieux.
- **Cmd+Maj+I** (**Ctrl+Maj+I**) ou le bouton **Boîte** de la barre de titre — la boîte **On a besoin de vous** : tout ce qui vous attend dans tous vos projets, dans une seule liste groupée par projet. Elle réunit les revues prêtes à décider, les questions qu'un agent attend, les exécutions en échec ou bloquées, les exécutions en pause à cause du budget quotidien et les mises à jour Jira qui n'ont pas pu se synchroniser. Chaque ligne porte son action principale (**Ouvrir la revue**, **Répondre**, **Reprendre**, **Réessayer**) ainsi que **Reporter** (1 heure ou jusqu'à demain) et **Terminé**. Un élément reporté ou terminé revient tout seul si son état change. Le bouton indique combien d'éléments attendent, et une notification de limite du fournisseur ouvre la boîte. La boîte est aussi un lien (`?inbox=1`) et une action de la palette de commandes.
- **?** — l’aide-mémoire des raccourcis. Saisissez dans son champ de recherche pour filtrer les raccourcis et trouver les pages et sections de ce guide, qui s’ouvrent dans le guide sans quitter votre écran. Les petites icônes **ⓘ** et les liens **En savoir plus** à côté des réglages, des rails, de Flow, du curseur de contexte et des budgets ouvrent le guide à la section correspondante de la même façon.

## Et maintenant ?

Voilà pour le tour du propriétaire. À partir d'ici, le réflexe naturel est d'**ajouter une spec** et de la lancer sur un rail — regardez le pipeline se dérouler de bout en bout, puis consultez **Analytics** pour voir ce que ça a coûté. Bienvenue à bord.
