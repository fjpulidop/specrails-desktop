# inbox

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

<!-- audit-client-features:begin (generated: public subpaths and feature dependencies; edit outside this block) -->
## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/InboxButton.tsx](components/InboxButton.tsx)
- [components/InboxDialog.tsx](components/InboxDialog.tsx)
- [context/InboxContext.tsx](context/InboxContext.tsx)

## Feature dependencies

- [integrations](../integrations/README.md)
- [recovery](../recovery/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.
<!-- audit-client-features:end -->

## "Needs you" inbox

A title-bar button (count badge), `⌘⇧I` on macOS / `Ctrl+Alt+I` on Windows and Linux, the ⌘K action *Open inbox* and the place
`?inbox=1` open one panel that lists what waits for the person across **every
project**, grouped by project, newest first.

- **Projection, not a store.** Items come from `GET /api/inbox`
  ([server module](../../../../server/modules/inbox/README.md)), which reads each registered
  project's own database. The client keeps no cross-project cache: the list is refetched
  on open, on app focus, every 60 s while visible and (debounced) on the WS events that
  change attention (`rail.pr_state`, `rail.job_*`, `loop.run_*`, `job.stuck`,
  `jira.outbox_changed`, any project).
- **Sources:** review ready (delivery `on_review`, `pr_draft`, `pr_ready`, changes requested),
  agent question (a run paused for a human decision), run failed or blocked (a delivery that
  failed, a failed/stalled/blocked run, a run interrupted by a restart), budget paused, and
  a Jira update that exhausted its retries (dead outbox op).
- **Cause.** A failed or blocked run's row says why in the diagnosis' plain words ("The AI provider's usage limit was reached", "The environment can't run the checks") instead of the raw outcome; an unknown cause keeps the raw outcome ([recovery](../recovery/README.md)).
- **Primary action** reuses the existing handlers: Open review / Open / Answer navigate
  to the place (`?review=` / `?job=` in Mission mode, `/review/:id` / `/jobs/:id` in Board
  mode) after switching project when needed; Resume calls `POST /loop-runs/:id/resume` of
  the item's project (the budget 409 is shown localized); Retry calls the Jira outbox retry.
- **Snooze (1 hour, until tomorrow 08:00) and Done** are per viewer (`localStorage`, in try/catch)
  and keyed by item id **and state version**: when the underlying state changes the item
  comes back. Entries older than 30 days are pruned.
- **Place:** `?inbox=1` is pushed on open (Back closes it). Opening a row replaces that
  entry with the place it leads to.
- **Notifications:** a provider-limit OS notification opens the inbox
  (`lib/inbox-events.ts`); job notifications keep deep-linking to the job itself.
- **Shortcut.** `Ctrl+Shift+I` opens DevTools in WebView2 and Chromium (development builds and the
  web view), so off macOS the chord is `Ctrl+Alt+I` (`useKeyboardShortcuts`, `SHORTCUTS` with `platform`,
  `keyboardLabel`). macOS keeps `⌘⇧I`. The count badge is neutral (it mixes failures, questions and reviews).
- **Opening an item of another project** closes the inbox, switches project and navigates one frame later
  (the route memory restores the project's last page in the same commit and would overwrite it).
- **Done / Snooze** show a toast with Undo (sonner directly: the app undo stack is per project) and move the
  focus to the next row. The dialog opens with the first row's primary button focused; only the focused
  primary is filled, the rest are outlined.
- Panel keyboard: `↑ ↓ Home End` walk the rows' primary buttons, `Esc` closes.

Run the adjacent tests with `npm run test --prefix client -- src/features/inbox`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.
