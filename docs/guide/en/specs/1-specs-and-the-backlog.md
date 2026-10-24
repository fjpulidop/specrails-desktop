# Specs & the backlog

A **spec** is the unit of work the AI pipeline implements. Think of it as a ticket: a title, a description of what you want done, a priority, and optional labels. When you launch the pipeline, the AI agents read the spec and act on it — so a clear spec is the single most important input to a good result.

Specs are sometimes called **tickets** in the app — the two words mean the same thing.

## The board

Every project opens on its **Dashboard**, which shows the **SpecsBoard** — the list of all the project's specs. This is your backlog. From here you create new specs, set their priority, drag them onto a rail to implement them, and watch their status change as work happens.

The board has two view modes, switched from a toolbar toggle and remembered per project:

- **Post-it view** (the default) — card-style tiles with short summaries.
- **List view** — compact one-line rows.

The Specs toolbar has two rows. The first holds a **search** field (press `/` to jump to it; it matches title, `#number`, label or Jira key), a single **Filters** button, the sort and view controls, and **New spec**. The second row is the **status selector**: every status as its own segment with a live count, plus two smart buckets, **Active** (the default: everything still moving, so drafts, todos, in-progress and on-review specs) and **All** (everything, with Done pinned at the bottom). When the column is narrow, the less-used statuses fold into a **More** menu, and the status you picked always stays visible. Your pick is remembered per project and mirrored to the URL, so a refresh or a shared link restores the exact view. **Filters** opens one panel with a section per dimension: **labels** (multi-select), and on Jira-connected projects **epic**, **sprint** and **Jira status** (the board's *real* workflow statuses, e.g. "Code Review", grouped under the state they map to, combining with the status selector). While a search or filter narrows the board, a third row lists each one as a removable chip, shows "x of y" specs, and offers **Clear all** (which keeps your status pick). Sort by **Default**, **Ticket #** or **Priority**, each with an ascending/descending toggle.

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

## Where to go next

- [Add Spec — Quick mode](add-spec-quick-mode.md) — the fastest way to turn an idea into a spec.
- [Add Spec — Explore mode](add-spec-explore-mode.md) — shape a spec in conversation.
- [Drafts & the Contract Layer](drafts-and-contract-layer.md) — save work in progress and enrich specs for the pipeline.
