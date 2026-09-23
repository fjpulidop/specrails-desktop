## Why

Today's TicketDetailModal AI Edit is a single-shot, small-textarea experience tucked into a narrow right sidebar. After an edit streams in, the user sees the rewritten description but has no visual of *what changed* — the only recourse is a binary "Revert to original". Iterating ("make it shorter", "add an acceptance criterion", "tone down the technical jargon") means rewriting the whole instructions from scratch each time, losing all prior context including attached resources.

For specs — the primary thing users edit in this app — the real work is refinement across 3-5 passes. The current UX makes each pass feel like starting over.

## What Changes

- AI Edit becomes a **full-width, main-content** flow inside the TicketDetailModal (not a sidebar widget) with three discrete states: **Idle → Composing → Reviewing**.
- After the first edit streams in, the user enters **Review mode**: a word-level **diff view** (original vs. proposed) with inline insert/delete spans. Apply/Discard actions are global.
- From Review mode, a **Refine input** stays available. The user iterates by typing new instructions — each refine sends the prior proposal + instruction history to the server, so Claude operates on the latest draft, not the original.
- **Attachments persist across the iteration session**. A chip bar shows files active in the current session. The session chip `×` removes from the session context only (not from the ticket); full ticket-level deletion stays on the existing `AttachmentsSection` below. New attachments added mid-session are added to both the ticket and the session.
- Apply saves the proposed draft and preserves the "Revert to original" affordance (existing snapshot behavior). Discard clears the session without saving.
- Server `POST /tickets/:id/ai-edit` route is extended with optional `priorInstructions?: string[]` and `priorProposal?: string` fields. When present, the system prompt switches to "refine this draft" mode and the user prompt threads the history.

## Capabilities

### New Capabilities
- `ai-edit-diff-review`: Iterative AI editing of ticket descriptions with word-level diff preview, refinement loop with instruction history, and per-session attachment context pinning.

### Modified Capabilities
- `ticket-attachments`: The `POST /tickets/:id/ai-edit` scenario gains support for `priorInstructions` and `priorProposal` fields so refinement turns reuse the same attachment resolution pipeline.

## Impact

- **Server**: `server/project-router.ts` — extend `ai-edit` body parsing and prompt construction. No new dependencies. No schema changes.
- **Client**: `client/src/features/specs/components/TicketDetailModal.tsx` — replace sidebar AI Edit block with expanded main-content flow. New components: `AiEditDiffView`, `SessionAttachmentBar`, `AiEditComposer` (extracted from current inline logic). Add `diff` npm package (~30 KB) for word-level diffing.
- **State scope**: Refinement history + proposed draft live in client component state only — ephemeral, cleared on modal close. No persistence, no DB changes.
- **Out of scope**: ProposeSpecModal (stays one-shot); per-hunk accept/reject; slash-command shortcuts (`/shorter`, `/expand`); side-panel composer; persisting history to disk.
