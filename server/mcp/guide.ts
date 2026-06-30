// The platform guide returned by the `specrails_guide` meta tool and the
// `specrails://guide` resource. This is what lets an external LLM "understand
// the platform" without prior knowledge. It is intentionally English (the LLM
// consumes it); human-facing onboarding docs are localized separately.
//
// Keep this BYTE-STABLE where possible (no timestamps / live data) so MCP
// clients that cache resources stay valid.

export const SPECRAILS_GUIDE = `# Specrails Desktop — Agent Guide

You are operating Specrails Desktop through its MCP server. Specrails is a local
dashboard + pipeline runner that manages multiple software projects and drives AI
coding agents (Claude Code, Codex, Gemini) to implement specs.

## Core concepts

- **Project**: a registered repository. Almost every tool is project-scoped and
  takes a \`projectId\`. Use \`specrails_select_project\` to set an active project so
  you can omit \`projectId\` on later calls; pass an explicit \`projectId\` to override.
- **Spec / ticket**: a unit of work in a project's backlog. Statuses: \`draft\`,
  \`todo\`, \`in_progress\`, \`done\`, \`cancelled\`. Priorities: \`critical\`, \`high\`,
  \`medium\`, \`low\`. INVARIANT: priority may be null ONLY when status is \`draft\`.
- **Rail**: a launch slot that runs the AI pipeline over one or more assigned
  tickets. Modes: \`implement\`, \`batch-implement\`, \`ultracode\`, \`loop\`. Launching a
  rail spawns AI CLI processes that write code, run tests and commit — it costs
  money and runs for minutes.
- **Job**: one spawned pipeline run. Jobs stream logs/events over the WebSocket
  and settle (completed/failed/canceled). Cost is authoritative for Claude and
  estimated for Codex/Gemini.
- **Profile**: a per-project agent configuration (which agents, which models,
  routing). Profiles are CLAUDE-ONLY; they are ignored for Codex/Gemini rails.
- **Provider / engine**: claude, codex, or gemini. A project installs one or
  more. A requested provider must be one of the project's installed providers.
- **Loop**: a saved, app-driven workflow graph runnable on a rail in \`loop\` mode.
- **Plugin**: an MCP-based integration installed per project (e.g. serena).

## Async results (IMPORTANT)

Cost-incurring / streaming actions (launch a rail, generate a spec, send a chat
turn, refine an agent, SMASH) return immediately with a reference (jobId /
requestId) and emit their REAL result over the WebSocket bus. To get the actual
outcome, call \`specrails_watch\` with the returned reference; it waits for the
operation to settle and returns the final result. Do not assume success from the
acceptance alone.

## Permission tiers

The server enforces four opt-in tiers, configured by the user in Settings ▸ MCP:
- **Read** (always on): queries + resources.
- **Write**: create/edit specs, settings, rail config.
- **AI-spawn**: actions that spawn an AI CLI and cost money.
- **Destructive**: delete data, kill processes, mutate external systems.

If a tool is refused, the error names the tier the user must enable. Relay that
to the user rather than retrying blindly.

## Claude-only features

Agent profiles, Contract Refine, and SMASH are Claude-only. They are unavailable
(and rejected) on projects whose selected provider is Codex or Gemini.

## Typical workflow

1. \`specrails_projects(list)\` → pick a project; \`specrails_select_project\`.
2. \`specrails_specs(list)\` → inspect the backlog. To ADD a spec from a user
   request, use \`specrails_specs(action:'create')\` — it routes through **Quick
   Add Spec**: the specrails agent generates a structured spec with AI from the
   request, exactly like the app's "Add Spec" button (so MCP-created specs are
   indistinguishable from UI-created ones). It is async — watch the returned ref
   with \`specrails_watch\`. Use \`from_prompt\` only to store a finished spec verbatim.
3. \`specrails_rails(set_tickets)\` then \`specrails_rails(launch)\` → run the pipeline;
   \`specrails_watch\` the returned jobId.
4. \`specrails_analytics(spending)\` → review cost.

## Resources

Read-only state is also exposed as MCP resources: \`specrails://projects\`,
\`specrails://projects/{id}/tickets\`, \`specrails://projects/{id}/rails\`,
\`specrails://projects/{id}/analytics\`, and \`specrails://guide\` (this document).
`
