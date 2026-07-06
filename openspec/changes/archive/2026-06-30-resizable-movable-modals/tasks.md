## 1. Hook + shared primitives — capability `movable-resizable-modal`

- [x] 1.1 Add a shared `MODAL_FLOAT_VIEWPORT_MIN = 900` constant module; re-point the existing inline split-view 900px threshold to it (no behavior change).
- [x] 1.2 Create `client/src/hooks/useMovableResizableModal.tsx`: `{x,y,w,h}` state, `panelRef`, `panelStyle` (empty until first interaction), `headerHandleProps`, `resizeHandles[]`, `isFloating`, `reset()`; options `enabled`, `allowMove`, `minWidth=320`, `minHeight=200`.
- [x] 1.3 Move logic: `position:fixed` + inline `left`/`top` (no transform), header target exemption (button/input/a/[role=button]), rAF-throttled pointermove.
- [x] 1.4 Resize logic: 8 grips; corner=2 dims, edge=1 dim; top/left anchor opposite edge; clamp `w∈[min,innerW-16]`, `h∈[min,innerH-16]`.
- [x] 1.5 Off-screen-jail clamp (header ≥48px×120px incl. close button always visible) after every move/resize.
- [x] 1.6 Seed-from-bbox on first interaction via `getBoundingClientRect()` (no jump).
- [x] 1.7 Viewport gate: `enabled:false` below `MODAL_FLOAT_VIEWPORT_MIN`; auto-collapse a floating modal to centered on resize-below-threshold.
- [x] 1.8 Pointer-capture safety: `setPointerCapture` try/catch, clear `dragRef` on up/cancel, remove window listeners in cleanup unconditionally, `wasDragging` backdrop-suppression ref.
- [x] 1.9 `ResizeGrips` component: 8 grips with semantic theme tokens (`bg-border/40`, `hover:bg-accent-primary/40`), `role="separator"`, `aria-orientation`, sr-only `aria-label`; keyboard Arrow ±16 / Shift ±64 / Home/End / `0`-reset.

## 2. DialogContent integration — capability `dialog-movable-resizable`

- [x] 2.1 Add optional `movableResizable?: boolean` (default `false`) to `DialogContent` in `client/src/components/ui/dialog.tsx`; when on, apply the hook to the Radix `Content` element + render grips + header move surface; keep Radix focus trap / `role` / `aria-modal` / Esc untouched.
- [x] 2.2 Opt the 16 Tier A modals into `movableResizable` (AddProjectDialog, CreateTicketModal, ProposeSpecModal, CreateTemplateDialog, FeatureProposalModal, FreestyleLaunchDialog, DiscardSpecDialog, PromptDialog, RoutingRuleDialog, PairWebCompanionModal, LoopRunModal, TemplatePreviewModal, KeyboardShortcutsCheatsheet, DocsDialog, GlobalSettingsPage SettingsDialog, InstallInstructionsModal).
- [x] 2.3 Confirm nested confirmation dialogs (inside TicketDetailModal etc.) stay `movableResizable` off.

## 3. Tier B bespoke modals — capability `bespoke-modal-movable-resizable`

- [x] 3.1 Wire the hook + grips + header handle into: JobDetailModal, JobComparisonModal, SmashConfirmModal, RecentJobs clear-modal, IntegrationsPage ModalShell, FileViewer budget prompt, ExploreSpecShell, AiEditShell — preserving each one's existing Esc/backdrop close.
- [x] 3.2 JobDetailModal/JobComparisonModal: `pointer-events:none` on Recharts subtrees during active drag, restored on settle (re-render-storm mitigation).
- [x] 3.3 FileViewer (Monaco): rely on `automaticLayout`; rAF-throttle resize so it settles cleanly.
- [x] 3.4 ExploreSpecShell/AiEditShell (terminal/xterm if present): call `fitAddon.fit()` on resize-settle, debounced.

## 4. TicketDetailModal + SplitViewShell — capability `bespoke-modal-movable-resizable`

- [x] 4.1 TicketDetailModal: adopt the hook with `allowMove:false` (resize grips only); header keeps the existing drag-to-split gesture.
- [x] 4.2 SplitViewShell: pass `enabled={false}` to embedded TicketDetailModal instances; verify no fixed positioning / no grips when embedded.

## 5. i18n

- [x] 5.1 Add `common` keys for grip aria-labels (per-corner/edge) and "Reset position" across all 8 locales; key-parity test passes.

## 6. Tests + coverage

- [x] 6.1 Hook unit tests: default-state-empty invariant, seed-from-bbox, clamp math, off-screen guard, gate enable/disable + auto-collapse, no-persist-on-reopen, keyboard resize math.
- [x] 6.2 Pointer-flow tests using the jsdom-safe capture pattern (move, resize, cleanup-on-unmount, backdrop-suppression).
- [x] 6.3 Collision tests: TicketDetailModal header → split (not move); `embedded ⇒ enabled:false` invariant.
- [x] 6.4 DialogContent default-off renders identically; opt-in renders grips.
- [x] 6.5 Run `npm run typecheck`, `npm test`, `npm run test:coverage`, `cd client && npm run test:coverage`; iterate until client ≥80% lines/statements and all gates green.
- [x] 6.6 Theme-token audit: grips use semantic tokens only; verify across all 5 themes; brand-color regression guard passes.
