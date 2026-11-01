# flow

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

<!-- audit-client-features:begin (generated: public subpaths and feature dependencies; edit outside this block) -->
## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/IntentMissionsBridge.tsx](components/IntentMissionsBridge.tsx)
- [components/StartInIntent.tsx](components/StartInIntent.tsx)

## Feature dependencies

- [background](../background/README.md)
- [missions](../missions/README.md)
- [providers](../providers/README.md)
- [rails](../rails/README.md)
- [specs](../specs/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.
<!-- audit-client-features:end -->

## Mission extension slots

`IntentMissionsBridge` fills the missions seam: the `flow-offer` fence card, the
conversation mode (`useFlowConversationMode`: while an Intent session is open the
composer's **Intent** chip and placeholder, "In Intent" by the
mission title, no git strip; only an active Intent interrupts sends), the
Intent's runs in the mission's run strip (`useLiveRuns` → [`IntentLiveRuns`](components/IntentLiveRuns.tsx)),
the words for the steps of Intent → Spec (`describeRun` → `describeFlowRun`),
the mission list's "In Intent" mark (`useConversationMarks` →
[`IntentConversationMarks`](components/IntentConversationMarks.tsx), fed by
`GET /flow/open` and `flow.state`) and, from the same app-wide watch, its
attention dot for Intent runs (`useRunAttention` → `useFlowRunAttention`, live
whether or not the mission is open; one rule with the strip's tone in
[`lib/intent-run-tone.ts`](lib/intent-run-tone.ts): no open Intent state waits for
the person today, paused and needs-review are calm, and an Intent session → Spec run
that fails or waits is a delivery that feeds the dot itself), the state announcements
(`ConversationDock` → `IntentDock`, said through the run strip's one live
region), the per-turn mark (`useTurnMark`), the run card's Back to Intent / Relaunch
(`IntentRunCardActions`, Back to Intent is the run's declared `local` primary) and
`RunFailureOutcome` (`IntentRunFailure`): an Intent session → Spec run that failed outright
is explained in the person's words — a localized headline per failing step
([`lib/intent-failure.ts`](lib/intent-failure.ts) maps the recipe's step ids), the
runtime's error as the cause, what happens next, the actions or "Returned to
Intent", and the codes only under **Technical details**. Intent API refusals read
by code (`flowErrorMessage`); the server detail is never the headline.

## Intent from an existing spec

[`StartInIntent`](components/StartInIntent.tsx) is the door for a spec that
already exists, always next to the Implement door, never instead of it.
Specs never import Intent: App.tsx provides `FLOW_SPEC_EXTENSIONS` through the
specs seam ([SpecExtensionsContext](../specs/context/SpecExtensionsContext.tsx)
`StartAlternative`): `StartInFlowMenuItem` in the board's spec context menu
(`extraItems` of `TicketContextMenu`) and `StartInFlowButton` in the spec
detail header (next to **Move to Rail**). `IntentRailLaunchAlternative` fills
missions' `RailLaunchAlternative` slot on a rail-launch card of one spec. `startInFlowBlock` mirrors
the server's checks (in Intent, done/cancelled, on a rail or running, Intent
unavailable) and the disabled action says why. `useStartInFlow` starts the
Intent in the spec's own mission, else in a new mission pinned to the project
and titled after the spec, then opens it. A `flow-offer` block with
`ticketId` shows the spec ("Spec #N · title") and spec-specific hints;
`IntentEntryCard` with `ticketId` names the spec and explains that it is
rewritten from what was built (its text kept as a comment).

## Intent in the run strip and the hand-off

The Intent is one entry of the mission's run strip, keyed `flow:<id>` so the
strip morphs in place. Its row stays short: "Intent · 7 files", Pause (or
Resume Intent) and the primary **Hand off**
([`IntentStripControls`](components/IntentStripControls.tsx)); disabled controls
say why. While the strip has focus, **P** pauses or resumes and **H** hands
off (`IntentBarControl.shortcut`, named in the tooltip); never globally. The chevron opens `IntentPanel`: the copyable branch, a files ± stat
that opens `IntentChangesDialog`, the billed cost (with a visible note when
partial), Preview and **Discard** set apart (`IntentDiscardDialog` lists what is
lost). `useFlowLiveStats` measures diff and cost once per Intent and polls only
while the agent works and the page is visible. A needs-review Intent is
informational (`info` tone): its panel keeps the branch and stats and offers
only **Close this Intent** (`IntentCloseDialog`, branch kept; `POST …/close`). **Hand off** turns the entry
into "Ready to turn into a PR" — a calm `info` tone (no bell, no attention
dot: the person just asked for it) — and opens `IntentHandOffCard` as the
strip's panel: ONE line ("Rail 2 will turn your 7 changed files into a
reviewed PR. If it fails, your work is safe.") with **Launch** and **Not
yet**, and the engine fallback note right under it when relevant; rail,
engine, model and effort are prefilled under **Change how** (with the files ±
and cost so far). Only **Not yet** and Esc dismiss it (the entry's
`onPanelClose` seam hears `escape`); a click outside, the toggle or another run
only fold the panel (`collapse`): the strip keeps "Ready to turn into a PR" and
offers Launch as its primary (`wantsPrimary`). The choices (rail, engine,
model, effort) are kept per Intent in `IntentContext.handOffDrafts` and restored
when the hand-off reopens; a launch clears them.
**Launch** is declared as an outward primary; while the request runs
(`IntentContext.launching`) and until the run's own entry shows (the hand-off
receipt, `yieldsTo` its delivery) the strip is a launching skeleton. After
`HAND_OFF_SHOW_TIMEOUT_MS` (45 s) without the run it stops spinning: "Still
handing off to Rail N…" with **Refresh** (re-reads the run cards and drops
the receipt, so the Intent state rules). Every Intent entry keeps the Waves mark;
the strip badges it with the state's shape. The offer stub's **View run** opens the run through missions' focus
bus.

## Repository target

In a workspace (folder primary) or a project with several Git repositories,
`IntentEntryCard` shows where the Intent runs: the Git members from
`GET /api/projects/:id/repositories` (`flowApi.repositories`,
`flowRepositoryChoice`), preselected from the `flow-offer` block's
`repositoryId`. It sends `repositoryId` only for such projects; a
single-repository project never shows or sends it.
The picker is `IntentRepositoryPicker` (Git members only, one tab stop, arrow
keys / Home / End). "Start in Intent" from the board or the spec detail reuses
it in `IntentRepositoryPrompt` (a dialog provided by `IntentMissionsBridge`) when
the project has several Git members and the spec does not name exactly one:
the spec's repository, else the Git primary, is preselected and the pick is
sent as `repositoryId`. The mission rail-launch card's "Start in Intent"
(`IntentRailLaunchAlternative`) asks the same way.

Run the adjacent tests with `npm run test --prefix client -- src/features/intent`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.
