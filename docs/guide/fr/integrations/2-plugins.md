# Plugins (Intégrations)

La section **Intégrations** est une place de marché par projet de modules optionnels qui étendent les capacités de l'IA. Chaque projet décide indépendamment des plugins qu'il souhaite — installer un plugin dans un projet ne touche jamais à un autre.

Les plugins fonctionnent en enregistrant discrètement un **serveur MCP** (Model Context Protocol) dans votre projet, ce qui donne à l'IA de nouveaux outils à appeler pendant les rails et le chat. Pas besoin de comprendre MCP pour vous en servir : installez-le, et il sera disponible au prochain rail.

## Ce qui est disponible aujourd'hui

Cette version est **fournie en mode intégré uniquement** : les plugins que vous pouvez installer sont ceux qui sont embarqués dans l'app. Il n'y a pas de registre distant, pas de plugin déposé par les utilisateurs, ni de chargement de code tiers — tout ce qui figure dans le catalogue est donc vérifié et livré avec Specrails.

Le plugin phare est :

- **Serena** — navigation sémantique du code. Il donne à l'IA une compréhension de votre code basée sur un serveur de langage (aller à la définition, trouver les références, recherche tenant compte des symboles) plutôt qu'une simple correspondance de texte. Idéal pour les dépôts volumineux ou inconnus, lorsque vous voulez que l'agent raisonne sur de vrais symboles.

  Serena requiert l'outil `uv` dans votre `PATH` (il s'exécute via `uvx`). L'app détecte automatiquement la présence de `uv` et vous prévient s'il manque.

## Installer un plugin

1. Ouvrez **Intégrations** depuis la barre latérale droite.
2. Repérez le plugin dans le catalogue. Chaque carte affiche un statut : **Non installé**, **Installé**, **Dégradé** ou **Orphelin**.
3. Cliquez sur le plugin pour **prévisualiser l'installation** — cela vous montre exactement quels fichiers vont changer avant que quoi que ce soit ne se produise.
4. Cliquez sur **Installer**. Vous suivez la progression en direct pendant la mise en place.

En coulisses, l'installation est *chirurgicale et additive* : elle n'ajoute que ses propres entrées au `.mcp.json` de votre projet (et, pour certains plugins, un fichier de fragment dans l'espace de noms protégé `.claude/agents/`). Elle ne réécrit jamais votre configuration dans son ensemble, et l'ajout d'un second plugin ne peut jamais perturber le premier. Si l'installation ne parvient pas à se vérifier comme saine, elle effectue un retour arrière propre.

## Gérer les plugins installés

- **Santé.** Chaque plugin dispose d'une vérification de santé à la demande. Un plugin qui s'installe correctement mais ne démarre plus ensuite est marqué **Dégradé** — il ne bloquera pas vos rails ; vous verrez simplement le badge et la raison.
- **Désinstaller.** Retirer un plugin supprime chirurgicalement uniquement les entrées qu'il possède, en laissant le reste de votre configuration intact.
- **Orphelins.** Si les fichiers d'un plugin subsistent sans état correct (par exemple après une modification interrompue), il apparaît comme **Orphelin** et vous pouvez le nettoyer d'un clic.

## Comment les plugins interviennent dans votre travail

- **Rails.** Avant qu'un rail ne s'exécute, Specrails vérifie quels plugins sont installés et sains, et rend ces outils disponibles pour l'agent sur ce job. Un plugin dégradé est simplement ignoré pour cette exécution — le rail se lance quand même normalement. Chaque job enregistre un instantané des plugins actifs, visible dans l'export de diagnostic du job.
- **Chat.** Le chat reprend automatiquement la configuration MCP de votre projet, de sorte que les plugins installés y sont également disponibles.
- **Configuration.** Les plugins sont ignorés tant qu'un projet est encore en cours de configuration — ils entrent en jeu une fois le projet prêt.

## Notes sur les fournisseurs

Les plugins tiennent compte du fournisseur. Serena et les plugins MCP similaires s'activent pour les fournisseurs qui enregistrent MCP via le `.mcp.json` du projet (Claude et Gemini). Pour les projets Codex, les serveurs MCP sont gérés via la configuration globale propre à Codex ; les entrées de plugin dans **Intégrations** sont donc filtrées en conséquence. La carte Jira dans Intégrations est indépendante du fournisseur et s'affiche pour tout le monde — voir le guide Jira.

## Fichiers réservés

Les plugins gèrent un petit ensemble de fichiers bien défini dans votre projet : votre `.mcp.json` (fusionné chirurgicalement), un peu d'état sous `.specrails/plugins/`, et les fragments d'agent par plugin dans `.claude/agents/custom-<plugin>.md`. Ce sont des ressources d'équipe versionnables si vous souhaitez partager une intégration avec vos coéquipiers — l'app ne les écrase jamais aveuglément.
