## Why

In Mission mode the only object that represents an implementation run is the PR-decision card, which exists only when worktree isolation produced a `rail_pr_deliveries` row (git repo with commits), hides the failure reason on terminal states, offers no resume/recover action, and never wakes the agent. Assigning specs to a rail by dictating rail/engine/profile/loop in prose is awkward, so users fall back to Board mode for launch, for failure diagnosis and for recovery — the very gap Mission mode was meant to close.

## What Changes

- **Rail launch card** (agent-emitted): the operator agent proposes a launch as a fenced `rail-launch` JSON block that renders as an editable card pre-filled with its recommendation — target rail (existing or **new rail** created from the card), specs, engine, model, reasoning effort, profile, loop/mode, target PR, base branch, rail name. A **Play** action launches from the client (user action, tagged with the mission's origin), and the proposal is persisted as taken on the message row so it never re-renders editable.
- **One card lifecycle**: proposal → launched → running (live phase/step, log, stop) → settled (failure reason + resume/recover/relaunch/discard, or the existing PR-decision phase). The run card is keyed on the launch's run ids, so it **exists without git** (shared-cwd launches) and degrades to "no delivery phase" instead of vanishing.
- **Failure trigger job → card → agent**: terminal failures/stalls/provider limits/stuck detection update the card's state in place AND post a bounded system row into the origin mission, then start ONE automatic agent turn with a fixed briefing (read state, explain, offer recovery through the card). No chaining.
- **Agent eyes + hands**: runtime controls (`/agent-runtime/runs`, evidence, resume, recover, approve, settle, dismiss) exposed through MCP; `specrails_rails` returns rail free/busy state for prefill; rails become a referenceable entity (`@rail-N`) in the composer palette.
- **Operator prompt**: "propose = emit a card; launch directly only on an explicit 'launch now'".
- **Card honesty fixes**: `discarded`/`implementation_failed` render `statusDetail` and per-unit failure codes as text, not hover-only.
- **UX bar**: same visual language as the existing mission cards (glass card, status pills, `#` chips, `motion` transitions, pinned dock), all copy in the 8 locales. No new workspace pane (the Board pane idea is dropped in favour of this card).

## Capabilities

### New Capabilities
- `mission-rail-cards`: agent-proposed, user-configurable rail launch cards with a full run lifecycle inside a mission, including the failure trigger into the conversation.

### Modified Capabilities
- `desktop-agent-chat`: card protocol (`rail-launch` fence, persisted launch intent), automatic bounded failure turn, rail entity in the context palette.
- `desktop-mcp-tools`: runtime-run controls and rail availability exposed to the agent.
- `safe-pr-workflow`: PR-decision card becomes the delivery phase of the run card; terminal states show failure detail.
- `agent-chat-context-palette`: `@rail-N` references.

## Impact

Client: `client/src/components/agent-chat/` (new `AgentRailLaunchCard`, run-card state machine, `AgentMessage` fence extraction, pinned dock, palette), rail selectors reused from the rail header. Server: `agent-operator-prompt.ts`, `agent-chat-manager.ts` (system row + auto-turn), `rails-router.ts` (origin link on the shared-cwd path, `202` payload), `agent-store.ts`/desktop-db migration (message intent), `server/mcp/tools/` (runtime controls, rails list), settle chokepoints (`rail-isolated-launch.ts`, `project-registry.ts` `onLoopRunFinished`/`onJobFinished`) for the failure trigger. i18n `agent` namespace ×8. No specrails-core change. Kill switches for the auto-turn and the card protocol keep the legacy behaviour byte-identical.
