## Why

When a user finishes shaping a spec in Explore today, the only feedback before commit is the draft pane itself — every field is shown in its final form, with no separation between "I'm still iterating" and "I'm about to commit". AI Edit already solved this for ticket text refinement with a word-level diff review step, but that capability is locked inside `TicketAiEditOverlay` and not available in Explore.

Porting the diff-review step into Explore as a deliberate "Review changes" overlay closes the gap: Explore becomes powerful enough to ALSO be the future home of "Continue exploring" on existing tickets (Phase B of the broader plan), while also benefitting brand-new specs by giving users a final, structured "this is what I'm about to commit" pass before the click.

## What Changes

- **New `Review changes` overlay**: invoked from a new `Review →` action next to `Create Spec` in the Explore composer footer. The overlay renders ALL draft fields with their proposed values; the description and title surface **word-level diffs** against a baseline; labels and acceptance criteria are rendered as add/remove chip diffs. The Create/Update action lives inside the overlay; the user can click `Back to edit` to return to Explore without losing state.
- **Word-level diff** uses the existing `diff` npm dependency (already used by `AiEditDiffView`) — same library, similar render style, but adapted to Explore's draft shape.
- **Diff baseline**: for a brand-new draft, baseline is empty (so the overlay is effectively a structured preview, not a diff). The architecture is designed so Phase B (Continue exploring on existing tickets) can drop in a non-empty baseline without touching Explore internals.
- **No fixed suggestion chips** — Explore keeps the model-driven `chips` from the `spec-draft` block as today. Out of scope.
- **No reversible apply / snapshot** — Explore commits via the existing `from-draft` path (or its future PATCH equivalent in Phase B). Out of scope for v1.
- **Phase B (replacing `TicketAiEditOverlay` with `Continue exploring`)** is intentionally **NOT in this change**. This change ONLY powers Explore up with the Review overlay. A follow-up change consumes the new capability.

## Capabilities

### New Capabilities

_None — additive behaviour layers onto the existing `explore-spec` capability._

### Modified Capabilities

- `explore-spec`: adds requirements around the Review changes overlay (entry point, field rendering, word-level diff for text fields, chip diff for arrays, Back-to-edit, Create from overlay), and around the diff baseline contract used by future callers.

## Impact

- **Client**:
  - New `client/src/features/specs/components/explore-spec/ExploreReviewOverlay.tsx` — full-screen overlay rendering each draft field with diff vs. baseline. Reuses `diff` package via a new helper.
  - New shared helper `client/src/features/specs/components/explore-spec/diff-utils.ts` — `wordDiff(a, b)`, `arrayDiff(a, b)` returning typed segment lists usable by both text and chip renderers.
  - `client/src/features/specs/components/explore-spec/ExploreSpecShell.tsx` — new `Review →` button next to `Create Spec`; state for overlay open/closed; passes current draft + an optional baseline prop (defaulting to empty draft) to the overlay.
  - `client/src/features/specs/components/explore-spec/SpecDraftPanel.tsx` — unchanged (left pane stays "editing" view; diff lives in the overlay).
  - Existing `AiEditDiffView` reused or wrapped where appropriate; the new helper extracts the core word-diff into a shared util so both surfaces stay aligned.
- **Server**: no changes. The Create Spec path still hits the existing `POST /tickets/from-draft`.
- **Specs**: 5-7 new ADDED requirements under `explore-spec`.
- **Tests**: new component tests for `ExploreReviewOverlay` (word diff render, array diff render, Back navigation, Create commits). New unit tests for `diff-utils`. ExploreSpecShell tests extended for the new button and overlay wiring.
- **No new dependencies** — the `diff` package is already in `client/package.json` and used by `AiEditDiffView`.
- **No changes** to: `TicketAiEditOverlay`, `AiEditShell`, `AiRefineOverlay`, server endpoints, or analytics surfaces. Phase B (which DOES delete `TicketAiEditOverlay`) is a separate future change.
