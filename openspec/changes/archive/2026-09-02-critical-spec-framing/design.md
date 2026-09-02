# Design — Critical spec framing

## Context

The operator agent's spec-authoring path currently has one gate (the `spec-draft` card plus an explicit yes) and it sits at the very end, immediately before persistence. Everything upstream of it — deciding what the user's problem actually is — happens inside a single model turn with no artifact, no confirmation, and no way for the user or the code to observe that it happened at all.

This change adds the missing gate. The design question is not "how do we make the model think more" but "what is the smallest observable artifact whose production requires the thinking, and where does the check on that artifact live so the model cannot route around it".

## Decision 1: A forcing function, not a guardrail

A guardrail prevents an action. Its value is in what it blocks, and it works because the blocked action is nameable: launch without confirming cost, delete without restating what dies.

The failure here is not an action the agent takes; it is a step it never takes. There is nothing to block. Instructing the model to "reflect before proposing" produces a sentence claiming reflection occurred, because the instruction's only observable output is prose and prose is the cheapest thing a model can fabricate.

The mechanism therefore has to be a **forcing function**: an artifact whose fields cannot be filled without performing the work. The enforcement layer on top of it — the tool refusing to persist without one — is the guardrail, and it exists only to make the forcing function non-optional. Both layers are required, and each is useless alone:

- The card alone is skipped precisely when the agent is confident, and confidence is uncorrelated with correctness of framing.
- The refusal alone is friction without help: it forbids progress without teaching the shape of the missing step.

## Decision 2: Two readings, anchored and separable

```
problem-frame
├── restated       what I think you are asking   + the surfaces it would touch
├── alternative    a different reading of it     + the surfaces THAT would touch
├── discriminator  the one thing you could say that picks between them
├── assumptions    what I am taking as given that you did not say
└── unknowns       what would change the spec if answered differently
```

`restated` and `unknowns` are useful to the user but weakly forcing — a model that has already committed to an interpretation can produce both from that interpretation without revisiting it. The reflective work lives in the second reading, so the design question is not whether to ask for one but how to make a fake one visible.

Asking harder does not work. "Give a genuinely different reading" is an instruction whose only output is prose, and prose is the cheapest thing a model can fabricate: it will emit the same reading in different words and the field will look filled. Two mechanisms make the degenerate case observable instead, and both reuse work the agent is already required to do.

**Anchoring.** Each reading names the files or surfaces it would touch. The agent is already required to ground in real code before proposing, so this costs no new reads — it only makes the reads answer a second question. Two readings that touch the same surfaces and mean the same outcome ARE the same reading, and comparing two short lists is something the user does at a glance and a test does exactly. Where the ambiguity is not about surface but about what "done" means, the surfaces may legitimately coincide; the difference then has to show up in the outcome, and the discriminator is what proves it does.

**The discriminating question.** The frame carries the one thing the user could say that picks between the two readings. This is the load-bearing check, because it is not satisfiable by paraphrase: **if the two readings are the same, no question separates them**, and the attempt produces something visibly incoherent in the card. A model cannot route around it by writing better prose — it can only route around it by actually having two readings.

This is the same move the manual already makes for code claims. It does not ask the agent whether it verified a path; it requires the path to be quoted. Here it does not ask whether the agent considered another reading; it requires the artifact that exists only if it did.

Neither mechanism is a similarity metric over the two strings. That was considered and rejected: it fires on genuinely distinct readings that happen to share vocabulary, and it teaches the model to write evasively to clear a threshold rather than to think differently.

## Decision 3: Confirmation state is derived, not stored

The gate needs to answer one question: has the user seen a frame and responded to it?

Two options were considered. A new column or table keyed by conversation would let the agent explicitly record "frame confirmed", but it adds a migration and a tool call whose only purpose is to satisfy a check — and an agent that can call it can call it without meaning it.

The chosen approach derives the answer from `agent_messages`, which already holds the full conversation: a frame is present when an assistant message in the conversation contains a valid `problem-frame` block, and it is answered when at least one user message follows it. `listAgentMessages` already returns exactly this. No migration, no new tool, and the evidence is the same evidence the user saw.

**Honest limitation, stated rather than engineered around:** this verifies that the user saw the frame and replied. It does not verify that they agreed. Intent cannot be reliably parsed from a free-form reply, and attempting it would produce a check that is confidently wrong. The gate's job is to prevent the step from being *skipped*, not to adjudicate agreement — disagreement is handled by the manual, which requires a corrected frame when the user pushes back. Making the weaker guarantee explicit is preferable to a stronger one the implementation cannot honour.

## Decision 4: Freshness — one frame authorises one spec

A conversation that produces five specs must not have the first frame authorise all five. The rule is positional and derivable from the same message list: a `commit_draft` requires a frame emitted **after the last successful `commit_draft` in that conversation**.

This falls out of the derived-state design for free and needs no bookkeeping. It also produces the right behaviour on the common path: an agent authoring a second spec in the same conversation must frame it separately, which is correct, because the second request is a different request.

## Decision 5: First-party only

`registerTieredTool` already resolves an agent capability into `originConversationId` and `firstPartyAgent` (`server/mcp/tools/types.ts:233-243`). The gate applies only when `firstPartyAgent` is true.

An external MCP client — Cursor, Claude Desktop, a custom agent — cannot render the card, has no conversation in `agent_messages`, and did not agree to this workflow. Applying the gate there would break `commit_draft` for every third-party consumer to enforce a UI ritual they cannot participate in. The distinction is already carried in the call context, so this costs nothing to honour.

## Decision 6: The waiver is sticky, user-owned, and announced

"Change the button to blue" does not need a framing card, and forcing one there teaches the user to click through the ritual without reading it — which destroys its value exactly where it matters.

The waiver is a user utterance ("do it directly", "skip the framing"), never an agent judgement. The agent may not decide a request is trivial, may not infer a waiver from brevity, and may not solicit one preemptively. The moment the agent can classify its own work as not worth framing, the gap this change closes reopens.

The waiver persists for the remainder of the conversation rather than for a single spec. A per-spec waiver was the initial design and is wrong in practice: a user authoring a run of small specs would have to repeat it every time, which is the precise friction that makes a feature resented and then disabled wholesale.

The risk of a sticky waiver is that it is switched off once and forgotten, and the ritual dies silently. That risk is answered with visibility, not with rigidity: the agent SHALL state that framing is off when the waiver takes effect and name the word that restores it. This mirrors how the permission ladder is already handled — the level is not re-confirmed on every action, it is shown. A disabled ritual that is visible on screen is a user's choice; a disabled ritual nobody can see is a bug.

## Decision 7: Scope — operator agent only

The app's Explore spec chat has the same structural gap and a different prompt (`ChatManager._buildLightweightSystemPrompt`), a different transport, and its own draft-card protocol. Quick generation (`specrails_specs(generate)`) is a single AI pass with no conversation at all and cannot host a multi-turn ritual.

This change touches only the operator agent. If the ritual proves out there, porting it to Explore is a follow-up with a known shape; if it proves annoying or ineffective, one surface was affected instead of three. The measurable success signal is available in either case: frames whose `alternative` the user selects, or replies that correct the `restated` line, are direct evidence the step caught a misframing that would otherwise have become a spec.

## Decision 8: The change states how it will be judged, and how it dies

A ritual with no success criterion becomes permanent by default: nobody can show it works, and nobody dares remove it in case it does. That is the worst kind of debt, because it wears the costume of quality. The bar is therefore written before the code, so removing it later is an appeal to a recorded decision rather than an argument.

The signal is already in the data and needs no instrumentation. A frame that the user answers and that the agent then SUPERSEDES with a corrected frame is direct evidence the step caught a misframing — a wrong reading that would otherwise have become a spec, been assigned to a rail, and been implemented faithfully. Both events are ordinary `agent_messages` rows, so the measurement is the same derived-state read the gate already performs.

**The criterion.** After 50 answered frames, count how many were superseded before their spec was persisted. Below roughly one in ten, the ritual is not earning its friction and is removed or redesigned — and the two possible causes both point the same way. Either the agent was already framing correctly, in which case the ceremony is pure cost; or the frames are hollow, in which case the anchoring and discriminator mechanisms failed and the artifact needs rethinking rather than defending.

The 50-frame sample and the one-in-ten bar are judgements, not measurements — there is no prior data on this behaviour in this product. They are recorded here so the first evaluation revises a written number instead of inventing one under pressure to keep the feature.

Deliberately NOT built: an analytics page, a WebSocket event, or a counter column for this. Instrumenting a kill criterion is how a kill criterion becomes a feature that must itself be maintained. The evaluation is a query run once, by a person, when the sample exists.

## Alternatives considered

**Prompt-only rewrite.** Reword the stance, invert the question ceiling, drop "action-oriented". Cheapest option and part of this change anyway — but rejected as the whole solution. It produces no artifact, so nothing can verify it happened, and the existing prompt already demonstrates that a well-written instruction to slow down ("do not one-shot fuzzy requests") does not survive contact with a confident model.

**Raise reasoning effort.** `defaultReasoningEffortForModel` returns `medium` (`server/providers/runtime.ts:94`) and could be raised for this agent. Rejected: the problem is not insufficient thinking, it is thorough thinking about the wrong problem. More effort without a frame produces a better spec of the wrong thing, at higher cost.

**A second Shift+Tab axis for depth.** The tier ladder steers permission; a parallel axis could steer cadence (direct / normal / reflective). Honest and possibly right eventually, but it is new UI, a new persisted dimension, and a product decision — disproportionate to validating whether the ritual works at all.

**Blocking heuristics on the request text.** Refuse `commit_draft` when the originating user message is under N words, or matches vagueness patterns. Rejected: short requests are frequently precise and long ones frequently ambiguous, so the heuristic fires on the wrong population and trains the agent to route around it.

## Risks

- **Degenerate second readings.** Addressed structurally rather than by instruction — see Decision 2. The residual risk is a model that produces a coherent-looking discriminator for two readings that are subtly the same. This surfaces to the user in the card rather than hiding in a reasoning trace, and Decision 8 measures whether it is happening in aggregate.
- **Ceremony fatigue.** The card appears on every authored spec while framing is on. Mitigated by the sticky waiver (Decision 6), by keeping the card short, and by the ritual costing zero AI spend — it is one block in a turn the agent was already taking.
- **A forgotten waiver.** A conversation-scoped waiver could silently disable the ritual for a long session. Mitigated by requiring the agent to announce the state and the word that restores it; the failure mode is a visible choice rather than an invisible regression.
- **Gate refusal loops.** A refusal the agent does not understand could produce retry loops. Mitigated by the refusal naming the exact missing artifact and the action that produces it, matching `tierRefusalMessage`'s existing shape and precedent.
- **A richer block is a more malformable block.** Five fields with two nested readings fail to parse more often than four flat strings. The parse contract already degrades safely — a malformed block renders no card and the message survives — and the agent sees the absence of its own card as the signal to re-emit.
