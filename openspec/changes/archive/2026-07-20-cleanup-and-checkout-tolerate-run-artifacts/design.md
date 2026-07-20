# Design — cleanup and checkout tolerate run-created artifacts

## Context

Both gates come from the #548 hardening and are deliberately conservative. Live repro (2026-07-12, brain-ai-coach-service ticket-112): Checkout 409s on `?? .specrails/local-tickets.json` (app-owned, permanent on legacy projects), and a successfully delivered worktree is preserved with "changes made after settlement" whose entire status output is `!! __pycache__/ …` — Python bytecode created by the run's own test execution. Verified empirically: non-force `git worktree remove` succeeds with only ignored files present (git's own final TOCTOU guard already treats ignored as disposable), and `git checkout` aborts by itself on an untracked collision leaving the tree untouched.

## Goals / Non-Goals

**Goals:**

- Checkout works when the main folder's only dirt is untracked files; still refuses on tracked modifications; a genuine untracked collision still fails safely (git aborts, we surface it).
- A delivered worktree whose only post-settlement status entries are run-created gitignored artifacts releases cleanly, with the authorization anchored to immutable settlement evidence — never to a live classification of "looks like cache".
- A NEW ignored path appearing after settlement preserves the worktree exactly as today (the user-parks-work-after-Inspect threat model stays covered).

**Non-Goals:**

- No pattern allowlists (`__pycache__`, `node_modules`, …) — classification stays evidence-based, not name-based.
- No change to untracked (non-ignored) handling at release: any unexcluded untracked path still preserves.
- No forced removal anywhere; non-force `git worktree remove` remains the final guard.
- No backfill for legacy delivery rows (absent snapshot ⇒ no ignored authorization ⇒ today's behavior).

## Decisions

### D1 — Checkout gates count tracked changes only

`inspectProjectCheckoutCleanliness` and the redundant inner gate in `checkoutProjectReviewBranch` run `git status --porcelain --untracked-files=no`. Rationale: `git checkout` never deletes or modifies untracked files; the only untracked risk is a path collision with the target branch, which git itself refuses (verified: exit 1, tree untouched) and the checkout flow already reports as a failure. Counting untracked made Checkout structurally unusable on legacy projects (`.specrails/**` app state) — a protective refusal that protects nothing.

*Alternative considered*: allowlisting `.specrails/**` — rejected; any other untracked file (editor droppings, `.DS_Store`) would still permanently block, and the underlying premise (untracked = at risk) is false.

### D2 — Settlement snapshot is the sole ignored-path authorization

At settlement, immediately after `commitWorktreeAndVerify` proves the worktree clean, the launcher captures `git status --porcelain --untracked-files=all --ignored=matching -- . <overlay excludes>` and records the `!! ` paths as `settlementIgnoredPaths` on the unit's `DeliverBranchRecord`. Everything ignored at that instant was created by the run itself (the worktree is app-created; deliverables are already committed), so it is reproducible run residue by construction. The release preflight splits its check: tracked/untracked lines must be empty (minus verified overlay evidence — unchanged), and every live `!!` path must be a member of the recorded snapshot (prefix-aware for directories). Any live ignored path outside the snapshot preserves the worktree — that is exactly "a change made after settlement".

*Alternative considered*: dropping `--ignored=matching` entirely (aligning with git's own non-force guard) — rejected; it would silently delete an ignored file a user parked in the worktree after settlement, which the spec's threat model explicitly protects.

*Accepted corner*: an EDIT to an ignored file that already existed at settlement is not detected (paths, not digests — fingerprinting `node_modules`-scale trees is infeasible). The file was created by the run inside an app-owned transient worktree and is declared disposable by the repo's own gitignore; the quarantine/overlay machinery is unaffected.

### D3 — Durable collapse mirrors the overlay-evidence pattern

`durableSettlementIgnoredPaths(records)` collapses per branch exactly like `durableOverlayCleanupEvidence`: malformed entries are dropped, conflicting per-branch snapshots (two records, different sets) grant NO authorization, paths are sanitized with the same `safeRelativeOverlayPath` rules. Cap: >400 paths ⇒ record `null` at capture time ⇒ no authorization (fail-safe preserve, disclosed in the warning as today).

### D4 — Additive persistence, zero migration

`DeliverBranchRecord.settlementIgnoredPaths?: string[] | null` rides the existing `branches` JSON column. Legacy rows (and rows from settles that couldn't run the capture) simply lack the field → the release preflight behaves byte-identically to today for them.

## Risks / Trade-offs

- [Snapshot taken before a late writer adds an ignored file in the same settle window] → the release-time check compares LIVE state against the snapshot; a later-appearing path is outside the snapshot and preserves. The window between proof-of-clean and snapshot capture is milliseconds and only shrinks authorization, never widens it.
- [Ignored-file edits post-settlement go undetected (D2 corner)] → accepted and documented; overlay-copied files keep their digest evidence and quarantine path.
- [Checkout now allows switching with untracked files present] → git aborts on real collisions; `pull --ff-only` equally refuses to clobber untracked content.

## Migration Plan

No flag, no migration. Rollback = revert; new JSON fields are ignored by older code.

## Open Questions

None.
