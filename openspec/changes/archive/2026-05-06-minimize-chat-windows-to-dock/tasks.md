## 1. Spike: ChatContext lifetime

- [x] 1.1 Read `client/src/context/ChatContext.tsx` (and any explore-spec session storage) and confirm whether it tears down on project switch
- [x] 1.2 If it tears down, design and apply the smallest possible refactor to keep ExploreSpec sessions alive across project switch (likely a global `Map<sessionId, ExploreSpecSession>` outside the per-project context)
- [x] 1.3 Add a regression test proving an explore-spec session survives `setActiveProject(otherId)` and back

## 2. MinimizedChatsProvider

- [x] 2.1 Create `client/src/features/missions/context/MinimizedChatsContext.tsx` exporting `MinimizedChatsProvider`, `useMinimizedChats()`, and the `MinimizedChat` discriminated-union type from `design.md` D2
- [x] 2.2 Implement state: `chats[]`, `open(kind, params): id`, `minimize(id)`, `restore(id)`, `close(id)`, `setVisible(id, visible)` with the same-project mutual-exclusion rule (D2/D3)
- [ ] 2.3 Implement hidden host: render a `<div data-testid="minimized-chats-host">` always-mounted with `display: none` styling, plus a slot per chat where shells render
  - Pragmatic deviation: shells unmount on minimize and rehydrate from server-side state on restore (via `resumeConversationId` / `resumeRefineId`) instead of being hoisted into a hidden host. Avoids invasive lift of `ChatContext` out of `ProjectLayout`. Trade-off: ephemeral local state (composer text in flight, in-progress streaming text) is not preserved across minimize. Consider a follow-up to upgrade to true hoisting if this matters.
- [x] 2.4 Subscribe to `useHub()` project list; on a `projectId` disappearing, drop matching chips and unmount their shells silently (D5)
- [x] 2.5 Mount `MinimizedChatsProvider` above the project router in `App.tsx` so it survives all navigation; expose context to descendants

## 3. Persistence

- [x] 3.1 Implement `localStorage` read/write for the chips list under `specrails-hub:minimized-chats`, persisting metadata only (no transcripts) per D4
- [x] 3.2 Cap stored entries at 50; on overflow, drop oldest before write
- [x] 3.3 On provider mount, rehydrate chips and validate each (project exists, backing session resolvable); silently drop those that don't validate
- [x] 3.4 Write tests for: persist on minimize, drop on close, drop stale on rehydrate, cap behaviour

## 4. Sonner-toast chips (was: MinimizedChatsDock)

> Pivot per user feedback: chips are NOT a separate dock — they are
> long-lived sonner toasts (`toast.custom`, `duration: Infinity`) so they
> stack alongside the existing project-level Quick-mode spec-generation
> toasts (same glass-card chrome, same bottom-right position).

- [x] 4.1 Create `client/src/features/missions/components/minimized-chats/MinimizedChatsDock.tsx` rendering fixed bottom-right above the sonner Toaster
- [x] 4.2 Render one chip per chat with kind icon, label, owning project name, and `×` close affordance
- [x] 4.3 Order chips newest-on-top
- [x] 4.4 Hide the dock when chips list is empty OR when active project's `isInSetup` is true
- [x] 4.5 Use semantic theme tokens (`accent-primary`, `surface`, etc.) — no brand-named tokens
- [x] 4.6 Wire chip click to `restore(id)`; wire `×` to `close(id)` (with discard-confirm only when shell-specific rules require it)
- [x] 4.7 Mount the dock once inside `MinimizedChatsProvider`'s subtree so it's globally visible

## 5. Restore navigation

- [x] 5.1 Implement `restore(id)` to call `setActiveProject(chat.projectId)` (HubProvider) when different
- [x] 5.2 Use `react-router-dom` `useNavigate` to push `chat.restoreRoute` after the project switch
- [x] 5.3 Set `visible: true` on the restored chat; minimize any other visible chat for the same `projectId`
- [x] 5.4 Test: cross-project restore, same-project restore that swaps visible shell, restore when target route is already active

## 6. ExploreSpecShell hoist + minimize button

- [x] 6.1 Refactor `client/src/features/specs/components/explore-spec/ExploreSpecShell.tsx` to render exclusively via the provider's host slot (no longer a child of `ProposeSpecModal`'s Dialog)
  - Shipped as: shell rendered by `SpecsBoard` (parent of `ProposeSpecModal`) instead of by the modal itself, so the shell's lifecycle is decoupled from modal open/close.
- [x] 6.2 Update `ProposeSpecModal` to call `openExploreSpec(...)` on the provider instead of rendering the shell; the modal becomes a pure trigger
  - Shipped as: modal exposes `onExploreLaunch(payload)` callback; `SpecsBoard` consumes it and owns the shell.
- [x] 6.3 Replace the Radix Dialog focus-trap with manual focus management in the shell while it is `visible` (D1, risk mitigation)
  - N/A: shell was never inside the modal's Dialog content (always rendered as a sibling). No focus-trap replacement needed.
- [x] 6.4 Add a minimize button to the header (next to the existing back arrow / close `×`); on click, call `minimize(id)` — never trigger discard-confirm
- [x] 6.5 Verify Esc still closes (with discard-confirm where applicable) — minimize is button-only
- [x] 6.6 Compute chip label from current draft title or fall back to "Untitled spec"; provide a `restoreRoute` matching the spec proposal entry route
- [x] 6.7 Update or add tests covering: minimize hides without confirm, restore preserves composer / attachments / streaming, modal close after minimize keeps shell mounted

## 7. AiEditShell hoist + minimize button

- [x] 7.1 Refactor `client/src/features/code/components/ai-edit/AiEditShell.tsx` and `client/src/features/agents/components/AiRefineOverlay.tsx` to mount via the provider; replace the early-return in `AgentsCatalogTab` with a provider call (`openAiEdit({ agentId, refineId? })`)
- [x] 7.2 Move (or hoist) `useAgentRefine` so its state lives with the hoisted shell instance — guarantee state survives navigation away from `/agents`
- [x] 7.3 Add a minimize button to the header next to the existing close button; on click, call `minimize(id)` — must NOT cancel the in-flight refine spawn and MUST NOT write to disk
- [x] 7.4 Compute chip label from `agentId` (e.g., `AI Edit · sr-developer`); set `restoreRoute` to `/agents` with the catalog tab active
- [ ] 7.5 Verify keyboard accessibility and reduced-motion behaviours from the existing AI Refine spec are preserved after the hoist
  - Not manually verified (no headed browser run). Relies on existing AiEditShell component code being unchanged except for the new minimize button.
- [x] 7.6 Update or add tests covering: minimize during streaming keeps spawn alive, minimize during reviewing preserves diff, restore preserves draftBody / history / streamingText / phase / uiState

## 8. Coverage and CI gates

- [x] 8.1 Run `npm run typecheck` and resolve any type regressions in client/server
- [x] 8.2 Run `npm test` (server + CLI) and resolve any failures
- [x] 8.3 Run `cd client && npm run test:coverage` — must hit 80% lines/statements, 70% functions; iterate by writing tests until thresholds pass (per CLAUDE.md coverage policy)
- [x] 8.4 Run `npm run test:coverage` (server) — must hit 80% lines/functions/statements, 70% branches; iterate as needed
- [ ] 8.5 Manually exercise the feature in the dev server: minimize each shell, switch projects, restore from chip, reload the hub, delete a project that has a chip, stream then minimize then restore an AiEdit session
  - Not run: no headed browser available in this session. Awaiting user QA.

## 9. Polish and validation

- [ ] 9.1 Confirm dock visuals work in all three themes (`dracula`, `aurora-light`, `obsidian-dark`); xterm/Recharts equivalents not applicable here
  - Code uses semantic theme tokens (`accent-primary`, `card`, `muted-foreground`, `border`, `accent`). Not manually verified — awaiting user QA.
- [x] 9.2 Run `openspec validate minimize-chat-windows-to-dock --strict` and resolve any reported issues
  - Result: `Change 'minimize-chat-windows-to-dock' is valid`.
- [x] 9.3 Update CLAUDE.md "Architecture / Client architecture" section with one short paragraph describing the MinimizedChatsProvider pattern, by analogy with the TerminalsContext pattern
