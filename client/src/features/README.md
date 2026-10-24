# Frontend capability ownership

Application boot/composition stays in `App.tsx` and `main.tsx`. Each feature owns
its components, state, hooks, API clients, feature utilities and adjacent tests.
Generic UI primitives and shared infrastructure (origin/auth, WebSocket transport,
project caching, routing and native shell helpers) stay outside feature folders.

The [boundary manifest](boundaries.json) records each feature's public subpaths
and direct feature dependencies. Public subpaths avoid an eager barrel importing
React views when a consumer only needs a model or API client. New cross-feature
imports require an explicit manifest update; tests reject undeclared changes and
imports from feature code back into application composition.

The feature READMEs link every externally consumed entry point and collaborating
feature. This is ownership and dependency visibility, not a claim that all existing
UI collaborations are acyclic. Domain/validation code should depend on contracts;
HTTP, storage and native-shell effects belong in hooks or adapters.

Generate reviewed changes with `node scripts/audit-client-features.mjs --write`;
validate with `--check`. `--write` rewrites only the block between the
`audit-client-features:begin` / `:end` markers of each feature README (public
subpaths and feature dependencies, [scripts/client-feature-readme.mjs](../../../scripts/client-feature-readme.mjs));
hand-written sections outside it are kept. `--check` also fails when a block is
stale. Run client coverage after changes spanning capabilities.

## Modals

Every modal follows the [modal standard](../../../docs/internals/modal-standard.md):
`DialogContent` from `components/ui/dialog.tsx` with one of five sizes
(`confirm`, `form`, `wide`, `workspace`, `fullscreen`), a sticky `DialogHeader`
(it owns the close button), `DialogBody` as the only scroll region and a sticky
`DialogFooter` with Cancel (ghost) before the primary action. Confirms use
`ConfirmDialog`. Stacking uses the named layers in `lib/layers.ts` (`base` 50,
`entity` 65, `stacked` 70, `capture` 80, `media` 100), never a literal
`z-[NN]`. Only `workspace` modals are resizable. Text inside a modal is at
least 12px (11px only on `data-chip` pills). Anything a user consults while
working (Docs, Analytics, activity log) is a candidate for a side sheet rather
than a modal. `components/ui/__tests__/modal-standard-guard.test.ts` rejects
hand-rolled `aria-modal` dialogs outside `components/ui` and sub-12px text in
modal files.

## Places (Back / Forward / links)

A *place* is where the person is, written to the URL so router history is the
navigation history and every place is a link. Do not invent a second history.

| Place | URL | Owner |
| --- | --- | --- |
| Spec detail modal | `?spec=<ticketId>` | `DashboardPage` (richer modal, claims it) / `TicketDetailModalProvider` |
| Selected mission (Mission mode) | `?mission=<conversationId>` | `missions/hooks/useMissionPlaceSync.ts` |
| Loops / Plugins / Docs / Analytics modal | `?overlay=loops\|plugins\|docs\|analytics` | `App.tsx` (Board mode shows Loops/Plugins as routes) |
| Review packet over a mission | `?review=<prDeliveryId>` (Board mode: `/review/:id`) | `App.tsx` |
| Job detail over a mission | `?job=<jobId>` (Board mode: `/jobs/:id`) | `missions/components/AgentModeJobsPane.tsx` |
| Project switch | `?p=<projectId>` on the pushed entry | `useProjectRouteMemory` in `App.tsx` |

Rules:

- Open a place with `usePlaceParam(name).open(value)` (pushes) and close it with
  `.close()` (pops the entry it pushed, otherwise removes the param in place).
  Never `navigate()` a place param by hand.
- **Not places** (use `replace`, or no navigation): filters, sort, search, tabs inside
  a modal, sidebar pins, run-strip focus (`⌥[ ⌥]`), terminal toggle, scroll, composer
  state and the Board/Mission toggle. Writing them with `setSearchParams` must pass
  `{ replace: true }`.
- Back/Forward (`usePlaceHistory`) never flips `uiMode`: `placeKey(entry, mode)` decides
  what is the same place in the current mode, and entries that mean nothing there are
  skipped. Restoring re-runs no side effect (no launch, no new-mission draft).
- A surface that discovers its target is gone calls `usePlaceHistory().reportMissing(kind)`;
  after Back/Forward the entry is skipped with a quiet toast, otherwise the param is dropped.
- Shortcuts live in `hooks/useKeyboardShortcuts.ts` (`⌘[` `⌘]`; `Ctrl+[` `Ctrl+]` / `Alt+←` `Alt+→`
  off macOS), mouse buttons 4/5 in `PlaceHistoryProvider`, the title-bar buttons in
  `components/PlaceNavButtons.tsx`.

## Undo instead of confirm

Reversible actions (delete a spec or mission, remove a spec from a rail, move a
spec to another status, change its labels) apply immediately and call
`useUndo().pushUndo({ projectId, label, undo })` from [`hooks/useUndo.tsx`](../hooks/useUndo.tsx).
It shows an 8 s toast with **Undo** and registers **⌘Z / Ctrl+Z** (ignored in
text fields, code editors and terminals). The stack is per project: ⌘Z only
reaches entries of the active project and a project switch dismisses the
previous project's toasts, so `undo` must address its project explicitly. Without
a provider `pushUndo` is a no-op that returns `false`. Throw `UndoBlockedError`
from `undo` to refuse with a specific reason.

Deletes are soft (specs and missions stay restorable for 30 days under project
settings → Recently deleted, `settings/components/RecentlyDeletedSection.tsx`).
Keep a confirm only for what cannot be reversed: discarding unpushed work,
force-closing a PR, removing a project, deleting permanently, and deleting a
mission whose agent turn is still running.
