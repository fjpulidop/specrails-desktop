# Piloter Specrails depuis n'importe quelle IA (serveur MCP) {#mcp-server}

Specrails peut s'exposer **lui-même** à n'importe quel assistant IA qui parle le [Model Context Protocol](https://modelcontextprotocol.io) — Claude Desktop, Claude Code, Cursor, Cline, ou votre propre agent. Activez-le, pointez votre assistant vers Specrails, et vous pouvez piloter toute l'app en discutant : *« liste mes projets », « crée une spec pour la connexion sociale dans le projet API », « lance le rail 0 et préviens-moi quand c'est terminé », « combien ai-je dépensé cette semaine ? »*. Votre assistant appelle les outils de Specrails en coulisses, plutôt que de vous faire cliquer partout.

C'est la direction inverse des fonctionnalités plugins et « Mes MCP approuvés » : celles-ci permettent à Specrails d'*utiliser* d'autres serveurs MCP ; ceci permet à d'autres apps d'utiliser **Specrails**.

## Activé d'emblée

C'est **activé par défaut** : le serveur tourne déjà dès la première ouverture de l'app, sans redémarrage ni rien à basculer. Ouvrez **Paramètres ▸ MCP** pour copier la configuration client, ou pour le désactiver si vous n'en voulez pas.

Vous gardez le contrôle de *ce qu'*une IA externe peut faire grâce à un ensemble de niveaux de permission :

| Niveau | Ce qu'il autorise | Par défaut |
|---|---|---|
| **Lecture** | Lister et inspecter les projets, specs, jobs, analyses… | Toujours actif (lorsque MCP est activé) |
| **Écriture** | Créer et modifier des specs, changer les paramètres et la configuration des rails | Activé — décochez pour restreindre |
| **Lancement d'IA** | Actions qui exécutent une IA et **coûtent de l'argent** (lancer un rail, générer une spec, envoyer un tour de chat) | Activé — décochez pour restreindre |
| **Destructif** | Supprimer des projets/specs/jobs, arrêter un travail en cours | Activé — décochez pour restreindre |

Les quatre niveaux sont accordés d'emblée : un assistant connecté peut piloter toute l'app immédiatement. Décochez tout niveau que vous préférez garder pour vous ; si votre assistant tente ensuite quelque chose que ce niveau couvre, Specrails refuse avec un message clair vous indiquant quel niveau réactiver.

## Connecter Claude Code ou Codex en une étape

Ouvrez **Paramètres ▸ MCP** et cliquez sur **Connecter** à côté de Claude Code ou de Codex, ou lancez une commande dans un terminal :

```bash
specrails-desktop mcp connect --client claude   # ou codex
```

Specrails s'ajoute à la configuration du client, garde une sauvegarde du fichier, n'écrit aucun jeton d'accès et vérifie aussitôt la connexion (vous voyez combien d'outils il a trouvés). Le relancer est sans risque. Ouvrez ensuite une nouvelle session Claude Code ou Codex. **Copier la commande** affiche la commande du client si vous préférez la lancer vous-même ; pour les autres assistants, utilisez **Copier la configuration**.

Si quelque chose ne marche pas, lancez `specrails-desktop mcp doctor`. Il vérifie tout d'un coup (l'app, le fichier du jeton d'accès, le pont et le Node qui l'exécute, l'entrée de chaque client et une vraie connexion) et donne la solution à chaque problème. Il ne fait que regarder ; il ne change rien. Après une mise à jour de Node (par exemple avec Homebrew), refaites **Connecter** si votre assistant ne trouve plus Specrails.

**Demander avant de dépenser** (même panneau, 0,50 $ par défaut) est le montant au-delà duquel un assistant connecté doit vous demander avant de lancer un travail payant. Les fusions, les PR et les suppressions demandent toujours. Votre assistant reçoit un jeu simple de 15 outils avec les prochaines étapes prêtes, une attente sans interrogation répétée, des réponses dans votre langue et des prompts comme *start-my-day*, *review-waiting*, *ship-milestone* et *why-stuck*. Si un ancien script a besoin des outils précédents, désactivez **Outils MCP simplifiés** dans le même panneau ; les missions de Specrails ne sont pas concernées.

## Réservé aux agents : connecter votre client

Quand une personne demande à un agent de se connecter, lisez le [guide de connexion MCP](https://github.com/fjpulidop/specrails-desktop/blob/main/docs/agents/mcp.md). Il couvre la connexion en une commande, l'enregistrement manuel dans Claude Code et Codex, la vérification et le dépannage. L'enregistrement seul ne prouve pas la connexion : terminez `initialize`, `tools/list` et un appel en lecture seule.

Pour un coup d'œil rapide sur l'ensemble, l'assistant appelle `specrails_overview` : ce qui tourne, ce qui vous attend, les échecs récents, la dépense du jour, le CPU et la mémoire de la machine, en un seul appel. `specrails_inbox` lit la boîte **À traiter** et y répond, `specrails_missions` liste vos missions et leur envoie des messages, `specrails_specs` et `specrails_rails` montrent le backlog et les rails d'un projet, `specrails_insights` vos dépenses et vos limites, et `specrails_wait` attend la fin d'une exécution au lieu de redemander sans cesse. Une exécution en échec arrive avec son diagnostic et la fin de son journal.

Chaque réponse commence par un court résumé en langage clair et les prochaines étapes possibles, avec celle recommandée signalée, et les erreurs disent ce qui n'a pas marché et si réessayer peut aider. Avant toute action irréversible, ou un travail payant au-delà de votre limite, l'assistant vous montre un aperçu et vous demande d'abord. Votre accord ne vaut que pour cette action précise et expire si quelque chose change entre-temps.

Avant d'agir, l'assistant peut demander à `specrails_overview` un point à jour sur un projet : specs, exécutions et état Git. Les sections indisponibles sont signalées explicitement ; elles ne signifient pas que le projet est vide. Il peut aussi chercher et lire votre code source, ligne par ligne, sans le modifier.

Chaque session MCP externe conserve sa propre sélection de projet. En mode Mission, le projet par défaut est celui épinglé dans la conversation, que vous changez depuis l'interface de la mission ; une sélection MCP ne peut pas le remplacer. Nommer un autre projet dans un appel vise ce projet volontairement.

## Ce que vous pouvez en faire

Quelques recettes une fois votre assistant connecté. Tout est activé par défaut ; décochez **Écriture** ou **Lancement d'IA** dans Paramètres ▸ MCP si vous préférez qu'il se contente d'observer pour l'instant.

**Transformez le travail de vos autres outils en specs.** Si votre assistant a aussi GitHub, Jira, Gmail ou Slack connectés, il peut amener le travail jusqu'à Specrails pour vous :
> *« Prends les issues GitHub ouvertes cette semaine étiquetées "bug", crée une spec pour chacune dans le projet API, et lance-les. »*
>
> *« Lis mes derniers e-mails de retours clients, regroupe-les par thème, et crée une spec par thème. »*

**Pilote automatique nocturne.** Laissez-le tourner avec l'app dans la zone de notification et revenez à un rapport :
> *« Voici 12 idées. Transforme chacune en une spec, lance-les trois par trois à travers les rails, surveille chaque job, et demain donne-moi un résumé de ce qui s'est terminé, ce qui a échoué et ce que ça a coûté. »*

Décochez **Destructif** et il peut construire toute la nuit sans jamais rien supprimer.

**À travers tous vos projets.** Quelque chose que le tableau de bord ne fait pas tout seul :
> *« Vérifie tous mes projets. Dis-moi lesquels ont des specs dans le backlog sans aucun rail en cours, et démarre la plus prioritaire dans chacun. »*

**Sans les mains pendant que vous codez.** Pilotez Specrails depuis votre éditeur ou à la voix, sans changer de fenêtre :
> *« Lance le rail 0 avec Opus pour la spec #42 et préviens-moi quand c'est terminé. »*

**Interrogez les coûts et l'historique.** Vos analyses, en langage clair :
> *« Où ai-je le plus dépensé en IA cette semaine, par projet et par modèle ? Montre-moi les cinq specs les plus coûteuses. »*

**Votre point quotidien.**
> *« Rédige mon point quotidien : quels rails ont tourné hier, ce qui s'est terminé, ce qui a échoué, le coût total — sous forme de puces prêtes à coller dans Slack. »*

**Comprenez le code.** Aucun éditeur nécessaire :
> *« Quels fichiers la spec #38 a-t-elle touchés ? Résume en une ligne ce qui a changé dans chacun. »*

Parce que votre assistant lit d'abord le guide intégré, vous avez rarement besoin de nommer des outils ou des specs — décrivez le résultat voulu et il trouve les appels à faire.

## Quelques points à connaître

- **Specrails doit être en cours d'exécution.** Le serveur MCP vit à l'intérieur de l'app, donc votre assistant ne peut l'atteindre que tant que Specrails est ouvert. Grâce à la zone de notification, fermer la fenêtre laisse l'app tourner en arrière-plan — seul **Quitter** depuis la zone de notification (barre de menus Mac / zone de notification Windows) l'arrête réellement.
- **Les actions longues sont diffusées en flux.** Lancer un rail ou générer une spec renvoie une réponse immédiate et se termine en arrière-plan ; votre assistant peut le « surveiller » et vous faire un retour une fois l'action stabilisée.
- **Sécurité.** Le MCP utilise son propre jeton d'accès, distinct de tout le reste, et n'écoute que sur votre propre machine (boucle locale). Le jeton ne peut pas se faire passer pour le mode Agent en fournissant des en-têtes de niveau, de projet ou de conversation : l'agent embarqué utilise une capacité privée, de courte durée, émise par le serveur. Vous pouvez copier ou régénérer ce jeton restreint à tout moment depuis le panneau.
- **Non exposé (v1).** Par sécurité, les clients MCP externes ne peuvent pas exécuter de commandes shell brutes dans le terminal, utiliser le navigateur embarqué, modifier des fichiers dans l'app ni installer des prérequis système. Le mode Agent dispose d'un chemin authentifié distinct pour les commandes d'arrière-plan longues et confirmées en permission Autonome ; les clients externes ne peuvent pas l'obtenir en activant Destructif. Tout le reste de ce qui *gère* Specrails est disponible.

Vous pouvez désactiver MCP à tout moment depuis le même panneau — votre assistant perd simplement l'accès, et rien d'autre ne change.
