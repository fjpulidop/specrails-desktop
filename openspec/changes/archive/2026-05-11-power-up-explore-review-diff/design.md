## Context

Today's Explore Spec shell renders the live draft on the right pane as the user converses with Claude. When the user is ready to commit, they click `Create Spec` and the ticket is inserted via `POST /tickets/from-draft`. There is **no intermediate "Review" step** — the draft pane is the only surface the user sees, and the act of clicking Create Spec is the only "moment of commit".

AI Edit (its ticket variant in `TicketAiEditOverlay`) has a different shape today: the user iterates, then the shell enters a `reviewing` UI state where `AiEditDiffView` renders a word-level diff of the proposed description against the saved baseline. The user accepts or rolls back from there. This pattern is validated and beloved by users, but the implementation is locked inside an overlay that ONLY supports `{title, description}` of an existing ticket — it does not know about labels, priority, acceptance criteria, or new-spec creation.

Per the broader plan (`unify-spec-edit-flows`), Phase A — this change — ports the diff-review affordance into Explore as a deliberate overlay step. Phase B (a separate change) will then replace `TicketAiEditOverlay` with `Continue exploring`, leaning on the new Review overlay to provide the diff feature that AI Edit users relied on.

This change is intentionally **scoped to Phase A only**. Nothing is deleted. The Phase B follow-up is what removes `TicketAiEditOverlay` and re-wires Ticket Detail.

## Goals / Non-Goals

**Goals:**

- Add an opt-in "Review changes" overlay to `ExploreSpecShell` that renders all draft fields with word-level diffs (text fields) and add/remove diffs (label / criteria arrays) against a configurable baseline.
- Reuse the `diff` npm package already in the client (no new dependencies).
- Extract a small shared helper (`diff-utils.ts`) so both `AiEditDiffView` and the new overlay produce visually consistent diffs.
- Design the baseline contract so Phase B can pass a non-empty baseline (the existing ticket) without changing Explore internals.
- Keep the Review overlay fully optional — current Explore users can still click Create Spec without ever opening Review. Review is an additional path, not a replacement.
- Hold or improve current coverage thresholds (client 80% lines/statements, 70% functions).

**Non-Goals:**

- Replacing `TicketAiEditOverlay`. That is Phase B in a separate change.
- Replacing `AiRefineOverlay` (custom agents). That overlay edits real `.md` files in `.claude/agents/custom-*.md` and stays as-is.
- Adding fixed suggestion chips ("Tighten the language", etc.) — user explicitly declined.
- Snapshot / reversible apply — user explicitly declined.
- Allowing the Review overlay to commit on an EXISTING ticket (Phase B). The overlay's Create button in this change always hits `POST /tickets/from-draft` (new ticket). The baseline prop exists in the API for Phase B but is exercised in this change only with an empty default.
- Server changes. The endpoint and persistence path are untouched.

## Decisions

### D1: Review overlay is a separate full-screen overlay, not inline

The overlay is rendered on top of `ExploreSpecShell` with a backdrop, blocking input on the underlying shell. The shell remains mounted so `Back to edit` returns to the exact same conversation/draft state with no remount. Layout: two columns inside the overlay (`Title` + `Description` left, `Labels` + `Priority` + `Acceptance Criteria` right) on wide screens, single-column on narrow. Header `REVIEW CHANGES · explore-spec`; footer with `[← Back to edit]` and `[Create Spec]`.

**Why.** A separate moment of conscious review keeps the editing experience visually clean for the iterative phase and gives the commit click a deliberate "audit" gate. The shell stays mounted so the user can flip back and forth without re-bootstrapping the conversation.

**Alternatives considered.**
- *Inline highlights in the draft pane*: cluttered for new specs where there's no "before". Forces diff visibility even when irrelevant.
- *Drawer slide-in*: visually noisier, harder to fit the two-column diff layout responsively.

### D2: Baseline contract

`ExploreReviewOverlay` accepts a single `baseline` prop typed as:

```ts
interface ReviewBaseline {
  title: string
  description: string
  labels: string[]
  priority: 'low' | 'medium' | 'high' | 'critical' | null
  acceptanceCriteria: string[]
}
```

In this change `ExploreSpecShell` always passes the empty baseline `{ title: '', description: '', labels: [], priority: null, acceptanceCriteria: [] }`. The overlay treats every field as "added" when baseline is empty, which renders as the proposed value highlighted as new (no `~~strikethrough~~` for "removed" content). For Phase B, the baseline will be populated from the existing ticket and the diff will show real before/after.

**Why.** A single typed contract that handles both "new spec" and "edit existing" symmetrically. Phase B doesn't need to touch the overlay; it only needs to pass a richer baseline.

### D3: Word-level diff for `title` and `description`; structural diff for arrays

Text fields (`title`, `description`) use `diffWords` from the `diff` package — the same approach as `AiEditDiffView`. Output: a stream of `{value, added?, removed?}` segments rendered with semantic Tailwind tokens (`accent-success` for additions, `accent-warning` strikethrough for removals, default for unchanged).

Array fields (`labels`, `acceptanceCriteria`) use a set-based diff:
- `added` = items in proposed but not in baseline
- `removed` = items in baseline but not in proposed
- `unchanged` = items in both
Order of `proposed` is preserved for `unchanged + added`; `removed` items are listed below them.

`priority` uses a simple before/after pill ("low → high" if changed, single pill if unchanged or only one side has a value).

**Why.** Word-level for prose is what users expect (matches AI Edit). Set-based for tags / criteria avoids spurious "reordered" diffs and matches how the spec actually thinks about those fields.

**Alternatives considered.**
- *Line-level for description*: too coarse — entire paragraphs would be marked changed for a single-word tweak.
- *Sequence diff for labels*: noisy on reorder. Order doesn't carry semantic meaning for tags.

### D4: Shared `diff-utils` helper

Extract the word-diff core into `client/src/features/specs/components/explore-spec/diff-utils.ts`:

```ts
export interface DiffSegment { value: string; added?: boolean; removed?: boolean }
export function wordDiff(a: string, b: string): DiffSegment[]
export function arrayDiff<T>(a: T[], b: T[], eq?: (x: T, y: T) => boolean):
  { added: T[]; removed: T[]; unchanged: T[] }
```

`AiEditDiffView` is **NOT refactored** in this change to consume the helper — that's a follow-up after Phase B lands and the AI Edit code is reshaped. The helper exists so the new overlay doesn't reinvent `diffWords` wrapping and is testable in isolation.

**Why.** Touching `AiEditDiffView` now is gratuitous risk (its tests are tied to its current shape and AI Edit is still active). Keep the new helper pure and independently testable; align the two views in Phase B.

### D5: Entry point + UX

The composer footer in `ExploreSpecShell` already has `[Send] ⌘⏎` on the right and chips/composer on the left. Add a `Review →` outline button **only when the draft has a non-empty `title`** (same gating as `Create Spec` today). The current `Create Spec` button remains where it is — clicking it still commits directly without opening Review. Review is opt-in, not a forced funnel:

```
[Composer................]  [Send ⌘⏎] [Review →] [Create Spec]
```

Inside the overlay, the `Create Spec` button in the overlay footer IS the same commit action — clicking it dispatches the same POST and the overlay closes the shell on success. The user has two routes to commit: fast path (Create Spec in footer) and reviewed path (Review → Create Spec inside overlay). Both call into the same handler.

**Alternative considered.** *Force every commit through Review*: rejected. Users who know what they're about to commit shouldn't have to click twice. Review is an audit affordance, not a wall.

### D6: Overlay lifecycle and state

- Overlay opens with the CURRENT live draft as `proposed`. If the user clicks Send mid-Review (impossible — composer is blocked), or if a new `spec_draft.update` WS event arrives while the overlay is open, the overlay re-renders against the new proposed draft. This is rare in practice — review is a "I'm done iterating" gesture — but the live binding keeps state consistent.
- `Back to edit` simply closes the overlay; no state mutation. Shell continues exactly where it left off.
- `Esc` closes the overlay equivalent to Back to edit.
- The overlay does NOT minimize-to-toast independently — minimizing the shell while Review is open closes the overlay first.

### D7: Tests

New tests:

- `client/src/features/specs/components/explore-spec/__tests__/diff-utils.test.ts` — wordDiff: identical, fully different, partial, empty baseline; arrayDiff: empty/empty, added-only, removed-only, mixed.
- `client/src/features/specs/components/explore-spec/__tests__/ExploreReviewOverlay.test.tsx` — renders with empty baseline (all "added"), renders with non-empty baseline (mixed), Back-to-edit fires callback, Create-Spec fires callback, Esc fires Back-to-edit callback.
- `client/src/features/specs/components/explore-spec/__tests__/ExploreSpecShell.test.tsx` — `Review →` button appears when title non-empty, opens overlay, Create from overlay calls the same commit path as Create Spec in footer.

Coverage thresholds (client 80% L / 70% F / 80% S) must hold.

## Risks / Trade-offs

- **[Risk] Two commit paths (footer + overlay) drift apart**. Both buttons call the same handler — guard with a single unit test asserting both wire to the same callback identity. → Mitigation: extract the commit handler into a stable ref / callback hooked once in the shell; both buttons close over the same function.
- **[Risk] `diff` package size adds to bundle**. → Already imported by `AiEditDiffView`. No new dep.
- **[Risk] Word diff on a long description (5 KB) hits a perceptible delay**. → `diffWords` is fast for this size. If we later see a problem, memoize on (baseline, proposed) — already trivial via `useMemo`.
- **[Risk] Overlay forgets state on the very rare WS draft update arriving mid-review**. → Overlay reads draft directly from the same source ExploreSpecShell uses (`useSpecDraftStream`), so it always reflects the latest. Acceptable.
- **[Risk] Phase B never happens and the baseline contract becomes dead code**. → The baseline is a 4-property object with a sensible empty default. Cost is ~20 LoC and one test. Acceptable insurance.
- **[Trade-off] No reversible apply**. If a user clicks Create Spec from the overlay and immediately wants to "undo", they have to manually edit the freshly-created ticket. Acceptable for this change; revisit if users complain.
- **[Trade-off] Review is opt-in, not forced**. Some users will keep one-clicking Create Spec and never see the overlay. That's fine — the audit gate exists for the people who want it.

## Migration Plan

1. Ship as additive behaviour. No flag needed — the button only appears when the draft has a title (same condition as Create Spec). Users who never click `Review →` see no difference.
2. No data migrations; no server changes; no spec schema changes.
3. **Rollback strategy**: a single client build-time flag `VITE_FEATURE_EXPLORE_REVIEW=false` removes the `Review →` button entirely. The overlay code stays in the bundle (harmless) but is unreachable.
4. Phase B will land as a separate change that imports `ExploreReviewOverlay` with a real baseline and re-wires the Ticket Detail entry.

## Open Questions

- *Should the overlay show a sticky summary count ("3 fields changed, 2 added")?* Nice-to-have. Defer until users ask.
- *Should `Cmd+Enter` from inside the overlay trigger Create Spec?* Lean yes for keyboard parity with the composer. Confirm during implementation; add the binding if it doesn't conflict with the conversation pane's Cmd+Enter.
- *Should Review be reachable from the chips row (e.g. when the model emits `ready: true`)?* Today the chips row stays as-is. If users start asking for a one-click "Review now" shortcut from the ready-banner, add it later.
