# Creating specs

A **spec** in specrails-desktop is a description of work you want done — what the AI agents will read and act on. This guide walks through every way you can create, refine, compare, and organise them.

Specs are engine-agnostic: depending on how the project was set up, they can
be shaped by **Claude, Codex, Gemini, or Kimi**. Engine selectors show only
providers that advertise the surface's required capability. Kimi is available
for agentic Explore/proposal work, but its `-p` mode cannot enforce the
no-tools/read-only boundary required by Quick Spec and the structured
transforms listed below.

## Creating a spec

Open the Dashboard and click **Add** (the Plus button on the SpecsBoard toolbar). The **Add Spec** dialog opens with three modes:

- **Quick** — you describe what you want; the AI writes the full spec.
- **Explore** — you converse with the AI and shape the spec turn by turn.
- **Raw** — your prompt is saved verbatim as a spec, with **no AI** involved.

If the project has **more than one compatible provider installed**, an **AI
engine** selector sits at the top of the dialog. The choice is remembered per
project. Projects with a single compatible provider don't show the selector;
Kimi is not offered for Quick Spec even when it is installed.

### Quick mode

For when you already know what you want. Type your idea; the AI generates the full spec. This is usually a single turn — but it runs multi-turn when you give it the full codebase (the context slider's higher presets) or attach files, so it can read what it needs first.

> **Kimi:** Quick Spec is unavailable. The server rejects a direct Kimi
> request before spawning because this form is a pure-output action. This is
> separate from the agentic **Quick Launcher**, where commands such as
> `/opsx:ff` can run with Kimi. Use Explore, Raw, or that launcher instead.

**Controls:**

- **Engine + model** — the engine selector (multi-provider only) and a model picker. The model defaults to a sensible choice for the engine and can be overridden per spec.
- **Context slider** — Quick mode shows the same context preset slider as Explore, capped at the **Max** preset (see the table below).
- **Fine-tune** — expand to toggle the underlying flags by hand, including **Enrich with Contract Layer**.
- **From a website** — when the browser-capture feature is enabled, this opens an embedded browser so you can capture a page (DOM, screenshots, network) and turn it into a spec.
- **Attachments** — drop mockups, briefs, or data files into the idea field. Attachments give the AI more to work with (and switch Quick generation to multi-turn).

**Enrich with Contract Layer** appends a structured block to the generated description so downstream agents don't have to guess names or shapes:

- **Naming Contract** — exact identifiers to reuse
- **Data Shapes** — JSON-ish payloads
- **State Machine** — transitions
- **Invariants** — must-hold properties
- **File Touch List** — files the implementation will edit

Your last choice for this toggle is remembered per project.

Contract Layer enrichment requires a provider that can enforce the structured
action's safe tool policy. It is hidden for Kimi because Kimi 0.27 prompt mode
auto-approves tools and has no per-spawn no-tools boundary. A direct request
fails before spawn.

While the spec is being generated, a toast in the corner shows the project name, a truncated copy of your idea, and the **elapsed time** ("Generating… 0:12"). When it finishes it switches to "Generated in <time>" with a **View** action that jumps straight to the new spec.

### Explore mode

For when the spec needs shaping. You converse with the AI; a live draft updates each turn.

**Context preset slider** — pick how much the AI sees before it answers. Each preset flips a set of concrete flags:

| Preset | What the AI sees |
|--------|------------------|
| Minimal | Just your message — nothing else loaded. Fastest and cheapest. |
| Light | + your specrails tickets (`.specrails/local-tickets.json`). |
| Standard | + specrails tickets **and** OpenSpec specs. |
| Rich | + full-codebase read access (Read / Grep / Glob). |
| Max | Rich, plus a **Contract Layer** enrichment pass. |
| Desktop | Max, plus **project MCPs** (`.mcp.json`) **and your own approved MCP servers**. |

Rich and Max both load the full codebase — they differ only in whether the Contract Layer pass runs. The decision is per-conversation (saved on `chat_conversations.context_scope`) so it doesn't bleed into other Explore sessions.

Kimi supports the agentic Explore conversation and proposal flow. It does not
offer the Max Contract Layer pass. Its prompt mode may use tools
autonomously—Explore is not a read-only sandbox.

The **Desktop** preset is Explore-only — Quick mode caps the slider at **Max** (no project/approved MCPs), as noted under [Quick mode](#quick-mode) above.

Click **Fine-tune** to set the flags individually. One toggle only appears here:

- **My approved MCPs** — loads the MCP servers you've already approved locally (`claude mcp add` / `codex mcp add`) without changing where the spawn runs. Explore-only; disabled in Quick mode. On a **Gemini** project, Gemini reads your own approved MCP servers from its native config (`~/.gemini`) automatically, so this toggle isn't needed there. Kimi's user-global MCP source cannot be isolated per spawn, so this opt-in is unavailable for Kimi; project `.kimi-code/mcp.json` remains supported.

**Buttons in the shell:**

- **Save as Draft** — persists the conversation as a draft ticket so you can come back later. Available once you've sent at least one user message. The draft carries `origin_conversation_id` pointing back at this conversation so you can resume it from the dashboard.
- **Review →** — opens a Review overlay that diffs the proposed spec against the baseline before you commit.
- **Create Spec** — promotes the live draft to a real spec (status `todo`). When you're editing an existing spec the same button reads **Update Spec** instead. The conversation stays in history.
- **Minimize** — parks the conversation as a chip in the minimized-chats dock; click the chip later to restore it.
- **Discard** — destructive, asks for confirmation.

### Raw mode

No AI. Whatever you type is saved verbatim as a spec, with a title (auto-derived from the first line, editable), a priority, and optional labels. Use it when you already have the spec text and just want it on the board.

## Drafts

A draft is an in-progress Explore conversation saved as a ticket with status `draft`. Drafts behave like normal tickets but:

- Carry a `Draft` pill where the priority pill would be.
- Live in the active (Todo) bucket with a subtly tinted border — there's no separate Backlog column.
- Have a **Continue Editing** action in the detail modal that re-opens the original conversation with its full chat history.

Drafts are never auto-deleted. You either discard them explicitly or commit them to a real status.

> Pro tip: when you're not sure if a spec is worth doing, save it as a draft and let it sit. The next morning, open the draft, glance at the description, and decide.

## Compare two specs side by side

Open any spec modal. Then either:

- **Drag the modal header** toward the left or right edge of the screen — once you cross 20% of the viewport it snaps to a half-screen panel and a picker of your other todo specs appears on the opposite side.
- **Click "Compare"** in the modal toolbar — same result, no drag.

```
Drag left:                          Drag right:
┌────────┬─────────┐                ┌─────────┬────────┐
│ Spec A │ Picker  │                │ Picker  │ Spec A │
│        │ ┌─────┐ │                │ ┌─────┐ │        │
│        │ │ #2  │ │                │ │ #2  │ │        │
│        │ │ #5  │ │                │ │ #5  │ │        │
│        │ └─────┘ │                │ └─────┘ │        │
└────────┴─────────┘                └─────────┴────────┘
```

Click a picker card and that side becomes a second detail modal — now you have two specs open side by side, fully interactive.

**Resize the split** by dragging the vertical divider, or focus it and use arrow keys / Home / End / 0. The ratio is clamped between 25% and 75%.

**Exit rules:**

- Backdrop click → close both.
- `×` on the *original* (origin) side → close both.
- `×` on the *other* side → return that side to the picker.
- Open a third spec from a link inside either panel (e.g. an epic chip in the SMASH sidebar, or **Continue Editing** on a draft) → split-view collapses and the third spec opens centred.

**URL persistence:** the comparison is encoded in the URL as `?compare=<id>&compareSide=<side>&compareOrigin=<id>`, so a page refresh restores the split.

**Viewport:** disabled below 900px. If you shrink the window while in split, the app collapses cleanly to a centred modal.

## SMASH a big spec

Got an epic that's clearly too big? Open it and click **SMASH Spec into Sub-Specs** in the toolbar. The AI decomposes it into a family of sub-specs. Each child:

- Gets `parent_epic_id` pointing back at the epic.
- Carries an execution order (the SMASH agent decides the right order).
- Carries a short summary surfaced on its postit card. The agent is asked to keep it to ~120 characters; the server hard-caps it at 240 characters as a safety net.

Inside the epic's modal you'll see an **Epic Family Sidebar** listing all children. Inside each child's modal, an **Epic Breadcrumb** lets you jump back to the parent. If the epic already has children, the button reads **Re-SMASH** and regenerates the family (after a confirmation).

SMASH and Re-SMASH are unavailable for Kimi: both require a constrained
structured transform, and Re-SMASH can delete existing children. Desktop
checks the capability before any spawn or deletion, so a direct Kimi request
leaves the existing family untouched.

## Continue Editing — refine an existing spec

For any spec with status `draft`, `todo`, or `backlog`, the detail modal shows a **Continue Editing** button. Click it and:

1. The spec opens in a fresh Explore shell with the draft pane pre-seeded with the current title, description, priority, labels, and acceptance criteria.
2. If the spec was originally an Explore draft (i.e. it has `origin_conversation_id`), that original conversation is resumed — you see the chat history.
3. You type the first refinement. The AI updates the live draft.
4. The Review step shows a real diff against the current spec before you commit.
5. On commit, the spec is PATCH-ed — no new ticket is created.

Continue Editing works from the dashboard or from inside a split-view comparison — triggering it from a split-view panel collapses the comparison automatically because the shell needs the full screen.

The AI Edit/refine operation is unavailable for Kimi because its output-only
rewrite contract must not be able to mutate the workspace through tools.
Manual edits and a separate Kimi Explore proposal remain available.

The Contract Layer (if a spec has one) is shown inside the detail modal as a collapsible disclosure with an `N/5 populated` badge. You can re-run the enrichment for a single ticket from there.

## Status visuals

Every spec card shows a status indicator that stays consistent across view modes:

| Status | Indicator | Border |
|--------|-----------|--------|
| `draft` | Accent-secondary dot, `Draft` pill | Subtle accent-secondary tint, dashed on postit |
| `todo` | Gray dot, muted text | Dashed left border |
| `in_progress` | Blue pulsing dot, bold text | Solid blue left border |
| `done` | Green checkmark, dimmed text | Solid green left border |
| `cancelled` | Red X, dimmed text | No border |

## Filtering and sorting

The SpecsBoard toolbar always shows these four controls plus the Add button:

- **Status filter** — a single-select dropdown with three values: **All**, **ToDo**, **Done**. Defaults to **All**, which shows everything (including drafts and done specs).
- **Label dropdown** — multi-select across every label used in the project.
- **Sort** — **Default**, **Ticket #**, or **Priority**, each with an ascending/descending toggle.
- **View toggle** — switch between List view and Post-it view (see below).

Two more filters appear **only once your board has the data for them**, so don't be surprised if you see five or six controls. Both are surfaced only on **Jira-linked** projects:

- **Epic filter** — appears once at least one spec carries a Jira epic, letting you narrow the board to one epic's children.
- **Sprint filter** — appears when specs carry Jira sprint data.

On a **Jira-linked** project the Sort dropdown also gains a fourth mode, **Jira key**, so you can order the board by Jira ticket number.

Priority itself is set per spec from the right-click menu (below), not from a toolbar filter — there is no priority filter and no search box on the board.

## Right-click context menu

Right-click any spec card (in any view mode):

- **Delete ticket** — with confirmation.
- **Change status → Todo / Done**
- **Set priority → Critical / High / Medium / Low**

On a **Jira-backed** spec the first item changes from **Delete ticket** to **Move to `<status>`** (which transitions the linked Jira issue) with a separate **Discard** flow, since a Jira-backed spec can't simply be deleted locally.

## View modes

The SpecsBoard has **two** view modes, switched from a toolbar toggle and remembered per project:

- **List view** (`row`) — compact one-line rows.
- **Post-it view** (`postit`, the default) — postit-style cards with short summaries; drag a card onto a rail to queue it.

(The separate List / Grid / Post-it picker you may see elsewhere — like the split-view comparison picker — is its own surface and unrelated to this toggle.)

## What happens behind the scenes

You don't need this to use the feature, but it's nice to know:

- Specs live in `<project>/.specrails/local-tickets.json` (a JSON store).
- A file watcher catches external edits (e.g. when an agent flips a spec to `in_progress`) and broadcasts a WebSocket event, so the board updates instantly.
- Every AI CLI invocation that actually creates or refines a spec is recorded in your analytics under one of these surfaces:
  - `quick-spec` — Quick mode generation (and the Quick-mode Contract Refine pass).
  - `explore-spec` — every Explore conversation turn (and the Explore Contract Refine pass).
  - `ai-edit` — Continue Editing / AI Edit refine turns.
- Drafts are linked to their conversation via `origin_conversation_id`. Deleting a draft cascades to its conversation when no other ticket references it; deleting a conversation clears the field on any linked tickets.

## Where to go next

- [Running pipelines](running-pipelines.md) — drag those specs onto rails and launch the implementation pipeline.
- [Tracking cost](tracking-cost.md) — see what each spec is costing you.
- [Customising the app](customizing.md) — set a daily budget so you can stop worrying.
- [Using Codex](codex.md) / [Using Gemini](gemini.md) — provider-specific notes if you generate specs with Codex or Gemini.
- [Using Kimi](kimi.md) — agentic spec surfaces and the structured actions that fail closed.
