# Design

## Context

Mission rows in `ArcSidebar` call `useOpenMission()` (`client/src/features/missions/hooks/useOpenMission.ts`), which focuses/shows the pane and calls `useAgentChat().selectConversation(id)`. Nothing there touches `activeProjectId`. `useDesktop().setActiveProjectId` (`client/src/hooks/useDesktop.tsx:107`) synchronously updates the API base (`setApiActiveProjectId`) and batches the state change, flagging `isSwitchingProject` for 400 ms only when the id actually changes. Mission conversations expose their pin as `pinned_project_id` (`AgentConversation`, `features/missions/lib/agent-api`); `useAgentChat().conversations` is already the sidebar's source.

Finding that shapes the design: `AgentChatContext.tsx:1713-1726` ("backward binding") re-pins the *active* conversation to the new `activeProjectId` when it has no messages (or sets the draft pin when none is active) whenever `activeProjectId` changes in agent mode. With a naive switch, the mission being left (still `active` when the effect runs, because `selectConversation` is async) would be silently re-pinned to B, violating the "pins unchanged" constraint.

See proposal.md for motivation.

## Goals / Non-Goals

**Goals:** switch the project on mission selection synchronously; no-op for same/Home/unregistered; never rewrite pins; no new network calls.

## Non-Goals

- No `missionProjectId` or other second source of truth in the desktop context.
- No change to the command palette, deep links, OS notifications or the pin UI (they keep their existing paths).
- No redesign of the Mission sidebar or its filter (spec #6).
- No server, schema or API change.

## Decisions

1. **Wire in `useOpenMission`** (the handler for sidebar rows). It reads `conversations` via `useAgentChat()` and `projects`, `activeProjectId`, `setActiveProjectId` via `useDesktop()`. Before the existing focus/select logic it calls `resolveMissionProjectSwitch(...)` and, when non-null, `setActiveProjectId(target)`. Both calls run in the same synchronous handler, so React batches them in one render; no effect is used. Conversation not found in `conversations` → no switch.
2. **Pure helper** `resolveMissionProjectSwitch({missionProjectId, activeProjectId, projects})` returns the project id or `null` (null/undefined/empty pin, not in `projects`, equals active). Placed in `client/src/features/missions/lib/resolve-mission-project-switch.ts`.
3. **Suppress re-pin during selection.** Add a `pendingSelectionRef` in `AgentChatContext`: set in `selectConversation` after its early returns, cleared in `finally` once `loadConversation` settles. The backward-binding effect, after updating `lastBoundProjectIdRef`, returns early when the ref is set, so a project change caused by a selection never patches the outgoing mission nor sets a draft pin. Project changes without a selection behave as today.
4. **Rapid A→B→A:** `setActiveProjectId` is last-write-wins and `setApiActiveProjectId` is synchronous; the helper reads the current render's `activeProjectId`, so the final state is the last mission's project.
5. Leaving Mission mode keeps the switched project (nothing reverts it).

Open-question answers: Home missions → no switch; drafts and streams are component/conversation-scoped, not project-keyed, and the switch only changes `activeProjectId`, so they survive (asserted by a test).

## Local reference patterns

- Closest implementations: `ArcSidebar.handleSelectProject` (`client/src/components/ArcSidebar.tsx:906`) and `AgentChatContext.setPinnedProject` (`AgentChatContext.tsx:1688`), both calling `setActiveProjectId` from a user handler.
- Tests: `client/src/components/__tests__/ArcSidebarAgentConversations.test.tsx` mocks `useDesktop` (module-level `mockSetActiveProjectId`, `mockProjects`, fixed `activeProjectId: 'proj-1'`) and `useAgentChat` (`mockSelectConversation`, `conv(id,title,pinned)`); the `useDesktop` mock must become mutable to vary the active project. `client/src/context/__tests__/AgentChatProjectBinding.test.tsx` covers the backward binding and hosts the no-repin test.
- Async/state: `setActiveProjectId` is sync for the API base and batched for React state; `selectConversation` is async (awaits window focus + `loadConversation`), hence the pending ref. Errors: `selectConversation` rejection handling is unchanged.
- React 18 automatic batching (client stack per `.claude/rules/client.md`). No equivalent mission→project follow exists today.

## Risks / Trade-offs

- A frame could show the old conversation under the new project until `loadConversation` resolves (cached missions resolve at once) → `isSwitchingProject` covers the transition; deferring the switch was rejected by the ticket.
- `pendingSelectionRef` also skips an unrelated project change landing during a pending selection → short window, convenience binding only.

Rejected alternatives: effect on `active` (stale frame); context-level `missionProjectId` (split brain); switching inside `selectConversation` (changes palette/deep-link behaviour, out of scope).

## Assumptions

- Only missions opened via `useOpenMission` (sidebar) are in scope; the command palette stays unchanged.
- Home missions leave the project unchanged (ticket answer).
- Draft/stream behaviour is unaffected by the switch; verified by test, no code.

## Blast radius

- `client/src/features/missions/lib/resolve-mission-project-switch.ts` (new): pure helper.
- `client/src/features/missions/lib/resolve-mission-project-switch.test.ts` (new): helper cases.
- `client/src/features/missions/hooks/useOpenMission.ts`: perform the switch.
- `client/src/features/missions/context/AgentChatContext.tsx`: `pendingSelectionRef` guard.
- `client/src/components/__tests__/ArcSidebarAgentConversations.test.tsx`: different/same/Home/unregistered/rapid/draft cases.
- `client/src/context/__tests__/AgentChatProjectBinding.test.tsx`: outgoing empty mission not re-pinned.
- `docs/internals/source-map.md`: regenerated (a file is added).
- No locale strings, API docs, schema or migrations change.

Out-of-scope findings: none.
