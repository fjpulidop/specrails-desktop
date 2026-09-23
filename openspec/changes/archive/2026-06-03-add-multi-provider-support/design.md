## Context

specrails-hub supports two AI CLIs today — Claude (full) and Codex (gated as "Coming Soon"). Investigation across 30+ files showed a paradox: the codex code path is wired through most managers (provider field on `projects`, codex branches in `ChatManager`, `QueueManager`, `project-router/tickets/generate-spec`, dedicated `spec-models.ts`, `result-event.ts` provider param, codex-aware `setup-manager.ts`, an integration contract with `providers.codex` separated, codex templates `codex-config.toml` / `codex-rules.star` shipped in specrails-core, codex skill scaffolding for enrich/doctor), yet six gates prevent end-to-end usage and five functional pieces are incomplete:

| # | Gate / gap | Location |
|---|---|---|
| 1 | `provider: codex` rejected | `specrails-core/src/installer/phases/install-config.ts:96` |
| 2 | `--provider codex` rejected | `specrails-core/src/installer/phases/provider-detect.ts:65` |
| 3 | `--provider codex` rejected (dup) | `specrails-core/src/installer/commands/init.ts:79` |
| 4 | `available-providers` hardcoded false | `server/hub-router.ts:147` |
| 5 | `POST /projects` rejects codex | `server/hub-router.ts:181` |
| 6 | UI force-falsifies codex | `client/AddProjectDialog.tsx:59,74` + `useHub.tsx:37` |
| A | Stream read as plain text, not `--json` | `chat-manager.ts:637`, `queue-manager.ts:601`, `setup-manager.ts:1126`, `agent-refine-manager.ts` (no codex branch) |
| B | Synthetic session_id; `codex exec resume` never used | `chat-manager.ts:794`, `setup-manager.ts:1118` |
| C | Tokens / cost not captured (`turn.completed.usage` ignored) | `queue-manager.ts:890`, `result-event.ts:42` |
| D | Profiles / plugins Claude-only by hardcoded gates | `queue-manager.ts:632,688`, `profile-manager.ts`, `plugin-manager.ts` |
| E | Codex rails (`sr-architect/developer/reviewer`) don't exist as skills | `specrails-core/templates/agents/sr-*.md` are Claude-only |

Codex CLI 0.128.0 (verified locally) supports `exec --json` (JSONL: `thread.started → turn.started → item.completed → turn.completed{usage}`), `exec resume <thread_id> <prompt>`, `mcp add/list/remove`, `--sandbox`, `--cd`, OAuth via ChatGPT or API key. It does not emit `total_cost_usd`. Its conventions are `.codex/` directory + `AGENTS.md` instructions file + per-project sandbox rules in `.codex/rules.star`.

The user has framed this work as a qualitative leap and asked for an architecture that scales to additional providers in the future. The naïve approach of growing `if (provider === 'codex')` branches across the codebase has reached its breaking point — every new feature added (profiles, plugins, telemetry, pricing) carries a "skipped for codex" footnote. We will replace the enum-driven branching with a single contract.

## Goals / Non-Goals

**Goals:**

1. Codex projects can be created end-to-end from the UI: Add Project → Quick install → first job → tokens + cost visible in Analytics.
2. Codex Explore Spec preserves context across turns (real `codex exec resume`).
3. Codex jobs persist real `tokens_in / tokens_out / cache_read` and an estimated `total_cost_usd` derived from a local pricing table.
4. Codex jobs emit OTEL spans / metrics / logs equivalent to Claude jobs (synthesised by the hub from JSONL) — telemetry export ZIP unchanged.
5. Profiles work on codex projects with codex models in the dropdown.
6. Plugins (Serena today) install on codex projects via `codex mcp add` with per-project `CODEX_HOME`.
7. Adding a third provider in the future is one new adapter file + one registry entry; no manager file gets a new `if/else`.
8. Coverage thresholds (server ≥ 80 % lines/funcs/stmts, client ≥ 80 % lines/stmts) hold.

**Non-Goals:**

- Multi-job pipeline orchestration for codex (split architect/developer/reviewer into separate `dependsOnJobId` jobs). v1 ships single-job inline orchestration via the `sr-implement` skill. Multi-job is a follow-up change.
- Provider switching after project creation. Stays immutable.
- Authoritative cost via OpenAI Usage API. Local pricing table is "estimated" with explicit UI disclaimer.
- Codex `plugin marketplace` integration. Bundled plugins only, same as today.
- Compatibility with codex < 0.128.0. We require 0.128.0+ for `--json` + `resume` semantics and pin the requirement in `setup-prerequisites`.

## Decisions

### D1 — Provider abstraction shape

**Decision**: Define a `ProviderAdapter` TypeScript interface (one file: `server/providers/provider-adapter.ts`) implemented by per-provider modules (`claude-adapter.ts`, `codex-adapter.ts`). A `providerRegistry` (Map<string, ProviderAdapter>) is the single discovery point. Managers consume the adapter for `provider` strings stored on the project row.

**Interface surface (minimal — only what ≥ 2 providers need):**

```ts
interface ProviderAdapter {
  readonly id: ProviderId                              // 'claude' | 'codex' | ...
  readonly displayName: string                          // 'Claude Code', 'Codex CLI'
  readonly binary: string                               // 'claude', 'codex'
  readonly minCliVersion: string | null                 // null = no pin

  // Filesystem conventions
  readonly projectDirName: string                       // '.claude', '.codex'
  readonly instructionsFilename: string                 // 'CLAUDE.md', 'AGENTS.md'
  readonly mcpRegistration: 'project-json' | 'cli-add'  // dictates plugin install path

  // Capability flags — managers gate behaviour on these, never on `id`
  readonly capabilities: {
    nativeResume: boolean
    nativeStreamJson: boolean
    nativeCostUsd: boolean
    nativeOtelEnv: boolean
    profileEnvSupport: boolean
    systemPromptArg: boolean
  }

  // Model catalog — populates UI dropdowns and validates profile schemas
  modelCatalog(): readonly { value: string; label: string; default?: boolean }[]
  defaultModel(): string

  // Spawn args by action — every spawn site funnels through one of these
  buildArgs(action: SpawnAction, opts: SpawnOptions): string[]

  // Stream parsing — uniform event shape across providers
  parseStreamLine(line: string): AdapterEvent | null

  // Result extraction — token usage + model + duration + session id
  extractResult(events: AdapterEvent[]): NormalisedResult

  // Baseline agents (rails) — names used by ProfileManager validation
  baselineAgents(): readonly string[]

  // Health probe — runs at startup + via /setup-prerequisites
  detectInstalled(): Promise<DetectionResult>
}

type SpawnAction =
  | 'chat-turn'                    // ChatManager
  | 'chat-resume'                  // ChatManager turn 2+
  | 'rail-job'                     // QueueManager
  | 'spec-gen'                     // project-router /tickets/generate-spec
  | 'agent-refine'                 // AgentRefineManager
  | 'setup-enrich'                 // SetupManager

type AdapterEvent =
  | { kind: 'text-delta'; text: string }
  | { kind: 'tool-use'; name: string; inputPreview: string }
  | { kind: 'session-started'; sessionId: string }
  | { kind: 'result'; payload: Record<string, unknown> }
  | { kind: 'other'; type: string; raw: Record<string, unknown> }
```

**Alternative considered**: full Strategy pattern with one class per `SpawnAction` × per `Provider` (Claude × 6 + Codex × 6 = 12 classes). Rejected: too much boilerplate for the variance involved. The actions differ enough in semantics that a flat `switch (action)` inside each adapter's `buildArgs` is readable; the explosion isn't worth it for v1.

**Alternative considered**: keep the enum-driven branches but extract them into one helper module. Rejected: every new provider would still touch every helper. The interface is the only design that meets goal #7.

### D2 — Capability flags, not provider IDs

**Decision**: Managers branch on `adapter.capabilities.nativeResume`, not on `provider === 'claude'`. A future provider that supports resume gets it for free by setting the flag true.

Example, `ChatManager.sendMessage`:

```ts
// Wrong (today's pattern):
if (this._provider === 'codex') { /* synthetic session_id */ }
else if (capturedSessionId) { args.push('--resume', capturedSessionId) }

// Right (with adapter):
if (capturedSessionId && this._adapter.capabilities.nativeResume) {
  args = this._adapter.buildArgs('chat-resume', { sessionId: capturedSessionId, ... })
}
```

Trade-off: developers must add capability flags as they discover new behavioural differences. Mitigated with code review and the spec file (`multi-provider-architecture/spec.md`) being normative.

### D3 — Cost calculation strategy

**Decision**: Local pricing table at `server/modules/accounting/runtime/pricing.ts`, keyed by `${providerId}:${model}`. Used as a fallback when `adapter.capabilities.nativeCostUsd === false`. Surface as `estimated: true` in `ai_invocations` (new optional column added by migration — see Migration Plan) and badge in UI.

```ts
// server/modules/accounting/runtime/pricing.ts
export interface PriceEntry {
  inputPer1M: number
  outputPer1M: number
  cacheReadPer1M: number
  /** YYYY-MM-DD — used by a quarterly review reminder; not user-facing. */
  lastReviewedAt: string
}
export const PRICING: Record<string, PriceEntry> = {
  'codex:gpt-5.5':        { inputPer1M: 1.25, outputPer1M: 10.00, cacheReadPer1M: 0.125, lastReviewedAt: '2026-05-17' },
  'codex:gpt-5.4':        { inputPer1M: 2.50, outputPer1M: 10.00, cacheReadPer1M: 0.25,  lastReviewedAt: '2026-05-17' },
  'codex:gpt-5.4-mini':   { inputPer1M: 0.25, outputPer1M: 2.00,  cacheReadPer1M: 0.025, lastReviewedAt: '2026-05-17' },
  'codex:gpt-5.3-codex':  { inputPer1M: 1.50, outputPer1M: 6.00,  cacheReadPer1M: 0.15,  lastReviewedAt: '2026-05-17' },
}
export function estimateCostUsd(providerId: string, model: string | null | undefined, usage: TokenUsage): number | null {
  if (!model) return null
  const entry = PRICING[`${providerId}:${model}`]
  if (!entry) return null
  const inputCost     = (usage.tokens_in        ?? 0) * entry.inputPer1M     / 1_000_000
  const outputCost    = (usage.tokens_out       ?? 0) * entry.outputPer1M    / 1_000_000
  const cacheReadCost = (usage.tokens_cache_read ?? 0) * entry.cacheReadPer1M / 1_000_000
  return inputCost + outputCost + cacheReadCost
}
```

Reasoning tokens (`reasoning_output_tokens` in codex) are tariffed as output tokens — this matches OpenAI's pricing model. The cache write tier doesn't exist on the OpenAI side, so `tokens_cache_create` is always `null` for codex.

**Alternative considered**: skip cost entirely for codex (show "—"). Rejected: breaks daily-budget enforcement and the Spending Hero burn meter, both of which the user actively uses. Estimated > unknown.

**Alternative considered**: call OpenAI Usage API. Rejected for v1: requires API key permissions, async polling, rate limits. Marked Open Question for v2.

### D4 — Synthetic OTEL for codex

**Decision**: `server/modules/accounting/runtime/codex-otel-bridge.ts` consumes the JSONL emitted by `codex exec --json` and writes OTLP-shaped JSON payloads directly to the in-process OTLP receiver (POST `/otlp/v1/{traces,metrics,logs}`). Same destination QueueManager already feeds via env vars for Claude. `telemetry_blobs` rows, `telemetry.ndjson`, and the diagnostic export ZIP work identically.

The bridge runs only when `pipelineTelemetryEnabled === true` for the project, mirroring the Claude path.

Span mapping:
- `thread.started` → root span start (`specrails.job.run`), capture `thread_id` as `specrails.codex.thread_id` attribute
- `turn.started` → child span start (`specrails.codex.turn`)
- `item.completed` of type `agent_message` → log line (`logs.txt` content)
- `item.completed` of type `function_call` (tool use) → span event
- `turn.completed` → child span end with `usage.*` attributes; root span end on process close

**Alternative considered**: implement an MCP / OTLP server inside the codex sandbox. Rejected: requires codex CLI changes outside our control.

### D5 — Codex rails as skills, not delegating to subagents

Codex has no Task tool. The Claude rails (`sr-architect`, `sr-developer`, `sr-reviewer`, `sr-merge-resolver`) are `.md` files with `model: sonnet|opus|haiku` frontmatter, invoked as sub-agents via Task by the orchestrator command.

**Decision**: Port each Claude rail to a Codex Skill (`templates/skills/rails/sr-*/SKILL.md`) in specrails-core. The codex `sr-implement` skill (already 50 KB, exists) runs all three rails inline within a single codex session, not as separate spawns. The orchestrator's prompt is shaped by the SKILL.md content.

Codex skill SKILL.md format (from upstream codex docs + existing `templates/skills/sr-implement/SKILL.md`):

```yaml
---
name: sr-architect
description: "When implementing a spec, architect the change first."
license: MIT
compatibility: "Requires git."
metadata: { author: specrails, version: '1.0' }
---

# Architect rail
...

```

The frontmatter `model:` field has no meaning to codex (model is chosen at spawn time via `--model`). Personality / tone customisations from the Claude version are preserved verbatim in the skill body.

**Trade-off**: codex pipeline runs as one job vs Claude's many spawns. Telemetry granularity drops (one set of usage numbers covers all 3 phases). Mitigated by adding `specrails.codex.phase` attributes inside the bridge when the skill text emits checkpoint markers (existing pattern used by `enrich.md` for hub UI).

**Future work**: a follow-up change (`add-codex-pipeline-multi-job-orchestration`) will split this into multiple jobs with `dependsOnJobId`, gated behind a `useMultiJobOrchestration` flag.

### D6 — Plugin install path

**Decision**: `PluginManager.install(projectPath, projectId, name, broadcast)` resolves `adapter = getAdapter(project.provider)` and dispatches:

- `adapter.mcpRegistration === 'project-json'` → existing `.mcp.json` surgical merge (Claude path).
- `adapter.mcpRegistration === 'cli-add'` → `codex mcp add <plugin-name> -- <command> <args>` with `CODEX_HOME` set to `~/.specrails/projects/<slug>/codex-home/`. Idempotent: probe `codex mcp list` first.

Per-plugin manifests gain an optional `expectedMcpEntry(adapter): { server: 'serena', command: 'uvx', args: [...] }`. The shape is provider-agnostic; the adapter converts it to `.mcp.json` JSON or `codex mcp add` invocation.

Shared-file contributors (today `CLAUDE.md` block insertion) target `adapter.instructionsFilename`. `AGENTS.md` block insertion uses the same `<!-- specrails-hub-managed:<plugin> -->` sentinel.

**Trade-off**: per-project `CODEX_HOME` means codex MCP entries are scoped per-project but visible globally if the user runs `codex` from terminal with a different `CODEX_HOME`. Documented limitation. The alternative (mutating user's `~/.codex/config.toml`) was rejected: violates additivity invariant (the user might already have entries we don't own).

### D7 — Profile schema evolution

**Decision**: Keep schema version 1, additive evolution:
- `Profile.provider?: ProviderId` — optional. Resolves to the project's provider when absent. Used by ProfileManager to know which adapter validates `ProfileAgent.model`.
- `ProfileAgent.model` no longer enum-constrained to `sonnet|opus|haiku`. Validation: must be in `adapter.modelCatalog().map(m => m.value)`.
- `validateStructural` checks baseline agents come from `adapter.baselineAgents()` instead of the hardcoded `['sr-architect', 'sr-developer', 'sr-reviewer', 'sr-merge-resolver']`. Codex adapter returns the same set (the rails are conceptually identical), but a future provider could return different names.

Existing profiles (`provider` absent, `model: sonnet`) keep working — they resolve to Claude adapter, validate identically. No migration needed.

JSON Schema update path: amend `schemas/profile.v1.json` with the new optional `provider` field and replace the enum on `ProfileAgent.model` with a string pattern that AJV accepts; the structural validator (`validateStructural`) does the provider-aware enforcement. This preserves the JSON Schema as a coarse-grained guard while moving fine-grained checks to runtime.

### D8 — Provider discovery and detection

**Decision**: `setup-prerequisites.ts` reports two entries: `claude` (severity `optional` if at least one provider is available, otherwise `required`) and `codex` (same). At least one must be on PATH for the hub to allow Add Project. `available-providers` endpoint returns `{ claude: bool, codex: bool, tiers: [...] }` — same shape as today, just truthful.

`detectAvailableCLIs()` already returns `{ claude: bool, codex: bool }`. We extend it to the future by walking `providerRegistry`:

```ts
export function detectAvailableProviders(): Record<ProviderId, DetectionResult> {
  const out: Record<string, DetectionResult> = {}
  for (const [id, adapter] of providerRegistry) {
    out[id] = adapter.detectInstalled()  // sync version
  }
  return out
}
```

Backwards compat: `detectAvailableCLIs()` is kept as a wrapper that returns `{ claude, codex }` from the new map (used by older callsites; deprecated path).

### D9 — Explore Spec cwd for codex

Today, `explore-cwd-manager.ts` creates `~/.specrails/projects/<slug>/explore-cwd/` with a synthetic `CLAUDE.md` so Claude doesn't auto-load the project's heavy `CLAUDE.md`.

**Decision**: Provider-aware. Codex projects get an `AGENTS.md` with the same hub-owned content. The `./project` symlink to the real repo is unchanged. `removeExploreCwd` works identically.

A future provider with a different convention sets `instructionsFilename` and gets the right file generated automatically.

### D10 — Telemetry of the rollout itself

**Decision**: add a `provider` tag to existing `ai_invocations` aggregation. Already inferable from the joined model name, but explicit `provider` makes `byProvider` queries trivial for the analytics dashboard and for our own rollout monitoring.

`ai_invocations` already has a `provider` column? — checked: no. Add migration 18:

```sql
ALTER TABLE ai_invocations ADD COLUMN provider TEXT;
UPDATE ai_invocations SET provider = 'claude' WHERE provider IS NULL;
```

Backfill: existing rows default to `claude` (the only path that ran). New rows populated by `recordInvocation` from the adapter's `id`.

### D11 — UI badge for "estimated cost"

**Decision**: `ai_invocations` gains a `total_cost_usd_estimated: 0 | 1` column (migration 19, default 0). Rows where `estimateCostUsd` was used (vs `result.total_cost_usd` from the provider) get `1`. The Analytics row renderer shows a small ~ symbol prefix on the cost cell when `total_cost_usd_estimated === 1`.

**Alternative considered**: derive `estimated` at query time from `provider === 'codex'`. Rejected: brittle, breaks if we add a new provider that does emit cost.

## Risks / Trade-offs

| Risk | Severity | Mitigation |
|---|---|---|
| Cost table drifts from real OpenAI pricing | High | `lastReviewedAt` field; quarterly review checklist in repo; UI badge `~` so users know it's estimated; CI doesn't break on drift |
| Codex stream-JSONL shape changes between CLI versions | Medium | Tolerant parser (unknown event types → `{ kind: 'other' }`); pin minimum codex version in setup-prerequisites; fixtures under `server/providers/__fixtures__/codex/` per CLI version |
| Codex `resume` UUID-not-found error mid-Explore | Medium | Fallback to fresh exec with last user message + previous turn's text as context; same UX as today's session-loss path on Claude |
| Concurrent `codex mcp add` from two plugins racing on `~/.codex/config.toml` | Medium | Per-project `CODEX_HOME`, plus existing in-process file lock in `withFileLock` extended to gate the codex install path |
| Skill SKILL.md for `sr-architect/developer/reviewer` diverges from Claude `.md` | High | Both files generated from a shared source-of-truth template (option) or CI test that compares headings (option). Decision: a CI test in specrails-core that walks `templates/agents/*.md` and asserts a matching `templates/skills/rails/*` exists with the same H2 sections |
| Coverage drops below 80 % during the refactor | High | Adapter contract has its own test suite (`server/providers/*.test.ts`); existing test files extended in lockstep; the refactor itself is behaviour-preserving |
| OAuth ChatGPT auth absent in CI / new dev machines | Low | `setup-prerequisites` displays both auth options (OAuth or `OPENAI_API_KEY`); e2e tests gated behind `SPECRAILS_HUB_E2E_CODEX=1` |
| Reasoning tokens billed but not visible | Low | Surface `reasoning_output_tokens` in `ai_invocations.tokens_out` (codex bills them as output); add docs note |
| AGENTS.md collides with codex CLI's own AGENTS.md convention | Medium | Sentinel `<!-- specrails-managed -->` block in updates; preserves user content outside sentinel; same pattern as existing `CLAUDE.md` contributors |

## Migration Plan

**DB migrations** (additive, no destructive ALTERs):

- Migration 18: `ALTER TABLE ai_invocations ADD COLUMN provider TEXT;` + backfill `'claude'`
- Migration 19: `ALTER TABLE ai_invocations ADD COLUMN total_cost_usd_estimated INTEGER NOT NULL DEFAULT 0;`

Both per-project (run on `initDb`). No hub.sqlite changes.

**Deploy order:**

1. specrails-hub: ship the adapter refactor + codex stream fixes + pricing + OTEL bridge + profile/plugin extensions, **with gates still up** (Stage A). Internal behaviour change only — claude path is byte-identical.
2. specrails-core 4.6.0: lift the three "coming soon" gates + extend scaffold + new skills. Publish to npm.
3. specrails-hub: lift the three remaining gates (hub-router 147/181, UI). Stage B is now opt-in via `SPECRAILS_HUB_CODEX_BETA=1` env on the hub.
4. After internal validation across at least one real project per provider, drop the env var gate; codex is generally available.

**Rollback:**

- Hub side: revert the gate-lift commit. No DB rollback needed (additive columns are inert).
- Core side: revert to 4.5.x in `package.json` of hub-side smoke tests (not pinned, but it works because the gates re-throw consistently).

**Communication:**

- CHANGELOG.md entry (hub side) under "Features": Codex CLI is now fully supported.
- specrails-core 4.6.0 CHANGELOG.md entry under "Features": Codex provider support enabled; new rail skills.
- README of hub: replace "Claude Code (required)" with "Claude Code or Codex CLI".
- AGENTS.md scaffold sentinel documented in `docs/codex.md` (new) so users opening the file in their editor know what's hub-managed vs user-managed.

## Open Questions

1. **Codex CLI version pin**: should `setup-prerequisites` hard-fail on codex < 0.128, or soft-warn? **Lean: hard-fail** because `--json` and `resume` are required. Confirm during implementation.
2. **Plugin manifest `codexInstall` callback vs declarative `expectedMcpEntry`**: declarative is simpler, but the codex install needs `codex mcp add` which is imperative. **Lean: keep `install(ctx, adapter)` callback for the imperative branch, declarative as a convenience for the trivial case.**
3. **Cost-table review cadence**: monthly or quarterly? **Lean: quarterly with a calendar reminder; if OpenAI raises prices mid-quarter we ship an out-of-band update.**
4. **OAuth refresh failures during long jobs**: codex tokens can expire mid-run. Detect & report? **Lean: leave to codex CLI (it surfaces auth errors on stderr); hub captures the stderr tail in the existing failed-job message path.**
5. **What's a "provider" exactly**: do we want a hierarchical model (provider → engine → model) for future expansion, or flat? **Lean: flat for v1.** Hierarchy is over-engineering until we have evidence we need it.
