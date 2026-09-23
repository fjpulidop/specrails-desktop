## Why

Today's `Add Spec` modal offers two non-interactive modes (the implicit "Quick" path and the misleadingly-named "Explore codebase" checkbox, which is actually a slower non-interactive variant that reads files but never asks questions). Users with a vague or evolving idea have no in-hub way to think it through with an AI partner; they either commit a half-formed spec or leave the hub to chat elsewhere. We want a true exploratory mode inside the hub where the user converses with Claude, sees a structured draft materialize live, edits any field by hand, and decides when to commit — always ending in a real local ticket. The flow must reuse the visual language of `AI Edit` so it feels native.

## What Changes

- Replace the `☐ Explore codebase` checkbox in `ProposeSpecModal` with a two-mode segmented control: **Quick** (current default fast path, ~15s) and **Explore** (new, multi-turn interactive).
- **REMOVE** the existing `Deep` semantics (the previous "Explore codebase" path that runs `/specrails:propose-spec` non-interactively). Users who wanted code-anchored specs use Explore and instruct Claude in their first message ("read the relevant code, don't ask me anything").
- Add a new full-screen overlay component `ExploreSpecShell` (built on the same primitives as `AiEditShell`) that hosts the interactive flow: conversation history on the left, structured draft on the right, composer at the bottom.
- Add a new slash command `/specrails:explore-spec` (in `.claude/commands/specrails/`) that instructs Claude to (1) be a thinking partner, (2) ask only what it needs, (3) maintain a structured draft using a fenced ` ```spec-draft ` JSON convention, (4) never create the ticket itself — the hub will commit the final draft.
- Add a server-side parser that scans assistant turns for ` ```spec-draft ` fenced blocks, parses the JSON payload, broadcasts the merged draft state over the existing chat WebSocket, and strips the block from the rendered chat content so it does not show to the user.
- Add a `Create Spec` action that always commits the current draft. It is enabled the moment the draft has a non-empty `title`. When Claude has emitted `ready: true`, the button visually amplifies (filled primary + soft pulse). There is no auto-create; the user is always the commit.
- Add a `POST /api/projects/:projectId/tickets/from-draft` endpoint that accepts the structured draft (title, description, labels, priority, acceptanceCriteria) and inserts a ticket in `local-tickets.json` directly — no further LLM generation, no codebase reading.
- Stateless v1: closing the overlay (X / Esc / discard) discards the conversation. Confirm-discard guard when the conversation has more than the initial user idea, mirroring `AiEditShell`'s pattern.
- Migrate the unused `Deep` documentation in `ProposeSpecModal` and any tour copy that mentions "Explore codebase". Update placeholder copy and time hints.

## Capabilities

### New Capabilities
- `explore-spec`: interactive, multi-turn spec creation experience inside the hub. Owns the segmented mode control, the overlay shell, the draft model, the fenced-block protocol, the from-draft commit endpoint, and the slash command contract.

### Modified Capabilities
<!-- None: there is no existing spec for ProposeSpecModal or local-ticket creation, so the new behaviour lands as a fresh capability. The current "Explore codebase" checkbox lives only in code, not in spec form. -->

## Impact

- `client/src/features/specs/components/ProposeSpecModal.tsx` — remove the `exploreCodebase` checkbox, add a 2-mode segmented control, branch on submit (Quick → existing `/generate-spec`; Explore → mount `ExploreSpecShell`).
- `client/src/features/specs/components/explore-spec/ExploreSpecShell.tsx` (new) — overlay layout based on `AiEditShell` primitives. Two-column: chat history left, draft fields right. Composer + chips at the bottom.
- `client/src/features/specs/components/explore-spec/SpecDraftPanel.tsx` (new) — structured fields (title, priority, labels, description, acceptanceCriteria) editable in place, with subtle flash animation on Claude-driven updates.
- `client/src/features/specs/hooks/useSpecDraftStream.ts` (new) — subscribes to the chat WS, accumulates draft updates from `spec-draft` blocks, exposes `{ draft, ready, mergeUserEdit }`.
- `client/src/lib/spec-draft-parser.ts` (new) — parses fenced ` ```spec-draft ` JSON blocks, validates fields against the draft type, returns parsed draft + remaining text (for chat rendering).
- `server/modules/conversations/runtime/chat-manager.ts` — when broadcasting an assistant message, run the parser, emit a `spec_draft.update` WS event with the merged draft, and replace the original block in the chat content with an empty string so the client never renders it.
- `server/tickets-router.ts` — new route `POST /tickets/from-draft` that accepts `{ title, description, labels, priority, acceptanceCriteria }` and inserts a ticket directly into the per-project `local-tickets.json` without invoking `/generate-spec` machinery.
- `.claude/commands/specrails/explore-spec.md` (new) — slash command body with the system prompt: thinking-partner stance, fenced-block convention, examples, `ready: true` semantics, and an explicit "do NOT create the ticket — the user does."
- Tests: `ExploreSpecShell.test.tsx`, `SpecDraftPanel.test.tsx`, `useSpecDraftStream.test.ts`, `spec-draft-parser.test.ts` (client); `chat-manager.test.ts` extension for the parser hook; `tickets-router.test.ts` extension for `from-draft`.
- No new client dependencies. Server uses existing JSON validation utilities.
- `local-tickets.json` schema is unchanged — `from-draft` writes the same shape `/generate-spec` writes.
- Release-please: this lands as a `feat:` commit; minor bump.
