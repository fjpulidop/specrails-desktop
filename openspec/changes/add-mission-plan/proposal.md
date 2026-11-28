## Why

While a mission's agent works in Intent (explore), the person sees its messages and tool activity but not
the plan it set out to follow nor how far it got. Coding agents keep that plan (Claude Code's todo list);
Specrails should show it, in its own style, without the person reading the transcript.

## What Changes

- **Mission plan**: the agent's plan of work (steps, each pending / in progress / done) is kept per mission
  as a silent system row (`mission-plan`): persisted, live over the usual message events, a new row for new
  work so the history keeps each plan.
- **Two sources**: the agent's own todo list when its provider has one (Claude's `TodoWrite`, read from the
  turn's tool calls in Core sessions and native turns, no extra instruction or cost), and Specrails'
  `specrails_missions(plan)` for any provider (the Intent persona asks for it; one of the two, not both).
- **Plan pill**: beside Processes and Resources in the composer, a "Plan" pill with a progress ring and
  done/total appears once the mission has a plan; hover or focus shows the steps with their state, the step
  in progress and a per-step progress bar.
- **MCP**: in-app agents write it (`specrails_missions` action `plan`, read tier, own mission only, from the
  agent's capability); any client reads it (`specrails_missions get` field `plan`, `GET
  /api/agent/conversations/:id/plan`).

## Capabilities

### New Capabilities
- `mission-plan`: the agent's plan of work and its progress, shown in the mission and readable over MCP.

## Impact

- Server: `server/modules/missions/runtime/mission-plan.ts`; hooks in the Core session projector and the
  native turn stream; the plan route in the agent chat router; the Intent persona; MCP v1 `specrails_missions`
  (`plan`, alias to v2 `get` with `plan`) and v2 `specrails_missions get` (`plan` field).
- Client: `MissionPlanPill` in the composer; the plan row is silent in the transcript; strings in 8 locales.
