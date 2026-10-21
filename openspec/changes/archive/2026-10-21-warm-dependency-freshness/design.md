## Context

`linkNodeModulesIntoWorktree(baseRepo, worktreePath)` discovers package directories down to depth 2 under the project checkout. For each one, it builds a worktree-owned `node_modules` directory whose package entries are links into the base checkout's tree, with local writable caches. The worktree's code comes from `origin/<integration>` (`resolveWorktreeBaseRef`), while the linked packages come from whatever the user installed on their current branch. Nothing checks that the two match.

In a yarn-workspace monorepo such as busuu-web, the project checkout is a subdirectory (`apps/busuu-courses`). The lockfile lives at the git top level, so a per-directory lockfile check would miss it.

## Goals / Non-Goals

**Goals:**
- Never hand a run packages that were installed for different dependency inputs.
- Keep the warm fast path when the inputs match, which is the common case.
- Explain every cold fallback.

**Non-Goals:**
- Installing, updating or switching anything in the user's checkout.
- Detecting an install that is stale relative to its own lockfile. Core's `environment-version-drift` change covers that.
- Partial linking, where only the packages whose versions match are linked. The trees are too coupled (hoisting, peers) to do this safely.

## Decisions

1. **Compare inputs, not installed trees.**
   - Lockfile digests and dependency fields are cheap to compare and decide the outcome.
   - Alternative: walk `node_modules/*/package.json` and check each against the declared ranges. Rejected for this layer, because it is slow on large trees and still blind to transitive drift.
   - Core's drift check is the complement for the case this misses.

2. **Find the nearest lockfile upwards to the git top level.**
   - This covers monorepos where the project is a subdirectory.
   - In both checkouts, the search uses the same relative path from the package directory to the top level.
   - The first lockfile found decides the comparison. If one side has a lockfile and the other does not, the inputs differ.

3. **Canonical comparison of dependency fields.**
   - Compare JSON with sorted keys, using only the four dependency fields.
   - Edits to `scripts`, `version` or other metadata do not force a cold install.

4. **Skip the directory, do not delete.**
   - The guard runs before link preparation. A skipped directory gets no `node_modules`.
   - Core's `prepareEnvironment` already installs a root whose `node_modules` is absent (`plannedInstalls`). No new install path is needed in Desktop.

5. **Reuse the warning channel.**
   - Warnings flow through `NodeModulesLinkResult.warnings`, which feeds `notifyOverlayDegraded`.
   - The run log and the UI already surface that channel.

## Risks / Trade-offs

- [A cold install is slow and needs registry access and credentials] → If the install fails, Core's existing precondition classification turns it into a credential or network blocker with a clear action. Today the same run fails on a misleading lint error instead.
- [A hoisted root `node_modules` in the worktree, which Desktop does not link, may still resolve stale packages] → Desktop does not link the git top level when the project is a subdirectory, so the worktree root only has what Core installs from the worktree lockfile.
- [Lockfile churn on the user's branch makes every launch cold] → This is an accepted trade-off: correctness over speed. The warning tells the operator to bring their checkout up to date if they want warm starts.

## Migration Plan

This is a behaviour change on the fast path only. No data migration is needed. Rollback is a revert. `SPECRAILS_WORKTREE_NODE_MODULES=false` keeps working as before.

## Open Questions

- Should the warning surface as a distinct `rail.dependencies_cold` event, so the UI can explain the slower start? Proposal: no for now. Reuse the overlay-degraded channel and revisit if users find it noisy.
