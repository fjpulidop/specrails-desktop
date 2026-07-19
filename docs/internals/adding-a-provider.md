# Adding a new AI provider to Specrails

> Last verified with the Kimi provider change, which ships **four** registered
> providers: **Claude, Codex, Gemini, and Kimi**. Kimi is the freshest worked
> example — `server/providers/kimi-adapter.ts` demonstrates multi-event JSONL,
> per-child environment overrides, native skill commands, and CLI-only resume.

The app is provider-agnostic by design. Every manager that spawns an AI
CLI consumes a `ProviderAdapter` rather than branching on a hardcoded
`if (provider === 'claude')`. Adding a provider is, in the ideal case,
**one adapter file plus one registry line** — and that ideal is now real:
`ProviderId` is just `string` (no `'claude' | 'codex'` union to widen),
and the provider-discovery routes are registry-driven, so a newly-registered
adapter surfaces in the API and the Add Project UI with **zero** further edits.
You only fill a few non-adapter seams that are inherently provider-specific
(pricing rows, a spawn-env quirk, install hints, a branded UI chip) — tracked
in **Optional polish** and the conditional steps 3–6 below.

If you find yourself wanting to write `if (this._provider === 'X')` in
a manager, **the design has drifted** — find the capability you're
gating on, add a flag to `ProviderCapabilities`, and branch on the
flag instead.

The remaining genuine id-keyed sites (the legacy `normaliseResultEvent`
branch and the Codex rail slash-command rewrite) are inventoried in
**Don't break the principle** at the end.

## The recipe

### 1. Implement the adapter

Create `server/providers/<id>-adapter.ts` exporting a `const` of type
`ProviderAdapter`:

```ts
import type { ProviderAdapter, SpawnAction, SpawnOptions, AdapterEvent, NormalisedResult, DetectionResult } from './types'

const MODELS = [
  { value: 'flagship', label: 'Provider X Flagship', default: true as const },
  { value: 'fast',     label: 'Provider X Fast' },
] as const

export const exampleAdapter: ProviderAdapter = {
  id: 'example',
  displayName: 'Example CLI',
  binary: 'example',
  minCliVersion: '1.0.0',
  projectDirName: '.example',
  instructionsFilename: 'EXAMPLE.md',
  mcpRegistration: 'cli-add', // or 'project-json'
  capabilities: {
    nativeResume: true,
    nativeStreamJson: true,
    nativeCostUsd: false,    // if false, add the provider:model entries to server/pricing.ts
    nativeOtelEnv: false,    // if false, the app will synthesise OTEL via the bridge
    profileEnvSupport: true,
    systemPromptArg: false,
  },
  modelCatalog: () => MODELS,
  defaultModel: () => 'flagship',
  buildArgs: (action: SpawnAction, opts: SpawnOptions): string[] => { /* per-action argv */ },
  parseStreamLine: (line: string): AdapterEvent | null => { /* line → canonical event */ },
  extractResult: (events): NormalisedResult => { /* events → tokens/cost/session */ },
  baselineAgents: () => ['sr-architect', 'sr-developer', 'sr-reviewer'],
  detectInstalled: async (): Promise<DetectionResult> => { /* `which` + `--version` */ },
  // Optional — see "(Optional) prepareHeadlessSpawn" below. Gemini uses it to
  // pre-acknowledge project subagents so they load in headless `gemini -p` rails.
  // prepareHeadlessSpawn: (projectPath: string): void => { /* best-effort prep */ },
}
```

The `ProviderAdapter` interface is documented in
`server/providers/types.ts`. Read the existing
`server/providers/{claude,codex,gemini,kimi}-adapter.ts` for the patterns —
`SpawnAction` shapes per provider, `text-delta` event normalisation
across native JSONL formats, etc. **`kimi-adapter.ts` is the newest
end-to-end exemplar** for prompt-mode providers; Gemini remains the example for
the optional
`prepareHeadlessSpawn` hook, `systemPromptArg: false` system-prompt folding
(via the `GEMINI_SYSTEM_MD` env), native OTEL with `nativeCostUsd: false`,
and a per-action `buildArgs` switch that throws defensively on the
`chat-stream` action it doesn't support. Note the shipped baseline is the
three-agent trio `['sr-architect', 'sr-developer', 'sr-reviewer']`;
`ProfileManager` validation requires exactly your `baselineAgents()` to
be present in every profile chain, so don't add agents your scaffold
won't actually create.

The `SpawnAction` union also includes **`chat-stream`** — used by the
Explore persistent-stdin fast-path and interactive jobs. Only providers
that advertise `capabilities.persistentStdin` (claude today) ever receive
it; if your CLI has no persistent-stdin transport, `throw` in that `case`
(as Gemini does) so a misrouted spawn fails loudly instead of emitting a
broken argv.

#### (Optional) prepareHeadlessSpawn

`prepareHeadlessSpawn?(projectPath)` is an optional, best-effort filesystem
prep run **right before a headless rail spawn** (cwd = the project path).
Gemini implements it to pre-acknowledge the project's custom subagents
(writing `~/.gemini/acknowledgments/agents.json`) so they load in
`gemini -p` mode instead of falling back to a generic agent. Claude and
Codex omit it. Managers wrap the call so a thrown error never blocks the
spawn — adding it is allowed and does **not** violate the no-id-branching
principle (it's an adapter member, not a `provider === 'X'` check in a
manager). See `server/providers/gemini-agent-ack.ts` for the worked use.

`parseStreamLine` returns `null` for empty input lines **and** for lines
that fail `JSON.parse` (see `server/providers/codex-adapter.ts`); unknown
JSON event types resolve to `{ kind: 'other' }`. Write your tests
accordingly — don't assume null-only-on-empty.

#### Two capability flags that bite

- **`systemPromptArg: false`** ⇒ the CLI has no `--system-prompt` flag, so the
  adapter must fold the system prompt into the user prompt before spawning —
  **except** Explore (`chat-turn`) turns, which must stay user-text-only (a
  long system prompt drowns a short Explore message); those trust the
  app-managed instructions file (`<instructionsFilename>`) in the explore cwd
  instead. Folding isn't the only mechanism: Gemini *also* exports its system
  prompt via the `GEMINI_SYSTEM_MD` env, so an implementer should pick whatever
  the CLI actually honours rather than assuming string concatenation.
- **`nativeCostUsd: false`** ⇒ `extractResult` leaves `total_cost_usd`
  undefined and the framework estimates it from a rate card (step 3). If your
  token usage reports `cached` as a **subset** of input (it usually does — see
  Gemini's `stats.cached`), map it to `tokens_cache_read`; `pricing.ts` already
  bills `tokens_in - tokens_cache_read` at the input rate and the cached portion
  at the cache rate, so don't double-count.

#### Mirror the model catalog into spec-models.ts

The model catalog is **duplicated** by design: the adapter's `modelCatalog()`
drives the spawn-time UI, but spec-model validation reads a *second* copy in
`server/spec-models.ts` (`PROVIDER_MODELS` + `PROVIDER_DEFAULT_MODEL`, both
`Record<string, …>` keyed by provider id). The file even comments that
`GEMINI_MODELS` "Mirrors GEMINI_MODELS in server/providers/gemini-adapter.ts".
If you add the catalog only to the adapter, your models won't validate in the
Add Spec flow. **Add your provider to both.** (Unmatched providers fall back to
the Claude catalog, so the failure is silent — easy to miss.)

### 2. Register it

Append the import to `server/providers/index.ts`:

```ts
import { register } from './registry'
import { claudeAdapter } from './claude-adapter'
import { codexAdapter } from './codex-adapter'
import { exampleAdapter } from './example-adapter' // ← add this

register(claudeAdapter)
register(codexAdapter)
register(exampleAdapter) // ← and this
```

**Truly automatic** (these walk the registry, so they pick up the new
provider with zero edits):

- `getAdapter` / `listAdapters` / `hasAdapter` (`server/providers/registry.ts`).
- `detectAvailableCLIs` (`server/core-compat.ts`).
- `GET /api/available-providers` (`server/desktop-router.ts`) — returns the
  **full detected map** built by iterating the registry, not a hardcoded
  `{ claude, codex }` literal. A new provider shows up here with no edit
  (the only per-id touch on this route is an optional beta gate, below).
- `POST /api/projects` provider validation (`server/desktop-router.ts`,
  via `hasAdapter` / `listAdapters`).
- `AddProjectDialog` (`client/src/components/AddProjectDialog.tsx`) — it
  fetches `/available-providers` generically (`Object.entries(data)`) and a
  `providerRenderOrder()` helper appends **any** detected-but-unlisted
  provider after the canonical-ordered known ones, with a neutral chip
  fallback. A new provider appears in the Add Project UI automatically.
- `setup-prerequisites` provider rows (`server/setup-prerequisites.ts`,
  iterates `listAdapters()`).
- Analytics `byProvider` (`server/spending.ts`) and the
  `ProviderBreakdownCard` (`client/src/components/analytics/ProviderBreakdownCard.tsx`).

### `ProviderId` is `string` — no compile-time blocker

There is **no type-union to widen**. `ProviderId` is `export type ProviderId = string`
(`server/providers/types.ts`), and every provider-typed seam already aliases it:
`CliProvider` (`server/desktop-db.ts`), `SpecProvider` (`server/spec-models.ts`),
`EnqueueOptions.provider` and `_jobProviderSelection` (`server/queue-manager.ts`),
`ChatManager`, `AgentRefineManager`, and `ProjectRegistry`. Adding a provider is
**not** a compile-time blocker — the old "widen ~8 unions" step is paid off (Gemini
is the proof it works). Any remaining `'claude' | 'codex'` literals live in test
fixtures and code comments, not the production type system.

### Optional polish (auto-works, but nicer with an edit)

None of these block a new provider — it works without them — but each one
makes it look first-class instead of falling back to a raw id:

- **Canonical position + branded chip.** `PROVIDER_ORDER` / `PROVIDER_META`
  in `AddProjectDialog` give the provider a fixed position in the picker and
  a custom icon + label (otherwise it's appended last with a `•` neutral chip).
- **Install hint.** `providerInstallUrl` / `providerInstallHint`
  (`server/setup-prerequisites.ts`) have generic `default:` fallbacks so
  nothing crashes, but a good install hint needs a `case` for your id.
- **Beta gate (only if you ship behind a kill switch).** If your CLI's stream
  schema isn't yet validated against a live binary, gate selection behind a
  `SPECRAILS_<ID>_BETA` env var. Mirror Codex/Gemini: add an
  `isXBetaDisabled()` helper in `server/desktop-router.ts` (return `true`
  only when the env value is the **exact string `'0'`** — both providers are
  default-**enabled**), force the provider `false` in the `/available-providers`
  response when disabled, and reject it in `POST /projects` with the same 400
  the others use. There is no `isGeminiBetaEnabled` — the helper is
  `isGeminiBetaDisabled` (returns `true` to DISABLE). Codex additionally honours
  the legacy `SPECRAILS_HUB_CODEX_BETA` name as a fallback; a brand-new provider
  has no such legacy alias.

### 3. (If `nativeCostUsd === false`) add pricing entries

For providers that don't report `total_cost_usd` in their terminal
event, append the rate card to `server/pricing.ts`:

```ts
'example:flagship': { inputPer1M: 5.00, outputPer1M: 15.00, cacheReadPer1M: 0.50, lastReviewedAt: '2026-05-18' },
'example:fast':     { inputPer1M: 0.50, outputPer1M:  1.50, cacheReadPer1M: 0.05, lastReviewedAt: '2026-05-18' },
```

The `finaliseInvocationResult` flow in `server/result-event.ts` falls
back to this table automatically and returns an `estimated` flag that
`recordInvocation` (`server/ai-invocations.ts`) persists as
`total_cost_usd_estimated = 1` on the `ai_invocations` row, which in
turn lights up the `~` tilde + Hero footnote on the AnalyticsPage.

### 4. OTEL telemetry

Two paths, picked by your `nativeOtelEnv` capability flag:

- **`nativeOtelEnv: true`** (Claude, Gemini) ⇒ nothing to do. `QueueManager`
  injects the **standard `OTEL_*` env vars** (`buildTelemetryEnv`) into every
  rail spawn and the CLI exports OTLP/JSON to the app's receiver natively. There
  is no `GEMINI_TELEMETRY_*` env var — Gemini honours the same `OTEL_*` vars as
  Claude.
- **`nativeOtelEnv: false`** (Codex, Kimi) ⇒ the synthetic OTEL bridge at
  `server/codex-otel-bridge.ts` fills the gap. It's provider-neutral despite its
  name — it consumes the canonical `AdapterEvent` stream. As long as your
  adapter's `parseStreamLine` emits `text-delta`, `tool-use`, `session-started`,
  and `result` events, the bridge synthesises traces / metrics / logs for free.
  The exported factory is still named `createCodexOtelBridge`; renaming it to
  `createSyntheticOtelBridge` (and updating callers) is safe — same logic.

### 5. (If `mcpRegistration === 'cli-add'`) wire the plugin install path

The codex MCP integration lives at `server/plugins/codex-mcp.ts`.
Mirror that file for a new `<provider>-mcp.ts` if your provider has a
similar `<binary> mcp add/remove/list` subcommand. Then update
`server/plugins/serena/install.ts`, which routes to the CLI-add helper
whenever `getAdapter(providerId).mcpRegistration === 'cli-add'`. The
app-level `PluginManager` already threads `providerId` through every
relevant method.

For `mcpRegistration === 'project-json'` providers, the adapter's
`projectMcpPath()` selects the JSON file for surgical merge: Claude uses
`.mcp.json`, Kimi uses `.kimi-code/mcp.json`, and Gemini uses
`.gemini/settings.json`. Never assume a CLI reads Claude's root `.mcp.json`.
Gemini is the proof it isn't universal: gemini-cli has
never read `.mcp.json` — its only MCP surface is `mcpServers` in
`settings.json` (user scope `~/.gemini/`, project scope
`<cwd>/.gemini/`), and an untrusted cwd suppresses MCP entirely (headless
runs exit 55 with `FatalUntrustedWorkspaceError`; the app injects
`GEMINI_CLI_TRUST_WORKSPACE=true` per spawn). The desktop agent chat
registers its MCP for gemini via `<agent-cwd>/.gemini/settings.json` +
that trust env (`prepareAgentMcp` in `server/agent-mcp-config.ts`);
Full facts are in
[gemini-mcp-registration.md](gemini-mcp-registration.md). If your provider has
its own config surface, implement `projectMcpPath()` and mirror the relevant
`prepareAgentMcp` branch rather than assuming `.mcp.json` is enough.

### 6. (If the binary needs a spawn-env quirk) add it to cli-prompt.ts

Per-binary spawn quirks live in `server/util/cli-prompt.ts` — the spawn layer
already special-cases `spawnClaude` / `spawnCodex` / `spawnGemini` / `spawnKimi`, dispatched
by binary name. Gemini needed `GEMINI_CLI_TRUST_WORKSPACE=true` injected into
every spawn (its "trusted folders" gate otherwise silently disables `--yolo`
and blocks headless tool calls). If your CLI has an equivalent env that
non-interactive spawns require, add a `spawn<Provider>` helper there. Most
providers need nothing here.

### CLI version floor vs. specrails-core package floor

Two distinct version concepts — don't conflate them:

- **`minCliVersion`** is the **binary** floor surfaced by `detectInstalled`
  (Claude = `null` / none pinned, Codex = `0.128.0`, Gemini = `0.11.0`,
  Kimi = `0.27.0`). It
  guards stream-format / flag availability for that one CLI.
- **`specrails-core@^4.12.0`** (`CORE_PACKAGE_SPEC`, `server/core-package.ts`) is
  the single shared package floor the app installs/probes for **all** providers.
  It matters when your provider's **rails** rely on core-side scaffolding: core
  must emit the provider's command/agent/skill tree (e.g. Gemini needed core
  `4.8.0` to ship the `.gemini/` commands + `sr-*` agents, while Kimi requires
  4.12.0 for `.kimi-code/`). The desktop adapter
  alone covers spec / explore / quick; rails need the matching core target.

## Known gotchas

- **Legacy result path.** `normaliseResultEvent(event, provider)`
  (`server/result-event.ts`) is still live for any callsite not yet
  migrated to `finaliseInvocationResult`. It only special-cases
  `provider === 'claude'`; everything else falls into the non-claude
  (codex-shaped) branch. A new provider hitting that path would be
  silently parsed as codex — migrate the callsite or extend the branch.
- **Rail command translation is provider-specific.** Implement
  `formatCoreCommand()` on the adapter. Codex maps `/specrails:<name>` to a
  `$<name>` skill; Claude passes its native slash command unchanged. Kimi is
  different in headless mode: its TUI/ACP intercept `/skill:<name>`, but
  `kimi -p` does not. Its hook therefore loads the installed
  `.kimi-code/skills/<name>/SKILL.md`, expands arguments, and returns the
  materialized activation prompt. Always pass the execution artifact `cwd` to
  this hook and fail before spawn when the skill cannot be resolved.

## Drop a fixture set

Add a JSONL capture of a real `<binary> exec --json` (or whatever your
CLI's JSONL flag is) under
`server/providers/__fixtures__/<id>/<minCliVersion>/`. The adapter's
test suite consumes these so future CLI-version bumps surface schema
drift loudly instead of silently.

## Write the tests

Mirror the test layout under `server/providers/<id>-adapter.test.ts`.
Required coverage:

- Identity: id / binary / projectDirName / instructionsFilename /
  mcpRegistration / capability flags / model catalog.
- `buildArgs` for every `SpawnAction` the manager flow uses:
  `chat-turn`, `chat-resume`, `rail-job`, `spec-gen`, `agent-refine`,
  `setup-enrich`, `setup-enrich-resume`, `auto-title`, and `chat-stream`
  (the persistent-stdin / interactive-job action — test either the argv
  you emit or the defensive `throw`, like Gemini does, if your CLI has no
  persistent-stdin transport).
- `parseStreamLine` per event type, including an "unknown type maps
  to kind: 'other'" defensive test and a "returns null on empty input
  and on unparseable JSON" test.
- `extractResult` from a fixture-derived event sequence.
- `detectInstalled` happy / missing / non-zero-exit paths.

## Verify

```bash
npm run typecheck
npx vitest run server/providers server/pricing server/result-event server/plugin-manager
```

`npm run typecheck` runs `tsc --noEmit` for both the server and the
client — run both halves, because a provider touches types each side
imports (`ProviderId`, the model catalog) and a mistake can surface only
on the side you didn't check.

Then a manual smoke test: register a project via the UI with the new
provider, run a chat turn, run a rail, confirm tokens + cost land on
the AnalyticsPage.

## Don't break the principle

Most of the old debt is **paid off** — and Gemini's addition is what paid it:

- ✅ The `'claude' | 'codex'` type unions are gone (`ProviderId = string`).
- ✅ The two hardcoded provider lists are gone (`/available-providers` and
  `AddProjectDialog` are registry-driven with fallbacks).

The genuine id-keyed sites that **remain** are:

- **`normaliseResultEvent` legacy branch** (`server/result-event.ts`) — the
  pre-`finaliseInvocationResult` path that special-cases `provider === 'claude'`.
- **Codex rail slash-command rewrite** (`server/queue-manager.ts`) —
  `adapter.id === 'codex'`.

Plus a few cosmetic per-id sites that are *expected* edits, not drift: the
provider beta-gate env checks (`server/desktop-router.ts`), the install-hint
`switch` (`server/setup-prerequisites.ts`), the `PROVIDER_ORDER` / `PROVIDER_META`
chip, and the duplicated model catalog (`server/spec-models.ts`).

The long-term goal is to delete the two remaining branches so adding a fourth
provider really is just the adapter file plus the registry entry. If you find a
**new** hardcoded `if (provider === 'X')` site in a manager that this guide
doesn't list, **the architecture has drifted further** — file an OpenSpec
change at `openspec/changes/<your-change-name>/` and capture the drift before
papering over it with another manager-level branch.

## See also

- [`docs/codex.md`](../codex.md) and [`docs/gemini.md`](../gemini.md) — the
  user-facing guides for the two non-Claude providers; `gemini.md` is the most
  recent worked example end-to-end.
