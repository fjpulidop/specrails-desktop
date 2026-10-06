## Context

Desktop authors the Implement graph in `server/modules/loops/runtime/loop-implement-recipe.ts` and compiles it to a Core definition. Role prompts for the recipe's custom roles (`plan`, `build`, `assess`, `correct`) are inherited from Core (`INHERIT_ROLE_PROMPT`), so prompt rules are a Core concern. Project runtime configuration is validated with the vendored Core schema (`server/schemas/agent-runtime.schema.json`, parity-tested) and sent to Core; Core advertises capabilities through `runtime-api` (`cli.ts`), which Desktop reads in `agent-runtime-loader.ts` and gates features such as `configurableGuardrails`. The loop log renders the durable completion through `completion-model.ts` and `LoopCompletionSummary.tsx`; the bridge maps a failed acceptance to `runtimeStatus: 'blocked'`.

The paired Core change adds: `verify` params `hostBlockers` and `setup`, the opt-in `blocked` outcome, `output.blocker` and `completion.blocker` (`HostBlocker`), `RuntimeConfig.setup`, the `end` param `blockerFrom`, `[environment]` progress lines and the fixer `blocker` output field. Core advertises `hostBlockers: 1` and `setupCommands: 1` in `capabilities`.

## Goals / Non-Goals

Goals: consume every new Core contract in the Implement recipe, settings, UI and docs; keep older Core installations working; keep the run isolation, route precedence and WebSocket contracts untouched.

Non-Goals: changing the generic loop builder's verify node UI beyond exposing the new params in the piece catalog; snapshot reuse of setup commands; Codex sandbox network changes.

## Decisions

### D1. Recipe routing

- Both `verify` nodes get `{ commands: 'configured', additionalCommandsFrom: 'architect', setup: 'configured', hostBlockers: true }` and a `blocked` edge to a new `host-blocked` end node: `{ outcome: 'failure', blockerFrom: 'verify', reason: 'Host blocker ({{outputs.verify.blocker.kind}}): {{outputs.verify.blocker.reason}} Required action: {{outputs.verify.blocker.requiredAction}}' }`. `verify-archive` maps `blocked` to `host-blocked` too with `blockerFrom: 'verify-archive'`.
- The `implementation` structured schema for the fixer turn becomes `objectSchema({ summary, incomplete, blocker: objectSchema({ kind: { enum: [...] }, command, cwd, evidence, requiredAction }) }, ['summary', 'incomplete'])`; the developer keeps the two-field schema plus the same optional `blocker`.
- New condition `correction-blocker` between `fixer` and `correction-progress`: `exists($outputs.fixer.structured.blocker) && $outputs.fixer.structured.blocker != null` → `fixer-blocked` end node `{ outcome: 'failure', reason: 'Fixer reported a host blocker ({{outputs.fixer.structured.blocker.kind}}): {{outputs.fixer.structured.blocker.requiredAction}} Evidence: {{outputs.fixer.structured.blocker.evidence}}' , blockerFrom: 'fixer' }`; `false` → `correction-progress`. Core's `end` piece reads `output.structured.blocker` as a fallback when `output.blocker` is absent (Core task 3.2 covers both shapes).
- When the installed Core lacks `hostBlockers`, `configurableImplementGraph(capabilities)` omits `hostBlockers`/`setup`/`blockerFrom` and the `blocked` edges, and `correction-blocker` still routes a fixer blocker to `fixer-blocked`. The recipe function takes an optional capabilities argument resolved by the caller (`loop-executors.ts`) from the loader.
- `loop-graph.ts` piece catalog: `verify` outcomes include `blocked` when `params.hostBlockers === true` (mirror Core's `getOutcomes`); the client `core-authoring.ts` does the same so the builder validates edges consistently.

### D2. Role defaults

Superseded: Desktop loops inherit Core role definitions, so the developer and fixer rules ship with the paired Core change and its `prompts.test.ts`. No Desktop prompt file or parity test exists.

### D3. Setup settings

- `RuntimeConfig.setup?` added to `agent-runtime-settings.ts` and the vendored schema regenerated from Core (parity test). `validateLoopRuntimeSettings` keeps excluding it from loop agent settings (it is a project check list like `verification`). `loadLoopRuntimeConfig` reads `saved.setup ?? []` next to `verification`.
- Bridge: `setup` is forwarded only when `capabilities.setupCommands >= 1`; otherwise stripped with a one-line runtime log note so older Core validation does not reject the configuration.
- Settings router: `PUT /agent-runtime` accepts `setup`; response `config.setup` always an array.
- UI: `AgentRuntimeSettingsSection.tsx` renders a second `CommandListEditor` (extracted from the existing verification rows) titled "Setup commands" with hint "Idempotent commands Core runs before every verification, in the repository checkout (for example `npx playwright install chromium`)". No auto-detect button for setup. Same validation of the command line as verification rows.

### D4. Completion rendering

- `completion-model.ts`: `completion.blocker?: { kind, reason, command, args, cwd, requiredAction }` parsed leniently (absent on old runs).
- `LoopCompletionSummary.tsx`: when `blocker` exists render a highlighted block: title `loops:core.hostBlocked` ("Blocked by the host environment"), kind label (`loops:core.blockerKind.<kind>`), the command with cwd in a mono line, the required action, and a copy button for `command args` (reuse the app's copy utility). Acceptance line reads `status('blocked')`.
- `narration-model.ts`: `workflow_failed` whose reasons start with "Host blocker" or "Fixer reported a host blocker" narrate as a blocked outcome, not a failure; `[environment]` lines from the verification channel keep the verification style.
- Runs list and job status: the loop run row shows the existing blocked badge (already driven by `runtimeStatus`); confirm with a test that a `host-blocked` end produces `runtimeStatus: 'blocked'` through the bridge.

### D5. Locales and docs

Keys in `loops.json` (`core.hostBlocked`, `core.blockerKind.*`, `core.requiredAction`, `core.copyCommand`) and `agentRuntime.json` (`setup.title`, `setup.hint`, `setup.add`, `setup.invalidLine`, `setup.saved`) in de, en, es, fr, it, ja, pt, zh. `docs/internals/configuration.md` Project settings section documents `setup`; `server/modules/loops/README.md` and `docs/internals/programmatic-agent-runtime.md` document the blocker routing and the `[environment]` repair lines.

## Risks / Trade-offs

- Capability gating duplicates a little recipe logic; a single `withHostBlockers(capabilities)` helper keeps it in one place.
- Fixer-declared blockers end the run without a hash check; a fixer that misclassifies a code defect as a blocker stops early. Acceptable: the blocker text is shown verbatim and the user can relaunch; the prompt requires evidence.

## Migration Plan

Additive. Existing `agent-runtime.json` files without `setup` validate unchanged. Older Core: no `setup` sent, no `blocked` edges compiled.

## Open Questions

None.
