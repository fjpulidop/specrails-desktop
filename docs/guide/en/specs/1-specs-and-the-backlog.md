# Specs & the backlog

A **spec** is the unit of work the AI pipeline implements. Think of it as a ticket: a title, a description of what you want done, a priority, and optional labels. When you launch the pipeline, the AI agents read the spec and act on it — so a clear spec is the single most important input to a good result.

Specs are sometimes called **tickets** in the app — the two words mean the same thing.

## The board

Every project opens on its **Dashboard**, which shows the **SpecsBoard** — the list of all the project's specs. This is your backlog. From here you create new specs, set their priority, drag them onto a rail to implement them, and watch their status change as work happens.

The board has two view modes, switched from a toolbar toggle and remembered per project:

- **Post-it view** (the default) — card-style tiles with short summaries.
- **List view** — compact one-line rows.

The toolbar's **status selector** shows every status as its own chip with a live count — plus two smart buckets: **Active** (the default — everything still moving: drafts, todos, in-progress and on-review specs) and **All** (everything, with Done pinned at the bottom). Your pick is remembered per project and mirrored to the URL, so a refresh or a shared link restores the exact view. On Jira-connected projects an extra **Jira status** dropdown appears, listing the board's *real* workflow statuses (their raw names, e.g. "Code Review", each with a live count) grouped under the state they map to — it combines with the status chips. You can also filter by **label**, and sort by **Default**, **Ticket #**, or **Priority** (each with an ascending/descending toggle).

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

To create a spec, click **Add** (the Plus button on the SpecsBoard toolbar). The **Add Spec** dialog opens with a few ways to work:

- **Quick mode** — you describe what you want and the AI writes the full spec in one shot. See [Add Spec — Quick mode](add-spec-quick-mode.md).
- **Explore mode** — you converse with the AI, and it helps you shape the spec turn by turn. See [Add Spec — Explore mode](add-spec-explore-mode.md).
- **Raw mode** — whatever you type is saved verbatim as a spec, with no AI involved. Use it when you already have the spec text written.

Which one you reach for depends on how clear the idea already is. Know exactly what you want? Quick. Still figuring it out? Explore. Already have the text? Raw.

## Where to go next

- [Add Spec — Quick mode](add-spec-quick-mode.md) — the fastest way to turn an idea into a spec.
- [Add Spec — Explore mode](add-spec-explore-mode.md) — shape a spec in conversation.
- [Drafts & the Contract Layer](drafts-and-contract-layer.md) — save work in progress and enrich specs for the pipeline.
