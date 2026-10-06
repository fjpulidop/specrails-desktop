## Why

The Implement loop fails as `correction-stalled` when host verification breaks on the environment rather than on the change. On 2026-10-06 the `pixel-depths` ticket 1 run lost a correction round and $0.82 because `npm run test:e2e` needed a Playwright browser build that was not cached; the fixer correctly refused to touch the environment, edited nothing and the hash-progress check ended the run with a long prose reason. The paired Core change `engine-environment-repair-and-host-blockers` gives the engine v2 `verify` piece host-owned environment repair, an opt-in `blocked` outcome with a structured blocker, optional `setup` commands and a structured fixer `blocker`. Desktop must consume those contracts so the loop repairs what it can, stops early with an actionable message when it cannot, and lets the user configure setup commands.

## What Changes

- The Implement recipe opts into host blockers on both `verify` nodes (`hostBlockers: true`, `setup: 'configured'`) and routes `blocked` to a new `host-blocked` end node whose reason renders the structured blocker's required action. The fixer structured output accepts an optional `blocker`; a new `correction-blocker` condition routes a fixer-declared blocker to `host-blocked` instead of `correction-stalled`, so an unchanged candidate with a declared host blocker is no longer reported as a stalled correction.
- Loop role defaults (`loop-agent-defaults.json`) gain the same developer and fixer rules Core adds for builtin roles: no temporary verification bypasses, install a missing documented tool or report it, return the structured `blocker`, admit documented idempotent toolchain installs, keep the configuration prohibition.
- Project runtime settings gain a `setup` list with the same editor as verification checks (repository, command, label, reorder, remove) in the Agent Runtime settings section, persisted in `.specrails/agent-runtime.json`, validated with the vendored Core schema and forwarded to Core only when the installed Core advertises the capability.
- The loop log completion summary renders a host blocker as a distinct state ("Blocked by the host environment") with the kind, the failing command and cwd, the required action and a copy button for the suggested command; the run row and job status show "blocked" rather than "failed". Environment repair progress lines (`[environment] …`) render with the verification styling.
- All eight locales and the configuration and loop documentation are updated.

## Capabilities

### New Capabilities
- `implement-host-blockers`: recipe routing of verification and fixer blockers to a dedicated terminal state, the fixer schema extension and the completion/UI rendering of a structured blocker.
- `runtime-setup-settings`: the `setup` command list in project runtime settings, its editor, persistence, validation and Core capability gating.
- `loop-role-environment-rules`: developer and fixer default prompt rules about environment blockers, documented toolchain installs and temporary verification bypasses.

### Modified Capabilities
- (none; existing requirement texts are unchanged, behavior is additive)

## Impact

- `server/modules/loops/runtime/loop-implement-recipe.ts`, `loop-agent-defaults.json`, `loop-graph.ts` (verify params and outcomes catalog), `server/modules/agent-runtime/runtime/agent-runtime-settings.ts` (vendored schema, `setup`), `agent-runtime-bridge.ts` (capability gate, blocker passthrough), `client/src/features/settings/components/AgentRuntimeSettingsSection.tsx`, `client/src/features/loops/components/loop-log/*` (completion model and summary), eight locale bundles (`agentRuntime.json`, `loops.json`, `jobs.json`), `docs/internals/configuration.md`, loops module README.
- Depends on the paired Core change; Desktop checks `capabilities.hostBlockers` / `capabilities.setupCommands` (or the vendored schema version) before sending `setup` and before compiling `hostBlockers` into the definition, so older Core installations keep working.
