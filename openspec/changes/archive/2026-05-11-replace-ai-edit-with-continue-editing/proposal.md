## Why

`TicketAiEditOverlay` was AI Edit's entry point for tickets — a separate UX with its own shell, its own diff view, its own session-attachment scoping, and its own status pills, all to do something Explore Spec (now powered up with Review changes) can do natively: refine a ticket's text in conversation and audit the result before commit. With Phase A landed, Explore is the strictly better surface: same conversational paradigm as new-spec creation, same Review overlay with word-level diff, same minimize-to-dock, same save-as-draft semantics. Keeping two competing surfaces for "refine a ticket's text" is now pure cost: two UXes for users to learn, two test surfaces to maintain, drift risk between them.

This change retires `TicketAiEditOverlay` and replaces the `AI Edit` button on `TicketDetailModal` with `Continue Editing` that opens `ExploreSpecShell` seeded with the ticket. The ticket itself becomes the baseline for the Review overlay's diff, so the user sees real before/after when they audit their changes.

## What Changes

- **Replace the `AI Edit` button** on `TicketDetailModal` with a `Continue Editing` button. Visible only when the ticket is in `todo`, `backlog`, or `draft` status. Hidden (or disabled with tooltip) for `in_progress` / `done` / `cancelled`.
- **Drafts keep their existing `Continue Explore` flow** unchanged — the new `Continue Editing` action is the equivalent affordance for non-draft tickets and renders with the same wording. (For consistency we standardise on "Continue Editing" as the visible label for both; the underlying handler routes by ticket status.)
- **`ExploreSpecShell` accepts an `editTicket` prop** (seed-from-existing-ticket mode). When set:
  - The conversation starts fresh (no `resumeConversationId`) so the user has a clean chat surface
  - The draft pane is pre-populated with the ticket's title, description, labels, priority, and any acceptance criteria parsed out of the description body
  - The `ExploreReviewOverlay` baseline is the original ticket (NOT empty), so the Review step shows real diff
  - Commit hits **`PATCH /tickets/:id`** instead of `POST /tickets/from-draft` and **does not change ticket status**
- **Extend `PATCH /tickets/:id`** with an optional `acceptanceCriteria: string[]` field that, when present, folds into the description body under `## Acceptance Criteria` (same formatting as `from-draft` already does).
- **Delete `TicketAiEditOverlay`** and its tests. Remove the imports + state from `TicketDetailModal`. The `AiEditShell` itself stays alive (still used by `AiRefineOverlay` for custom agents in `.claude/agents/`).
- **No analytics rename** — `surface='ai-edit'` continues to receive entries from `AiRefineOverlay` (agents). Tickets now log under `surface='explore-spec'`.
- **No database migration** — `agent_refine_sessions` table stays (used by Agents flow). Existing ticket-bound AI Edit sessions are abandoned (single-flow rows are cheap to leave).

## Capabilities

### New Capabilities

_None — additive behaviour layers onto the existing `explore-spec` capability._

### Modified Capabilities

- `explore-spec`: adds the seed-from-existing-ticket mode (`editTicket`), the update-in-place commit path, and the wiring rules for the Review overlay's non-empty baseline.
- `ai-edit-diff-review`: scope contracts. The capability previously covered AI Edit on tickets; that surface is removed and the capability narrows to its remaining caller (`AiRefineOverlay` on custom agents) which is the `ai-refine-custom-agents` capability. We MARK the ticket-scoped requirements as REMOVED so the spec accurately reflects the surface that exists.

## Impact

- **Server**:
  - `server/project-router.ts` — extend the existing `PATCH /api/projects/:projectId/tickets/:id` to accept `acceptanceCriteria: string[]`, folding into description when present
- **Client**:
  - `client/src/features/specs/components/TicketDetailModal.tsx` — remove `TicketAiEditOverlay` import + state + button; add `Continue Editing` button gated by ticket status; on click, hand off to a new flow that mounts `ExploreSpecShell` (likely via `MinimizedChatsContext.triggerResume` or a dedicated overlay slot)
  - `client/src/features/specs/components/explore-spec/ExploreSpecShell.tsx` — new optional `editTicket` prop with the ticket payload; when present, seed draft + use non-empty baseline + commit via PATCH
  - `client/src/features/specs/components/explore-spec/ExploreReviewOverlay.tsx` — no changes (already accepts arbitrary baseline)
  - **Delete**: `client/src/components/tickets/TicketAiEditOverlay.tsx`, `client/src/components/tickets/__tests__/TicketAiEditOverlay.test.tsx` (if exists)
  - `client/src/components/AiEditDiffView.tsx` — kept as-is for `AiRefineOverlay` use
- **Specs**: ADDED requirements under `explore-spec` for the edit-existing-ticket flow; REMOVED requirements under `ai-edit-diff-review` for the ticket-scoped surface
- **Tests**:
  - Server: extend `project-router.test.ts` for PATCH with `acceptanceCriteria`
  - Client: extend `ExploreSpecShell.test.tsx` / new test file for seed-from-ticket mode; verify Continue Editing on TicketDetailModal opens the shell with the right seed; verify Review overlay receives non-empty baseline
  - **Delete**: any tests dedicated to `TicketAiEditOverlay` (if present)
- **No new dependencies**, no migrations, no analytics surface renames.
- **Phase A's escape hatch (`VITE_FEATURE_EXPLORE_REVIEW=false`) still works** — disables the Review button inside the edit flow but does not break Continue Editing.
