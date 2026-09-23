## Context

The hub already has all the pipes needed for an interactive spec flow:

- `useChatContext` / `ChatManager` (server) spawn a `claude` CLI subprocess in chat mode and stream turns over the existing project WebSocket.
- `RichAttachmentEditor` provides the composer primitive used elsewhere.
- `AiEditShell` (`client/src/features/code/components/ai-edit/AiEditShell.tsx`) is a well-factored, reusable full-screen overlay with eyebrow + headline + composer + history/diff layout, confirm-discard, focus trap and keyboard handling. We reuse its visual language and split layout but cannot reuse the component verbatim because it is shaped around "edit existing target" not "compose from blank".
- `local-tickets.json` is the source of truth for project tickets; `POST /tickets/generate-spec` invokes Claude to materialise one. The new commit path is simpler — the LLM has already produced a structured draft via the conversation, so we just persist.

The new piece is the **draft protocol**: how Claude tells the hub what fields to put on the right panel. We chose a fenced JSON-block convention over a tool/MCP because the chat pipe is already a textual stream and Claude CLI does not expose hub-defined tools. The same trick is used by other AI products (Cursor's structured outputs, Replit Ghostwriter draft mode).

## Goals / Non-Goals

**Goals:**
- A native, in-hub conversational spec flow that ends in a ticket in `local-tickets.json`.
- Visual coherence with `AI Edit` (eyebrow, hero, composer, two-column reviewing layout).
- Live, structured draft visible during the conversation, editable by hand at any moment.
- The user is always the commit. No auto-create, no irreversible state changes mid-conversation.
- Stateless v1: closing the overlay discards the conversation.
- Zero new client dependencies, zero MCP tools.

**Non-Goals:**
- Persisting in-progress conversations across sessions (deferred to v2 when there is real demand).
- Resuming an existing ticket as an "explore" (the flow is creation-only).
- Supporting attachments inside Explore (Quick keeps attachments; Explore v1 does not — the conversation is the input).
- Reading attachments inline through Claude (same reason — attachments are bound to the Quick path).
- Multi-spec output (one conversation produces one ticket).
- Replacing the `Deep` path with anything other than removal — there is no shim or fallback.

## Decisions

### D1. Draft protocol: fenced ` ```spec-draft ` JSON block

**Choice:** Claude is instructed to end any assistant turn that has new draft information with a fenced code block tagged `spec-draft`, containing a JSON object with `title`, `description`, `labels`, `priority`, `acceptanceCriteria`, `ready`. The hub parses these blocks server-side, broadcasts a `spec_draft.update` WS event with the merged draft, and removes the block from the chat content rendered to the user.

```
Sample assistant message body Claude produces:

> Settings page. I'll persist to localStorage and respect prefers-color-scheme.
>
> ```spec-draft
> { "title": "Add dark mode toggle", "priority": "medium",
>   "labels": ["ui", "theme"], "description": "...", "ready": false }
> ```
```

**Why over MCP tool / structured output API:** the chat pipe is a textual stream from `claude` CLI. We do not own a tool registry that Claude can call. A fenced-block convention is portable across LLM versions, easy to debug (visible in raw logs), and parseable in 30 lines of code. If we ever migrate to a tool model (specrails-core MCP), this becomes a thin shim.

**Why server-side parsing, not client-side:** the chat WS broadcast already passes through `ChatManager`. Doing the parsing there means (a) clients receive a structured `spec_draft.update` event ready to render, (b) the original block can be stripped before reaching the client, so non-explore consumers (e.g., a side chat view) never see the noise. If we parsed client-side, every consumer would need the same logic.

**Validation:** unknown fields are dropped. `priority` is constrained to the existing enum (`low | medium | high | critical`). `labels` is normalised to a string[]. Malformed JSON or wrong types in known fields cause the block to be ignored entirely (logged as warn server-side); the hub does not crash and Claude continues. The next valid block supersedes prior state.

**Merge semantics:** server keeps a per-conversation `latestDraft` object. Each parsed block is shallow-merged into it. Empty strings are treated as "leave existing". Arrays replace (not append) — Claude is the authority on the current label / criteria set.

### D2. Conversation-scoped state, not ticket-scoped

**Choice:** the draft lives on the server keyed by `conversationId`. Closing the overlay or starting a new Explore creates a new conversation and a fresh draft. There is no `pendingSpecId` reservation as Quick does — Explore does not write to disk until commit.

**Why:** stateless v1. No orphan cleanup, no resume UI. Aligns with the AiEdit lifecycle.

**Implication:** if the user closes the overlay accidentally, the conversation is lost. Mitigated by the confirm-discard pattern from `AiEditShell` and the always-available `Create Spec` button — committing a rough draft is a one-click safety net.

### D3. Reuse `AiEditShell` primitives, but build a sibling shell

**Choice:** create `ExploreSpecShell` next to `AiEditShell` rather than generalising one shell to handle both. Share via small helper components (header chrome, focus trap hook) when the duplication is non-trivial.

**Why over generalising AiEditShell:** AiEditShell is shaped around an existing target (eyebrow `AI EDIT`, target label, base body disclosure, diff view on review). Bending it to also handle "compose from blank with live draft" would muddy props and force consumers through optional escape hatches. A sibling component is cheaper to maintain and clearer to evolve.

**Shared primitives (extracted only if reused):**
- Header chrome (back arrow, eyebrow, target label, close button) → `OverlayHeader` component.
- Focus trap + Esc/⌘⏎ key handling → `useOverlayKeyboard` hook (small).
- Confirm-discard dialog → reuse the existing one inline; small enough to copy.

If on first PR these primitives feel forced, leave them inlined and revisit on the next overlay we add.

### D4. Right pane: structured fields, not markdown

**Choice:** the draft pane renders structured form controls (title input, priority select, label chips with add/remove, description textarea, acceptance bullet list). Each is independently editable. The user edit precedes any later Claude write to the same field within the same turn-cycle (see D5).

**Why over a markdown blob:** maps 1:1 onto the ticket creation payload, no parsing dance at commit, and the visual is far more "premium" — the user sees the spec take shape as a real artefact.

**Trade-off:** structured fields are less expressive than freeform markdown. We accept this because tickets ARE structured; the conversation provides the freeform thinking and the panel commits the structured outcome.

### D5. Edit conflicts: user edits win until next Claude turn

**Choice:** when Claude emits a draft update for a field that the user has manually edited *during the most recent assistant pause* (i.e., between the previous and current Claude turn), the user value is preserved. The Claude value applies for fields the user has not touched. After the next user message is sent, the "manual override" set is cleared — the user has had a chance to push back, and Claude's next update is authoritative again.

**Why:** matches the way collaborative document tools handle co-authoring. The user is in control of what they explicitly touched; Claude advances the rest.

**Implementation:** the draft hook tracks `manualFields: Set<keyof Draft>`. `mergeFromClaude(update)` skips entries in `manualFields`. `clearManualOverrides()` is invoked when the composer sends a new user message.

### D6. Quick chip suggestions: model-driven, capped

**Choice:** Claude may include up to 3 quick-reply chips per turn in the same fenced block under a `chips: string[]` field. The shell renders these above the composer. Clicking a chip sends it as the next user message immediately. If Claude does not provide chips, none are shown (no fallback list).

**Why model-driven:** they should be context-relevant ("Yes, settings page", "Smaller scope"). Hardcoded fallback chips quickly become noise.

**Cap of 3:** UI hygiene; more clutters and slows decision.

### D7. Streaming: defer draft updates to turn end

**Choice:** during a streaming turn, the chat pane shows the streaming text as usual but the draft pane does NOT update until the assistant turn completes (the fenced block is parsed only on close). The pane shows a subtle "draft updating…" hint when the parser detects the start of a `spec-draft` block in the stream.

**Why:** parsing partial JSON mid-stream is fragile. End-of-turn parse is robust and the perceived latency cost is small (one full turn ≈ 5-15s).

### D8. Commit endpoint: separate route, not a flag on `/generate-spec`

**Choice:** add `POST /api/projects/:projectId/tickets/from-draft` that accepts the structured payload and inserts directly into `local-tickets.json`. It does NOT call any Claude generation; the draft IS the spec.

**Why over a flag on `/generate-spec`:** `/generate-spec` is shaped around `idea: string` plus optional codebase exploration, returning a generated structured spec. Adding a `fromDraft: true` branch overloads the route and complicates testing. A separate route is small (~30 lines) and has a precise contract.

**Validation:** title required and non-empty after trim; priority must be in the enum; labels normalised; arrays defaulted to `[]`. Returns the inserted ticket so the client can route to it / surface a toast.

### D9. Removing Deep: hard removal, no shim

**Choice:** the existing `exploreCodebase` checkbox and the special non-interactive prompt path in `ProposeSpecModal.handleSubmit` are removed entirely in this change. There is no migration period and no flag.

**Why:** the path is undocumented in any spec, surfaces only as a checkbox label, and Explore subsumes its outcome (the user can instruct Claude in the first message). Carrying both modes during a transition would force a 3-mode segmented control and confuse new users.

**Risk:** users who relied on `Explore codebase` will need to type "read the relevant code and don't ask me anything" in their Explore opening message. Mitigation: include this line as one of the suggested chips on the empty composer.

## Risks / Trade-offs

- **[Risk]** Claude ignores the fenced-block convention or emits malformed JSON → **Mitigation**: tight system prompt with two few-shot examples; the parser logs warnings and ignores; the user can always edit the panel by hand and click Create. The flow degrades to "manual fill" gracefully.
- **[Risk]** Live draft pane updates feel jarring (flash on every field) → **Mitigation**: use a 200ms colour-bg transition, only on changed fields, capped to one transition per turn.
- **[Risk]** Conversation drags forever and the user is unsure when to commit → **Mitigation**: button is always available once `title` exists; visual amplification on `ready: true`; chip "Looks good — create" suggested on quiet turns.
- **[Risk]** User accidentally closes the overlay and loses work → **Mitigation**: confirm-discard with a non-default destructive action when the conversation has more than the initial idea.
- **[Risk]** Edit conflict (user typed `medium`, Claude later overwrites with `high`) → **Mitigation**: D5 manual-override semantics. Tested with explicit unit cases.
- **[Risk]** Stripping ` ```spec-draft ` blocks from chat content surprises a future debugging session ("where did my JSON go?") → **Mitigation**: the raw assistant content is still on disk in `~/.specrails/projects/<slug>/chats/<conversationId>.ndjson`; only the WS-broadcast version is stripped.
- **[Risk]** Server parser introduces latency on every chat turn (not just Explore) → **Mitigation**: cheap regex pre-check (`.includes("```spec-draft")`) before JSON parse; near-zero overhead for non-Explore conversations.
- **[Trade-off]** No streaming draft updates means the right pane sits idle for 5-15s during a turn → acceptable for v1; revisit if user testing flags it.
- **[Trade-off]** No persistence means accidental close = lost work → acceptable given the always-available Create button and the confirm-discard guard.

## Migration Plan

1. Land the change behind no flag — Explore is additive at the API level. Quick remains the fast path and is the default highlighted mode.
2. The `exploreCodebase` checkbox and its special prompt path are removed in the same PR. Existing tour copy and prerequisite hints are updated in the same commit.
3. The `.claude/commands/specrails/explore-spec.md` slash command is added under the project's `.claude/commands/specrails/` path. Hub auto-detects via the existing slash-command discovery (no separate registration). If a project's `.claude/commands` does not yet have a `specrails/` directory (very old setup), the Explore button surfaces a soft warning "Run /setup again to enable Explore" — this affects effectively zero current installs but is the safe path.
4. Rollback: revert the PR. No persistent state to clean up. Users who started conversations during deploy lose them on revert (acceptable — same as a server restart today).

## Open Questions

- Should the empty composer in Explore include suggested first messages ("Make it small in scope", "Read code first, don't ask")? Defaulting to two static suggestions; revisit after 1-2 weeks of usage.
- When `ready: true` is set and the user keeps typing, should we down-grade `ready` to `false`? Defaulting to no — once Claude says ready, the button stays amplified; only the user clicks decide when to commit.
- Should the `from-draft` commit also accept attachments (so a user could paste an image into the description)? Out of scope for v1; description is plain text only. v2 if requested.
- Telemetry: do we track `mode_used` (Quick vs Explore) and `turns_to_commit` for Explore? Strongly suggested for product insight, but defer the actual emit to a separate analytics change.
