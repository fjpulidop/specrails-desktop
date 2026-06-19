# Add Spec — Quick mode

Quick mode is for when you already know what you want. You type your idea, the AI writes the full spec, and it lands on your board as a **Todo**. No back-and-forth — just describe it and go.

## Create a spec in Quick mode

To create a spec quickly:

1. On the Dashboard, click **Add** (the Plus button on the SpecsBoard toolbar).
2. Choose **Quick** mode.
3. Type your idea in the text field — a sentence or a paragraph, whatever captures it.
4. Click to generate.

While the spec is being written, a small toast in the corner shows the project name, a snippet of your idea, and the **elapsed time** ("Generating… 0:12"). When it finishes, the toast switches to "Generated in <time>" with a **View** action that jumps straight to your new spec.

That's the whole flow. Everything below is optional fine-tuning.

## What you can tune

**Model** — by default the AI picks a sensible model. You can override it per spec from the model picker if you want a faster or more capable one.

**Engine** — if your project has more than one AI provider installed (any mix of Claude, Codex, and Gemini), an engine selector sits at the top of the dialog so you can choose which one generates this spec. Your choice is remembered per project. Single-provider projects don't show this — there's nothing to choose between.

**Context** — Quick mode usually runs as a single turn, because it doesn't need to read your codebase to write a spec from your description. But a context slider lets you give it more to work with:

- At the lowest setting it just reads your description.
- At higher settings it can read your existing specs, your project's OpenSpec specs, and even your full codebase before writing.

The more context you give it, the longer generation takes (it switches to multi-turn so it can read first), but the spec comes back grounded in your actual project. Reach for higher context when the spec needs to reference real code, file names, or existing behaviour.

**Attachments** — drop mockups, briefs, or data files into the idea field. The AI reads them as part of writing the spec. (Attachments also switch generation to multi-turn.)

**Enrich with Contract Layer** — a toggle that appends a structured block to the generated spec so the downstream pipeline doesn't have to guess names or data shapes. It's optional and off by default; your last choice is remembered per project. See [Drafts & the Contract Layer](drafts-and-contract-layer.md) for what it adds and when it's worth it.

## When to use Quick mode vs Explore

Use **Quick** when the idea is already clear in your head — you could write the spec yourself, you'd just rather the AI do it. Use [**Explore**](add-spec-explore-mode.md) when you're still thinking it through and want a partner to help you shape it.

A spec created in Quick mode is a fully normal spec: you can later open it and **Continue Editing** in an Explore session if it needs refining.

## Where to go next

- [Add Spec — Explore mode](add-spec-explore-mode.md) — for specs that need shaping.
- [Drafts & the Contract Layer](drafts-and-contract-layer.md) — the Contract Layer enrichment explained.
- [Running pipelines](running-pipelines.md) — drag your new spec onto a rail and implement it.
