# Piloter Specrails depuis n'importe quelle IA (serveur MCP)

Specrails peut s'exposer **lui-même** à n'importe quel assistant IA qui parle le [Model Context Protocol](https://modelcontextprotocol.io) — Claude Desktop, Claude Code, Cursor, Cline, ou votre propre agent. Activez-le, pointez votre assistant vers Specrails, et vous pouvez piloter toute l'app en discutant : *« liste mes projets », « crée une spec pour la connexion sociale dans le projet API », « lance le rail 0 et préviens-moi quand c'est terminé », « combien ai-je dépensé cette semaine ? »*. Votre assistant appelle les outils de Specrails en coulisses, plutôt que de vous faire cliquer partout.

C'est la direction inverse des fonctionnalités plugins et « Mes MCP approuvés » : celles-ci permettent à Specrails d'*utiliser* d'autres serveurs MCP ; ceci permet à d'autres apps d'utiliser **Specrails**.

## L'activer

C'est **désactivé par défaut**. Ouvrez **Paramètres ▸ MCP** et basculez **Activer MCP**. C'est tout — le serveur démarre immédiatement, sans redémarrage.

Vous gardez le contrôle de *ce qu'*une IA externe peut faire grâce à un ensemble de niveaux de permission :

| Niveau | Ce qu'il autorise | Par défaut |
|---|---|---|
| **Lecture** | Lister et inspecter les projets, specs, jobs, analyses… | Toujours actif (lorsque MCP est activé) |
| **Écriture** | Créer et modifier des specs, changer les paramètres et la configuration des rails | Désactivé — à activer |
| **Lancement d'IA** | Actions qui exécutent une IA et **coûtent de l'argent** (lancer un rail, générer une spec, envoyer un tour de chat) | Désactivé — à activer |
| **Destructif** | Supprimer des projets/specs/jobs, arrêter un travail en cours | Désactivé — à activer |

Si votre assistant tente quelque chose que couvre un niveau désactivé, Specrails refuse avec un message clair vous indiquant quel niveau activer. Vous pouvez donc commencer en lecture seule et ouvrir exactement ce dont vous avez besoin.

## Connecter votre assistant

Le panneau affiche un bloc de configuration prêt à coller. La voie la plus simple et universelle est le **pont** (« bridge ») embarqué (`specrails-mcp`) : votre assistant l'exécute, et il relaie vers Specrails pour vous. Le pont lit le jeton d'accès localement, donc **le jeton n'apparaît jamais dans la configuration de votre assistant**.

Dans un client comme Claude Desktop ou Cursor, la configuration ressemble à ceci :

```json
{ "mcpServers": { "specrails": { "command": "specrails-mcp" } } }
```

Les clients qui prennent en charge les serveurs MCP HTTP distants peuvent à la place pointer directement vers `http://127.0.0.1:4200/api/mcp` avec le jeton du panneau.

### Depuis le terminal : Claude Code, Gemini CLI, Codex CLI

Copiez votre jeton depuis **Réglages ▸ MCP ▸ Copier le jeton**, puis :

```bash
# Claude Code
claude mcp add --transport http specrails http://localhost:4200/api/mcp \
  --header "X-Desktop-Token: <votre jeton>"

# Gemini CLI
gemini mcp add --transport http specrails http://localhost:4200/api/mcp \
  --header "X-Desktop-Token: <votre jeton>"

# Codex CLI (stdio — enregistrez la commande du bridge affichée dans Réglages ▸ MCP)
codex mcp add specrails -- <commande du bridge depuis Réglages ▸ MCP>
```

L'en-tête `Authorization: Bearer <token>` fonctionne aussi. Si vous avez changé le port de l'app, remplacez `4200`.

Une fois connecté, votre assistant voit environ **18 outils** couvrant toute l'app — projets, specs, rails et jobs, chat/Explore, agents, plugins, Jira, loops, l'explorateur de code, les analyses, les paramètres — plus un outil **guide** intégré qu'il lit en premier afin de comprendre le fonctionnement de Specrails sans que vous ayez à expliquer quoi que ce soit.

## Ce que vous pouvez en faire

Quelques recettes une fois votre assistant connecté. Commencez avec **Lecture** activée, puis activez **Écriture** et **Lancement d'IA** quand vous voulez qu'il crée et lance réellement du travail.

**Transformez le travail de vos autres outils en specs.** Si votre assistant a aussi GitHub, Jira, Gmail ou Slack connectés, il peut amener le travail jusqu'à Specrails pour vous :
> *« Prends les issues GitHub ouvertes cette semaine étiquetées "bug", crée une spec pour chacune dans le projet API, et lance-les. »*
>
> *« Lis mes derniers e-mails de retours clients, regroupe-les par thème, et crée une spec par thème. »*

**Pilote automatique nocturne.** Laissez-le tourner avec l'app dans la zone de notification et revenez à un rapport :
> *« Voici 12 idées. Transforme chacune en une spec, lance-les trois par trois à travers les rails, surveille chaque job, et demain donne-moi un résumé de ce qui s'est terminé, ce qui a échoué et ce que ça a coûté. »*

Gardez **Destructif** désactivé et il peut construire toute la nuit sans jamais rien supprimer.

**À travers tous vos projets.** Quelque chose que le tableau de bord ne fait pas tout seul :
> *« Vérifie tous mes projets. Dis-moi lesquels ont des specs dans le backlog sans aucun rail en cours, et démarre la plus prioritaire dans chacun. »*

**Sans les mains pendant que vous codez.** Pilotez Specrails depuis votre éditeur ou à la voix, sans changer de fenêtre :
> *« Lance le rail 0 en mode Freestyle avec Opus pour le ticket #42 et préviens-moi quand c'est terminé. »*

**Interrogez les coûts et l'historique.** Vos analyses, en langage clair :
> *« Où ai-je le plus dépensé en IA cette semaine, par projet et par modèle ? Montre-moi les cinq tickets les plus coûteux. »*

**Votre point quotidien.**
> *« Rédige mon point quotidien : quels rails ont tourné hier, ce qui s'est terminé, ce qui a échoué, le coût total — sous forme de puces prêtes à coller dans Slack. »*

**Comprenez le code.** Aucun éditeur nécessaire :
> *« Quels fichiers le ticket #38 a-t-il touchés ? Résume en une ligne ce qui a changé dans chacun. »*

Parce que votre assistant lit d'abord le guide intégré, vous avez rarement besoin de nommer des outils ou des specs — décrivez le résultat voulu et il trouve les appels à faire.

## Quelques points à connaître

- **Specrails doit être en cours d'exécution.** Le serveur MCP vit à l'intérieur de l'app, donc votre assistant ne peut l'atteindre que tant que Specrails est ouvert. Grâce à la zone de notification, fermer la fenêtre laisse l'app tourner en arrière-plan — seul **Quitter** depuis la zone de notification (barre de menus Mac / zone de notification Windows) l'arrête réellement.
- **Les actions longues sont diffusées en flux.** Lancer un rail ou générer une spec renvoie une réponse immédiate et se termine en arrière-plan ; votre assistant peut le « surveiller » et vous faire un retour une fois l'action stabilisée.
- **Sécurité.** Le MCP utilise son propre jeton d'accès, distinct de tout le reste, et n'écoute que sur votre propre machine (boucle locale). Vous pouvez copier ou régénérer ce jeton à tout moment depuis le panneau.
- **Non exposé (v1).** Par sécurité, quelques capacités à haut risque sont volontairement laissées de côté : exécuter des commandes shell dans le terminal, le navigateur embarqué, l'édition de fichiers dans l'app, et l'installation des prérequis système. Tout ce qui *gère* Specrails est disponible ; l'accès brut à la machine ne l'est pas.

Vous pouvez désactiver MCP à tout moment depuis le même panneau — votre assistant perd simplement l'accès, et rien d'autre ne change.
