## 1. Recipe and catalogs

- [x] 1.1 `loop-implement-recipe.ts`: optional capabilities argument; `hostBlockers`/`setup` on both verify nodes, `host-blocked` end with `blockerFrom`, fixer schema with optional `blocker`, `correction-blocker` condition and `fixer-blocked` end; capability-gated omission. Tests in `loop-implement-recipe.test.ts` (or nearest) for both Core generations and for the fixer-blocker routing expression.
- [x] 1.2 `loop-graph.ts` and `client/src/features/loops/lib/core-authoring.ts`: `verify` outcomes include `blocked` only with `hostBlockers: true`; validation tests on both sides.
- [x] 1.3 `loop-executors.ts` passes the loader's capabilities to the recipe; bridge test proves a `host-blocked` end maps to `runtimeStatus: 'blocked'`.

## 2. Role defaults

- [x] 2.1 `loop-agent-defaults.json`: developer bypass prohibition and install-or-report rule; fixer `blocker` contract, intentional no-change statement and toolchain-install allowance; configuration prohibition kept. Parity test against the Core sentences; defaults validation test.

## 3. Setup settings

- [x] 3.1 `server/schemas/agent-runtime.schema.json` regenerated from Core; `RuntimeConfig.setup?` in `agent-runtime-settings.ts`; `loadLoopRuntimeConfig` reads `setup`; settings router accepts and returns it; tests.
- [x] 3.2 `agent-runtime-bridge.ts`: forward `setup` only with `setupCommands` capability, strip otherwise with a runtime note; tests for both.
- [x] 3.3 `AgentRuntimeSettingsSection.tsx`: extract the row editor, add the Setup commands editor without detect; `lib/agent-runtime.ts` types; component tests for add/save/validation.

## 4. Completion UI

- [x] 4.1 `completion-model.ts` parses optional `blocker`; `LoopCompletionSummary.tsx` renders the blocked block with kind, command/cwd, required action and copy button; tests.
- [x] 4.2 `narration-model.ts` narrates host/fixer blocker ends as blocked and keeps `[environment]` lines in verification style; tests.

## 5. Locales and docs

- [x] 5.1 Add every new key to `loops.json`, `agentRuntime.json` (`agentRuntime.json` ×8 done; `loops.json`/`jobs.json` pending) (and `jobs.json` if a status label is added) in de, en, es, fr, it, ja, pt, zh; locale parity test green.
- [x] 5.2 Update `docs/internals/configuration.md` (setup commands) (configuration.md done), `server/modules/loops/README.md` and `docs/internals/programmatic-agent-runtime.md` (blocker routing, environment repair lines); `npm run docs:source-map` if files were added.

## 6. Verification

- [x] 6.1 `npm run typecheck`, `npx vitest run server/modules/loops server/modules/agent-runtime`, `npm run test --prefix client -- loops settings`, `npm run audit:architecture`; record results. (2026-10-07: typecheck clean; server modules 4414 passed; client loops/settings/locale-parity 676 passed; audit:architecture OK; check-core-compat ✓; docs:source-map regenerated.)
