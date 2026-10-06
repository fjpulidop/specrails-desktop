## Why

specrails-core stops shipping the installed role agents (`sr-architect`, `sr-developer`, `sr-reviewer`) in its paired change `retire-installed-role-templates`: the programmatic runtime owns the role definitions and never read those files. Desktop still treats the presence of `sr-*` files as proof that a project is installed, counts them in the setup summary, requires them to seed profiles, repairs them on Windows before every rail spawn and asserts them in the Windows CI smoke. Without this change a project installed with the next Core would never report setup as complete.

## What Changes

- Setup completion is decided by the workflow commands (and skills) Core places, never by role files. The setup summary's `agents` count reports the project's custom roles only, and the `agent_generation` checkpoint disappears from the full-install flow.
- Profiles keep their id-based data model (`sr-architect`, `sr-developer`, `sr-reviewer` remain role identifiers), but no server path requires or reads an `sr-*` file: migration from settings seeds the baseline from the adapter and reads models only from files that exist; the Agents catalog lists the baseline roles as runtime-defined entries whose read-only body is the Core runtime definition.
- The Windows per-spawn repair that copied framework `sr-*` agents into the workspace is removed; command-subtree repair stays.
- The Revision loop's `revision-verify` prompt and the MCP guide no longer refer to an installed `sr-reviewer`/baseline files; Gemini headless acknowledgment keeps covering custom agents only.
- `EXPECTED_CORE_CONTRACT_SCHEMA_VERSION` accepts contract 5.2 (and 5.1), and the Windows bundled-Core smoke script asserts commands, skills and runtime instead of role files.
- User documentation (profiles, getting started, running pipelines, platform notes and the eight-language guides) describes roles as runtime-defined and stops pointing at `.claude/agents/sr-*.md`; the Agents section copy in all eight locales follows.

## Capabilities

### New Capabilities
- `setup-completion-detection`: how Desktop decides that a provider workspace carries a complete Core installation and what the setup summary counts.

### Modified Capabilities
- `agents-section`: the Agents tab's Upstream segment lists runtime-defined roles instead of `sr-*` files.
- `multi-provider-architecture`: `baselineAgents()` declares role identifiers, not installed files, and installation detection is not derived from them.
- `legacy-install-migration`: the cleanup manifest no longer contains `sr-*` agents; the historical patterns still remove them.
- `setup-wizard-summary`: the `Agents` tile reports custom roles.

## Impact

- `server/setup-manager.ts`, `server/workspace-manager.ts` (+ callers in `queue-manager.ts`, `loop-executors.ts`), `server/modules/agents/runtime/profiles-router.ts`, `server/modules/loops/runtime/loop-command-catalog.ts`, `server/mcp/guide.ts`, `server/providers/gemini-agent-ack.ts`, `server/core-compat.ts`, `scripts/smoke-bundled-core-windows.ps1`.
- Client: `AgentsCatalogTab.tsx` copy and empty states, `client/src/locales/*/agents.json`, `agentstudio.json`.
- Docs: `docs/getting-started.md`, `docs/running-pipelines.md`, `docs/internals/profiles.md`, `docs/internals/adding-a-provider.md`, `docs/platforms/windows.md`, `docs/internals/review-packet.md`, `docs/guide/<lang>/agents/*.md`, `docs/guide/<lang>/pipeline/2-the-job-detail-view.md`.
- Tests across `server/setup-manager.test.ts`, `workspace-manager.test.ts`, `profiles-router.test.ts`, `profile-migrate.test.ts`, `framework-manager.test.ts`, `core-compat` tests and the client agents tests.
