## Why

Isolated launches branch from `origin/<base>` after `git fetch origin`. To skip a cold install, they then link the package entries of the user's base checkout `node_modules` into the worktree (`linkNodeModulesIntoWorktree`). The user's checkout can be on another branch, or behind the remote, so its installed packages may not match the lockfile of the code the run builds.

Example from busuu-courses (Skills #207, 2026-10-09):

- The base checkout sat on `fix/SKILLS-203-…` with `@busuu/experiments@5.23.0` installed.
- `origin/main` declared `^5.24.0` and used an API that only exists in 5.24.
- Verification failed on an untouched file (`experiments.service.ts`), and the run stopped with a setup blocker.
- The only workaround was to switch or update the user's own checkout. That is intrusive, and Desktop must never do it itself.

## What Changes

- **Freshness guard before linking.** Desktop compares the dependency inputs of the base checkout and the worktree for each discovered package directory before linking it.
  - The inputs are the nearest lockfile, searched upwards to the git top level (`yarn.lock`, `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml` or `bun.lock`), and the package directory's `package.json` dependency fields.
  - If any input differs, Desktop skips that directory and leaves it without `node_modules`.
  - Core's existing `prepareEnvironment` then installs it cold in the worktree, from the worktree's own lockfile.
- **Visible degradation.** A skipped directory produces a warning on the existing overlay-degraded channel. The warning names the package directory and the input that differed, for example `apps/busuu-courses: yarn.lock differs from the base checkout; dependencies will be installed in the worktree`. This lets the operator see why the start is cold.
- **Unchanged behaviour when inputs match.** Warm reuse stays the fast path whenever the inputs are equal.
- **Kill switch kept.** `SPECRAILS_WORKTREE_NODE_MODULES=false` still disables linking entirely.
- **No changes to the user's checkout.** No checkout, pull or install ever runs there.

## Capabilities

### New Capabilities
- `warm-dependency-freshness`: warm `node_modules` reuse is allowed only when the base checkout's dependency inputs match the worktree's. When they do not, the worktree falls back to a cold install with an explained warning.

### Modified Capabilities
<!-- None: warm-link reuse has no canonical requirement yet (documented only in legacy notes). -->

## Impact

- **Code:**
  - `server/worktree-node-modules.ts`: adds the freshness guard in `linkNodeModulesIntoWorktree` and a new helper that fingerprints the dependency inputs.
  - `server/modules/delivery/runtime/rail-isolated-launch.ts`: no signature change, because the warnings already flow through `notifyOverlayDegraded`.
- **Cost:** a run whose base checkout is stale does a cold install. For busuu-courses that is a few minutes. That cost replaces a guaranteed false failure.
- **Already-linked worktrees:** resumed runs keep their authenticated links. The guard applies only when a link is prepared.
- **Companion change:** Core `environment-version-drift` reinstalls when the installed versions do not satisfy the declared ranges. It is the safety net for drift this guard cannot see, such as a lockfile that matches but has an out-of-date install.
