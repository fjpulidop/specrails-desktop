# Specs & the backlog {#specs-backlog}

A **spec** is the unit of work the AI pipeline implements. Think of it as a ticket: a title, a description of what you want done, a priority, and optional labels. When you launch the pipeline, the AI agents read the spec and act on it — so a clear spec is the single most important input to a good result.

Specs are sometimes called **tickets** in the app — the two words mean the same thing.

## The board

Every project opens on its **Dashboard**, which shows the **SpecsBoard** — the list of all the project's specs. This is your backlog. From here you create new specs, set their priority, drag them onto a rail to implement them, and watch their status change as work happens.

The board has two view modes, switched from a toolbar toggle and remembered per project:

- **Post-it view** (the default) — card-style tiles with short summaries.
- **List view** — compact one-line rows.

The Specs toolbar has two rows. The first holds a **search** field (press `/` to jump to it; it matches title, `#number`, label or Jira key), a single **Filters** button, the sort and view controls, and **New spec**. The second row is the **status selector**: every status as its own segment with a live count, plus two smart buckets, **Active** (the default: everything still moving, so drafts, todos, in-progress and on-review specs) and **All** (everything, with Done pinned at the bottom). When the column is narrow, the less-used statuses fold into a **More** menu, and the status you picked always stays visible. Your pick is remembered per project and mirrored to the URL, so a refresh or a shared link restores the exact view. **Filters** opens one panel with a section per dimension: **labels** (multi-select), and on Jira-connected projects **epic**, **sprint** and **Jira status** (the board's *real* workflow statuses, e.g. "Code Review", grouped under the state they map to, combining with the status selector). While a search or filter narrows the board, a third row lists each one as a removable chip, shows "x of y" specs, and offers **Clear all** (which keeps your status pick). Sort by **Default**, **Ticket #** or **Priority**, each with an ascending/descending toggle.

### Selecting several specs

Triage in bulk instead of one spec at a time. Press `x` on a focused card, `Ctrl`/`⌘`-click a card, or `Shift`-click to select a range (a range stays inside one column: the active specs or the Done bucket). `Ctrl`/`⌘`+`A` selects the whole column you are in, and `Esc` clears the selection. Each card shows a checkbox when you hover or focus it; selected cards get a highlighted border. None of these keys act while you are typing in the search field.

As soon as one spec is selected, a bar floats at the bottom of the board with the count and the actions:

- **Move to** changes the status. Local specs get the local statuses; specs that come from Jira get the Jira board's real workflow statuses and move through the same Jira queue as a single move.
- **Label** adds a label to the selection, or removes one the specs carry.
- **Priority** sets one priority for all of them.
- **Add to rail** puts the selection on a rail.
- **Launch all** gives each selected spec its own free rail and starts them in parallel, after the same confirmation and daily-budget check as *Launch all* on the rails. Specs that cannot launch yet (for example, on review without an open PR) or that find no free rail are skipped and counted in the summary.
- **Delete** removes them to *Recently deleted*.
- **Clear** (or `Esc`) drops the selection.

Delete, status, label and priority changes are undoable as one step: a single *Undo* toast (or `⌘Z`) restores every spec it changed. If some specs fail, one toast says how many worked and how many did not. The selection only ever holds specs you can see: a filter that hides a selected spec drops it from the selection.

### Saved views

The **Views** button next to **Filters** saves the board as you have it now: the status selector, the filters, the sort and the density (not the search text). Choose **Save current view…**, name it ("Ready to launch", "Sprint 42", "Failed this week") and pick it from the same menu later. **Manage views…** renames a view, updates it from the board as it is now, copies its link, or deletes it. Views belong to the project. A copied link (`?view=…`) applies the view when opened in this app, and the command palette (`⌘K`) can save the current view or switch to another.

## Statuses

A spec moves through a small set of statuses. The board gives each one a consistent visual cue so you can read the state of your backlog at a glance:

| Status | What it means |
|--------|---------------|
| **Draft** | An in-progress idea saved from an Explore conversation. Not ready to implement yet — you can come back and keep shaping it. Shows a `Draft` pill. |
| **Todo** | Ready to be picked up. This is where a finished spec lands when you create it. |
| **In progress** | The pipeline is currently working on it (a pulsing blue dot). |
| **On review** | Implemented — every finished run parks its specs here for your approval: merge the draft PR or move them on yourself (an amber pill). |
| **Done** | Approved — its PR was merged, or you moved it here yourself (a green checkmark). |
| **Cancelled** | Abandoned (a red X). |

Drafts live in the same active bucket as Todo specs — there's no separate column for them — but they carry a subtly tinted border and a `Draft` pill so they're easy to spot. See [Drafts & the Contract Layer](drafts-and-contract-layer.md) for the full story on drafts.

## Priorities

Every non-draft spec has a priority: **Critical**, **High**, **Medium**, or **Low**. Priority is purely an organising tool — it helps you decide what to implement next and lets you sort the board. You set it when you create a spec, and you can change it any time by right-clicking the spec card and choosing **Set priority**.

Drafts are the one exception: a draft can have *no* priority at all, because it's still an idea in progress. The priority gets locked in when you commit the draft to a real spec.

## Creating a spec

To create a spec, click **New spec** (the Plus button on the SpecsBoard toolbar). The **Add Spec** dialog opens with a few ways to work:

- **Quick mode** — you describe what you want and the AI writes the full spec in one shot. See [Add Spec — Quick mode](add-spec-quick-mode.md).
- **Explore mode** — you converse with the AI, and it helps you shape the spec turn by turn. See [Add Spec — Explore mode](add-spec-explore-mode.md).
- **Raw mode** — whatever you type is saved verbatim as a spec, with no AI involved. Use it when you already have the spec text written.

Which one you reach for depends on how clear the idea already is. Know exactly what you want? Quick. Still figuring it out? Explore. Already have the text? Raw.

## Addenda — iterating on an existing spec

When a spec already has work behind it — a PR under review, a merged feature — and you want *more*, don't rewrite its description: that drifts the spec (and syncs the drift to Jira) and makes the next run re-plan everything. Open the spec and add an **addendum** instead: a short note with a kind (change request, review feedback, clarification, constraint) and your words. Open addenda ride automatically into the next launch of that spec on any loop — Implement, SDD Quick, Freestyle — so the run changes only what you asked, and the review packet reports each one as applied, partially applied or blocked. If the run fails or you discard the delivery, they return to **Open** on their own. The mission agent can add them for you when you ask it to change something about an existing spec.

## Reviewing a delivery — what to look at first

When a run finishes, its review packet opens with **What to look at**: the AI reviewer's short brief listing the riskiest spots first (high, then medium, then low, each with a file and line), the behaviour that changes, the rules the change leans on, the code paths no test exercises and the checks only a person can do. The same risks, untested paths and checks appear in a short block at the top of the pull request, and the mission card shows the top risk in one line. The brief is advice for your review, not a verification result: it never blocks Accept. Runs made with an older Specrails Core have no brief, and their packet looks as before.

## Undo, and Recently deleted {#recently-deleted}

Deleting a spec, moving it to another status, changing its labels or taking it off a rail all happen at once — there is no "Are you sure?" first. Instead a toast offers **Undo** for about eight seconds, and **⌘Z** (**Ctrl+Z** on Windows and Linux) does the same while you are not typing in a field. Undo is per project: switching project closes the window.

A deleted spec (and a deleted mission) is not gone. It moves to **Settings → Recently deleted** in the project settings, where you can **Restore** it for 30 days or **Delete permanently**, which does ask first. After 30 days it is removed for good. Discarding unpushed work, force-closing a pull request and removing a project are the actions that still ask first, because they cannot be reversed. A Jira-backed spec is still moved with **Move to** rather than deleted.

## The spec timeline and hand-off {#spec-timeline}

Open a spec and switch to the **Timeline** tab to read its whole story in one place: the edits and addenda, the missions that touched it, every run with its phases and agent actions, the pull request events and the reviewer's verdict with its findings. Entries are grouped by day, the chips filter by kind, and each entry has a link to the mission, run or review it came from. Long groups (phases, agent actions, mission turns) are collapsed with a count and expand in place.

Cost appears next to the entry that spent it, with the two kinds kept apart: a figure the provider reported, and a figure estimated from the local pricing table (marked "est."). If a provider is billed through a plan, the timeline and the exports show turns, never dollars; a run that reported no cost simply shows none.

**Export hand-off** (the menu beside the tabs, or ⌘K → *Export hand-off for #N*) writes a Markdown file or a self-contained HTML page with the summary, the decisions (addenda, clarifications, reviewer verdicts), the diff stats, the cost and what is still open (open addenda and unresolved review findings). **Copy as PR description** (also in ⌘K) puts a shorter Markdown version on the clipboard. Headings follow the app language. Everything is passed through the same secret redaction the agent actions audit uses, and the toast tells you when something was hidden.

## Where to go next

- [Add Spec — Quick mode](add-spec-quick-mode.md) — the fastest way to turn an idea into a spec.
- [Add Spec — Explore mode](add-spec-explore-mode.md) — shape a spec in conversation.
- [Drafts & the Contract Layer](drafts-and-contract-layer.md) — save work in progress and enrich specs for the pipeline.
