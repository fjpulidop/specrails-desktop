## Context

After Phase A (`power-up-explore-review-diff`) landed, Explore Spec now has every ingredient AI Edit used to be unique for: word-level diff via the Review overlay, configurable baseline, conversation-driven refinement, save-as-draft, minimize-to-dock, and char-by-char streaming UX. `TicketAiEditOverlay` — the surface that wired AI Edit into `TicketDetailModal` — duplicates all of that with a worse, narrower implementation: it can only refine `title + description`, has no draft pane for labels/priority/criteria, no minimize, no save-as-draft, no `Continue Explore` rehydration. Keeping it alive after Phase A is pure inventory.

The user has chosen to retire it. This change replaces the `AI Edit` button on `TicketDetailModal` with `Continue Editing`, which opens `ExploreSpecShell` seeded with the existing ticket as both the initial draft AND the Review baseline. The conversation starts fresh — there is no carried-over chat history because tickets historically have no `origin_conversation_id` except for ones that were saved-as-draft.

`AiEditShell` (the shared shell component) and `AiRefineOverlay` (its agent-refine consumer in `.claude/agents/custom-*.md`) stay alive. Only the ticket-scoped surface (`TicketAiEditOverlay`) and its capability requirements under `ai-edit-diff-review` are removed.

## Goals / Non-Goals

**Goals:**

- Remove `TicketAiEditOverlay` from the codebase entirely (component file + its tests + import sites).
- Add `Continue Editing` button on `TicketDetailModal`, gated by ticket status, that opens `ExploreSpecShell` seeded with the ticket and configured to commit via `PATCH /tickets/:id`.
- Seed the Review overlay's baseline with the original ticket so the diff shows real before/after, naturally exercising the contract Phase A built.
- Keep `AiEditShell` and `AiRefineOverlay` (agents) untouched.
- Preserve all currently-archived behaviour around the `Continue Explore` button on draft tickets — same conversation rehydration semantics. The new `Continue Editing` button is a wider affordance covering draft + todo + backlog.
- Hold or improve current coverage thresholds (server 80%, client 80%).

**Non-Goals:**

- Refactoring `AiEditShell` to use `diff-utils` from Phase A. That's a future code-quality follow-up after Phase B settles and tests stabilise.
- Renaming `surface='ai-edit'` in `ai_invocations`. Existing rows + future agent-refine rows continue to use it; only the ticket scope shifts to `surface='explore-spec'`. The shift is automatic because the ticket flow now uses `ChatManager.sendMessage` with `kind='explore'` and ChatManager already records under `explore-spec`.
- Adding any new ticket statuses or status transitions.
- Backporting `acceptanceCriteria` into existing tickets that don't have a `## Acceptance Criteria` section. New edits that add criteria simply append/replace the section.
- Allowing edit-mid-job (status `in_progress`). Excluded per the user's locked decision.
- Surfacing AI-Edit-on-agents (`AiRefineOverlay`) inside Explore. Agent files are not specs; they remain in their own catalog flow.

## Decisions

### D1: Visibility — `Continue Editing` only for `todo` / `backlog` / `draft`

The button is conditionally rendered in `TicketDetailModal` based on `ticket.status`:

| Status | Button visible? |
|---|---|
| `draft` | ✅ Yes (replaces existing `Continue Explore` affordance — same wording) |
| `todo` / `backlog` | ✅ Yes |
| `in_progress` | ❌ Hidden |
| `done` / `cancelled` | ❌ Hidden |

**Why.** Editing in-flight work creates confusing race conditions (jobs running, ticket text changing); editing closed work is noise. The narrow gate keeps UX intentional.

**Alternatives considered.** *Disabled-with-tooltip for in_progress*: tempting but invites users to bypass it; hiding is clearer.

### D2: `ExploreSpecShell` gains an `editTicket` prop

```ts
interface EditTicketSeed {
  id: number
  title: string
  description: string
  labels: string[]
  priority: 'low' | 'medium' | 'high' | 'critical' | null
  /** Parsed from the description body if a `## Acceptance Criteria` section exists. */
  acceptanceCriteria: string[]
}

interface ExploreSpecShellProps {
  // ... existing
  editTicket?: EditTicketSeed
}
```

When `editTicket` is set:

- The shell starts in `non-resumed, non-draft, edit-existing` mode. No `resumeConversationId` is used (the existing draft-resume path stays untouched for legit drafts).
- The shell's local draft state is initialised from `editTicket` instead of waiting for the first `spec-draft` WS update.
- The `ExploreReviewOverlay` baseline becomes `editTicket` (not `EMPTY_REVIEW_BASELINE`).
- The commit handler (currently `handleCreate` calling `from-draft`) detects `editTicket` and instead calls `PATCH /tickets/:id` with the current draft fields.
- The shell's header eyebrow renders `EDITING SPEC · {ticket.id}` (instead of `EXPLORE SPEC · INTERACTIVE`) so the user knows they're updating, not creating.

**Why.** A single prop is the cleanest way to express "edit existing ticket" without forking the shell. All downstream wiring branches off it.

### D3: Acceptance criteria parsing from description

Tickets store all spec body in `description` as markdown. A `## Acceptance Criteria` section, when present, is the canonical form (matches what `from-draft` writes). Client-side helper:

```ts
function parseAcceptanceCriteria(description: string): { body: string; criteria: string[] }
```

Splits `description` at the first `## Acceptance Criteria` heading; everything before is `body`, bullets under it become `criteria`. When committing, the helper folds `criteria` back into `description` under the same heading (matching `from-draft`'s output).

**Why.** Tickets are a single text field on disk; the structured fields the user sees in Explore are extracted/folded at the seams. Keeps the storage format stable.

**Alternatives considered.** *Add a separate `acceptance_criteria` column to the ticket store*: invasive, migration-heavy, breaks existing tickets that don't have one. Defer indefinitely.

### D4: Commit endpoint — extend existing `PATCH /tickets/:id`

The server already exposes `PATCH /api/projects/:projectId/tickets/:id` accepting `title`, `description`, `status`, `priority`, `labels`, `assignee`, `prerequisites`, `metadata`. We add **one** optional field: `acceptanceCriteria: string[]`. When present, server-side handler builds the final description by folding the criteria into a `## Acceptance Criteria` section (replacing any existing one), then writes via `mutateStore`.

We do NOT change ticket status from this endpoint (the user explicitly editing text should never accidentally flip a `todo` to `done`).

**Why.** Reusing an endpoint over inventing a new one is the smallest possible surface. The folding logic mirrors `from-draft`'s existing code, ideally factored into a shared `formatDescriptionWithCriteria(body, criteria)` helper to avoid drift.

**Alternatives considered.** *New `POST /tickets/:id/update-from-draft` endpoint*: more code, no benefit. *Make the client fold criteria itself before PATCH*: duplicates logic across client/server with no benefit.

### D5: Conversation lifetime — fresh per edit session

When `Continue Editing` is clicked, a NEW conversation is created (no resume). The user can converse, refine, click `Review →`, audit the diff against the original ticket, click `Create Spec` — the button text inside the overlay reads `Update Spec` in edit mode for clarity — and the ticket is patched.

The conversation is NOT persisted on the ticket after commit. If the user wants to edit again later, they click `Continue Editing` again and get a fresh session. (Drafts have their own different lifetime via `origin_conversation_id`; this change doesn't touch that.)

**Why.** Editing sessions are transient by intention. Persisting them across opens would tie tickets to lingering chat history that may no longer reflect the current state.

**Alternatives considered.** *Persist the conversation id on the ticket for "View edit history"*: nice but out of scope; defer until users ask.

### D6: Review overlay button label adapts in edit mode

The footer button inside `ExploreReviewOverlay` reads:

- `Create Spec` when creating a new ticket (`editTicket` is unset)
- `Update Spec` when in edit mode (`editTicket` set)

Same handler is called either way; the visible label is the only difference. The `aria-label` and `data-testid` stay constant (`review-commit`) so tests don't need branching.

**Why.** Same affordance, different verb. Avoids confusing a user editing an existing ticket into thinking they're creating a second one.

### D7: Removal hygiene — what gets deleted and what stays

**Delete:**
- `client/src/components/tickets/TicketAiEditOverlay.tsx`
- `client/src/components/tickets/__tests__/TicketAiEditOverlay.test.tsx` (if present)
- All imports of `TicketAiEditOverlay` (only `TicketDetailModal.tsx`)
- The `aiEditOpen` state, `handleAi*` methods, and snapshot revert affordance in `TicketDetailModal` (the snapshot mechanism was AI-Edit-specific)

**Keep:**
- `client/src/features/code/components/ai-edit/AiEditShell.tsx` — used by `AiRefineOverlay`
- `client/src/features/code/components/ai-edit/__tests__/AiEditShell.test.tsx`
- `client/src/features/agents/components/AiRefineOverlay.tsx`
- `client/src/components/AiEditDiffView.tsx` — used by `AiRefineOverlay`'s shell
- `server/agent-refine-*.ts` — still backs agent-refine sessions
- `agent_refine_sessions` SQLite table — still in use

**Spec deltas:**
- `explore-spec` gets ADDED requirements for `Continue Editing` and edit-mode shell behaviour
- `ai-edit-diff-review` gets REMOVED requirements for the ticket-scoped surface (its agent-scoped capabilities migrate to `ai-refine-custom-agents` which already covers them — no duplication needed)

### D8: UX placement of the `Continue Editing` button

`TicketAiEditOverlay`'s button today is in the right-rail of `TicketDetailModal` next to the labels section. `Continue Editing` replaces it in-place — same position, same visual style (outline button, same width). For draft tickets, the existing `Continue Explore` button (in the detail body) is renamed to `Continue Editing` for consistency, and its handler is the same. One button, one wording, three statuses.

**Why.** Same surface, no UI churn. Users with muscle memory for AI Edit's location find `Continue Editing` there immediately.

## Risks / Trade-offs

- **[Risk] Users who used AI Edit heavily lose the word-level diff "inline on a single field"**. → The Review overlay shows the same diff and more (all fields). The transition is forward, not regressive.
- **[Risk] Snapshot revert disappears**. AI Edit had `descriptionSnapshot` / `titleSnapshot` letting users revert their last AI-applied change. Phase B kills this. → Mitigation: an undone refinement is just one more refinement away ("revert to the previous wording") via conversation. If users complain, add an explicit "Revert to last save" button later (out of scope).
- **[Risk] Conversation history is not persisted post-edit**. → Tickets are not chat threads; if users want a paper trail, they save-as-draft mid-edit. Out of scope.
- **[Risk] PATCH endpoint gets a new field, callers may forget to pass it**. → The field is optional. Existing PATCH callers (drag-drop status change, label add/remove, etc.) keep working. Only the edit-existing-ticket commit path uses it.
- **[Risk] `parseAcceptanceCriteria` misparses tickets whose body uses non-standard heading levels or alternate phrasing**. → Match only the exact `## Acceptance Criteria` heading, case-insensitive. Anything else stays in the body as-is. Worst case the user re-adds the criteria explicitly. Document the requirement in the helper's JSDoc.
- **[Trade-off] We do not unify `AiEditShell`'s diff renderer with the new `diff-utils`**. → Two implementations of word diff coexist (`AiEditDiffView` + the new overlay's inline `DiffText`). They render visually identically. Defer the merge until the next time someone touches either.
- **[Trade-off] Tickets that have been heavily edited via AI Edit accumulate `surface='ai-edit'` invocation rows from past usage that won't grow further**. → Acceptable. Analytics history is forever; current behaviour is what matters going forward.

## Migration Plan

1. Ship as an all-at-once swap. There is no user-visible flag — the AI Edit button is replaced by Continue Editing in the same release.
2. **Rollback strategy**: revert the change (single commit, narrow blast radius). Phase A's `VITE_FEATURE_EXPLORE_REVIEW=false` flag still works independently and is unaffected.
3. No data migration. The `agent_refine_sessions` table keeps its prior ticket-bound rows; they're inert. No SQL to run.
4. Existing in-flight AI Edit sessions on tickets (if any are open the moment the new build ships) are abandoned client-side — the user sees `Continue Editing` instead of their open AI Edit overlay. Acceptable for a refinement surface that's not in critical path.

## Open Questions

- *Should `Continue Editing` appear in the right-rail OR in the modal header next to the close button?* The right-rail keeps continuity with where AI Edit lived; the header is more discoverable. Lean right-rail. Confirm during implementation when seeing it in context.
- *Should we add a small visual cue inside the Review overlay when in edit mode (e.g., "Editing ticket #42")?* Lean yes — a single line above the diff body so the user knows what they're updating. Cheap addition.
- *What happens if the user opens Continue Editing on a draft ticket that ALSO has `origin_conversation_id`?* Today's `Continue Explore` resumes the conversation. The unified `Continue Editing` button on drafts should preserve that resume behaviour — so drafts route to the existing resume flow, non-drafts route to the new fresh-edit flow. The button label is the same; the handler branches on status. Confirm during implementation.
