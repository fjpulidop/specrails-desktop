# Flow : construire d’abord, la spec ensuite

Flow permet de construire avec un agent quand vous ne savez pas encore exactement ce que vous voulez. Vous parlez à l’agent dans votre mission, il écrit et exécute du vrai code dans un worktree isolé et, quand le résultat est le bon, vous dites **C’est ça** : un rail reprend le worktree, dérive la spec et exécute la vérification, la revue et la livraison habituelles.

Implement sert à déléguer un travail que vous savez déjà décrire. Flow sert à le découvrir.

## Comment démarre un Flow

Inutile de demander Flow par son nom. Quand vous décrivez quelque chose d’exploratoire ou de visuel (« je veux essayer… », « je ne sais pas à quoi ça doit ressembler »), la mission affiche une carte avec deux chemins :

- **Flow** — le construire ensemble maintenant ; la spec vient à la fin.
- **Spec + Implement** — valider d’abord une spec, puis la confier à un rail.

La carte indique le chemin recommandé et explique pourquoi en une phrase. L’autre chemin reste à un clic, et l’agent n’insiste pas si vous le choisissez ou appuyez sur **Pas maintenant**.

Choisir Flow ouvre une confirmation : Specrails crée un worktree isolé où l’agent peut écrire du code, et votre branche principale n’est pas modifiée. Appuyez sur **Démarrer le Flow**. Une spec provisoire apparaît sur le board avec l’étiquette **En Flow** (cliquez dessus pour revenir à la mission).

Si votre Specrails Core ne peut pas encore exécuter Flow, le bouton est désactivé et la carte liste ce qui manque ; une mise à jour de Specrails Core suffit en général.

## Pendant le Flow

La conversation change d’aspect (un fin liseré d’accent sur le bord) et une barre apparaît au-dessus du compositeur :

- la **branche** du worktree, les **fichiers modifiés** avec les lignes ajoutées et supprimées, et le **coût réel** du Flow jusqu’ici, tel que facturé par le fournisseur. Elle affiche `—` tant qu’aucun tour n’a de coût communiqué, et jamais d’estimation ;
- **Voir les modifications** liste chaque fichier modifié avec son statut et ses +/− ;
- **Pause** arrête l’agent et conserve le worktree et la spec. La mission affiche alors **Reprendre le Flow** ;
- **Abandonner** supprime le worktree, sa branche et la spec provisoire, après confirmation ;
- **C’est ça** — l’action principale, ci-dessous.

Vous pouvez écrire pendant que l’agent travaille : en Flow, votre message **interrompt** l’étape en cours (le bouton d’envoi devient un éclair) et l’agent repart aussitôt avec vos nouvelles informations. La bande git sous le compositeur affiche la branche du worktree.

## Essayer l’app

L’agent Flow lance lui-même le typecheck et les tests pour vérifier son travail. Quand il y a quelque chose à essayer, il propose trois choix : **Start the app**, **Start and expose on the local network** ou **Not now**. L’exposer permet d’ouvrir l’app depuis un téléphone sur le même Wi-Fi ou VPN, et toute personne sur ce réseau peut y accéder.

Une fois l’app à l’écoute, l’agent vous donne ses adresses sous forme de liens et la barre Flow affiche **Aperçu** avec un point vert : il ouvre l’app dans votre navigateur. Son menu contient l’adresse réseau et **Arrêter l’app**. L’app tourne dans le worktree du Flow, jamais dans votre checkout principal, et Specrails l’arrête quand vous mettez en pause, abandonnez ou transmettez le Flow.

## C’est ça

Quand le résultat vous convient, appuyez sur **C’est ça**. La barre Flow et le traitement visuel disparaissent et la carte de lancement de rail habituelle apparaît, avec la boucle **Flow → Spec** présélectionnée et un rail libre choisi pour vous. Ajustez le moteur, le modèle ou l’effort si besoin et appuyez sur **Lancer**. Si la limite de revue ou un budget est atteint, la carte l’indique et ne lance rien. **Pas encore** vous ramène au Flow.

Le rail dérive la spec Specrails et le changement OpenSpec à partir de ce que vous avez construit, les vérifie et les relit, et la carte de livraison apparaît dans la mission comme pour toute exécution.

## Bon à savoir

- Flow n’écrit que dans son worktree. Hors Flow, les missions restent en lecture seule.
- Un seul Flow par mission à la fois. La pause survit à un redémarrage de l’app.
- Si le worktree disparaît, le Flow est marqué **à vérifier** et rien n’est supprimé.
- Jira ne reçoit rien pendant le Flow ni si vous l’abandonnez.
- Le coût de Flow apparaît dans Analytics comme surface à part, **Flow**, et dans le bloc des missions d’agent.
