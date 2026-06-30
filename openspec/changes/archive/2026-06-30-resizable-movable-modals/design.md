# Design — Resizable + Movable Modals

## Context

Survey (multi-agent sweep of `client/src`, 2026-06-28) found **36** overlay components. The centered ones split into two tiers plus an out-of-scope set:

```
Tier A — funnel through ui/dialog.tsx (DialogContent)            ~16 modals
  AddProjectDialog, CreateTicketModal, ProposeSpecModal,
  CreateTemplateDialog, FeatureProposalModal, UltracodeLaunchDialog,
  DiscardSpecDialog, PromptDialog, RoutingRuleDialog,
  PairWebCompanionModal, LoopRunModal, TemplatePreviewModal,
  KeyboardShortcutsCheatsheet, DocsDialog, GlobalSettingsPage(SettingsDialog),
  InstallInstructionsModal

Tier B — own `fixed inset-0 … flex items-center justify-center` panel   8 modals
  JobDetailModal, JobComparisonModal, SmashConfirmModal,
  RecentJobs(clear-modal), IntegrationsPage(ModalShell),
  FileViewer(budget prompt), ExploreSpecShell, AiEditShell

Out of scope (different UX goal)
  TicketDetailModal (header = split gesture → resize-only carve-out)
  SplitViewShell (is itself a resize container)
  WebViewModal / BrowserCaptureModal (inset browser canvas)
  AttachmentPreviewLightbox, ChatPanel-maximized (fullscreen by design)
  MoveToRailPopover, TerminalSearchOverlay (anchored / non-modal)
  CommandPalette, OnboardingWizard, MinimizedChatsDock, toasts, MatrixRain
```

Existing reusable pointer infra: `SplitViewShell` divider (`setPointerCapture` try/catch, clamp, window listeners, role=separator + arrow/Home/End/0 keymap), `TerminalDragHandle` (rAF-throttled height preview), `DashboardSplitter`/`useDashboardSplit` (clamp, snap, per-project persist), `TicketDetailModal` drag-to-split (header pointerdown, button/input exempt, translateX feedback, 20% threshold).

## Decisions (resolved with user, 2026-06-28)

| Decision | Choice | Rationale |
|---|---|---|
| Persistence | **None in v1 — reset to centered every open** | Persisted coords are the #1 off-screen-jail source (saved on a 27" monitor, restored on a laptop); collides with the app's per-project modal-reset semantics; adds validation/reconciliation surface. Centered-on-open is surprise-free and matches today. |
| Scope | **All centered modals — Tier A + Tier B** | Satisfies the literal request ("todos los modales"). Tier A is one edit; Tier B is one import + grips per modal. |
| TicketDetailModal | **Resize-only (no move)** | Its header already owns the drag-to-split gesture. Resize (edges/corners) does not touch the header, so it coexists; move-via-header would collide. |
| Dialog-style modals (Tier A) + FileViewer | **Resize-only (no move)** — as-built revision | These have no obvious drag handle, so a whole-panel move made body clicks accidentally reposition the modal (and a mid-entry-animation `getBoundingClientRect` skew jammed it into the top-left corner). User explicitly wanted resize-only here. Move is kept only for the bespoke modals that have a real title bar (JobDetail, JobComparison, Smash, RecentJobs, Integrations, Explore/AiEdit shells), where header-drag is a deliberate, non-accidental gesture. |

## The hook

```ts
// client/src/hooks/useMovableResizableModal.tsx
useMovableResizableModal({
  enabled,                     // false below MODAL_FLOAT_VIEWPORT_MIN or when embedded
  allowMove = true,           // TicketDetailModal passes false
  minWidth = 320,
  minHeight = 200,
}) => {
  panelRef,                   // attach to the positioned panel element
  panelStyle,                 // {} until first interaction; then {position:'fixed', left, top, width, height}
  headerHandleProps,          // {onPointerDown} for move — spread on the header drag-zone (omit if !allowMove)
  resizeHandles,              // [{ position:'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w', onPointerDown, onKeyDown, role, 'aria-*' }]
  isFloating,                 // false until the user first moves/resizes
  reset(),                    // back to centered/default
}
```

### Move
- `position: fixed` + inline `left`/`top` — **not** `transform: translate`. Keeps `getBoundingClientRect()` truthful for embedded Monaco (`automaticLayout`), xterm, and Recharts, and avoids sub-pixel text blur.
- Header drag-zone exempts `button`/`input`/`a`/`[role=button]` targets (copy `TicketDetailModal`'s exemption) so the close button and form fields still work.
- rAF-throttle `pointermove` (pending-ref pattern from `TerminalDragHandle`) → 60fps even with charts inside.

### Resize
- 8 grips absolutely positioned inside the panel. Hover = `accent-primary/40`. Corner grip adjusts two dims; edge grip one.
- Top / left grips adjust `w`/`h` **and** shift `left`/`top` so the opposite edge stays anchored.
- Clamp: `w ∈ [minWidth, innerWidth-16]`, `h ∈ [minHeight, innerHeight-16]`.
- After any move/resize, clamp `left`/`top` so the header (≥48px tall, ≥120px wide incl. close button) stays on-screen — the off-screen-jail guard.

### Default-state invariant (the load-bearing one)
- `panelStyle` is `{}` until the first move/resize `pointerup`. While empty, the modal keeps its existing Tailwind classes (`left-[50%] top-[50%] translate-x/y-[-50%] max-w-* max-h-[85vh]`) → centered at current size, **zero visual delta vs today**.
- On first interaction the hook measures `panelRef.current.getBoundingClientRect()` to seed `{x,y,w,h}` from the real rendered box, then switches to fixed inline coords → no jump.
- Purely additive: a modal nobody drags is identical to today. This is the regression-safety contract and gets an explicit test.

### Pointer-capture idioms (copy SplitViewShell verbatim)
- `el.setPointerCapture(e.pointerId)` wrapped in try/catch (jsdom throws).
- `dragRef` holds the in-flight gesture; cleared on `pointerup`/`pointercancel`.
- `window` `pointermove`/`pointerup` listeners attached on down, removed in `useEffect` cleanup **unconditionally** (project-switch unmounts modals mid-drag → must not leak).
- `wasDragging` ref suppresses the backdrop `onClick={onClose}` for one tick after a drag/resize ends (overshoot onto backdrop must not close).

## Collisions

1. **TicketDetailModal split gesture** — header stays the split surface; the modal gets `allowMove=false` (resize grips only). No two gestures share a surface within any single modal.
2. **Embedded ⇒ disabled** — when `TicketDetailModal` renders inside `SplitViewShell` (`embedded`), it passes `enabled={false}`: empty style, no grips, sizes as a flex child. `SplitViewShell`'s divider stays the only resizer in that container. This is the single biggest correctness trap and gets a test.
3. **Nested confirm dialogs** (delete / Jira-save inside TicketDetail) are plain `DialogContent` with `movableResizable` off — only the top modal is interactive under the focus trap anyway.

## Accessibility & viewport

- **Esc / focus untouched.** Radix `Content` owns `role="dialog"`, `aria-modal`, focus trap, Esc; the hook adds zero Esc listeners. Tier B keeps its own Esc handlers.
- **Grips:** `role="separator"`, `aria-orientation` per axis, sr-only `aria-label` ("Resize modal — bottom-right"). Keyboard: Arrow ±16px, Shift+Arrow ±64px, Home/End → min/max dim, `0` → reset. Mirrors the `SplitViewShell` divider keymap for muscle memory.
- **Move** is pointer-only in v1 (a convenience); resize carries the a11y weight. Documented, acceptable.
- **900px gate:** export `MODAL_FLOAT_VIEWPORT_MIN = 900` from a shared module; the existing inline split-view threshold re-points to it. Below the gate the hook returns `enabled:false` (today's centered/fullscreen behavior). Auto-collapse to centered on resize-below-threshold (mirror `TicketDetailModalContext` split auto-exit).

## Risks

1. **Monaco reflow** (`FileViewer`, code surfaces): `automaticLayout` reflows on container size; rAF-throttle resize so it settles cleanly. Move (left/top only) → no reflow, free.
2. **xterm `fit()`**: xterm does not auto-reflow — any resizable modal embedding a terminal calls `fitAddon.fit()` on resize-settle (pointerup), debounced. Low exposure in v1 (terminals live mostly in out-of-scope modals); document the contract for the shell modals.
3. **Recharts re-render storm** (`JobDetailModal`): charts re-render on parent repaint; rAF throttle mandatory; consider `pointer-events:none` on chart subtrees during active drag, restored on settle.
4. **Off-screen recovery**: header-always-reachable clamp + `0`-key reset; highest-severity UX risk → explicit test.
5. **Theme tokens**: grips use semantic tokens only (`bg-border/40`, `hover:bg-accent-primary/40`, `surface`) — the brand-color regression guard greps for hex; verify across all 5 themes.
6. **Pointer-capture leak on unmount mid-drag**: clear `dragRef` + remove listeners in cleanup unconditionally (SplitViewShell net).
7. **Backdrop-click-while-dragging**: `wasDragging` guard suppresses one backdrop click after a gesture.

## Alternatives considered

- **Per-modal bespoke drag (no shared hook):** rejected — 24 divergent implementations, no choke point leverage, untestable in aggregate.
- **`transform: translate` for move:** rejected — breaks `getBoundingClientRect` for embedded Monaco/xterm/charts and blurs text.
- **Persist size/position in v1:** rejected — see decisions table; deferred with a documented key shape (`specrails-desktop:modal-state:<modalType>:<projectId>`, on-screen-validated on read) for a follow-up.
- **A third-party lib (`react-rnd` etc.):** rejected — the app already has the pointer idioms; a hook reuses them, stays bundle-light, and matches the codebase's pattern conventions.
