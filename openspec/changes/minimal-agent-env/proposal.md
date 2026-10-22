## Why

Every agent Specrails Desktop launches inherits the full environment of the Desktop process. A developer who exports cloud keys, `GITHUB_TOKEN`, database URLs or unrelated API keys in their shell hands all of them to the agent and to every command the agent runs. Organizations evaluating Specrails (feedback 2026-10, Phase 4, task 4.1) asked for a way to give agents only what they need. The project already stores a passthrough list of variable *names*; what is missing is a mode in which that list, plus a small fixed allowlist, is the whole environment.

## What Changes

- New project setting `agentEnvMode: 'inherit' | 'minimal'`, default `inherit`. `inherit` keeps today's environment construction byte-for-byte.
- `minimal` builds the agent's base environment from:
  - a shared allowlist (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, locale, temp, terminal, `TZ`, XDG dirs, proxy variables in both cases, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`);
  - Windows essentials, matched case-insensitively on Windows (`SystemRoot`, `ComSpec`, `PATHEXT`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `ProgramData`, `ProgramFiles*`, `windir`, `NUMBER_OF_PROCESSORS`, …);
  - Specrails' own `SPECRAILS_*` variables;
  - auth/config names declared by each provider adapter in a new `envAllowlist` field (Claude `ANTHROPIC_*`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_*`; Codex `CODEX_*`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`; Gemini `GEMINI_*`, `GOOGLE_*` auth names; Kimi `KIMI_*`, `MOONSHOT_*`; local engines their `apiKeyEnv`);
  - the project's passthrough names, with the existing login-shell recovery.
- One shared builder: a pure policy in `server/modules/execution/domain/agent-env.ts` and the project-bound `resolveProjectAgentEnv` / `projectAgentSourceEnv` in `server/project-env.ts`, used by every project agent spawn path (rail jobs, loops, runtime controls, missions and their Core session host, project chats, spec helpers).
- Value-free status endpoint `GET /api/projects/:projectId/agent-env/status` listing the variable names that would be passed.
- Project Settings card with an explanation, in all eight locales. The MCP `specrails_env` tool reports the mode read-only.
- Documentation in `docs/internals/configuration.md`, `SECURITY.md` and the provider guide.

Out of scope: redaction of Core's session journal (separate Core change); the setup wizard, project builder chat, file summaries, agent generation and title helpers keep the Desktop environment.

## Capabilities

### New Capabilities
<!-- None -->

### Modified Capabilities
- `project-runtime-environment`: adds the per-project agent environment mode, its allowlist composition, single-builder coverage of agent spawn paths and a value-free status report.
