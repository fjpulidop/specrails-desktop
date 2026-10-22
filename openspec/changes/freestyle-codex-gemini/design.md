## Context

`capabilities.freestyle` on a provider adapter gates four things:

1. `POST /rails/:i/launch` with `mode: 'freestyle'` (400 `Freestyle is not supported by provider '<id>'`).
2. `{{cmd:freestyle}}` in custom loops (`referencesUnsupportedProviderCommand`).
3. Listing the `factory:freestyle` built-in (`builtin-loops.ts`, any capable adapter).
4. QueueManager's loops-disabled path: `/specrails:freestyle #id` becomes the
   pre-prompt + spec prose (`_buildFreestylePrompt`) instead of a slash command.

With Loops on (the default) and Core `engineV2` + `workflowDefinitions`, the
Freestyle factory is a Core workflow definition (`coreFactoryGraph('freestyle')`):
`implement` (prompt, write) → `verify` (configured checks) → `decide` (Loop
Decider, read-only, structured verdict) → `fix` (prompt, write) → `verify` …
Core spawns the provider CLI for each prompt/decider step. The interactive
variant (in-job chat + Finalize) is a separate path that requires
`persistentStdin`, which only Claude advertises.

History: before #563 the gate was `engineCheck.provider !== 'claude'`. #563
(Kimi) turned it into a capability and enabled the providers that had been run
(Claude, Kimi, later local engines). Codex and Gemini were left `false` because
nobody had run them, not because of a known defect.

## Goals / Non-Goals

**Goals:** enable non-interactive Freestyle on Codex and Gemini only with
real-run evidence; keep the run reproducible; keep interactive Freestyle
Claude-only.

**Non-Goals:** interactive Freestyle on other providers (needs a Core session
input queue on those drivers); changing the Freestyle graph or Core.

## Evidence

Harness: `server/modules/loops/runtime/loop-factory-freestyle.live.test.ts`
(opt-in, `SPECRAILS_LIVE_FREESTYLE_PROVIDERS=codex,gemini`). It calls the
production `createLoopExecutors().runDefinition` with the `factory:freestyle`
graph resolved from the real Core capabilities, the real bridge and Core
(`specrails-core` main, 6.6.5), and the real provider CLIs. Task: a temp git
repo with a failing `sum.test.js`; spec "create `sum.js` exporting
`sum(a, b)`, add a negative-number test"; project verification `node --test`.
The test then re-runs `node --test` itself.

Run date 2026-10-22, codex-cli 0.160.1, gemini-cli 0.49.0, Node 25.9.0.

| Provider / model | Result | Steps (Core lifecycle) | Decider | Duration | Tokens in / out | Cost reported |
| --- | --- | --- | --- | --- | --- | --- |
| Codex `gpt-5.6-luna` (effort low) | succeeded, `completion { ok: true, verified: true }` | implement:ok → verify:pass → decide:**stop** → done | read-only; ran `node --test` and a `node -e` probe, then `stop` | 34 s | 103,647 / 1,233 | `null` (estimated) |
| Gemini `gemini-3.5-flash`, before fix | failed at `implement` | implement:failed (exit 55) → failed | not reached | 3 s | none | `null` |
| Gemini `gemini-3.5-flash`, after fix | succeeded, `completion { ok: true, verified: true }` | implement:ok → verify:pass → decide:**stop** → done | read-only (plan mode + admin policy); read both files, then `stop` | 36 s | 148,891 / 796 | `null` (estimated) |

In both successful runs the agent wrote `sum.js` and extended `sum.test.js`;
Core's verification ran `node --test` (2 tests, 0 failures); the host re-check
passed; the run settled `succeeded` with verified completion.

Gemini failure (verbatim cause): "Gemini CLI is not running in a trusted
directory. To proceed, either use `--skip-trust`, set the
`GEMINI_CLI_TRUST_WORKSPACE=true` environment variable, or trust this
directory". Desktop sets that variable for its own Gemini spawns (`cli-prompt`,
chat, MCP wiring, relocated rail jobs), but Core-spawned Gemini inherited only
the bridge environment. The same failure therefore affected every Core-run
Gemini workflow (Implement, Quick SDD) in a fresh project or rail worktree, not
only Freestyle.

Loops-disabled path (one-shot `rail-job` args, `_buildFreestylePrompt` prose,
temp repo with failing test): Codex exit 0, `sum.js` written, `node --test`
passes (88,329 in, of which 75,520 cached / 940 out); Gemini (with the trust
variable) exit 0, same outcome (55,578 in, 35,812 cached / 250 out). Both
parsed through the adapters' `parseStreamLine` / `extractResult`.

Accounting: Core returned `invocationUsage.costUsd = null` for both providers,
so the bridge result is `cost: undefined, estimated: true` with real token
counts. No cost was invented; Desktop's rate card stays the only estimate
source. Upper-bound spend for all smokes at rate-card prices without cache
discount: Codex ≈ $0.21, Gemini ≈ $0.32 (≈ $0.52 total). Billed amounts are
lower: in the one-shot runs 60–85% of input tokens were cache reads, which the
rate card prices at a tenth.

Not exercised live: the `fix` prompt and a decider `continue` verdict (no run
needed a correction). Both use the same prompt/decider drivers that the runs
did exercise; the routing is covered by the deterministic real-Core pairing
tests (`loop-factory-paired.test.ts`).

## Decisions

- **Enable both providers, non-interactive only.** Flip `freestyle: true` on the
  Codex and Gemini adapters. Interactive Freestyle keeps its separate
  `persistentStdin` gate (QueueManager and `planInteractiveAiStep`), so no extra
  flag is needed.
- **Trust Gemini at the Core boundary, in Desktop.** `coreProviderEnv` adds
  `GEMINI_CLI_TRUST_WORKSPACE=true` to the Core process environment unless the
  host set a value. Alternative: `--skip-trust` in Core's Gemini args. Rejected
  for this change because Desktop already owns the trust decision for every
  other Gemini spawn and the fix needs no Core release. A Core-side default can
  follow.
- **Client mirrors the server.** `providerSupportsFreestyle` returns true for
  every bundled CLI and for local engines; `roles` and unresolved providers stay
  false.

## Risks / Trade-offs

- Freestyle cost on Codex/Gemini shows as estimated (no native cost). This is
  the existing honest-accounting behaviour for those providers.
- Trusting the workspace lets Gemini load project `.gemini/settings.json`. This
  matches Desktop's existing Gemini spawns, which already trust the admitted
  workspace.
- Legacy loops-disabled Gemini jobs in a non-relocated project still get no
  trust variable (pre-existing QueueManager behaviour for all Gemini rail jobs).
  Relocated projects, the default, already set it.
