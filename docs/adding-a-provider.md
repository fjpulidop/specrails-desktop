# Adding a provider

Specrails drives every AI CLI through one contract: the **`ProviderAdapter`**
(`server/providers/types.ts`). Managers (chat, queue, agent-refine, setup,
result-event, project-router) consume the adapter exclusively — they branch on
`adapter.capabilities.*`, **never** on `provider === 'x'`. So a new provider is, in
the ideal case, *one adapter file + one registry line*. In practice you also fill a
few non-adapter seams (pricing, labels, install) that are inherently
provider-specific. This guide walks the real example: **Gemini CLI**.

## 1. Write the adapter (the one required file)

`server/providers/<id>-adapter.ts`, exporting a `ProviderAdapter`. Mirror
`codex-adapter.ts` (the reference non-native provider). You implement:

| Member | What it is |
|---|---|
| `id` / `displayName` / `binary` | the provider id, UI name, and PATH binary |
| `minCliVersion` | floor version for `detectInstalled` |
| `projectDirName` / `instructionsFilename` / `mcpRegistration` | filesystem conventions (e.g. `.gemini` / `GEMINI.md` / `project-json`) |
| `capabilities` | `nativeResume`, `nativeStreamJson`, `nativeCostUsd`, `nativeOtelEnv`, `profileEnvSupport`, `systemPromptArg`, optional `persistentStdin` — managers gate on these |
| `modelCatalog()` / `defaultModel()` | UI dropdowns + profile validation |
| `buildArgs(action, opts)` | argv per `SpawnAction` (`chat-turn`, `chat-resume`, `rail-job`, `spec-gen`, …) |
| `parseStreamLine(line)` | one NDJSON line → an `AdapterEvent` (`text-delta` / `tool-use` / `session-started` / `result` / `other`) |
| `extractResult(events)` | accumulated events → `NormalisedResult` (tokens, session id, optional cost) |
| `baselineAgents()` / `detectInstalled()` | rail agent names; a ≤3s health probe |

Two rules that bite:
- **`systemPromptArg: false`** ⇒ the CLI has no `--system-prompt` flag, so fold the
  system prompt into the user prompt — **except** Explore turns, which must stay
  user-text-only (a long system prompt drowns a short Explore message); they rely on
  the app-managed instructions file in the explore cwd instead.
- **`nativeCostUsd: false`** ⇒ add a rate card (step 3); `extractResult` leaves
  `total_cost_usd` undefined and the framework estimates it. If your token usage
  reports `cached` as a **subset** of input (it usually does), map it to
  `tokens_cache_read` — `pricing.ts` already bills `tokens_in - tokens_cache_read`
  at the input rate and the cached portion at the cache rate.

## 2. Register it (the one required line)

`server/providers/index.ts`:

```ts
import { geminiAdapter } from './gemini-adapter'
register(geminiAdapter)
export { /* … */ geminiAdapter }
```

That's enough for `getAdapter('gemini')`, `detectAvailableCLIs()`, the spec model
catalog, and provider-selection to all see it (they're registry-driven).

## 3. Pricing (only if `nativeCostUsd: false`)

Add `<id>:<model>` rows to `PRICING` in `server/pricing.ts` (USD per 1M tokens, with
a `lastReviewedAt`). A model without a row persists cost = NULL (fail-soft).

## 4. Spawn quirks (only if the binary needs them)

Per-binary spawn quirks live in `server/util/cli-prompt.ts` (the spawn layer that
already special-cases `spawnClaude`/`spawnCodex`). Gemini needed
`GEMINI_CLI_TRUST_WORKSPACE=true` injected (its "trusted folders" gate otherwise
silently disables `--yolo`); see `spawnGemini`.

## 5. Beta gate (optional, recommended for a new/unverified provider)

If the CLI's stream schema isn't yet validated against a live binary, gate selection
behind `SPECRAILS_<ID>_BETA` in `server/desktop-router.ts` (mirror
`isGeminiBetaEnabled` / `isCodexBetaDisabled`): omit/false the provider in
`GET /available-providers` and reject it in `POST /projects` until the flag is set.

## 6. The non-adapter seams (provider-specific by nature)

These don't fit the adapter and need a small explicit touch:

- **Install** (`specrails-core`, separate repo): a provider whose *rails* must run
  needs core to emit its command/agent/skill tree (e.g. `.gemini/commands/*.toml`,
  `.gemini/agents/sr-*.md`). The desktop adapter alone covers spec/explore/quick.
- **UI labels/accents**: `client/.../Navbar.tsx`, `analytics/ProviderBreakdownCard.tsx`
  (label + accent), and `AddProjectDialog`'s `PROVIDER_META` (icon + label). These
  use `Record<string,string>` lookups with graceful fallbacks, so they degrade to
  the raw id if you forget — add the entry for a polished chip.
- **Legacy non-adapter handlers**: a few endpoints predate the adapter and branch on
  `provider === 'codex' / 'claude'` (e.g. the ticket AI-edit handler in
  `project-router-tickets.ts`). Keep claude/codex byte-identical and route the
  `else` through `getAdapter(provider)` so every other provider works generically.

## 7. Tests + coverage (mandatory)

- `server/providers/<id>-adapter.test.ts` mirroring `codex-adapter.test.ts`:
  identity, capabilities, every `buildArgs` action, `parseStreamLine` (use NDJSON
  fixtures under `__fixtures__/<id>/<version>/`), `extractResult`, `detectInstalled`.
- Pricing rows, provider-selection, and any beta-gate behaviour.
- CI thresholds are hard gates (80% server / 80% client) — see CLAUDE.md.

## Checklist

- [ ] `server/providers/<id>-adapter.ts`
- [ ] `register(<id>Adapter)` in `index.ts`
- [ ] pricing rows (if not native cost)
- [ ] spawn quirk in `cli-prompt.ts` (if any)
- [ ] `SPECRAILS_<ID>_BETA` gate (if unverified)
- [ ] UI labels (Navbar, ProviderBreakdownCard, AddProjectDialog meta)
- [ ] adapter tests + fixtures, coverage green
- [ ] `docs/<id>.md`
- [ ] (rails) core emits the provider's command/agent tree

See `server/providers/gemini-adapter.ts` and `docs/gemini.md` for the worked example.
