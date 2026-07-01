# Pilotez Specrails en discutant (Agent Chat)

L'**Agent Chat** est un copilote qui vit *à l'intérieur* de Specrails et peut piloter toute l'application à votre place. Au lieu de cliquer à travers projets, specs, rails et analyses, il vous suffit de demander : *« combien de jobs ont réussi cette semaine ? »*, *« crée une spec pour la connexion sociale dans le projet API »*, *« lance les trois tickets les plus prioritaires et préviens-moi quand ils sont finis »*. Il exécute le travail en appelant les propres outils de Specrails — les mêmes que ceux exposés par le [serveur MCP](./5-mcp-server.md) — pendant que vous voyez le tableau de bord se mettre à jour en direct derrière lui.

> **À ne pas confondre avec les agents du pipeline.** La section *Agents* (Architect → Developer → Reviewer) concerne *la manière dont un rail implémente une spec*. L'**Agent Chat** est un unique assistant qui *pilote l'application elle-même*. Deux choses différentes, un même mot.

## Comment l'ouvrir

Une **bulle** flottante se trouve en bas de la fenêtre : cliquez dessus pour ouvrir le panneau, ou appuyez sur **⌘⇧A** (**Ctrl+Shift+A** sous Windows/Linux) depuis n'importe où. Le panneau est une vraie fenêtre que vous pouvez déplacer, redimensionner, agrandir et renvoyer dans la bulle ; il se souvient de l'endroit où vous l'avez laissé.

Il est **non modal, volontairement** : le tableau de bord derrière lui reste vivant, donc quand l'agent lance un rail ou crée une spec vous le voyez apparaître en temps réel — vous ne regardez pas un écran figé.

## Prérequis : le serveur MCP

L'Agent Chat pilote l'application via le **serveur MCP Specrails** intégré, il faut donc que celui-ci soit actif. S'il ne l'est pas, le panneau s'ouvre avec une bannière **Activer Specrails MCP** en un clic : appuyez dessus et c'est prêt (sans redémarrage). Voir [Contrôlez Specrails depuis n'importe quelle IA](./5-mcp-server.md) pour les détails ; rien n'est installé, tout est local sur votre machine.

## Choisir ce sur quoi il travaille

L'en-tête comporte un **sélecteur de projet** (comme celui de Cursor). Choisissez un projet et tout ce que vous demandez s'y rapporte : *« lance ceux qui sont hautement prioritaires »* se résout pour ce projet. Laissez-le sur **Accueil** et l'agent travaille sur l'ensemble de votre configuration : il peut lister ou créer des projets et répondre à des questions qui embrassent tout. Si vous demandez quelque chose de spécifique à un projet en étant sur Accueil, il vous demandera lequel (ou proposera d'en créer un) plutôt que de deviner.

Choisir un projet ici **ne déplace pas** votre tableau de bord : la cible de l'agent et ce que vous regardez sont indépendants.

## Fournisseur et modèle

Juste au-dessus de la zone de message, vous choisissez le **fournisseur** (Claude, Codex ou Gemini) et son **modèle**. Chaque fournisseur a sa propre liste de modèles, et changer de fournisseur démarre une nouvelle session avec le modèle par défaut de ce fournisseur — vous pouvez ainsi, par exemple, piloter l'application avec Claude et passer à Codex pour une autre conversation sans que rien ne se mélange.

## Niveaux d'autorisation — c'est vous qui tenez la laisse

L'agent peut toucher à toute l'application, c'est donc à vous de décider quelle liberté vous lui accordez, via un **niveau** que vous changez en direct en appuyant sur **Shift+Tab** (le même cycle que celui de Claude Code). Chaque niveau inclut tout ce qui se trouve en dessous :

| Niveau | Ce qu'il peut faire |
|---|---|
| 👀 **Observer** | Lecture seule — lister et inspecter projets, specs, jobs, analyses. Rien ne change. |
| ✍️ **Modifier** | Ce qui précède **+** créer et modifier (specs, réglages, configuration de rails) — changements réversibles. |
| ⚡ **Opérer** | Ce qui précède **+** lancer du travail d'IA qui **coûte de l'argent** (rails, génération de specs). |
| 🔥 **Autonome** | Ce qui précède **+** supprimer et arrêter des choses — actions irréversibles. |

Commencez sur **Observer** et n'élevez le niveau que lorsque vous voulez que l'agent agisse. S'il tente quelque chose au-dessus du niveau actuel, il s'arrête et vous indique exactement quel niveau activer — il ne contourne jamais la limite. C'est distinct des niveaux de Réglages ▸ MCP, qui régissent les assistants *externes* ; le niveau ici ne concerne que cet agent intégré à l'application.

## Quelques exemples de demandes

Une fois sur **Opérer**, essayez :

> *« Liste toutes les specs à faire du projet API, puis lance les trois plus prioritaires sur des rails séparés et surveille-les. »*
>
> *« Combien ai-je dépensé cette semaine, ventilé par projet ? »*
>
> *« Crée une spec pour un bouton de bascule mode sombre dans le projet web, avec une Contract Layer. »*
>
> *« Quelque chose a échoué dans le dernier lot — trouve les jobs en échec et résume pourquoi. »*

Les réponses arrivent en flux fluide et s'affichent déjà mises en forme (titres, tableaux, listes), chacune avec un petit bouton **copier**. Une étiquette d'état en bas montre ce que fait l'agent en ce moment — *Réflexion…*, *MCP · jobs*, *Terminal* — pour que vous connaissiez toujours son état.

## Petits plus pratiques

- **Historique des prompts.** Avec la zone vide, appuyez sur **↑**/**↓** pour parcourir ce que vous avez demandé auparavant (affiché en grisé pendant que vous défilez) ; commencez à taper pour le modifier, ou appuyez sur Entrée pour l'envoyer.
- **Réduire sans rien perdre.** Cliquez sur la ✕ pour renvoyer le panneau dans la bulle — la conversation continue de tourner. Rouvrez-le et vous atterrissez sur le dernier message ; rien n'est à retaper.
- **Nouvelle conversation.** Le bouton **+** démarre un fil vierge ; l'historique vit au niveau de l'application, au-dessus de tout projet individuel.

## Quelques points à savoir

- **Opérer et Autonome coûtent de l'argent** car ils exécutent de l'IA. L'agent met en avant les actions génératrices de coût avant de les réaliser ; gardez le niveau sur Observer ou Modifier si vous voulez juste regarder et ranger.
- **L'agent couvre toute l'application**, il n'est pas lié au projet que vous avez ouvert — c'est pourquoi il a son propre sélecteur et que son historique n'est pas par projet.
- **Il n'est capable que dans la mesure où le MCP le permet.** Si tout un domaine semble interdit, vérifiez que le serveur MCP est bien activé.
