# Cleanup and Checkout tolerate run-created artifacts

## Why

Two structural false positives shipped with the repeated-PR hardening (#548) break the happy path on every real project. (1) **Checkout is permanently blocked on legacy projects**: the cleanliness gate counts untracked files, and app-owned state like `.specrails/local-tickets.json` always exists in non-relocated repos — yet `git checkout` never loses untracked files, and git itself aborts loudly on an untracked collision. (2) **Every Python/Node run reports "Cleanup incomplete"**: the release preflight counts gitignored paths, and run-created build artifacts (`__pycache__`, `.pytest_cache`, `node_modules`) are unavoidable — the worktree is preserved forever and the warning noise buries real signals, even though `git worktree remove` (non-force) itself treats ignored files as disposable.

## What Changes

- **Checkout cleanliness counts only tracked modifications.** `inspectProjectCheckoutCleanliness` and the inner `checkoutProjectReviewBranch` gate use `--untracked-files=no`. Untracked files are never lost by a branch switch; a real collision still aborts inside git and is surfaced as a failed checkout. The spec's "uncommitted changes" scenario keeps its meaning (changes a commit/stash would capture).
- **Release authorizes run-created ignored artifacts via a settlement snapshot.** At settlement — immediately after the worktree is proven clean and its deliverables committed — the set of live gitignored paths is captured and durably recorded per branch (`settlementIgnoredPaths`, additive JSON field on `DeliverBranchRecord`, no migration). The release preflight still requires tracked+untracked cleanliness (minus verified overlay evidence) AND now permits ignored paths only when every live ignored path was already in the settlement snapshot. An ignored path that APPEARS after settlement (e.g. a user parks a `.env` after Inspect local result) preserves the worktree exactly as today. Oversized snapshots (>400 paths) record no authorization — fail-safe preserve.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `implementation-delivery-lifecycle`: the "Recoverable work is never removed automatically" requirement's ignored-path handling changes from "any ignored path preserves" to "ignored paths are release-safe only when fully covered by the immutable settlement snapshot"; the "Ignored user data exists beside a trusted overlay" scenario is restated in post-settlement-appearance terms.

## Impact

- **Server**: `server/project-git.ts` (two `git status` gates), `server/rail-isolated-launch.ts` (settlement snapshot capture), `server/rail-pr-store.ts` (`DeliverBranchRecord.settlementIgnoredPaths`, additive), `server/rail-worktree-release.ts` (durable collapse + preflight split).
- **No client changes** (same card states; the warning simply stops firing for run artifacts).
- **No DB migration** (`branches` is a JSON column; legacy rows without the field get no ignored authorization — behavior identical to today for pre-existing deliveries).
