# Drafts & the Contract Layer

This page covers two ways to get more out of your specs: **drafts** (saving an in-progress idea so you can resume it later) and the **Contract Layer** (an optional enrichment that makes specs more precise for the AI pipeline).

## Drafts: save an idea in progress

A **draft** is an in-progress [Explore](add-spec-explore-mode.md) conversation saved as a spec. It lets you stop mid-thought without losing anything and come back when you're ready.

### Saving a draft

While you're in an Explore conversation, click **Save as Draft** (available once you've sent at least one message). The app:

- Creates a spec with status **Draft** on your board.
- Gives it a title automatically if you didn't set one (a short summary of the conversation).
- Links it back to the conversation, so the full chat history is preserved.

Saving is idempotent — if you save the same conversation twice, it updates the existing draft instead of creating a duplicate.

### How drafts look on the board

Drafts live in the same active bucket as your Todo specs — there's no separate column. You'll spot them by:

- A `Draft` pill where the priority pill normally sits.
- A subtly tinted border on the card.

A draft is allowed to have *no priority* — you set the priority when you commit it to a real spec.

### Resuming a draft

To pick up where you left off:

1. Open the draft from the board.
2. Click **Continue Editing** in the detail modal.
3. The original Explore conversation re-opens with its full chat history, and the live draft pane pre-filled with everything you'd shaped so far.
4. Keep talking. When you're done, **Create Spec** promotes the draft to a real spec (status **Todo**, with the priority you choose).

### Discarding a draft

Drafts are **never auto-deleted**. They disappear only when you explicitly discard them, or when you commit them to a real status. Discarding a draft also cleans up its linked conversation when nothing else references it.

> Tip: when you're not sure a spec is worth doing, save it as a draft and let it sit. Open it the next morning, glance at the description, and decide with fresh eyes.

## The Contract Layer: precision for the pipeline

The **Contract Layer** is an optional enrichment that appends a structured block to a spec's description. Its job is to remove guesswork for the AI agents that implement the spec — so they reuse the right names, match the expected data shapes, and touch the right files instead of inventing their own.

### What it adds

The Contract Layer is five short sections appended to the spec:

- **Naming Contract** — the exact identifiers (functions, fields, routes) the implementation should reuse.
- **Data Shapes** — the JSON-ish payloads involved.
- **State Machine** — the transitions or states the feature moves through.
- **Invariants** — properties that must always hold true.
- **File Touch List** — the files the implementation is expected to edit.

Think of it as handing the pipeline a precise blueprint instead of a sketch. It's especially valuable for specs that plug into existing code, where the AI guessing a name or a shape would cause rework.

### How to add it

There are three ways the Contract Layer gets applied:

- **Quick mode** — flip the **Enrich with Contract Layer** toggle before generating. Your last choice is remembered per project. (See [Add Spec — Quick mode](add-spec-quick-mode.md).)
- **Explore mode** — choose the **Max** or **Desktop** context preset (which run the enrichment automatically on commit), or open **Fine-tune** and toggle it by hand. (See [Add Spec — Explore mode](add-spec-explore-mode.md).)
- **On an existing spec** — open the spec's detail modal and re-run the enrichment from there.

### Where it shows up

Once a spec has a Contract Layer, the detail modal shows it as a collapsible disclosure with a badge like `3/5 populated` — telling you how many of the five sections actually got filled in (some features simply don't have, say, a state machine, and those sections are marked as not applicable). Expand it to read the full contract; collapse it to keep the description tidy.

If the enrichment ever fails to run, the app surfaces a notification with a **Retry** action so you can fire it again.

### Is it always worth it?

Not always. For a small, self-contained spec the AI can implement fine without it. The Contract Layer earns its keep on specs that integrate tightly with existing code, where exact names and shapes matter — that's when pinning down the contract up front saves you a round of corrections later.

## Where to go next

- [Add Spec — Explore mode](add-spec-explore-mode.md) — where drafts come from.
- [Add Spec — Quick mode](add-spec-quick-mode.md) — the Contract Layer toggle in Quick mode.
- [Running pipelines](running-pipelines.md) — implement a spec once it's ready.
