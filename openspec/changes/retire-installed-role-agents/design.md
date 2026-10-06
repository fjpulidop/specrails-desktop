## Context

Core 6.3 (`retire-installed-role-templates`) removes `templates/agents` and the Codex rails: a fresh workspace has commands, skills and the runtime, and `assemble` prunes stale `sr-*` links from older installs. Desktop's `setup-manager` computes `complete = agents > 0 && commands > 0` from `<providerDir>/agents/sr-*.md` (or `skills/(rails/)?sr-*`), feeds checkpoint detection from those paths, and `workspace-manager.ensureFrameworkAgents` copies framework agents on Windows before each spawn. The profiles module (`server/modules/agents`) models a chain of agent ids whose baseline trio is mandatory by schema (`profile.v1.json` constants) and seeds a `default` profile by reading model frontmatter from the `sr-*` files; the Agents tab segments the catalog into Upstream (`sr-*` files) and Custom (`custom-*`).

The implement rail already runs the roles through Core's runtime; profile snapshots still reach the job (`profileOrchestratorModel`, per-agent models) when `projectSupportsProfiles` holds. Role ids are therefore an interface Desktop keeps; the files are not.

## Goals / Non-Goals

**Goals:**
- A project installed by Core 6.3 (no `sr-*` files) reports setup complete, shows a truthful summary and launches rails without a Windows repair step.
- A project installed by an older Core keeps working unchanged (old files are tolerated until Core prunes them).
- Profiles, routing rules, per-agent models and the Agent Studio keep their data model and validation; only file reads disappear.
- Documentation and locale copy stop describing installed role files.

**Non-Goals:**
- Retiring the profiles feature or renaming role ids (`sr-*`) in profile data, schemas or analytics.
- Changing how custom agents (`custom-*`) are stored, edited, refined or acknowledged.
- Changing Core's install-config payload Desktop writes (`agents.selected`/`excluded` stay; Core 6.3 ignores them).

## Decisions

- **Completion = commands.** `setupArtifactState.complete` becomes `hasCommands` for the native layout (legacy Claude fallback keeps the same rule). `agent_generation` leaves `CHECKPOINTS` and every detector regex that matched `sr-*` paths; `agent_selection` keeps its install-config signals. Alternative: derive `agent_generation` from commands. Rejected: a checkpoint named after work Core no longer does is misleading in the wizard.
- **Summary `agents` = custom roles.** `computeSummary` counts `custom-*` entries (claude/gemini `agents/*.md`, codex `skills/rails/custom-*`, kimi `skills/custom-*`) so the `Agents` tile stays truthful; personas are unchanged. The tile keeps its label; copy explains it counts custom roles.
- **Profiles keep ids, drop files.** `baselineAgents()` keeps returning the trio as role identifiers (schema constants and routing depend on them). `migrate-from-settings` seeds the baseline from `adapter.baselineAgents()` with the adapter default model, reads `model:` only from role files that still exist, and never answers 400 for missing baseline files. `GET /catalog` returns the baseline roles as `kind: 'upstream'` entries synthesized from the adapter, with the Core runtime definition (`rolePromptDefaults()` + global overrides via the existing loader, mapped `sr-architect → architect`, `sr-developer → developer`, `sr-reviewer → reviewer`) as the read-only body and a description that says the role is runtime-defined; custom entries are unchanged. Alternative: hide the Upstream segment. Rejected: users lose the only place that shows what the roles do; the segment now shows the live definition instead of a stale copy.
- **Remove the Windows agent repair.** `ensureFrameworkAgents` and its callers go; `ensureFrameworkCommandSubtrees` stays. The queue-manager comment about delegation is rewritten.
- **Prompts and guides.** `revision-verify` asks for an independent senior review against the OpenSpec package and the diff, with the same output reconciliation, instead of "load the installed sr-reviewer". The MCP guide's profiles paragraph describes the baseline trio as role identifiers.
- **Contract 5.2.** `EXPECTED_CORE_CONTRACT_SCHEMA_VERSION` moves to `5.2` and the compatibility check accepts `5.1` as well, so Desktop runs against the bundled Core until the bump lands.
- **Smoke script.** Claude asserts `commands` and `skills`, Gemini `commands`, Kimi a `specrails-*` workflow skill and the `specrails/` runner; no `sr-*` assertions remain.

## Risks / Trade-offs

- [Old projects still hold `sr-*` files until Core prunes them] → Summary counts only `custom-*`, so the count changes for them too; the Upstream segment shows runtime roles regardless. No user action.
- [Profile per-agent models imply a file to patch (`applyModelConfig`)] → The helper already skips absent files; models for baseline roles are configured in Settings → Agent runtime, and the docs say so.
- [Guides in eight languages describe `.claude/agents/sr-*.md`] → Only sentences that point at files change; role names and the profiles narrative stay. Each locale is edited, not machine-replaced.
- [Older Core (5.1 contract) still bundled while this ships] → Completion by commands works with it; the contract check accepts both versions.

## Migration Plan

1. Ship this change; Desktop keeps working with the bundled Core (5.1 contract).
2. Bump Core to 6.3 (contract 5.2); the next assemble prunes stale `sr-*` files from existing projects.
3. No user action.

## Open Questions

- None.
