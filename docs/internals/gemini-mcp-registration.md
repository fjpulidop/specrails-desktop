# Gemini MCP registration (as-built facts + known gap)

How MCP servers actually reach gemini-cli, what the app does about it today, and the surfaces
where the historical `.mcp.json` assumption still silently fails. All claims verified
empirically against **gemini-cli 0.49.0**.

## The facts

- **gemini-cli has NEVER read `.mcp.json`.** That file is a Claude convention. Gemini's only
  MCP surface is the `mcpServers` object in **settings.json** — user scope (`~/.gemini/
  settings.json`) or project scope (`<cwd>/.gemini/settings.json`).
- **An untrusted cwd suppresses MCP entirely.** With the trusted-folders gate unresolved, a
  headless (`gemini -p`) run exits **55** with `FatalUntrustedWorkspaceError`. The app-wide
  antidote is `GEMINI_CLI_TRUST_WORKSPACE=true` injected per spawn — the pattern
  `chat-manager` / `queue-manager` / `util/cli-prompt.ts` already use for every gemini spawn.
- **Gemini exposes MCP tools under an FQN prefix**: `mcp_<server>_<tool>` — for the Specrails
  server, `mcp_specrails_<canonical name>` (e.g. `mcp_specrails_specrails_specs`). The agent-chat
  operator prompt (`server/agent-operator-prompt.ts`) notes this so the model calls the right
  names on gemini.

## What works today: agent chat

`server/agent-mcp-config.ts` `prepareAgentMcp` (the desktop agent chat / Mission Control
wiring) handles gemini correctly: it merges the `specrails` server entry into
`<agent-cwd>/.gemini/settings.json` (merge-safe — read-if-exists, only the owned key touched)
AND returns `env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' }` for the spawn. The generic
project-json `.mcp.json` write still happens alongside (harmless — gemini ignores it; it keeps
the path uniform for any future project-json provider).

## Known DEFERRED gap: every other 'project-json' gemini consumer

The `mcpRegistration: 'project-json'` capability value really means **claude-style
`.mcp.json`**. Every other consumer of that flag still writes/relies on `.mcp.json`, which
gemini never loads — so on those surfaces an MCP server is registered but **silently never
loads** for gemini:

| Surface | What it does today | Effect on gemini |
|---|---|---|
| Plugins on rails (`server/plugin-manager.ts`, e.g. Serena) | surgical merge into `<project>/.mcp.json` for `project-json` providers | plugin installs "successfully", MCP server never loads in gemini rail spawns |
| Workspace MCP (`server/agent-mcp-config.ts` `mergeSpecrailsIntoWorkspaceMcp`, via `workspace-manager.ts`) | writes `<workspace>/.mcp.json` | not read by gemini |
| Explore `context_scope.mcp` (`server/chat-manager.ts`) | spawns from `<project.path>` so `.mcp.json` loads | loads nothing on gemini |

Fixing these means writing into the repo's / workspace's `.gemini/settings.json`, which
intersects the **pristine-repo / artifact-relocation policy** (the app must not mutate the
user's repo, and `.gemini/` in the repo belongs to the user) — that is its own future change,
deliberately not bundled with the agent-chat fix.

## Doc corrections this note anchors

- `docs/internals/adding-a-provider.md` no longer claims "`project-json` ⇒ nothing to add":
  project-json is the claude `.mcp.json` mechanism; a provider with its own config surface
  (gemini) needs explicit wiring + any trust env.
- `docs/gemini.md` no longer claims Serena-style plugins "work" on gemini rails.
