## Context

Two chat-style fullscreen surfaces today fully occlude the hub:

- `client/src/features/specs/components/explore-spec/ExploreSpecShell.tsx` — `fixed inset-0 z-50`, mounted as a child of `ProposeSpecModal`'s Radix Dialog. Uses `ChatContext` (per-project) plus local component state (composer, attachments, streaming flags, discard-confirm).
- `client/src/features/code/components/ai-edit/AiEditShell.tsx` — `fixed inset-0 z-50`, returned via early-return inside `AgentsCatalogTab` when `refine.kind === 'open'`. Drives state through the `useAgentRefine` hook (`refineId`, `agentId`, `baseBody`, `draftBody`, `history[]`, `streamingText`, `phase`, `uiState`, `testResult`, `appliedVersion`).

Both unmount when their trigger goes away (closing the Dialog, leaving the `/agents` route, switching projects). Anything held only in component state dies. The terminal panel solved a similar problem (`TerminalsContext`) by mounting xterm container divs inside a hidden `<div id="specrails-terminal-host">` appended to `document.body`, then `appendChild`-moving them into a viewport on demand.

Sonner is already mounted globally for transient toasts. It is not a fit for persistent "click to restore" affordances (auto-dismiss semantics, single-position stacking, conflicts with normal toasts). A separate dock UI is warranted.

## Goals / Non-Goals

**Goals:**
- Allow users to park an in-progress ExploreSpec or AiEdit session, navigate freely (other rails, logs, projects, settings), and resume exactly where they left off.
- Preserve all in-memory shell state across minimize/restore — including streaming buffers, composer text, attachments, conversation history, and diff review state.
- Surface parked sessions globally so users discover them from any project.
- Survive a full hub reload by persisting chip metadata; rehydrate best-effort.
- Drop chips silently when their owning project no longer exists.

**Non-Goals:**
- Out of scope: SetupWizard (already protected by `wizardCache`; user explicitly excluded), ImplementWizard, BatchImplementWizard, OnboardingWizard, ChatPanel sidebar.
- Not building a snapshot-and-rehydrate pipeline for streaming chat content. If a stream is in flight when the user reloads, the in-flight portion is lost; the chip rehydrates whatever the underlying ChatContext / refine session can recover.
- Not capping the chip stack. UI degrades gracefully when many chips exist, but no enforced limit.
- Not changing Esc behavior — Esc still closes (with current discard-confirm rules per shell).
- Not adding server endpoints, schema, or WebSocket changes.

## Decisions

### D1: Hidden-host hoisting (terminal pattern), not portals-in-place

**Decision**: Both shells render exclusively inside a single hidden host (`<div id="minimized-chats-host">`) owned by `MinimizedChatsProvider`. The provider mounts above the project router so it survives all in-app navigation. Triggers (`ProposeSpecModal`, `AgentsCatalogTab`) call provider APIs (`openExploreSpec(...)`, `openAiEdit(...)`) instead of rendering the shells themselves.

**Rationale**: Portals would still depend on the trigger staying mounted. The terminal panel proves the hidden-host pattern works for components with heavy local state (xterm). It keeps "shell instance lifecycle" exclusively under one provider, which is the only layer that knows when to destroy.

**Alternative considered**: Render shells in-place with a `useState` "minimized" flag. Rejected — closing the Dialog or unmounting the route still kills the shell.

### D2: Provider state shape

```ts
type MinimizedChatId = string; // uuid

type MinimizedChat =
  | {
      id: MinimizedChatId;
      kind: 'explore-spec';
      projectId: string;
      label: string;            // derived from current draft title or "Untitled spec"
      restoreRoute: string;     // route to navigate to on restore
      visible: boolean;         // true = shown over UI, false = chip in dock
      createdAt: number;
      // shell-specific bootstrap params (chatContextId, attachments seed, etc.)
      params: ExploreSpecParams;
    }
  | {
      id: MinimizedChatId;
      kind: 'ai-edit';
      projectId: string;
      label: string;            // e.g. "AI Edit · sr-developer"
      restoreRoute: string;     // typically `/agents` with the catalog tab active
      visible: boolean;
      createdAt: number;
      params: AiEditParams;     // refineId, agentId
    };
```

The provider owns: `chats: MinimizedChat[]`, `open(kind, params): id`, `minimize(id)`, `restore(id)`, `close(id)`. Visibility is mutually exclusive across kinds for a given owning project (only one shell visible at a time per project), but multiple invisible shells can coexist.

**Rationale**: Separating `visible` from "exists in stack" is what makes minimize cheap (no remount). One global stack simplifies persistence and dock rendering.

### D3: Chip click semantics

```
chip click(id) →
  setActiveProject(chat.projectId)   // HubProvider
  navigate(chat.restoreRoute)
  setVisible(id, true) and setVisible(others-of-same-project, false)
```

If the active project is already the owning project, skip the project switch but still navigate + show. If a different shell of the same project is currently visible, it minimizes (does not close).

### D4: Persistence — metadata only

`localStorage['specrails-hub:minimized-chats']` stores the `MinimizedChat` array minus any non-serializable refs and minus shell-internal state. Shells rehydrate from their own backing stores (ChatContext, agent-refine session APIs). If the underlying state is gone after reload (e.g., refine session was server-side ephemeral), the shell shows an empty/initial state and the user can choose to discard the chip.

**Rationale**: Storing full chat transcripts in `localStorage` invites quota issues and stale-data bugs. Best-effort rehydration matches the pragmatic posture used elsewhere (terminal scrollback is in-memory only).

### D5: Project-deleted cleanup

`MinimizedChatsProvider` subscribes to the hub project list (`useHub`). When a `projectId` referenced by a chip disappears, the provider drops matching chips silently — no toast, no confirm. Already-visible shells of that project are also unmounted (visible falls to false then chip removed).

**Rationale**: The deleted-project flow already destroys per-project state (terminals, contexts). Surfacing a "your session was lost" prompt would be noise; the project removal itself is the meaningful event.

### D6: Esc and discard-confirm unchanged

Minimize is a separate button (e.g., a `—` icon next to the existing close X). Esc and the close button keep their current discard-confirm logic (ExploreSpecShell prompts when composer has unsaved text). Minimize never prompts.

**Rationale**: Minimize being silent is exactly what makes it useful — it's "park, don't destroy". Coupling it to the destroy path defeats the purpose.

### D7: ChatContext lifetime

ExploreSpecShell relies on `ChatContext` (per-project). If `ChatContext` is torn down on project switch, conversations die even when the shell stays mounted. Verification + (if needed) a small refactor to keep ExploreSpec sessions in a global Map keyed by sessionId is part of this change. AiEdit's `useAgentRefine` is hook-local and moves with the hoisted shell — no extra work there.

### D8: Dock UI surface

Fixed bottom-right, above the existing sonner Toaster (`z-index` higher). One column of stacked chips (newest on top), each ~`max-w-xs`, project name as small subtitle, kind icon, label, and a `×` close affordance with discard-confirm if applicable. Theme-aware via existing semantic tokens (`accent-primary`, `surface`). Hidden on routes where no chips exist (no empty container).

## Risks / Trade-offs

- **[Hoisting changes z-index / focus-trap behavior]** ExploreSpecShell currently sits inside a Radix `Dialog` portal — moving it out of the Dialog may break focus trapping and Esc handling. → Mitigation: replace Dialog focus trap with a manual focus-management hook in the shell itself; explicit Esc handler at the host level when shell is `visible`.
- **[ChatContext per-project lifetime]** If ChatContext unmounts on project switch, explore-spec conversations die behind the chip. → Mitigation: spike ChatContext lifetime first; if it dies, lift session storage to a global map keyed by `sessionId`. Mark this as the first task.
- **[localStorage quota / stale chips after long absence]** A user could accumulate dozens of chips referencing long-dead refine sessions. → Mitigation: cap stored entries to a sane upper bound (e.g., 50) on write, drop oldest; on rehydrate, validate each chip can resolve its backing state and silently drop those that can't.
- **[Chip clutter]** Uncapped stack means UX gets ugly at 10+ chips. → Mitigation: design constraint, not an enforced limit. If users complain, add a "+N more" overflow chip in a follow-up.
- **[Refactor radius for AgentsCatalogTab]** The early-return-renders-shell pattern is load-bearing for keyboard / focus / dialog state. → Mitigation: replace early-return with provider call; verify catalog tab UI keeps working when shell is "open elsewhere" (chip mode).
- **[Test-environment portals]** jsdom + Radix portals can be flaky around the hidden host. → Mitigation: provider tests use a deterministic `getHostElement` injection; component tests render shells via the provider's public API rather than directly.

## Migration Plan

1. Land `MinimizedChatsProvider` + dock + persistence behind no flag (off by default = no chips, no behavior change visible).
2. Refactor ExploreSpecShell: hoist out of `ProposeSpecModal`, expose minimize button, wire to provider. Verify all existing explore-spec tests still pass.
3. Refactor AiEditShell similarly. Verify all existing ai-edit tests still pass.
4. Verify ChatContext survives project switch; if not, lift to global Map.
5. No rollback flag — feature is purely additive UI. If a regression appears, revert the relevant shell-hoisting commit; the provider can stay (idle).

## Open Questions

- Does `ChatContext` actually tear down on project switch today? (Spike before T1.) If yes, decide whether to lift it wholesale or only for parked sessions.
- Should the dock be hidden during the project-setup wizard takeover (which itself is fullscreen and out of scope)? Default: yes — dock hidden when `isInSetup` is true, since the wizard already replaces `ProjectLayout`.
- Chip ordering: newest-on-top vs. stable insertion order? Default: newest-on-top — matches user intuition for "what I just parked".
