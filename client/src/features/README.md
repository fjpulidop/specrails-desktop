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
| "Needs you" inbox | `?inbox=1` | [`features/inbox`](inbox/README.md) (`InboxProvider`; opening a row replaces this entry with the place it leads to) |

Rules:

- Open a place with `usePlaceParam(name).open(value)` (pushes) and close it with
  `.close()` (pops the entry it pushed, otherwise removes the param in place).
  Never `navigate()` a place param by hand.
- **Not places** (use `replace`, or no navigation): filters, sort, search, tabs inside
  a modal, sidebar pins, run-strip focus (`⌥[ ⌥]`), terminal toggle, scroll, composer
  state and the Board/Mission toggle. Writing them with `setSearchParams` must pass
  `{ replace: true }`. A copied saved-view link (`?view=<id>`, `VIEW_PARAM`) is one of these: the
  specs board applies the view and drops the param in place, and `placeKey` ignores it.
- Back/Forward (`usePlaceHistory`) never flips `uiMode`: `placeKey(entry, mode)` decides
  what is the same place in the current mode, and entries that mean nothing there are
  skipped. Restoring re-runs no side effect (no launch, no new-mission draft).
- A surface that discovers its target is gone calls `usePlaceHistory().reportMissing(kind)`;
  after Back/Forward the entry is skipped with a quiet toast, otherwise the param is dropped.
- Shortcuts live in `hooks/useKeyboardShortcuts.ts` (`⌘[` `⌘]`; `Ctrl+[` `Ctrl+]` / `Alt+←` `Alt+→`
  off macOS), mouse buttons 4/5 in `PlaceHistoryProvider`, the title-bar buttons in
  `components/PlaceNavButtons.tsx`.

## Contextual help (Learn more)

`components/HelpHint.tsx` is the one way to link a screen to the guide: an `ⓘ` icon button
(`variant="icon"`, beside a heading or control) or a "Learn more →" link (`variant="link"`). It
asks the shell for the guide through `openDocs()` ([`lib/docs-events.ts`](../lib/docs-events.ts),
same window-event pattern as `openAppSettings`); `App.tsx` opens `?overlay=docs` (a place) and
`DocsDialog` selects the page and scrolls to the heading, over the current screen (`stacked`
layer, so it also opens over the floating chat). The accessible name always names the topic
("Learn more about daily budgets").

- **Topics** live in [`lib/help-topics.ts`](../lib/help-topics.ts): `topic → { category, slug, anchor }`.
  The anchor is an explicit `## Title {#anchor}` on a heading of `docs/guide/<locale>/<category>/<n>-<slug>.md`,
  identical in all 8 locales (never a translated slug). `lib/__tests__/help-topics.test.ts` fails on a dead
  anchor in any locale or a topic without `help.topics.<id>` (`common.json`).
- **Adding a hint:** add the topic (and its anchor in all 8 guides, plus the topic name in all 8
  `common.json`), then render `<HelpHint topic="…" />`. Do not hard-code guide URLs.
- **Where they are:** section links in app/project settings (`APP_SETTINGS_HELP`, `PROJECT_SETTINGS_HELP`),
  the daily budget fields, the rail loop selector (what a rail runs), Flow entry and hand-off cards, the
  Run-a-loop dialog, the context-scope slider, and empty states (`EmptyState learnMore="…"`: one sentence of
  what will appear, the primary action, then Learn more).
- **Cheatsheet search:** the `?` cheatsheet filters shortcuts and asks `GET /api/docs/search` (current
  locale titles/headings) for guide matches that open in the guide at the heading.

## Launch forecast ("Usually 6–9 min · $2–4")

`components/LaunchForecast.tsx` sits next to a Launch action: the rail row (idle, with specs, one
engine), the mission rail card and the Flow hand-off card (`AgentRailLaunchCard`) and the Run-a-loop
dialog. It reads `GET /api/projects/:id/launch-forecast` ([API](../../../docs/internals/api-reference.md)):
the **same measured samples** as the job story's "Runs like this have taken…" band
(`server/modules/execution/runtime/run-duration-stats.ts`), narrowed to the provider about to run, plus a
cost band and the tightest daily budget's headroom. Rules, all in `lib/launch-forecast.ts`:

- **Honest unknowns.** Below the server's 5-sample floor there is no band: the line says "Not enough
  history yet" (tooltip: what it needs). Nothing is averaged, defaulted or guessed; an unreachable endpoint
  renders nothing.
- **Estimate, never a bill.** The tooltip says "Estimate from N past runs — not billed cost". The cost band is
  built server-side from provider-reported costs only (estimated costs and runs without a cost never enter it) and
  is never summed with a billed figure.
- **Dollars only when metered.** `isMeteredBilled` reads the machine's subscription-usage snapshot
  (`GET /api/subscription-usage`): the figure shows only when the provider is positively API-key billed
  (`unsupported-auth`) or on-demand enterprise. On a plan (`isPlanBilled`), while the snapshot has not answered,
  or when it does not say, the line shows time only: a plan user never sees a `$`.
- **Budget caution.** `budgetOutlook` compares, in integer cents, today's spend plus the top of the cost band with the
  daily budget: "May pause at budget" (or "Daily budget reached" when the gate would already refuse). It links to
  `openProjectSettings('budget')` or `openAppSettings('advanced')` for an app-wide budget. With the budget
  already reached, `hooks/useLaunchBudgetGuard` makes Play / Run / Launch ask first ("Launch anyway?"); it never blocks.
- Idle rails pass `hideWhenInsufficient` (no repeated "Not enough history yet") and `perSpec` when they hold several specs.
- Forecasts are cached 30 s per project/loop/provider (`fetchLaunchForecast`) and shared between rails.

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

A bulk change (board multi-select) pushes ONE grouped entry whose `undo` reverses every spec it
changed; see [specs: multi-select](specs/README.md#multi-select-bulk-actions-and-saved-views).

Deletes are soft (specs and missions stay restorable for 30 days under project
settings → Recently deleted, `settings/components/RecentlyDeletedSection.tsx`).
Keep a confirm only for what cannot be reversed: discarding unpushed work,
force-closing a PR, removing a project, deleting permanently, and deleting a
mission whose agent turn is still running.

## Command palette as an action hub (⌘K)

[`components/CommandPalette.tsx`](../components/CommandPalette.tsx) searches missions, projects
and jobs and runs **actions**. The registry is
[`components/command-palette/palette-actions.ts`](../components/command-palette/palette-actions.ts):
each action has an `id`, i18n label, `group`, icon, `shortcut` (shown through `keyboardLabel`),
`when(ctx)` availability, `run(ctx, arg)` and an optional `page(ctx)` for an argument.

- **Actions own no business logic.** They call what the buttons call. The surface that owns a
  handler registers it with `useRegisterPaletteSurface(key, surface)`
  ([`lib/palette-bridge.ts`](../lib/palette-bridge.ts)): the specs column (`specs`: New spec /
  Explore), the dashboard (`board`: launch on rail through `handleToggle` and its gates, status
  move with Undo or the Jira workflow move, review path), the Flow strip (`flow`: the very
  Pause/Resume/Hand off controls, disabled ones are not offered), the specs board's multi-selection
  and saved views (`selection`: Select all in column, bulk Move / Label / Priority / Add to rail /
  Launch / Delete while specs are selected, Save current view, Switch view). A surface that is not mounted is
  absent, so its actions are hidden. A surface is an object of functions; the registry stores a
  facade that forwards to the latest render, so lists are read fresh, never snapshotted.
- **Adding an action:** append to `PALETTE_ACTIONS`, add its label to `commands:palette.actions`
  in all 8 locales (the locale test fails otherwise), and give it a `when` that mirrors the
  button's own guard. Need a new handler from a feature? Add a surface key and register it there;
  never import a feature page into the palette.
- **Ranking.** The Actions group leads when the query starts with `>` or a verb (the locale's
  `palette.actions.verbs` list, or 3+ letters of one), otherwise it trails the existing groups.
  `>` alone shows only actions. Hard caps: `MAX_ACTION_ROWS` leading, `MAX_TRAILING_ACTION_ROWS`
  trailing. Existing mission/project/spec/job groups and their ranking are untouched.
- **Argument pages** (cmdk pages): a stack of `ArgPage`s inside the same dialog (never a nested
  dialog). Backspace on an empty query, or the back chevron, pops one. Options may `load()` async
  (loops, Jira workflow statuses), may be `disabled` with a hint (running rail, blocked spec), and
  may lead to a further page (pick a spec, then a rail). The spec an action defaults to is the one
  open in the detail modal (`?spec=`); the palette sits on the `stacked` layer so it opens over it.
- **Empty query:** *Recent actions* (last 5 ids, per viewer, `localStorage` in try/catch, only
  those still available) and *Recent places* (`usePlaceHistory().recent()`: last distinct places of
  the active project; selecting one *pushes* it). The palette itself is never a place.
- **Scoped search (CD6).** A leading prefix narrows ⌘K to one source: `#` specs, `@` missions, `/` settings,
  `f:` files, `log:` job logs, `?` the guide ([`search-scopes.ts`](../components/command-palette/search-scopes.ts)).
  The prefix becomes a chip in the input (the input then holds only the query); Backspace on an empty input, or the
  chip's ×, removes it; an empty unscoped input lists the prefixes as buttons. `>` actions and the unscoped groups are
  unchanged, except that a strong settings match (3+ characters) adds a small *Settings* group (cap
  `UNSCOPED_SETTINGS_CAP`). Per-scope row caps live in `SCOPE_ROW_CAPS`.
  - **Sources.** `#` → `GET /search/specs`, `log:` → `GET /search/jobs` ([API](../../../docs/internals/api-reference.md)),
    `f:` → the code explorer's `GET /code/find` (selecting opens `/code?path=`), `?` → `GET /api/docs/search` (selecting
    calls `openDocs` at the heading), `@` → the existing mission search. The remote scopes share one debounced, abortable
    hook ([`useScopedSearch.ts`](../components/command-palette/useScopedSearch.ts)); an answer is only used for the
    scope/project/query it was asked for. `#`, `f:` and `log:` need an open project.
  - **Highlights are ranges, never HTML.** Servers send `{ text, ranges }`; client-side matches (titles, paths,
    settings) are computed by `rangesForQuery`. [`SnippetText`](../components/command-palette/SnippetText.tsx) renders text
    nodes and `<mark>` after `sanitizeRanges` (integers, in bounds, sorted, merged), so markup in a spec title shows
    literally.
  - **Settings registry** ([`settings/lib/settings-registry.ts`](settings/lib/settings-registry.ts)): one typed entry per
    settings block (`id`, `scope` app\|project, `section`). Copy lives in `commands:palette.settings.entries.<id>.label|keywords`
    (all 8 locales, keywords per locale). Each block carries `data-setting-id="<id>"` (`SettingAnchor`, or `data-setting-id` on
    `SettingsCard`). Selecting a row calls `openAppSettings(section, id)` / `openProjectSettings(section, id)` (Board mode:
    `/settings?setting=<id>`); the dialog or page then runs `focusSettingAnchor` (waits for the pane to be visible, scrolls,
    focuses the first control, outlines the block for ~2 s). `lib/__tests__/settings-registry.test.tsx` mounts both surfaces and
    fails on a registry id without an anchor (or an anchor without an entry). **Adding a setting block:** add the anchor, the
    registry entry and its label/keywords in the 8 locales.
- **Settings sections** are deep links: `openAppSettings(section)` and
  `openProjectSettings(section)` ([`lib/app-settings-events.ts`](../lib/app-settings-events.ts));
  Board mode shows project settings on `/settings`.
