## Why

`core-agent-sessions-host` moved missions onto Core agent sessions. Every other multi-turn agent surface still drives providers through Desktop's own transports (`server/providers/*`, `spawn-lifecycle`, `claude-live-session`), so it keeps the problems the mission migration fixed:

- background sub-agents die when a turn ends;
- there is no sub-agent model or UI;
- usage is parsed per provider in Desktop;
- the "Allow sub-agents" setting, which the spec already applies to explore and refinements, has nothing to act on there.

Moving them onto the same runtime makes Core the single engine for conversational agent work, as decided for the program.

## What Changes

- Each surface runs its turns on Core sessions through the runner seam missions use (`createCoreSessionRunner`). Selection happens at composition, with the legacy transport as fallback when Core sessions are unavailable or `SPECRAILS_CORE_SESSIONS=off`. The surfaces are:
  - **Explore and project chat** (`server/modules/conversations/runtime/chat-manager.ts`), including its persistent explore turns;
  - **refinements**: agent refine (`agents/runtime/agent-refine-manager.ts`), contract refine (`specs/runtime/contract-refine-runner.ts`) and SMASH (`specs/runtime/smash-runner.ts`);
  - **project builder** blueprint chat (`builder/runtime/blueprint-chat-manager.ts`);
  - **interactive jobs** (`execution/runtime/interactive-job-session.ts`): the in-job chat and Finalize of interactive ultracode jobs.
- Each surface gets its own `ProjectionSink`, mapping the surface-neutral projection onto its tables. The generic reducer and pump in `agent-sessions` stay unchanged.
- Each surface resolves `policy.subagents` with `resolveSubagentPolicy` (`surface: 'explore' | 'refinement'`, and the mission rules for the builder). Implement pipelines stay excluded.
- Sub-agent presentation is reused from missions where a surface shows agent activity: the card, the activity drawer and stop.
- Accounting goes through `finaliseNormalisedResult`, with Core's per-turn usage and turn origin.

## Capabilities

### New Capabilities
- `conversational-surfaces-on-core`: which surfaces run on Core sessions, how each selects the transport, projects events, resolves the sub-agent policy and falls back to legacy transports.

### Modified Capabilities
- `subagent-policy-toggle`: explore and refinement sessions actually receive the resolved policy (today only missions do).

## Impact

- **Server**: the surface managers listed above, a projection sink per surface, composition in `server/index.ts` and project wiring.
- **Client**: sub-agent presentation in explore and refinement views, plus i18n in 8 locales.
- **Docs**: `docs/internals/agent-sessions.md`, the module READMEs and the user guide pages of each surface.
- **Dependency**: the released Core with `agent-session-runtime` (`sessions: 1`). Live verification covers Claude and Codex.
- **Sequencing**: after `core-agent-sessions-host` ships and `SPECRAILS_CORE_SESSIONS` defaults to `auto`. It precedes `core-runtime-one-shots`, which removes `server/providers/*`.
