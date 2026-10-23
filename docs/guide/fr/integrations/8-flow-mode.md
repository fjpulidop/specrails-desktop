# Flow : construire d’abord, la spec ensuite

Flow est une façon de construire avec un agent quand vous ne savez pas encore exactement ce que vous voulez. Vous parlez à l’agent dans votre mission, il écrit et exécute du vrai code sur sa propre branche de Flow (une copie séparée de votre projet), et quand le résultat est le bon, vous appuyez sur **Remettre** : un rail reprend vos modifications, dérive la spec et lance la vérification, la revue et la livraison habituelles.

Implement sert à déléguer un travail que vous savez déjà décrire. Flow sert à le découvrir.

## Comment démarre un Flow

Vous n’avez jamais à demander Flow par son nom. Quand vous décrivez quelque chose d’exploratoire ou de visuel (« je veux essayer… », « je ne sais pas à quoi ça doit ressembler »), la mission affiche une carte avec deux chemins :

- **Flow** : le construire ensemble maintenant ; la spec vient à la fin.
- **Spec + Implement** : s’accorder d’abord sur une spec, puis la déléguer à un rail.

Les deux chemins ont le même poids et apparaissent toujours dans le même ordre : aucun n’est recommandé, c’est vous qui choisissez. Sous **Pourquoi l’agent demande**, l’agent dit en une phrase ce qui l’a fait demander, et il n’insistera pas quel que soit votre choix ou si vous appuyez sur **Pas maintenant**.

Choisir Flow ouvre une confirmation : Specrails crée une copie séparée du projet sur sa propre branche de Flow, où l’agent peut écrire du code, et votre branche principale n’est pas touchée. Appuyez sur **Démarrer le Flow**. Une spec provisoire apparaît sur le board avec le libellé **En Flow** (cliquez dessus pour revenir à la mission).

Si votre Specrails Core ne peut pas encore exécuter Flow, Démarrer est désactivé et la carte liste ce qui manque. En général, une mise à jour de Specrails Core suffit.

## Pendant le Flow

Le mode Flow est nommé là où vous regardez, dans sa propre couleur de Flow : le compositeur affiche une puce **Flow** à côté de celle d’autonomie et l’indication *Dites à l’agent quoi modifier dans ce Flow…* ; le titre de la mission indique **En Flow**, tout comme sa ligne dans la liste des missions. La conversation marque où vous êtes entré dans Flow et où vous en êtes sorti, et les réponses de l’agent écrites en Flow portent une petite marque **Flow** à côté de leur heure.

Le bandeau juste au-dessus du compositeur montre le Flow sur une ligne courte : son état, **Flow · 7 fichiers**, **Suspendre le Flow** et l’action principale, **Remettre**. Quand une action est indisponible (le Flow enregistre encore, une autre action est en cours), le survol dit pourquoi. Ouvrez la ligne avec son chevron, comme n’importe quelle exécution, pour voir le reste :

- la **branche** (cliquez pour copier son nom), les **modifications** avec les lignes ajoutées et supprimées (cliquez pour lister chaque fichier modifié avec son état et ses +/−), et le **coût jusqu’ici** tel que facturé par le fournisseur. Il affiche `—` tant qu’aucun tour n’a de coût déclaré, jamais une estimation ; un `*` signale un total qui exclut des tours sans prix, avec une note indiquant combien ;
- **Aperçu** tant que l’app du Flow tourne (voir plus bas) ;
- **Abandonner**, à l’écart, supprime les modifications du Flow, sa branche et la spec provisoire. La confirmation liste ce que vous perdez : les fichiers modifiés avec leurs +/−, la branche et la spec.

**Suspendre le Flow** arrête l’agent et conserve vos modifications et la spec. La ligne affiche alors **Reprendre le Flow**.

Vous pouvez écrire pendant que l’agent travaille : en Flow, votre message **interrompt** l’étape en cours (le bouton d’envoi devient un éclair) et l’agent continue aussitôt avec vos nouvelles informations. Tant que le Flow est ouvert, la bande git sous le compositeur s’efface : le panneau du Flow montre déjà sa branche.

## Essayer l’app

L’agent Flow lance lui-même le typecheck et les tests pour vérifier son travail. Quand il y a quelque chose à essayer, il demande avec trois choix : **Start the app**, **Start and expose on the local network** ou **Not now**. L’exposer vous permet d’ouvrir l’app depuis un téléphone sur le même Wi-Fi ou VPN, et toute personne sur ce réseau peut y accéder.

Une fois l’app à l’écoute, l’agent vous donne ses adresses en liens et le panneau du Flow affiche **Aperçu** avec un point vert : il ouvre l’app dans votre navigateur. Son menu propose l’adresse réseau et **Arrêter l’app**. L’app tourne depuis la copie du Flow, jamais depuis votre checkout principal, et Specrails l’arrête quand vous mettez en pause, abandonnez ou remettez le Flow.

## Remettre

Quand le résultat vous convient, appuyez sur **Remettre**. La ligne indique **Prêt à devenir une PR** et ouvre une seule ligne au-dessus : *Rail 2 transformera vos 7 fichiers modifiés en PR relue. En cas d’échec, votre travail est en sécurité.* Appuyez sur **Lancer**, ou sur **Pas encore** pour revenir au Flow ; fermer la ligne (Échap ou un clic ailleurs) revient à **Pas encore**. Si le moteur de votre conversation ne peut pas exécuter la remise sur cette machine, une note juste sous la ligne le dit et le moteur par défaut du rail est utilisé.

Le rail, le moteur, le modèle et l’effort sont déjà choisis pour vous (un rail libre et le moteur de votre conversation). Pour les changer, ouvrez **Changer la méthode** ; vous y voyez aussi ce qui a changé et le coût jusqu’ici. Pendant le démarrage, le bandeau montre le lancement sans trou, puis suit l’exécution étape par étape. Si la limite de revue ou un budget est atteint, la ligne le dit et rien n’est lancé. Si l’exécution n’apparaît pas au bout de 45 secondes, le bandeau cesse de tourner et indique **Remise à Rail 2 toujours en cours…** avec **Actualiser**.

Le rail dérive la spec et son changement de spec à partir de ce que vous avez construit, la vérifie et la relit, et la carte de livraison apparaît dans la mission comme pour toute exécution.

Si l’exécution échoue pour une raison technique, le travail revient de lui-même dans ce Flow, intact : la carte dit en mots simples ce qui a échoué (les codes restent sous **Détails techniques**) et l’agent reçoit l’erreur et l’explique. Si la revue demande des modifications, la carte propose **Revenir dans Flow** ou **Relancer**. Quand la livraison est réglée, la mission clôt le Flow par un résumé : la pull request, la spec réécrite à partir de ce que vous avez construit, le changement de spec archivé et le ticket Jira s’il y en a un.

## Bon à savoir

- Flow n’écrit que sur sa propre branche. Hors de Flow, les missions restent en lecture seule.
- Un seul Flow par mission à la fois. Une pause survit au redémarrage de l’app.
- Si la copie du projet du Flow disparaît, le Flow est marqué **doit être vérifié** (pour information, rien à décider) et rien n’est supprimé.
- La barre ne change jamais l’exécution que vous regardez. Si une autre se met à vous attendre entre-temps, son nom dans le sélecteur de la barre indique **vous attend**.
- Jira ne reçoit rien tant que vous êtes en Flow ni si vous l’abandonnez.
- Le coût de Flow apparaît dans Analytique comme surface à part, **Flow**, et dans le bloc des missions d’agent.
