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
- **Analytics** — ce que coûte votre usage de l'IA. Les dépenses ventilées par jour, par activité, par modèle et par ticket — pour éviter les mauvaises surprises.
- **Agents** — les profils d'agents de votre projet : quels agents s'exécutent dans le pipeline et quels modèles d'IA ils utilisent. *(Projets propulsés par Claude uniquement.)*
- **Code** — un explorateur de fichiers en lecture seule, avec des résumés IA en langage clair et des badges indiquant quels fichiers l'IA a touchés. Idéal pour les non-développeurs qui veulent suivre.
- **Intégrations** — des extensions facultatives, comme connecter vos specs à un tableau **Jira** ou activer des outils supplémentaires pour l'IA.
- **Paramètres** — les options par projet (télémétrie, budgets, configuration des fournisseurs, et plus encore).

> Certaines sections n'apparaissent que lorsqu'elles ont du sens pour les fournisseurs que vous avez choisis — par exemple, **Agents** est spécifique à Claude. Si vous ne voyez pas une section, c'est simplement qu'elle ne s'applique pas à la configuration de ce projet.

## La barre de statut

Un fin bandeau court tout en bas de la fenêtre. Discret mais bien pratique :

- **Indicateur de connexion** (à gauche) — un point coloré et un libellé qui montrent que l'application est en ligne : vert pour *connecté*, ambre pendant la *reconnexion*, bleu pendant la *synchronisation* juste après une reconnexion. Vous en aurez rarement besoin, mais c'est rassurant le moment venu.
- **Dépense totale** (à droite) — un cumul en temps réel de ce que vous avez dépensé, pour que le coût soit toujours à portée de regard.
- **Bascule du terminal** (tout à droite) — ouvre le panneau de terminal intégré. Appuyez sur **Cmd+J** (macOS) ou **Ctrl+J** (Windows/Linux) pour l'afficher ou le masquer à tout moment. C'est un vrai shell, ouvert directement dans le dossier de votre projet.

## Quelques raccourcis bien pratiques

- **Cmd/Ctrl+B** — épingler ou replier les barres latérales.
- **Cmd/Ctrl+J** — afficher ou masquer le panneau de terminal.
- **Cmd/Ctrl+K** — ouvrir la recherche.

## Et maintenant ?

Voilà pour le tour du propriétaire. À partir d'ici, le réflexe naturel est d'**ajouter une spec** et de la lancer sur un rail — regardez le pipeline se dérouler de bout en bout, puis consultez **Analytics** pour voir ce que ça a coûté. Bienvenue à bord.
