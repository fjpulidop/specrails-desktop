## Why

Every centered modal in the desktop app is a fixed-size, fixed-position box. A user who opens `JobDetailModal`, `GlobalSettingsPage`, `DocsDialog` or any spec/create dialog cannot grow it to read more, shrink it to glance at the page behind, or shove it aside to reference the dashboard. The app already ships rich pointer-drag infrastructure (`SplitViewShell` divider, `TerminalDragHandle`, `DashboardSplitter`, the `TicketDetailModal` drag-to-split gesture) — the primitives exist, they are just not wired to the modal surface.

The codebase also funnels ~16 of those modals through a single primitive (`client/src/components/ui/dialog.tsx`, `DialogContent`), so a single enhancement there plus the same reusable hook applied to the bespoke overlays makes **every** centered modal movable and resizable with no per-modal positioning rewrites.

## What Changes

- **New `useMovableResizableModal()` hook** (`client/src/hooks/useMovableResizableModal.tsx`). One combined hook owning `{x, y, w, h}` + pointer-capture lifecycle for **both** move and resize. Returns `panelRef`, `panelStyle`, `headerHandleProps`, `resizeHandles[]`, `isFloating`, `reset()`. Adopts `SplitViewShell`'s exact pointer idioms (`setPointerCapture` in try/catch for jsdom safety, `dragRef` cleared on `pointerup`, window listeners removed in cleanup) and `TerminalDragHandle`'s rAF-throttled update pattern.
- **Move** = drag the modal header → `position: fixed` + inline `left`/`top` (never `transform: translate`, so embedded Monaco/xterm/charts keep a truthful `getBoundingClientRect`).
- **Resize** = 8 grips (4 corners + 4 edges); top/left grips anchor the opposite edge. Clamped to the viewport, with an off-screen-jail guard that keeps the header (≥48px tall, ≥120px wide incl. the close button) always reachable.
- **`DialogContent` gains an opt-in `movableResizable` prop** (Tier A choke point). Turning it on for the ~16 Dialog-based modals unlocks move+resize for all of them; Radix `Content` stays the positioned element so `role="dialog"`, `aria-modal`, focus trap, and Esc are untouched — the hook only mutates position/size.
- **Tier B bespoke overlays adopt the same hook directly** on their panel div: `JobDetailModal`, `JobComparisonModal`, `SmashConfirmModal`, the `RecentJobs` clear-modal, `IntegrationsPage` `ModalShell`, `FileViewer` budget prompt, `ExploreSpecShell`, `AiEditShell`.
- **`TicketDetailModal` gets resize-only** (edge/corner grips). Its header remains owned by the existing drag-to-split gesture — no move-via-header, no collision.
- **Default state is byte-identical to today.** `panelStyle` is empty until the first move/resize pointer-up; the modal renders centered at its current CSS size with zero visual change. On first interaction the hook seeds `{x,y,w,h}` from the live `getBoundingClientRect()` so there is no jump.
- **No persistence in v1.** Every open resets to centered/default (decision recorded in design.md). Avoids off-screen-jail bugs and matches the per-project modal-reset semantics the app already enforces.
- **Viewport gate at 900px.** Move and resize hard-disable below the existing split-view threshold; a shared `MODAL_FLOAT_VIEWPORT_MIN` constant is exported so dashboard split, TicketDetail split, and this feature reference one value. Auto-collapse to centered when the viewport shrinks below it.
- **Keyboard + a11y for resize.** Each grip is focusable with `role="separator"`, `aria-orientation`, and an sr-only label; Arrow nudges ±16px (±64px with Shift), Home/End → min/max, `0` → reset, mirroring the `SplitViewShell` divider keymap.

Not breaking: `movableResizable` defaults **off** on `DialogContent`, the hook is purely additive (empty style until interacted), no DB/schema/server changes, and a user who never drags a modal sees today's behavior exactly.

## Capabilities

### New Capabilities
- `movable-resizable-modal`: the `useMovableResizableModal` hook contract — move/resize mechanics, the default-state (untouched ⇒ identical) invariant, viewport clamping + off-screen guard, the 900px gate, no-persistence-in-v1, and keyboard/a11y for the grips.
- `dialog-movable-resizable`: the `DialogContent` opt-in `movableResizable` prop and its wiring across the Tier A Dialog-based modals, preserving Radix focus/Esc/role semantics.
- `bespoke-modal-movable-resizable`: adoption of the hook by the Tier B custom-overlay modals, plus the `TicketDetailModal` resize-only carve-out and the `embedded ⇒ disabled` invariant for `SplitViewShell` children.

## Impact

- **Client (new)**: `client/src/hooks/useMovableResizableModal.tsx` (the hook), a `ResizeGrips` component, and a shared `MODAL_FLOAT_VIEWPORT_MIN` constant module (extract the 900px value currently inline in the split-view code).
- **Client (modified)**: `client/src/components/ui/dialog.tsx` (`DialogContent` + `movableResizable` prop); the ~16 Tier A modals pass the prop; the 8 Tier B modals import the hook + render grips + spread header handle; `TicketDetailModal.tsx` adds resize grips (no move); `SplitViewShell.tsx` passes `enabled={false}` to embedded children. Optionally extract the shared pointer-capture core so `SplitViewShell`/`DashboardSplitter` can later converge.
- **i18n**: new `common` keys for grip aria-labels / "Reset position" across all 8 locales; key-parity test must pass.
- **Database / server / specrails-core**: ZERO — entirely a client interaction layer.
- **Out of scope (v1)**: persistence of size/position; move on `TicketDetailModal` (header owned by split); `WebViewModal`/`BrowserCaptureModal`/`AttachmentPreviewLightbox`/`ChatPanel`-maximized (full/inset by design); dropdowns, popovers, toasts, `MinimizedChatsDock`, `CommandPalette`, `OnboardingWizard`; touch/sub-900px move-resize.
- **Coverage**: the hook's pure geometry (clamp, off-screen guard, seed-from-bbox, gate) and the grip keyboard math are unit-tested; pointer flows tested with the jsdom-safe capture pattern, keeping client ≥80% lines/statements.
