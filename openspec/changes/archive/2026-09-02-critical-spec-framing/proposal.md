## Why

The in-app operator agent moves from a user's sentence to a persisted spec without ever verifying that it understood the request. Its manual (`server/agent-operator-prompt.ts`, 558 lines) makes grounding in CODE mandatory and checklisted — read the real tree, open the real module, quote the real behaviour, "never fabricate a path; if you did not verify it, do not name it" — and provides no equivalent step for grounding in INTENT.

The imbalance is measurable in the prompt text itself: `confirm` appears 19 times, `NEVER` 8 times, `ask|question` 57 times, and `reflect|reconsider|assumption|reframe|misunderstand` appears **0 times**. Four separate instructions brake questioning ("at most TWO questions per turn", "a grounded clarification beats five guess-questions", "stop reading as soon as you can ask", "do not interrogate past the point of usefulness"); none brake premature framing. The `## Think in specs` section is titled a stance but written as a numbered five-step pipeline, and `## Stance` closes the manual with "Be concise and action-oriented."

The one instruction that could slow the agent down — "when the request is fuzzy, contested, or high-stakes, DO NOT one-shot it" — is self-assessed and produces no observable artifact. A language model does not perceive ambiguity and then choose to resolve it; it resolves it silently by selecting the most probable reading. There is nothing for the user or the code to check.

The failure mode this produces is specific and expensive: a spec whose every technical claim is verifiably true and whose framing is wrong. The pipeline then implements it faithfully, and the cost surfaces minutes and dollars later at the review packet, not seconds later in the conversation.

Every other irreversible step in this agent is already gated by an artifact plus an explicit yes — the `spec-draft` card before `commit_draft`, the cost framing before an ai-spawn, the restatement before a destructive action. Understanding the request is the only step in the chain with no artifact and no gate, and it is the step that determines whether all the others were worth doing.

## What Changes

- Introduce a `problem-frame` fenced block the operator agent emits BEFORE any `spec-draft`, carrying two competing readings of the request, the surfaces each would touch, the question that distinguishes them, plus its assumptions and open unknowns. The block is a full snapshot rendered as an in-conversation card, reusing the `spec-draft` parser/card pattern verbatim.
- Make the second reading structurally impossible to fake rather than merely requested. Two mechanisms, both reusing work the agent already does: each reading names the files or surfaces it would touch (two readings that touch the same surfaces with the same outcome are the same reading, and that is visible to the user and to a test), and the frame carries a **discriminating question** — the one thing the user could say that picks between the readings. A frame whose two readings are identical cannot produce a coherent discriminating question, so the degenerate case exposes itself instead of passing silently.
- Rewrite the manual's spec-authoring stance: replace the numbered pipeline with a framing-first stance, convert the two-question ceiling into a floor-and-ceiling, and remove "action-oriented" as the closing posture for spec work. Keep every existing cost, destruction, and confirmation rule unchanged.
- Add a server-side gate so `specrails_specs(commit_draft)` refuses when the calling conversation has no problem frame that the user has seen and answered, with an LLM-readable refusal in the shape `registerTieredTool` already uses for tier refusals.
- Scope the gate to FIRST-PARTY in-app agent calls only (`firstPartyAgent`, already resolved from the agent capability in `server/mcp/tools/types.ts`). External MCP clients cannot render the card and are not subject to the ritual.
- Provide a user waiver that persists for the rest of the conversation rather than for a single spec, so a run of small specs does not pay the ceremony repeatedly. The waiver is user-only, reversible in one word, and the agent SHALL announce that framing is off — a silently disabled ritual is the failure mode a per-spec waiver was guarding against, and visibility solves it without the friction.
- Require a fresh frame per authored spec while framing is on: a frame authorises the next `commit_draft` in that conversation, never a series.
- State a success criterion and a kill criterion up front, both derivable from persisted conversation history with no new storage: how often an answered frame is superseded by a corrected one before the spec is persisted. A ritual that never gets corrected is either unnecessary or hollow, and both verdicts lead to removing or redesigning it. Writing the bar before building it is what makes that removal possible later without argument.
- Keep the app's own Explore spec chat (`ChatManager` `kind:'explore'`) and Quick generation (`specrails_specs(generate)`) untouched in this change.

## Capabilities

### New Capabilities

- `agent-spec-framing`: Defines the framing artifact the operator agent must produce and have answered before it may persist a spec it authored, the rendering and parsing contract for that artifact, the server-side gate that makes it non-skippable for first-party calls, and the escape path for work that does not warrant it.

### Modified Capabilities

None.

## Impact

- `server/agent-operator-prompt.ts`: the `## Think in specs`, `## Spec refinement mode`, and `## Stance` sections gain the framing ritual and lose the numbered pipeline framing; `OPERATOR_SYSTEM_PROMPT` gains the matching non-negotiable. Both constants remain byte-stable (no interpolation) per the file's existing caching contract.
- `client/src/components/agent-chat/`: a new `agent-problem-frame.ts` parser mirroring `agent-spec-draft.ts`, a new `AgentProblemFrameCard.tsx` mirroring `AgentSpecDraftCard.tsx`, and extraction wired in `AgentMessage.tsx` next to the existing draft-card extraction.
- `server/mcp/tools/specs.ts`: `commit_draft` acquires the framing precondition; no signature, schema, or REST change.
- `server/mcp/tools/types.ts`: no change to `registerTieredTool` itself — the gate reuses the `originConversationId` and `firstPartyAgent` context it already resolves.
- i18n: new keys under the existing `agent` namespace in all eight locales.
- No analytics surface is added for the success criterion: the measurement is derived by reading `agent_messages` when the criterion is evaluated, not by instrumenting a dashboard.
- No database migration, no WebSocket message, no REST endpoint, and no provider protocol change. `agent_messages` gains no column — the frame is derived from the conversation's existing message rows.
