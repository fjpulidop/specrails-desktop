# Fournisseurs d'IA (Claude, Codex)

## Les deux fournisseurs

| Fournisseur | CLI | Édité par | Notes |
|---|---|---|---|
| **Claude** | `claude` | Anthropic | Coût natif et transport interactif persistant. |
| **Codex** | `codex` | OpenAI | Nécessite codex `0.128.0+`. Lit ses serveurs MCP depuis votre fichier global `~/.codex/config.toml`. |

## Les fournisseurs sont détectés automatiquement

Si un fournisseur que vous voulez n'apparaît nulle part, c'est presque toujours
parce que le CLI n'est pas installé ou absent de votre `PATH`. Installez-le,
connectez-vous et revenez sur l'app — la détection se relance au focus de la
fenêtre et le fournisseur apparaît de lui-même partout, sa surface de workspace
assemblée en arrière-plan. Un fournisseur installé mais non connecté apparaît
quand même, avec un badge *Non connecté* sur les sélecteurs de moteur.

Quelques points utiles sur les machines multi-fournisseurs :

- **Un seul fournisseur se comporte exactement comme avant.** Si un seul est détecté, vous ne verrez jamais de sélecteur de fournisseur — l'app reste sobre et simple.
- **Rien n'est verrouillé.** Installer ou retirer un CLI met à jour tous les
  projets automatiquement — il n'y a aucun réglage de fournisseur par projet à gérer.

## Choisir un fournisseur à chaque invocation

Tout l'intérêt d'un projet multi-fournisseurs, c'est de choisir l'IA la plus adaptée à chaque tâche — sans toucher au moindre réglage global. Partout où une IA s'exécute, un petit sélecteur de fournisseur apparaît (uniquement lorsque le projet en compte plusieurs) :

- **En-tête de rail** — choisissez le moteur de ce rail précis avant de le lancer.
- **Terminal** — le bouton « Open AI CLI » (Sparkles) ouvre un menu de fournisseurs pour basculer dans n'importe quelle CLI installée, dans le répertoire de ce projet.

Votre choix est mémorisé par projet, avec le fournisseur principal comme valeur par défaut, pour ne pas avoir à le refaire à chaque fois.

## Dépannage

- **Les serveurs MCP de Codex ne se chargent pas dans le chat.** Codex lit ses serveurs MCP depuis votre fichier global `~/.codex/config.toml` — enregistrez-les là avec `codex mcp add`.
