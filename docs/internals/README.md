# Internals

These docs are primarily for contributors and people building on the app's API. They mostly describe how the app works under the hood — though a couple (like the profiles quick start) double as practical how-tos.

If you're a user looking for **how do I do X?** docs, head back to the [user guides](../README.md).

## Contents

Start with [the modular architecture decision](modular-architecture.md),
[the source map](source-map.md) and [the shared contributor/AI guide](../../AGENTS.md).

| Doc | What it covers |
|-----|----------------|
| [architecture.md](architecture.md) | Server modules, client layout, WebSocket protocol, process spawning, security model |
| [source-architecture.md](source-architecture.md) | Persistence boundaries, queue collaborators and unused-source audit |
| [api-reference.md](api-reference.md) | REST endpoint catalogue under `/api/*` and `/api/projects/:projectId/*` |
| [configuration.md](configuration.md) | Settings, env vars, kill switches, advanced flags |
| [operations-runbook.md](operations-runbook.md) | Start/stop, port conflicts, recovery procedures, backups |
| [core-runtime-updates.md](core-runtime-updates.md) | Core runtime discovery, durable package updates, version reporting and recovery after partial workspace refresh |
| [mission-read-only-policy.md](mission-read-only-policy.md) | Read-only mission agents: per-provider native boundary that keeps MCP tools callable, Core session policy, kill switch, limitations and live evidence |
| [agent-sessions.md](agent-sessions.md) | Core resident agent sessions in Desktop: host per scope, runner seam, projection, rebuild, sub-agent UI and rollout flag |
| [flow-mode.md](flow-mode.md) | Flow mode server side: lifecycle and sagas, worktree hand-off to a rail, Flow turns with interrupt delivery, capability gating, routes and events |
| [spec-triage.md](spec-triage.md) | Spec triage: hashed deterministic inputs, the one cheap structured-output call, triggers, rail preselection and the recommended/chosen loop recorded per delivery |
| [existing-project-anchoring.md](existing-project-anchoring.md) | Existing-project anchoring (feedback-2026-10 phase 3 + rules inventory): ticket non-goals, architect clarifications on Jira, requirements demonstrated, baseline on touch, project rules; every surface gated on its Core capability |
| [programmatic-agent-runtime.md](programmatic-agent-runtime.md) | Paired Core build, per-role providers/local models, project settings, saved execution recovery and delivery boundaries |
| [programmatic-agent-runtime-validation.md](programmatic-agent-runtime-validation.md) | Paired implementation test results, packaging evidence and release limitations |
| [openspec-workflow.md](openspec-workflow.md) | `opsx:*` change lifecycle — used by the app itself for structured change management |
| [adding-a-provider.md](adding-a-provider.md) | How to add a new AI CLI: one adapter file plus one entry in the registry |
| [profiles.md](profiles.md) | Agent profiles quick start: open the Agents section, pick a profile per rail at launch, author custom agents in Agent Studio. For the true file-format and snapshotting internals, read `server/modules/agents/runtime/profile-manager.ts` and the profile-manager section of `CLAUDE.md` |
| [safe-pr-review-flow.md](safe-pr-review-flow.md) | The ask-first PR delivery: the `rail_pr_deliveries` row, decision state machine, the two synced decision surfaces (rail row + agent-chat card), the `on_review` ticket status and its Jira mapping |
| [agent-actions-audit.md](agent-actions-audit.md) | The per-project `agent_actions` log: producers (provider streams, Core events, missions, MCP wrapper, provenance), redaction, batched non-blocking writer, JSONL/CSV export, review-packet summary and retention |
| [interactive-jobs.md](interactive-jobs.md) | Interactive-by-default jobs: the persistent-stdin session model, `finalize` vs `auto` settle modes, loop-step turn routing, accounting reconciliation, kill-switch matrix |
| [loop-step-log-explorer.md](loop-step-log-explorer.md) | The step-grouped log surface for loop runs: the `loop_graph` / `loop_step` / `loop_step_end` event contract and seq guarantees, grouping + status model (interrupted rule, legacy fallback), follow mode, perf notes |
| [gemini-mcp-registration.md](gemini-mcp-registration.md) | How MCP servers actually reach gemini-cli (`.gemini/settings.json` + trust env, FQN tool prefix) and the deferred `.mcp.json` gap on non-agent-chat surfaces |
| [../../DESIGN.md](../../DESIGN.md) | The design system record (Signal box at night): colour, type, radius, elevation, motion and component tokens derived from the shipped code; `visual-design-audit.md` stays the conventions log |
| [modal-standard.md](modal-standard.md) | The client modal standard: Radix primitive, five sizes, sticky header/body/footer anatomy, button order, named z-index layers (`client/src/lib/layers.ts`), one scrim and entrance animation, workspace-only resizing, 12px type floor |
| [browser-capture-performance.md](browser-capture-performance.md) | Embedded-browser fluidity: the CDP screencast → WS → canvas pipeline, the latency levers (non-blocking navigation, input coalescing, latest-frame-wins drawing, frame conflation), tuning knobs, and the OAuth popup design |

**See also:** the app registers Claude Code, Codex CLI, Gemini CLI, and Kimi
Code as first-class engines. See [`../kimi.md`](../kimi.md),
[`../codex.md`](../codex.md), and [`../gemini.md`](../gemini.md). First-class
status is capability-aware: Kimi pure-output transforms fail closed.

## Contributing

For coding conventions, file naming, the coverage policy and WebSocket invariants, see [`AGENTS.md`](../../AGENTS.md). `CLAUDE.md` imports that shared guide; detailed history is kept in [optional reference notes](legacy-implementation-notes.md).

When adding a feature, follow the OpenSpec workflow: `/opsx:new → /opsx:ff → /opsx:apply → /opsx:verify → /opsx:archive`. The `/opsx:*` invocations resolve to command files under `.claude/commands/opsx/*.md` (the related skills under `.claude/skills/` are named `openspec-*`).
