# missions

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/AgentActivityChip.tsx](components/AgentActivityChip.tsx)
- [components/AgentBrowserCaptureHost.tsx](components/AgentBrowserCaptureHost.tsx)
- [components/AgentMessage.tsx](components/AgentMessage.tsx)
- [components/AgentModeSurface.tsx](components/AgentModeSurface.tsx)
- [components/AgentModelSelector.tsx](components/AgentModelSelector.tsx)
- [components/AgentPrDecisionPill.tsx](components/AgentPrDecisionPill.tsx)
- [components/AgentRailLaunchCard.tsx](components/AgentRailLaunchCard.tsx)
- [components/AgentRunStrip.tsx](components/AgentRunStrip.tsx)
- [components/AgentToolbarSelector.tsx](components/AgentToolbarSelector.tsx)
- [components/AgentWorkspaceSidebar.tsx](components/AgentWorkspaceSidebar.tsx)
- [components/MissionConversationMenu.tsx](components/MissionConversationMenu.tsx)
- [components/MissionModeBadge.tsx](components/MissionModeBadge.tsx)
- [components/MissionWindowAction.tsx](components/MissionWindowAction.tsx)
- [components/MissionWindowBindings.tsx](components/MissionWindowBindings.tsx)
- [components/MissionWindowSurface.tsx](components/MissionWindowSurface.tsx)
- [components/agent-run-failure.ts](components/agent-run-failure.ts)
- [context/AgentChatContext.tsx](context/AgentChatContext.tsx)
- [context/AgentWorkspaceContext.tsx](context/AgentWorkspaceContext.tsx)
- [context/MinimizedChatsContext.tsx](context/MinimizedChatsContext.tsx)
- [context/MissionExtensionsContext.tsx](context/MissionExtensionsContext.tsx)
- [context/MissionSessionsContext.tsx](context/MissionSessionsContext.tsx)
- [context/MissionSplitViewsContext.tsx](context/MissionSplitViewsContext.tsx)
- [context/MissionWindowsContext.tsx](context/MissionWindowsContext.tsx)
- [hooks/useAgentRefActions.ts](hooks/useAgentRefActions.ts)
- [lib/agent-api.ts](lib/agent-api.ts)
- [lib/agent-refs.ts](lib/agent-refs.ts)
- [lib/mission-search.ts](lib/mission-search.ts)
- [lib/mission-windows.ts](lib/mission-windows.ts)

## Feature dependencies

- [agents](../agents/README.md)
- [analytics](../analytics/README.md)
- [background](../background/README.md)
- [browser](../browser/README.md)
- [builder](../builder/README.md)
- [code](../code/README.md)
- [delivery](../delivery/README.md)
- [jobs](../jobs/README.md)
- [loops](../loops/README.md)
- [projects](../projects/README.md)
- [providers](../providers/README.md)
- [rails](../rails/README.md)
- [settings](../settings/README.md)
- [specs](../specs/README.md)
- [terminals](../terminals/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.

## Runs in a mission: one strip, a history of events

A mission shows its live runs in ONE place: the run strip above the composer
([`AgentRunStrip`](components/AgentRunStrip.tsx), model in
[`mission-run-strip.ts`](components/mission-run-strip.ts)). It shows one run at
a time — the most urgent (waiting for you › failed › running › paused) unless
the person holds another (picked in the switcher, panel open, or focus inside
the strip) — as a status mark (a shape per state, never color alone), the
current step in plain words, progress (several runs), elapsed time and billed
cost (`—` until billed, `*` when partial). A held strip is never swapped: a
run that starts needing the person meanwhile gets a "needs you" mark in the
switcher and a polite announcement. A primary action appears only when the
run needs the person and is DECLARED by the run's card through
[`run-primary.tsx`](components/run-primary.tsx) (`RunPrimaryButton` /
`useRunPrimary`: id, label, kind, handler — no DOM reading). A `local` action
(Resume, Back to Flow, Mark done) runs in one click in place; an `outward` one
(Create PR, Publish, Reopen, Approve, Launch, retry delivery, and Relaunch and
Recover because they spend money on a new run) is never fired from the strip:
it opens the panel with focus on the card's own control. Clicking the strip opens that card as a panel
anchored above the strip (not a modal: Esc or a click in the conversation
closes it, focus returns to the strip). The cards stay mounted while hidden and
report the run's step and vitals to the strip. The strip owns the mission's
ONE polite live region (the extension's `ConversationDock` speaks through its
`announce`). Its "+N" menu has roving focus (arrows, Home/End, Esc back to the
button); switcher entries carry their full name and state as accessible name
and tooltip; a partial cost's `*` is also said in words. Extensions add their runs
through `useLiveRuns` (Flow) and name steps through `describeRun`; a live run
can hear its panel close (`onPanelClose`: Esc, a click outside, the toggle or
another run — Flow's hand-off treats it as "Not yet"), and a run with a `mode`
keeps the mode's icon as its mark in every state, badged with the state's
shape. The switcher marks each run with the same per-state shape (never color
alone), and a strip with one run still shows its name. An extension run in a
`decision` or `failed` tone feeds the mission list's attention dot like a
delivery; calm states never do. An extension that provides `useRunAttention`
(Flow) derives that attention app-wide for every listed mission, so the dot is
live and clears with the mission closed, and the strip leaves those runs to
it; otherwise the strip reports them while mounted (`reportRunAttention`). Every run primary (the
strip's, the hand-off Launch, the card primary, Flow's Start) shares ONE
recipe, `PRIMARY_ACTION_SHAPE` / `PRIMARY_ACTION` in `run-primary.tsx`.

The history never repeats what is live: each milestone is one event line
([`AgentRunEventLine`](components/AgentRunEventLine.tsx)) in its chronological
slot — "Launched on Rail 1", "Rail 1 failed: …", "Back to Flow", "Entered /
Left Flow" — that opens the run. A settled Implement run keeps its card in the
history; a settled Flow → Spec run is an outcome line that expands its card
(the Flow's closing summary is the full card of that story). Extension modes
(Flow) are named on the composer (chip, accent line, placeholder) in the
mode's own color (`MissionModeBadge.accent`; Flow: `--color-accent-flow`),
on its agent turns (`useTurnMark`) and on the strip mark (`MissionLiveRun.mode`), next to the
mission title and on the mission list ([`MissionModeBadge`](components/MissionModeBadge.tsx)),
where a dot with words also marks missions waiting for a decision
(`attentionConversationIds`).

Run the adjacent tests with `npm run test --prefix client -- src/features/missions`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.
