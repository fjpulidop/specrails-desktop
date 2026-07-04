# Code explorer

La section **Code** vous offre une fenêtre conviviale et en lecture seule sur votre dépôt — pensée tout particulièrement pour celles et ceux qui veulent comprendre ce que l'IA construit sans devoir vivre dans un éditeur. Vous disposez d'une arborescence de fichiers à gauche, d'un afficheur de code à droite, et, au-dessus du code, d'un résumé en langage clair de ce que fait réellement chaque fichier.

Dans cette version, c'est strictement en lecture seule : rien de ce que vous faites ici ne modifie vos fichiers. Voyez-le comme une salle de lecture, pas comme un atelier.

Ouvrez-la depuis la barre latérale droite (**Code**) et, comme tout le reste, elle se rapporte à votre projet actuel.

## L'arborescence de fichiers

Le volet de gauche est une arborescence virtualisée des fichiers de votre projet — rapide même sur de gros dépôts. Elle respecte votre `.gitignore` et une liste d'exclusion intégrée, pour que vous voyiez les fichiers qui comptent, et non un océan d'artefacts de build et de `node_modules`.

À côté des fichiers, vous remarquerez des **pastilles de provenance** — de petits marqueurs qui vous indiquent qu'un fichier a été *touché par l'IA*. C'est le cœur du Code explorer : Specrails enregistre quels fichiers chaque job de pipeline a créés ou modifiés, et les relie au ticket qui a déclenché le travail. Vous pouvez ainsi répondre, d'un coup d'œil, à la question « est-ce l'IA qui a écrit ça, ou moi ? »

En haut de l'arborescence se trouve un filtre :

- **Touchés par l'IA** (par défaut) — uniquement les fichiers que l'IA a modifiés.
- **Tous les fichiers** — l'arborescence complète.

Votre choix est mémorisé par projet : si vous vous intéressez surtout aux changements produits par l'IA, vous les verrez en premier à chaque fois.

## L'afficheur de code

Cliquez sur un fichier et il s'ouvre dans un afficheur complet (propulsé par Monaco, le même moteur que VS Code) avec une coloration syntaxique soignée qui s'accorde au thème d'application que vous avez choisi. Quelques limites raisonnables gardent l'ensemble fluide : les fichiers binaires sont poliment refusés, et les très gros fichiers (au-delà de 2 Mo) ne se chargent pas.

Le fichier en cours est enregistré dans l'URL de la page, pour que vous puissiez mettre en favori ou partager un lien direct vers un fichier précis.

L'édition ne faisant pas partie de cette version, l'afficheur propose un bouton **Modifier dans un éditeur externe** qui copie le chemin absolu du fichier — collez-le dans l'éditeur de votre choix et reprenez le travail là-bas.

## Les résumés IA

Au-dessus du code, vous verrez un **résumé en langage clair** du fichier — à quoi il sert, ce qu'il fait — rédigé pour qu'une personne non développeuse puisse suivre. Ces résumés sont générés pour vous et mis en cache, de sorte que rouvrir un fichier déjà consulté est instantané.

Les résumés savent rester à jour : ils sont indexés sur le contenu du fichier, donc lorsqu'un fichier change réellement, le résumé est régénéré, mais les fichiers inchangés ne sont pas résumés à nouveau inutilement. Si vous modifiez vous-même un fichier, son résumé est marqué comme obsolète plutôt que silencieusement régénéré — vous gardez la main sur le moment où il est rafraîchi. Une action **régénérer** est disponible quand vous voulez un nouveau résumé à la demande.

Quelques garde-fous gardent les coûts raisonnables : la génération des résumés s'inscrit dans un **budget mensuel** (quelques dollars par défaut, configurable dans les Paramètres), et il existe des plafonds sur le nombre de résumés qu'un même job peut déclencher. Si un résumé est ignoré, l'application vous en dit la raison — budget atteint, plafond par job, ou fichier tout simplement introuvable.

Vous pouvez aussi choisir la **langue des résumés** (anglais ou espagnol) dans les paramètres globaux, sous la rubrique *Code section*.

## L'histoire de construction

Sous l'afficheur de code vit l'**histoire de construction** : une chronologie de chaque spec et de chaque job qui ont bâti le fichier que vous regardez. Chaque chapitre est une carte : quelle spec est intervenue (avec son statut actuel), quand, si le fichier a été créé, modifié ou supprimé, et l'ampleur du changement (lignes ajoutées et supprimées). Cliquez sur une carte pour ouvrir le détail de cette spec. Les rails basés sur des loops enregistrent aussi les fichiers qu'ils touchent : le travail effectué dans des worktrees isolés apparaît dans l'histoire comme les jobs classiques du pipeline.

Pour n'importe quel chapitre, vous pouvez demander une explication en langage simple : appuyez sur **Expliquer ce changement** et l'app rédige une à trois phrases décrivant ce que ce changement précis a apporté au fichier — sans code, sans jargon. Les explications partagent le même budget mensuel que les résumés de fichiers, et tant qu'aucune n'a été générée, la carte s'en tient aux faits qu'elle connaît : le type de changement, la spec et la date. Vous préférez les données brutes ? Un sélecteur **Histoire / Journal** bascule vers la liste classique des modifications avec des diffs à la demande. Le même panneau apparaît dans le volet **Files** du mode Agent.

## Relier le code aux specs

Le lien de provenance fonctionne dans les deux sens. Dans le Code explorer, cliquer sur la pastille d'un ticket attachée à un fichier ouvre le détail de ce ticket. Et dans l'autre sens, la vue **détail du ticket** comporte une section *Fichiers touchés par ce ticket* — cliquez-y sur un fichier et vous atterrissez directement dans le Code explorer avec ce fichier ouvert. La boucle est ainsi bouclée entre « voici la spec que nous avons écrite » et « voici le code qui en est sorti ».

## Ce qu'il ne fait pas (encore)

Pour poser les attentes clairement, cette première version laisse délibérément quelques éléments de côté : l'édition dans l'application, les résumés par symbole ou par répertoire, une vue de diff narrative, et le « pose une question à l'IA sur ce fichier » conversationnel. La provenance attribue un fichier à son ticket principal uniquement. Ce sont là le genre de choses qui pourront se développer au fil du temps.

## Le désactiver

Le Code explorer est activé par défaut. Il peut être désactivé avec les flags `VITE_FEATURE_CODE_EXPLORER` (client) ou `SPECRAILS_CODE_EXPLORER` (serveur) — mettez l'un ou l'autre à `false`. Le désactiver laisse toutes vos données enregistrées et vos résumés sagement sur le disque, intacts, au cas où vous le réactiveriez.
