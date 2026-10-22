## Why

Freestyle (prompt → verify → Loop Decider → fix) is provider-agnostic in Core,
but Desktop blocked it for Codex and Gemini with `capabilities.freestyle: false`.
The flag dated from the Kimi provider work (#563), which replaced a hard
`provider !== 'claude'` gate with a capability and enabled only the providers
that had been exercised. Codex and Gemini were never run, so they stayed off.
External feedback (2026-10, task 4.6) asked for Freestyle outside Claude if real
runs prove it works.

## What Changes

- Real end-to-end Freestyle runs on Codex and Gemini through Desktop's
  production loop executor, the real bridge and a built Core (evidence in
  `design.md`). A reusable opt-in live test reproduces them:
  `server/modules/loops/runtime/loop-factory-freestyle.live.test.ts`.
- **Fix found by the run:** Gemini CLI exits 55 in a folder that was never
  trusted interactively. Core-spawned Gemini inherited no trust, so every
  Core-run Gemini workflow in a fresh project or rail worktree failed at the
  first prompt. The bridge now passes `GEMINI_CLI_TRUST_WORKSPACE=true` to Core
  (an explicit host value wins), matching every other Desktop Gemini spawn.
- Codex and Gemini adapters advertise `freestyle: true`. The interactive variant
  (in-job chat + Finalize) still requires `persistentStdin`, so it stays
  Claude-only; Codex and Gemini Freestyle runs are non-interactive.
- The client `providerSupportsFreestyle` mirrors the server: every bundled CLI
  plus local engines.
- Docs: rails guide (8 locales), engine guide (8 locales), provider matrix,
  running pipelines, customizing, configuration, runtime internals, loops README.

## Capabilities

### New Capabilities

- `freestyle-provider-support`: which providers may run Freestyle, the evidence
  gate for enabling one, and the interactive/non-interactive split.

## Impact

- `server/providers/codex-adapter.ts`, `server/providers/gemini-adapter.ts`
- `server/modules/agent-runtime/runtime/agent-runtime-bridge.ts`
- `client/src/features/providers/lib/provider-capabilities.ts`
- Tests: rails-router, loop-command-catalog, agent-runtime-bridge, client
  provider-capabilities; new opt-in live test.
- No migration, no contract change with Core, no new dependency.
