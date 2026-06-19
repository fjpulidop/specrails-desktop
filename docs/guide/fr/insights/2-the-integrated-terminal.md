# Le terminal intégré

Specrails embarque un véritable terminal — le panneau qui remonte depuis le bas de la fenêtre, exactement comme celui de VS Code ou Cursor. Il fait tourner votre shell réel, dans le répertoire réel de votre projet, pour que vous puissiez lancer `git`, `npm`, vos tests, ou tout autre commande sans quitter l'application.

## L'ouvrir et le fermer

Le plus rapide passe par le clavier : **Cmd+J** (macOS) ou **Ctrl+J** (Windows/Linux) ouvre et ferme le panneau, et place le focus sur le terminal dès qu'il apparaît pour que vous puissiez taper immédiatement. Vous pouvez aussi utiliser le chevron dans la barre d'état.

Le panneau a trois états :

- **Masqué** — rangé hors de vue.
- **Restauré** — le panneau normal à mi-hauteur.
- **Agrandi** — qui prend toute la zone de travail quand vous avez besoin de place pour lire une sortie.

Replier le panneau (le chevron) **n'arrête** rien — vos shells continuent de tourner en arrière-plan. La seule chose qui met réellement fin à une session, c'est de la fermer (l'icône corbeille, ou le ✕ propre à chaque onglet).

## Plusieurs sessions

Vous pouvez faire tourner plusieurs terminaux à la fois dans le même projet — jusqu'à dix. Chacun a son propre onglet ; vous pouvez les renommer pour ne pas confondre « dev server » et « tests ». Ils démarrent tous dans le dossier de votre projet et chargent votre profil de shell (`.zshrc`, `.bashrc`, etc.), pour que vos alias et votre PATH soient exactement ceux que vous attendez.

Voici le point important : vos terminaux **survivent aux changements de projet et d'onglet**. Specrails maintient chaque session vivante et intacte en coulisses — historique de défilement, processus en cours, tout — de sorte que basculer vers Analytics puis revenir ne réinitialise pas votre shell ni n'interrompt une commande de longue durée. Les sessions ne se terminent que lorsque vous les fermez explicitement (ou lorsque vous supprimez le projet entier).

## Par projet, et mémorisé

Que le panneau soit ouvert, la hauteur à laquelle vous l'avez étiré, les onglets qui existent — tout cela est mémorisé **par projet**. Revenez sur un projet et il est configuré comme vous l'aviez laissé.

## Les fonctionnalités premium

Ce n'est pas une console minimaliste. Le terminal embarque tout le confort qu'on attend d'un terminal de premier ordre :

- **Un rendu rapide et net** grâce à WebGL (avec un repli automatique pour qu'il ne casse jamais), une gestion complète de la largeur Unicode et les ligatures de police.
- **La recherche dans l'historique de défilement** avec **Cmd+F** — idéal pour retrouver cette erreur enfouie 500 lignes plus haut.
- **Le zoom de police** avec **Cmd+=**, **Cmd+-** et **Cmd+0** pour réinitialiser.
- **Les raccourcis presse-papiers** — Cmd+C / Cmd+V pour copier et coller, Cmd+K pour effacer — ainsi qu'un menu contextuel au clic droit.
- **Le glisser-déposer de chemins de fichiers** (dans l'application desktop) : déposez un fichier sur le terminal et son chemin est inséré, correctement échappé pour votre shell.
- **Le redimensionnement fluide** — étirer la hauteur du panneau ou replier la barre latérale ne fait pas trembloter la sortie.
- **Les images en ligne** — les terminaux qui émettent des images au format Sixel ou iTerm2 les affichent directement sur place.
- **L'intégration au shell** — Specrails sait où commence et où finit chaque commande, ce qui lui permet de suivre votre historique de commandes et de vous prévenir quand une commande de longue durée se termine (une notification desktop, avec un repli navigateur). Si votre shell ne peut pas être instrumenté pour une raison quelconque, l'intégration se dégrade discrètement et vous le signale une seule fois.

## Paramètres

Les préférences du terminal vivent sur deux couches : une valeur par défaut à l'échelle de l'application et une surcharge optionnelle par projet. Le réglage par projet l'emporte lorsqu'il est présent, ce qui vous permet de conserver une apparence globale tout en ajustant un projet qui a besoin de quelque chose de différent.

## Le désactiver

Le terminal est activé par défaut. Si vous préférez vous en passer, vous pouvez le désactiver via les flags `VITE_FEATURE_TERMINAL_PANEL` (client) ou `SPECRAILS_TERMINAL_PANEL` (serveur) — mettez l'un ou l'autre à `false`. La plupart des gens le laisseront simplement activé.
