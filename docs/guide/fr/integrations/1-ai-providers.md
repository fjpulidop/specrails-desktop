# Fournisseurs d'IA (Claude, Codex, Gemini, Kimi)

Specrails n'est lié à aucune IA. Claude, Codex, Gemini et Kimi sont des
fournisseurs de premier plan ; chaque surface ne propose que les moteurs dont
les capacités respectent son contrat.

## Les quatre fournisseurs

| Fournisseur | CLI | Édité par | Notes |
|---|---|---|---|
| **Claude** | `claude` | Anthropic | Coût natif et transport interactif persistant. |
| **Codex** | `codex` | OpenAI | Nécessite codex `0.128.0+`. Lit ses serveurs MCP depuis votre fichier global `~/.codex/config.toml`. |
| **Gemini** | `gemini` | Google | Nécessite gemini `0.11.0+`. Utilise une télémétrie native et un fichier d'instructions `GEMINI.md`. |
| **Kimi Code** | `kimi` | Moonshot AI | Nécessite Kimi `0.27.0+`. Desktop lance la CLI externe avec `-p` ; aucun serveur n'est installé ou démarré. |

Les quatre sont **activés par défaut**. Un fournisseur apparaît dans **Ajouter
un projet** lorsque sa CLI est installée et présente dans votre `PATH`. Pour
Kimi, vérifiez `kimi --version` puis exécutez `kimi login`.

## Installer un fournisseur pour un projet

Lorsque vous ajoutez un projet, l'assistant de configuration vous demande quel(s) fournisseur(s) installer. Choisissez-en un, déroulez l'étape d'installation, et c'est terminé. À partir de là, le projet *possède* simplement ce fournisseur — vous n'avez plus jamais à y penser. Les specs, les rails, le chat et les analytics fonctionnent de la même façon quel que soit votre choix.

Si une CLI que vous voulez n'apparaît pas dans Ajouter un projet, c'est presque toujours parce qu'elle n'est pas installée ou absente de votre `PATH`. Installez-la, puis rouvrez Ajouter un projet.

## Installer plusieurs fournisseurs pour un même projet

Vous pouvez installer **plus d'un** fournisseur dans le même projet — par exemple Claude *et* Gemini. Dans **Ajouter un projet**, la liste des fournisseurs devient une série de cases à cocher ; cochez tout ce que vous voulez. Le premier que vous sélectionnez devient le fournisseur **principal** (par défaut) du projet ; les autres restent disponibles comme alternatives.

Quelques points utiles à connaître sur les projets multi-fournisseurs :

- **Avec un seul fournisseur, rien ne change.** Si un projet n'a qu'un seul fournisseur, vous ne verrez jamais de sélecteur de fournisseur où que ce soit — l'app reste épurée et simple.
- **Les capacités pilotent l'interface.** Claude et Kimi prennent en charge des
  profils séparés par fournisseur ; Codex et Gemini utilisent le mode legacy.
- **Le choix des fournisseurs est verrouillé après la création.** Dans cette version, vous choisissez vos fournisseurs au moment d'ajouter le projet et vous ne pouvez plus les modifier ensuite depuis les Réglages. S'il vous faut une combinaison différente, créez un nouveau projet.

## Choisir un fournisseur à chaque invocation

Tout l'intérêt d'un projet multi-fournisseurs, c'est de choisir l'IA la plus adaptée à chaque tâche — sans toucher au moindre réglage global. Partout où une IA s'exécute, un petit sélecteur de fournisseur apparaît (uniquement lorsque le projet en compte plusieurs) :

- **Ajouter une spec** — Explore accepte Kimi ; Quick Spec ne propose que les
  fournisseurs capables d'imposer sa frontière pure-output, donc pas Kimi.
- **En-tête de rail** — choisissez le moteur de ce rail précis avant de le lancer.
- **Terminal** — le bouton « Open AI CLI » (Sparkles) ouvre un menu de fournisseurs pour basculer dans n'importe quelle CLI installée, dans le répertoire de ce projet.

Votre choix est mémorisé par projet, avec le fournisseur principal comme valeur par défaut, pour ne pas avoir à le refaire à chaque fois.

## Différences de capacités

Kimi prend en charge Project/Agent Chat, Explore et les propositions, Quick
Launcher (`/opsx:ff`), les rails, Freestyle, les loops sans Decider, les
profils/rôles manuels, MCP, Serena, le terminal et les pièces jointes.

`kimi -p` approuve automatiquement les outils et ne peut pas imposer une
frontière sans outils/read-only. Sont donc refusés avant démarrage : Quick
Spec, AI Edit, Contract Refine, SMASH/Re-SMASH, génération de
blueprint/milestone Project Builder, Loop Decider, résumés/histoire de
construction et automatisation Agent Studio. L'auto-title utilise un fallback
déterministe. Voir le [guide Kimi](../../../kimi.md).

## Suivi des coûts entre fournisseurs

**Analytics** enregistre les invocations réellement lancées. Claude rapporte
son coût ; Codex et Gemini utilisent une estimation. Kimi ne fournit ni tokens
ni coût USD autoritatifs, donc ces champs restent vides.

## Dépannage

- **Un fournisseur que j'ai installé n'est pas proposé.** Vérifiez la CLI dans votre `PATH` (`claude --version` / `codex --version` / `gemini --version` / `kimi --version`).
- **Les serveurs MCP de Codex ne se chargent pas dans le chat.** Codex lit ses serveurs MCP depuis votre fichier global `~/.codex/config.toml` — enregistrez-les là avec `codex mcp add`.
- **Désactivation d'urgence.** Un fournisseur peut être coupé à l'échelle de l'app via une variable d'environnement (`SPECRAILS_CODEX_BETA=0` ou `SPECRAILS_GEMINI_BETA=0`). Cela masque uniquement le fournisseur de la *sélection* ; c'est rarement nécessaire.

## Voir aussi

Consultez les guides dédiés à [Kimi](../../../kimi.md), Codex et Gemini.
