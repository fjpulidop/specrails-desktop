# Flow : construire d’abord, la spec ensuite

Flow permet de construire avec un agent quand vous ne savez pas encore exactement ce que vous voulez. Vous parlez à l’agent dans votre mission, il écrit et exécute du vrai code dans un worktree isolé et, quand le résultat est le bon, vous dites **C’est bon** : un rail reprend le worktree, dérive la spec et exécute la vérification, la revue et la livraison habituelles.

Implement sert à déléguer un travail que vous savez déjà décrire. Flow sert à le découvrir.

## Comment démarre un Flow

Inutile de demander Flow par son nom. Quand vous décrivez quelque chose d’exploratoire ou de visuel (« je veux essayer… », « je ne sais pas à quoi ça doit ressembler »), la mission affiche une carte avec deux chemins :

- **Flow** — le construire ensemble maintenant ; la spec vient à la fin.
- **Spec + Implement** — valider d’abord une spec, puis la confier à un rail.

Les deux chemins ont le même poids et apparaissent toujours dans le même ordre : aucun n’est recommandé, c’est vous qui choisissez. Sous **Pourquoi l’agent demande**, l’agent explique en une phrase ce qui l’a amené à poser la question, et il n’insiste pas, quel que soit le chemin choisi ou si vous appuyez sur **Pas maintenant**.

Choisir Flow ouvre une confirmation : Specrails crée un worktree isolé où l’agent peut écrire du code, et votre branche principale n’est pas modifiée. Appuyez sur **Démarrer le Flow**. Une spec provisoire apparaît sur le board avec l’étiquette **En Flow** (cliquez dessus pour revenir à la mission).

Si votre Specrails Core ne peut pas encore exécuter Flow, le bouton est désactivé et la carte liste ce qui manque ; une mise à jour de Specrails Core suffit en général.

## Pendant le Flow

Le mode Flow est nommé là où vous regardez : le compositeur affiche une puce **Flow** à côté de celle d'autonomie, un fin liseré d'accent en haut et l'indication *Dites à l'agent quoi modifier dans le worktree…* ; le titre de la mission indique **En Flow**, tout comme sa ligne dans la liste des missions. La conversation marque où vous êtes entré dans Flow et où vous en êtes sorti, et les réponses de l'agent écrites en Flow portent une petite marque **Flow** à côté de leur heure. La barre juste au-dessus du compositeur montre le Flow :

- la **branche** du worktree, les **fichiers modifiés** avec les lignes ajoutées et supprimées, et le **coût réel** du Flow jusqu’ici, tel que facturé par le fournisseur. Elle affiche `—` tant qu’aucun tour n’a de coût communiqué, et jamais d’estimation ;
- cliquez sur les **fichiers modifiés** pour lister chaque fichier avec son statut et ses +/−, et sur la **branche** pour copier son nom ;
- **Pause** arrête l’agent et conserve le worktree et la spec. La mission affiche alors **Reprendre le Flow** ;
- **Abandonner**, à l’écart sur la gauche, supprime le worktree, sa branche et la spec provisoire. La confirmation énumère ce que vous perdez : les fichiers modifiés avec leurs +/−, la branche et la spec ;
- **C’est bon** — l’action principale, ci-dessous. Quand elle est indisponible (le Flow enregistre encore, une autre action est en cours), son survol indique pourquoi.

Vous pouvez écrire pendant que l’agent travaille : en Flow, votre message **interrompt** l’étape en cours (le bouton d’envoi devient un éclair) et l’agent repart aussitôt avec vos nouvelles informations. Tant que la barre est visible, la bande git sous le compositeur s’efface : la barre affiche déjà la branche du worktree.

## Essayer l’app

L’agent Flow lance lui-même le typecheck et les tests pour vérifier son travail. Quand il y a quelque chose à essayer, il propose trois choix : **Start the app**, **Start and expose on the local network** ou **Not now**. L’exposer permet d’ouvrir l’app depuis un téléphone sur le même Wi-Fi ou VPN, et toute personne sur ce réseau peut y accéder.

Une fois l’app à l’écoute, l’agent vous donne ses adresses sous forme de liens et la barre Flow affiche **Aperçu** avec un point vert : il ouvre l’app dans votre navigateur. Son menu contient l’adresse réseau et **Arrêter l’app**. L’app tourne dans le worktree du Flow, jamais dans votre checkout principal, et Specrails l’arrête quand vous mettez en pause, abandonnez ou transmettez le Flow.

## C’est bon

Quand le résultat vous convient, appuyez sur **C'est bon**. La même barre devient **Flow → Spec prêt à lancer** et ouvre ses réglages juste au-dessus : la boucle **Flow → Spec**, un rail libre choisi pour vous et le moteur, le modèle et l'effort de votre conversation. Ajustez ce que vous voulez et appuyez sur **Lancer** (dans le panneau ou sur la barre). Pendant le démarrage, la barre l'indique — sans trou — puis suit l'exécution étape par étape. Si la limite de relecture ou un budget est atteint, le panneau le dit et ne lance rien. **Pas encore** vous ramène au Flow.

Le rail dérive la spec Specrails et le changement OpenSpec à partir de ce que vous avez construit, les vérifie et les relit, et la carte de livraison apparaît dans la mission comme pour toute exécution.

Dans ce panneau, un récapitulatif d'une ligne indique ce qui part vers le rail (fichiers et lignes) et le coût du Flow jusqu'ici. Si l’exécution échoue pour une raison technique, le travail revient de lui-même dans ce Flow, intact : la carte explique simplement ce qui a échoué (les codes restent sous **Détails techniques**) et l’agent reçoit l’erreur et l’explique. Si la revue demande des modifications, la carte propose **Revenir dans Flow** ou **Relancer**. Une fois la livraison finalisée, la mission clôt le Flow par un résumé : la pull request, la spec réécrite à partir de ce que vous avez construit, le changement OpenSpec archivé et le ticket Jira s’il existe.

## Bon à savoir

- Flow n’écrit que dans son worktree. Hors Flow, les missions restent en lecture seule.
- Un seul Flow par mission à la fois. La pause survit à un redémarrage de l’app.
- Si le worktree disparaît, le Flow est marqué **à vérifier** et rien n’est supprimé.
- Jira ne reçoit rien pendant le Flow ni si vous l’abandonnez.
- Le coût de Flow apparaît dans Analytics comme surface à part, **Flow**, et dans le bloc des missions d’agent.
