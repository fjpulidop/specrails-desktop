# Moteurs d'IA locaux

Faites tourner Specrails sur des modèles que vous hébergez vous-même — Ollama, llama.cpp, LM Studio, vLLM ou tout serveur parlant l'API chat-completions d'OpenAI. Une fois connecté, un endpoint local est un moteur comme les autres : il apparaît dans l'en-tête du rail, dans Ajouter une spec (Quick et Explore), dans le chat latéral et dans les missions de l'agent.

## Connecter un endpoint

1. Ouvrez **Réglages ▸ Agents Specrails ▸ Connexions de fournisseur** puis **Ajouter un moteur local**.
2. Saisissez un id, l'URL de base (par exemple `http://127.0.0.1:11434/v1`) et, si votre serveur exige une clé, le **nom de la variable d'environnement** qui la contient. La clé n'est jamais enregistrée : Specrails la lit dans l'environnement de l'application au lancement de chaque exécution.
3. Cliquez sur **Tester la connexion**. La pastille devient verte quand le serveur répond et les modèles servis sont listés. Choisissez un modèle par défaut.
4. **Enregistrer**. Le moteur est disponible immédiatement, sans redémarrage.

> Lancer l'application depuis le Finder, le Dock ou le menu Démarrer n'hérite pas des exports du shell. Si la carte indique que la variable *n'est pas définie dans le processus de l'application*, définissez-la au niveau système ou lancez l'application depuis un terminal qui la possède. Les serveurs sans clé n'ont besoin de rien.

Chaque connexion possède aussi un réglage **Boucle de l'agent**. **Compacte** (par défaut) guide les petits modèles par de courtes étapes structurées : c'est ce qui permet à un modèle de 7–14B de passer l'implement ; **Libre** est la boucle agentique classique pour les modèles puissants (~30B+). Réglez la **fenêtre de contexte** sur la taille réelle de votre serveur pour que Specrails compacte avant que le serveur ne rejette une requête.

## Ce que vous obtenez

- Rails (implement, batch, freestyle, boucles personnalisées), Explore et specs Quick, chat et missions s'exécutent sur le modèle local.
- Les missions conservent leurs outils Specrails et vos serveurs MCP externes.
- Les sessions reprennent d'un tour à l'autre ; les jobs interactifs fonctionnent.
- Le coût est honnête : les tokens sont enregistrés, le coût reste *inconnu* sauf si vous saisissez des tarifs (il est alors marqué *estimé*).

Indisponible sur les moteurs locaux : profils d'agent et rôles personnalisés, enrichissement SMASH / Contract Layer, pièces jointes et télémétrie du pipeline. Le Project Builder fonctionne en mode sortie pure (sans outils) ; son contrat de blueprint est strict, utilisez donc un modèle capable.

> Les missions exigent une **grande fenêtre de contexte** côté serveur (64k tokens ou plus) : le prompt de l'opérateur et les schémas d'outils Specrails sont volumineux. Chat et Explore fonctionnent à 32k. Si un tour échoue avec *exceeds the available context size*, augmentez la fenêtre (Ollama `OLLAMA_CONTEXT_LENGTH`, llama.cpp `-c`, LM Studio *Context Length*).

## Seulement un moteur local ?

Rien à configurer. Specrails propose les moteurs que votre machine peut réellement exécuter et choisit la valeur par défaut avec une seule règle partout : un CLI installé (Claude → Codex → Gemini → Kimi), sinon le premier moteur local dont l'endpoint répond. Sur une machine n'ayant qu'un endpoint local, les rails, Add Spec, le chat, **les missions de l'agent et le Project Builder** démarrent dessus, sans toucher au sélecteur. Un moteur dont le serveur est arrêté n'est simplement pas proposé tant qu'il ne répond pas. Les missions existantes gardent le moteur avec lequel elles ont été créées ; le sélecteur permet toujours d'en changer.

## Choisir un modèle

La qualité dépend du modèle, pas de Specrails. Pour les rails, utilisez un modèle de code entraîné au tool calling d'au moins 30B paramètres ; les petits modèles instruct suffisent pour le chat, Explore et les specs Quick. Essayez **Freestyle** ou une session Explore avant de confier un rail implement complet à un nouveau modèle.

## Désactiver

Définissez `SPECRAILS_LOCAL_ENGINES=false` dans l'environnement de l'application pour masquer les moteurs locaux partout. Les connexions enregistrées sont conservées et restent valables comme fournisseurs par rôle du runtime programmatique.
