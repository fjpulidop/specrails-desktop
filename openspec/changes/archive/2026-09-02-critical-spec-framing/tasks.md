## 1. The framing artifact (client)

- [x] 1.1 Add parser tests for `problem-frame`: full-snapshot replacement, all-keys requirement, nested reading/`touches` shape, empty `reading` or `discriminator` rejection, invalid JSON rejection, streaming-tail cut, last-valid-wins across multiple blocks, and coexistence with a `spec-draft` and an `options` block in one message.
- [x] 1.2 Implement `client/src/components/agent-chat/agent-problem-frame.ts` mirroring `agent-spec-draft.ts`, exporting the type and the extraction function with no rendering concerns.
- [x] 1.3 Implement `AgentProblemFrameCard.tsx` mirroring `AgentSpecDraftCard.tsx`, rendering the two readings side by side with equal visual weight, each under its touched surfaces, and the discriminating question as the card's call to answer — so a fake second reading is legible as fake at a glance.
- [x] 1.4 Wire extraction into `AgentMessage.tsx` beside the existing draft-card extraction, memoized on the same message-state boundary so streaming frames do not reparse.
- [x] 1.5 Add component tests: a valid frame renders a card and hides the raw block; a malformed block renders neither a card nor literal code and leaves surrounding content intact; readings sharing surfaces still render when their outcomes differ.

## 2. The stance (operator manual)

- [x] 2.1 Add prompt-content regression tests asserting the framing ritual is present, the numbered dispatch pipeline is gone, a question floor exists alongside the ceiling, and "action-oriented" no longer governs spec authoring.
- [x] 2.2 Rewrite `## Think in specs`, `## Spec refinement mode`, and `## Stance` in `OPERATOR_INSTRUCTIONS` to lead with framing, specifying the block protocol, the anchoring of each reading in surfaces actually read, the discriminating question, and the requirement to end the turn on that question.
- [x] 2.3 Add the matching non-negotiable to `OPERATOR_SYSTEM_PROMPT` for providers that receive the distillation rather than the manual.
- [x] 2.4 Assert both constants remain interpolation-free per the file's byte-stability contract, and confirm every existing cost, destruction, confirmation, and permission rule survives the rewrite unchanged.

## 3. The gate (server)

- [x] 3.1 Add tests for frame derivation over `agent_messages`: no frame, frame with no following user message, frame followed by a user message, frame followed by a disagreeing user message, and a second `commit_draft` after a prior success.
- [x] 3.2 Implement the derivation helper reading the conversation through `listAgentMessages`, requiring a frame emitted after the most recent successful `commit_draft` in that conversation, with no schema migration.
- [x] 3.3 Apply the precondition inside `commit_draft` in `server/mcp/tools/specs.ts`, refusing in the shape `tierRefusalMessage` establishes and naming both the missing artifact and the action that satisfies it.
- [x] 3.4 Gate the precondition on `firstPartyAgent`, and add a test proving an external MCP client's `commit_draft` is byte-identical to today.
- [x] 3.5 Prove a refusal writes nothing: no ticket row, no partial write, and no Contract Layer enrichment fired.

## 4. The waiver

- [x] 4.1 Add tests: a user waiver permits every subsequent commit in that conversation; a restore request re-arms the gate on the next commit; the agent cannot satisfy the gate without a user utterance.
- [x] 4.2 Implement waiver and restore detection on the same derived-state path the frame check uses.
- [x] 4.3 Document the waiver in the manual as user-only, never agent-inferred, never solicited preemptively, and always announced with the word that restores it.
- [x] 4.4 Assert the announcement: a turn in which the waiver takes effect states that framing is off and how to bring it back.

## 5. Localisation

- [x] 5.1 Add the framing-card keys to the `agent` namespace in English.
- [x] 5.2 Mirror them across the remaining seven locales and confirm the key-parity test passes.

## 6. The retention bar

- [x] 6.1 Record in `design.md` the sample size, the threshold, the action when unmet, and the fact that both numbers are judgements to be revised by the first evaluation.
- [x] 6.2 Add a test proving the two counts the criterion needs — answered frames, and those superseded before their spec was persisted — are derivable from existing agent message rows.
- [x] 6.3 Confirm no counter column, WebSocket event, or analytics surface was added to serve the criterion.

## 7. Verification

- [x] 7.1 Run the focused server tests for the MCP specs tool, the operator prompt, and the agent store.
- [x] 7.2 Run the focused client tests for the frame parser, the card, and `AgentMessage`.
- [x] 7.3 Run `npm run typecheck`, `npm test`, and both coverage suites, meeting the repository's existing thresholds without lowering any of them.
- [x] 7.4 Run OpenSpec strict validation for this change.
- [ ] 7.5 (NOT DONE — needs the desktop app running and a real provider turn; the gate, waiver, freshness and external-client paths are covered by integration tests instead) Exercise the loop end to end in the running app: a work request produces a card, a correction produces a superseding card, an unanswered frame refuses the commit, a waiver passes the rest of the conversation through with the state announced, and asking for framing back re-arms the gate.
