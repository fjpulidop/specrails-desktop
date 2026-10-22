## Context

Core's `RuntimeConfig.agents.{architect,developer,reviewer}` already carries `{ provider, model?, effort? }` per role and the desktop's runtime settings section edits it. `resolveEffectiveRuntimeConfig` applies a launch-time `providerOverride` to every role — that is the flattening. The loop engine (`LoopRunManager`) receives one `provider/model/effort` for the whole run and the rail header owns them ("lo que pongamos en el rail manda").

## Goals / Non-Goals

- Goals: let a rail run with the per-role runtime config intact; give the loop's own AI steps (verifier, decider) their own engines; keep every existing launch byte-identical.
- Non-Goals: per-node engines in custom loops (a node may later declare `role`), per-role Contract Refine / Explore engines, changing Core.

## Decisions

- **Sentinel over a new column.** `aiEngine = 'roles'` reuses the rail's `ai_engine` column, the launch body and the MCP tool with no migration; only `validateRequestedProvider` call sites special-case it.
- **Loop roles live beside `agent-runtime.json`, not inside it.** Core's schema is `additionalProperties: false`; a desktop-only file avoids stripping logic and keeps Core untouched.
- **Verifier = the rail's engine for non-core steps.** The loop engine keeps ONE provider/model/effort per run; under roles that triple is the verifier's, so verify/fix/custom steps, accounting and the step titles need no new plumbing. Only the Decider gets a dedicated field because it is the one step where a different (cheaper) model is the obvious win.
- **Fail-open resolution.** A stored role whose provider is no longer detected falls back to the rail's primary path (log-visible via the step title), never a blocked launch — the same fail-open the global agent defaults use.
- **Freestyle rejected.** Freestyle hands the spec to one autonomous agent; there is no role to map, so `roles` + freestyle is a 400 instead of a silent guess.

## Risks / Trade-offs

- The relaunch guards keyed on the rail engine (`runtime_provider_mismatch`) now have a roles branch; covered by tests.
- Under loops-off legacy mode the CLI pipeline cannot honour per-role engines; the launch degrades to the primary and the UI chip explains roles apply to the runtime path.
