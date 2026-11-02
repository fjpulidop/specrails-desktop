# Intent : dites le problème, pas la solution {#intent-mode}

Écrire du code n’est plus la partie lente du développement. Ce qui est lent, c’est de savoir quoi construire et de vérifier que c’est bien construit. Intent part de là. Vous écrivez l’**intent** : le problème, le résultat voulu, comment vous saurez que ça a marché, qui et quoi est concerné, les limites, et ce que personne ne sait encore. Vous n’écrivez pas la solution. Specrails dérive la spec de votre intent, et vous relisez la spec au lieu de l’écrire.

À partir d’un intent, il y a deux chemins égaux :

- **Explorer** : construisez-le avec un agent dans une session Intent isolée (sa propre branche, une copie séparée de votre projet). Quand le résultat est le bon, un rail dérive la spec de ce que vous avez construit.
- **Déléguer** : l’agent écrit la spec à partir de l’intent, vous la relisez, et un rail la construit.

Explorer sert à découvrir ; Déléguer, à construire ce qui est déjà clair. Aucun n’est recommandé : c’est vous qui choisissez.

## L’intent

Un intent comporte six parties, et aucune pour la solution :

| Partie | Ce qu’elle contient |
| --- | --- |
| **Problème** | Ce qui ne va pas aujourd’hui, pour qui et quand ça fait mal. |
| **Résultat recherché** | Ce qui est vrai une fois le problème résolu. Une **hypothèse** facultative se lit *Nous pensons que … produira … ; nous le saurons quand …*. |
| **Comment nous le saurons** | Des signaux observables que le résultat est atteint (« un nouvel utilisateur termine la configuration en moins de 2 minutes »). Ils deviennent des critères d’acceptation. |
| **Qui et quoi est concerné** | Des personnes, des écrans ou des systèmes. |
| **Contraintes** | Les limites que toute solution doit respecter. |
| **Questions ouvertes** | Ce que personne ne sait encore. Les agents les étudient au lieu de deviner. |

Si vous nommez une solution (« ajouter un cache Redis »), l’intent garde ce à quoi elle sert (« l’API répond en moins de 200 ms ») comme résultat recherché, et votre solution devient une contrainte (vous l’exigez) ou une question ouverte (c’est une option parmi d’autres).

Chaque spec peut porter un intent. Il se trouve au-dessus de la description dans le détail de la spec, où vous pouvez modifier chaque partie ; une spec qui n’en a pas affiche une action compacte **Ajouter un intent**. Pendant la modification, **Enregistrer l’intent** est le bouton principal, **Échap** annule et **⌘/Ctrl+Entrée** enregistre. Chaque question ouverte qui a reçu une réponse l’affiche sous l’étiquette **Réponse**, et quand plus aucune n’est ouverte, le titre devient **Questions · N répondues**. Une spec dont l’intent a encore des questions ouvertes affiche sur le board une petite boussole avec leur nombre, dans toutes les vues du board (post-it ou ligne). L’intent reste dans Specrails, comme **Hors périmètre**, et n’est jamais écrit dans Jira.

## D’où vient un intent

- **Dans une mission (par défaut).** Quand vous décrivez un travail, l’agent vous interroge comme un analyste. Il pose des questions sur les utilisateurs, les limites et la manière de savoir que ça a marché, puis affiche une carte **Intent** avec chaque partie et deux lectures de votre demande. Cliquez sur une lecture pour répondre, ou répondez avec vos mots. Tant que l’intent n’est pas convenu, chaque question ouverte de la carte est un bouton qui préremplit votre réponse dans le compositeur, et une pastille indique combien restent ouvertes. Une fois convenu, la pastille affiche **Convenu**, les lectures laissent place à **Lecture confirmée**, et la carte propose **Explorer** et **Déléguer** côte à côte sous **Comment voulez-vous continuer ?** ; les deux chemins restent sur la carte au fil de vos propres messages suivants, et un intent long est replié avec **Afficher l’intent complet**. La puce **Partir d’un problème** sur l’accueil de la mission lance cet entretien. Une spec que l’agent écrit à partir de lui porte l’intent automatiquement. Pour sauter l’étape de l’intent dans une mission, envoyez `#noframe` ; `#frame` la réactive.
- **Dans Ajouter une spec.** **Intent** est le premier mode et s’ouvre par défaut (marqué **Par défaut**). Décrivez le problème, pas la solution ; trois puces au-dessus de l’éditeur, **Problème**, **Qui est concerné** et **Comment nous le saurons**, insèrent une ligne à compléter (*Problème :*, *Qui est concerné :*, *Nous saurons que cela a fonctionné quand :*). Appuyez sur **Écrire l’intent et une spec** : une seule passe d’IA écrit l’intent puis la spec qui en dérive, prête à être relue. Quick, Explore et Raw sont toujours là. Si l’intent ne peut pas être écrit, vous obtenez quand même la spec, sans intent, et un avis l’indique ; si la génération échoue, votre texte reste dans l’éditeur. Une spec **Raw** ne reçoit plus d’intent : vous pouvez l’ajouter plus tard depuis la spec.

## L’intent accompagne le travail

- Chaque agent qui travaille sur la spec reçoit d’abord l’intent, présenté comme la source de vérité du *pourquoi* et du *résultat recherché*, jamais du *comment*. Cela inclut le planificateur, le développeur, le relecteur et l’agent de la session Intent. Le relecteur juge aussi le travail par rapport au résultat recherché et aux signaux.
- Quand un rail livre une spec qui a un intent, Specrails l’écrit sous le nom `intent.md` dans le changement OpenSpec de l’exécution, à côté de sa proposition, de sa conception et de ses tâches. L’intent vit alors dans Git avec le code. (Une exécution par lot qui couvre plusieurs specs n’en écrit aucun.)

## Explorer : démarrer une session Intent

Choisissez **Explorer** sur une carte d’intent convenu. Une confirmation s’ouvre, **Explorer avec l’agent** : Specrails crée une copie séparée du projet sur sa propre branche d’Intent, où l’agent peut écrire du code, et votre branche principale n’est pas touchée. Appuyez sur **Commencer à explorer**. Une spec provisoire portant votre intent apparaît sur le board avec le libellé **En Intent** (cliquez dessus pour revenir à la mission), et le premier tour de l’agent part de l’intent.

## Démarrer un Intent depuis une spec existante

Toute spec peut être construite en Intent, pas seulement une nouvelle idée. Intent et Implement restent deux façons égales d’y travailler :

- sur le tableau, faites un clic droit sur une spec et choisissez **Explorer avec l’agent** (à côté du glisser vers un rail) ; dans le détail de la spec, **Explorer avec l’agent** se trouve à côté de **Déplacer vers un rail** ;
- dans une mission, quand vous demandez d’implémenter une spec sans nommer de rail, l’agent affiche une carte à deux chemins pour cette spec sous **Comment voulez-vous continuer ?** : **Explorer** y travaille avec vous, **Déléguer** la lance sur un rail ;
- une carte de lancement sur rail pour une seule spec propose aussi **Explorer avec l’agent** à côté de son lancement.

Les trois portes ouvrent d’abord la même confirmation : le titre de la spec, un résumé de son intent, le moteur qui travaillera et, seulement dans un projet à plusieurs dépôts Git, un sélecteur **Dépôt** (dépôts Git uniquement ; le dépôt de la spec, sinon le principal, est présélectionné ; les flèches changent le choix). Rien ne démarre tant que vous n’appuyez pas sur **Commencer à explorer** ; **Annuler** laisse la spec telle qu’elle était. Depuis le menu du tableau, le détail de la spec s’ouvre avec cette confirmation par-dessus. Quand l’Intent démarre, la mission passe au premier plan et un toast affiche **Exploration de la spec #N sur <branch>** avec **Ouvrir la mission Intent**. La branche d’Intent porte le nom de la spec en mots entiers, jusqu’à 48 caractères, jamais coupée au milieu d’un mot (`feat/1-alta-sin-clave-de-api-proyecto`).

La spec elle-même passe **En Intent** : aucune spec provisoire n’est créée et le premier tour de l’agent reçoit la spec (son intent d’abord, puis ses critères d’acceptation, Contract Layer, hors-périmètre et addenda ouverts). Démarré depuis le tableau, l’Intent s’ouvre dans la mission de la spec, ou dans une nouvelle mission portant son nom. Une spec déjà en Intent propose à la place **Ouvrir la mission Intent**, et la carte post-it ne propose plus **Déplacer vers un rail**. **Explorer avec l’agent** est désactivé, avec la raison au survol, quand la spec est terminée ou annulée, sur un rail, ou que Intent n’est pas disponible.

**Abandonner** rend la spec exactement comme elle était, avec son statut précédent : votre spec n’est jamais supprimée. À la livraison de l’Intent, la spec est réécrite à partir de ce qui a été construit, et son texte d’origine est d’abord conservé en commentaire, **Original spec before Intent**, pour que rien ne se perde. L’intent lui-même n’est jamais réécrit : seules ses questions ouvertes reçoivent les réponses que le travail a tranchées. Une spec déjà liée à Jira met à jour ce même ticket et le passe au statut associé à la revue ; aucun second ticket n’est créé.

## Pendant l’Intent

Le mode Intent est nommé là où vous regardez, dans sa propre couleur d’Intent : le compositeur affiche une puce **Intent** à côté de celle d’autonomie et l’indication *Dites à l’agent quoi modifier dans cet Intent…* ; le titre de la mission indique **En Intent**, tout comme sa ligne dans la liste des missions. La conversation marque où vous êtes entré dans Intent et où vous en êtes sorti, et les réponses de l’agent écrites en Intent portent une petite marque **Intent** à côté de leur heure.

Le bandeau juste au-dessus du compositeur montre l’Intent sur une ligne courte : son état, **Exploration · 7 fichiers**, **Pause** et **Remettre**. **Remettre** est toujours présent et devient l’action principale, remplie, dès que des fichiers ont changé sur la branche d’Intent ; avant cela, le rail peut encore dériver la spec de votre conversation. Quand une action est indisponible (l’Intent enregistre encore, une autre action est en cours), le survol dit pourquoi. Ouvrez la ligne avec son chevron, comme n’importe quelle exécution, pour voir le reste :

- la **branche** (cliquez pour copier son nom), les **modifications** avec les lignes ajoutées et supprimées (cliquez pour lister chaque fichier modifié avec son état et ses +/−), et le **coût jusqu’ici** tel que facturé par le fournisseur. Il affiche `—` tant qu’aucun tour n’a de coût déclaré, jamais une estimation ; un `*` signale un total qui exclut des tours sans prix, avec une note indiquant combien ;
- **Aperçu** tant que l’app de l’Intent tourne (voir plus bas) ;
- **Abandonner**, à l’écart, supprime les modifications de l’Intent, sa branche et la spec provisoire. La confirmation liste ce que vous perdez : les fichiers modifiés avec leurs +/−, la branche et la spec.

**Pause** arrête l’agent et conserve vos modifications et la spec. La ligne affiche alors **Reprendre**.

Vous pouvez écrire pendant que l’agent travaille : en Intent, votre message **interrompt** l’étape en cours (le bouton d’envoi devient un éclair) et l’agent continue aussitôt avec vos nouvelles informations. Tant que l’Intent est ouvert, la bande git sous le compositeur s’efface : le panneau de l’Intent montre déjà sa branche.

## Essayer l’app

L’agent Intent lance lui-même le typecheck et les tests pour vérifier son travail. Quand il y a quelque chose à essayer, il demande avec trois choix : **Start the app**, **Start and expose on the local network** ou **Not now**. L’exposer vous permet d’ouvrir l’app depuis un téléphone sur le même Wi-Fi ou VPN, et toute personne sur ce réseau peut y accéder.

Une fois l’app à l’écoute, l’agent vous donne ses adresses en liens et le panneau de l’Intent affiche **Aperçu** avec un point vert : il ouvre l’app dans votre navigateur. Son menu propose l’adresse réseau et **Arrêter l’app**. L’app tourne depuis la copie de l’Intent, jamais depuis votre checkout principal, et Specrails l’arrête quand vous mettez en pause, abandonnez ou remettez l’Intent.

## Remettre {#intent-hand-off}

Quand le résultat vous convient, appuyez sur **Remettre**. La ligne indique **Prêt à devenir une PR** et ouvre une seule ligne au-dessus : *Rail 2 transformera vos 7 fichiers modifiés en PR relue. En cas d’échec, votre travail est en sécurité.* Appuyez sur **Lancer**, ou sur **Pas encore** pour revenir à l’Intent ; **Échap** revient à **Pas encore** ; un clic ailleurs replie seulement la ligne, et le bandeau garde **Prêt à devenir une PR** avec **Lancer**. Si le moteur de votre conversation ne peut pas exécuter la remise sur cette machine, une note juste sous la ligne le dit et le moteur par défaut du rail est utilisé.

Le rail, le moteur, le modèle et l’effort sont déjà choisis pour vous (un rail libre et le moteur de votre conversation). Pour les changer, ouvrez **Changer la méthode** ; vous y voyez aussi ce qui a changé. Le coût jusqu’ici figure sur la ligne principale. Vos choix sont conservés si vous appuyez sur **Pas encore** et remettez plus tard. Pendant le démarrage, le bandeau montre le lancement sans interruption, puis suit l’exécution étape par étape. Si la limite de revue ou un budget est atteint, la ligne le dit et rien n’est lancé. Si l’exécution n’apparaît pas au bout de 45 secondes, le bandeau cesse de tourner et indique **Remise à Rail 2 toujours en cours…** avec **Actualiser**, qui vérifie à nouveau et continue d’attendre jusqu’à ce que l’exécution apparaisse.

Le rail dérive la spec et son changement de spec à partir de ce que vous avez construit, la vérifie et la relit, et la carte de livraison apparaît dans la mission comme pour toute exécution.

Si l’exécution échoue pour une raison technique, le travail revient de lui-même dans cet Intent, intact : la carte dit en mots simples ce qui a échoué (les codes restent sous **Détails techniques**) et l’agent reçoit l’erreur et l’explique. Si la revue demande des modifications, la carte propose **Revenir dans Intent** ou **Relancer**. Dès que le travail est intégré, la mission clôt l’Intent par une carte de réussite au nom de votre spec : ce qui a changé (fichiers, coût, durée, branche), comment c’est arrivé dans le projet (la pull request, ou *Intégré localement dans main*), la spec réécrite à partir de ce que vous avez construit, le changement de spec archivé, le ticket Jira s’il y en a un et les questions ouvertes que le travail a tranchées. Elle apparaît tout de suite et se complète pendant la réécriture de la spec. En dessous, **Ouvrir la spec**, **Voir la pull request** vous emmènent plus loin.

## Bon à savoir

- Intent n’écrit que sur sa propre branche. Hors d’Intent, les missions restent en lecture seule.
- Un seul Intent par mission à la fois. Une pause survit au redémarrage de l’app.
- Si la copie du projet de l’Intent disparaît, l’Intent est marqué **doit être vérifié** (pour information, rien à décider) et rien n’est supprimé.
- Le bandeau ne change jamais l’exécution que vous regardez. Si une autre se met à vous attendre entre-temps, son nom dans le sélecteur du bandeau indique **vous attend**.
- Jira ne reçoit rien tant que vous êtes en Intent ni si vous l’abandonnez.
- Le coût d’Intent apparaît dans Analytics comme surface à part, **Intent**, et dans le bloc des missions d’agent.
