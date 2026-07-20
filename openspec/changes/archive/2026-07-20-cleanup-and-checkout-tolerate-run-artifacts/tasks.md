# Tasks — cleanup and checkout tolerate run-created artifacts

## 1. Checkout gates count tracked changes only

- [x] 1.1 `server/project-git.ts`: `inspectProjectCheckoutCleanliness` and the inner `checkoutProjectReviewBranch` gate use `git status --porcelain --untracked-files=no`.
- [x] 1.2 Tests: untracked-only main folder passes both gates; a tracked modification still refuses; an untracked collision surfaces git's own abort as a failed checkout.

## 2. Settlement snapshot of ignored paths

- [x] 2.1 `server/rail-pr-store.ts`: additive `DeliverBranchRecord.settlementIgnoredPaths?: string[] | null`.
- [x] 2.2 `server/rail-isolated-launch.ts`: after `commitWorktreeAndVerify` proves clean, capture `git status --porcelain --untracked-files=all --ignored=matching` `!!` paths (minus overlay excludes), cap 400 (over → null), thread into the settled branch record.
- [x] 2.3 Tests: capture records run-created ignored dirs; overflow records null; capture failure records null.

## 3. Release preflight split

- [x] 3.1 `server/rail-worktree-release.ts`: `durableSettlementIgnoredPaths(records)` (same collapse rules as overlay evidence: sanitize, conflict → none) + `verifyReleaseEvidence` partitions status lines — tracked/untracked must be empty (unchanged), live `!!` paths must be covered by the snapshot (directory-prefix aware); anything else preserves with the existing warning.
- [x] 3.2 Wire the snapshot map through every `releaseRailWorktrees` caller (same records that feed `overlayEvidenceByBranch`).
- [x] 3.3 Tests: run-created `__pycache__` covered by snapshot → released; new ignored path post-settlement → preserved; no snapshot (legacy row) → preserved; conflicting snapshots → preserved.

## 4. Verification

- [x] 4.1 `npm run typecheck` + full `npm test` green; coverage thresholds hold.
- [x] 4.2 `openspec validate cleanup-and-checkout-tolerate-run-artifacts --strict` passes.
- [x] 4.3 Docs: safe-pr-review-flow.md cleanup section note + CLAUDE.md if needed.
