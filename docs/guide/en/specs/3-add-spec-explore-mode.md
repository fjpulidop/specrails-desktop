# Add Spec — Explore mode

Explore mode is a conversation. Instead of writing the spec yourself, you talk through the idea with the AI — it acts as a thinking partner, asks questions, proposes structure, and builds a **live draft** of the spec as you go. When you're happy, you commit the draft to a real spec.

Reach for Explore when the idea isn't fully formed yet, when there are trade-offs to talk through, or when you want the AI to look at your actual code before pinning down the spec.

## Create a spec in Explore mode

To shape a spec in Explore mode:

1. On the Dashboard, click **Add**, then choose **Explore**.
2. Type your first message — the idea, a question, or a half-formed thought.
3. Read the AI's response and keep replying. Each turn, it refines its understanding.
4. Watch the **live draft** update alongside the chat — this is the spec taking shape.
5. When the draft looks right, click **Create Spec**.

The conversation stays in your history, so you can always come back to see how the spec was shaped.

## The live draft

As you converse, a draft pane shows the spec as it currently stands — title, description, priority, labels, acceptance criteria. It rewrites itself each turn based on what you've discussed. You don't edit it directly; you steer it through the conversation ("actually, make the priority high", "add a criterion about error handling", and so on).

This is the heart of Explore mode: you're never staring at a blank form. You're always looking at a real, evolving spec.

## How much the AI sees: the context slider

Before the AI answers, you decide how much of your project it can see. A context preset slider lets you trade speed for depth:

| Preset | What the AI sees |
|--------|------------------|
| **Minimal** | Just your message. Fastest and cheapest. |
| **Light** | + your existing specs. |
| **Standard** | + your specs and your project's OpenSpec specs. |
| **Rich** | + read access to your full codebase, so it can ground answers in real code. |
| **Max** | Rich, plus a Contract Layer enrichment pass on commit. |
| **Desktop** | Max, plus your project's MCP servers and your own approved MCP servers. |

Start low for fast brainstorming; move up when you want the AI to verify its suggestions against your actual code. The choice is saved on the conversation, so it doesn't leak into other Explore sessions.

If you want finer control, click **Fine-tune** to flip the underlying options by hand — including **My approved MCPs**, which loads the MCP servers you've already approved locally without slowing the session down.

## Buttons in the Explore shell

- **Create Spec** — promotes the live draft to a real spec with status **Todo**. (When you're editing an existing spec, this button reads **Update Spec** instead and patches that spec in place.)
- **Review →** — opens a Review overlay that shows the proposed spec diffed against the baseline before you commit, so there are no surprises.
- **Save as Draft** — persists the conversation as a draft ticket so you can pick it up later. Available as soon as you've sent at least one message. See below.
- **Minimize** — parks the conversation as a chip in the minimized-chats dock at the bottom-left. Click the chip any time to drop right back into the conversation — nothing is lost.
- **Discard** — throws the conversation away (asks for confirmation first).

## Saving as a draft

Not ready to commit, but don't want to lose the thinking? Click **Save as Draft**. The conversation becomes a **draft spec** on your board, and the draft stays linked to the conversation behind it.

Later, open the draft from the board and click **Continue Editing** — the original conversation re-opens with its full chat history intact, and you carry on exactly where you left off. Drafts are never auto-deleted; they wait for you.

This makes Explore safe to use for half-baked ideas: start a conversation, get somewhere, save it as a draft, and come back tomorrow.

For everything about drafts — including the Contract Layer enrichment — see [Drafts & the Contract Layer](drafts-and-contract-layer.md).

## Multi-provider note

If your project has more than one AI provider installed, an engine selector lets you pick which one drives the Explore conversation. Single-provider projects don't show it.

## Where to go next

- [Drafts & the Contract Layer](drafts-and-contract-layer.md) — saving work in progress and enriching specs for the pipeline.
- [Add Spec — Quick mode](add-spec-quick-mode.md) — when the idea is already clear.
- [Running pipelines](running-pipelines.md) — implement your spec once it's ready.
