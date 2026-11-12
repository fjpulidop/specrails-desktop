# Tasks

## 1. Decision helper

- [x] 1.1 Create `client/src/features/missions/lib/resolve-mission-project-switch.ts` exporting `resolveMissionProjectSwitch` (null/undefined/empty pin, unregistered, same-as-active → null; else the pin) and `resolve-mission-project-switch.test.ts` covering each case; verify with `npm run test --prefix client -- resolve-mission-project-switch`.

## 2. Stop the re-pin of the outgoing mission

- [x] 2.1 In `AgentChatContext.tsx` add `pendingSelectionRef` set in `selectConversation` (after early returns) and cleared in `finally`; make the backward-binding effect return early (after recording `lastBoundProjectIdRef`) when it is set. Add a test in `client/src/context/__tests__/AgentChatProjectBinding.test.tsx`: with an empty active mission pinned to A, selecting a mission of B (project switch during pending selection) does not patch the outgoing mission or set a draft pin, while a plain project change still re-pins as before; verify with `npm run test --prefix client -- AgentChatProjectBinding`.

## 3. Wire the switch into mission selection

- [x] 3.1 In `useOpenMission.ts` read `conversations`, and `projects`/`activeProjectId`/`setActiveProjectId` from `useDesktop()`; before the focus/select logic call the helper and `setActiveProjectId(target)` synchronously, no effect. Verify with the tests in 3.2.
- [x] 3.2 Extend `client/src/components/__tests__/ArcSidebarAgentConversations.test.tsx` (make the `useDesktop` mock mutable with two registered projects): different project calls `setActiveProjectId` with the pin and `selectConversation`; same project does not; Home mission does not; unregistered pin does not and still selects without throwing; rapid A→B→A ends with the last call for A; an unsent draft in a composer survives switching away and back (if the draft lives outside this sidebar tree, assert it in the nearest composer/agent-chat test instead); pins untouched (no pin patch call). Verify with `npm run test --prefix client -- ArcSidebarAgentConversations`.

## 4. Docs and map

- [x] 4.1 Run `npm run docs:source-map` to include the new helper and test; verify `docs/internals/source-map.md` lists them. Add a one-line note on mission selection following the pinned project to `client/src/features/missions` guide if one exists (`client/src/features/README.md` otherwise untouched).
