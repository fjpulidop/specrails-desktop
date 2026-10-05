## Context

`linkNodeModulesIntoWorktree` receives the registered source path. For a subdirectory registration, Git still creates a whole-checkout worktree. Core already computes the registration's checkout-relative scope correctly, but the dependency helper assumes identical relative coordinates on both sides. The user's root-level links pointing into source `apps/busuu-courses/node_modules` confirm this mismatch.

## Goals / Non-Goals

**Goals:** Match source and destination coordinates, retain local caches and per-entry cleanup evidence, and keep registration/recovery identities stable.

**Non-Goals:** Install dependencies, change Core scope or project settings, warm unrelated sibling packages, repair application tests, or redirect first-party workspace package links.

## Decisions

- Extract the existing filesystem-only `checkoutSubdirectory` resolver into a focused shared utility and re-export it from Core execution. This avoids a second interpretation of Git roots or a dependency on the runtime composition graph. Both `.git` directories and worktree `.git` files remain supported; non-Git fixture behavior is unchanged.
- Discover packages relative to the registered source, retaining the existing depth bound. Prefix only destination paths with the registration's checkout-relative subdirectory. Normalizing the registered source to Git root would widen discovery and alter lifecycle identities, so it is not used.
- Authenticate from the corresponding destination subtree with the same relative bound, returning whole-worktree-relative fingerprints. Also retain the existing exact proof for historical misplaced links, without moving or replacing them. Deduplicate evidence by path. Existing real dependency directories and foreign links stay untouched.
- Refuse destination paths reached through symlinked ancestors. Preparation must not write into another checkout through an `apps` or package directory link; live cleanup must not acquire authority there either.

## Risks / Trade-offs

- Existing failed runs remain failed and retain their worktrees. A new relaunch uses the corrected mapping; preparation on a resumed mount can add correct dependencies without deleting old directories.
- Reusing source installations does not guarantee dependencies match a different rail revision. Existing warm-dependency policy is retained; no automatic install or lockfile edits are introduced.
- Authentication must accept only exact live targets in the registered source. Real Git, restart and release tests cover nested coordinates, historical layout, foreign links and local caches.

## Migration Plan

Ship the Desktop helper correction; no database or Core migration. Keep durable registration and settlement paths unchanged. Rollback affects future preparation only and does not remove preserved worktrees.

## Open Questions

None for the confirmed coordinate mismatch. Actual Busuu tests must be rerun on the user's host after updating Desktop; the separate local Prettier error is outside this fix.
