# Tasks

## 1. Multi-source worktree overlay

- [x] 1.1 Add `fallbackSourceRoots?: string[]` to `WorktreeOverlayInput` and merge the union of provider-dir entries across `[sourceRoot, ...fallbackSourceRoots]` with first-root-wins per entry.
- [x] 1.2 Materialize a REAL directory with per-child links when more than one root contributes children to the same dir; convert a prior pass's own whole-dir link on resume; keep checkout-wins and foreign-symlink semantics.
- [x] 1.3 Authenticate cleanup evidence against ANY configured root (`sourcePathForOverlayEntry` → candidates); converted prior links drop out without widening authority.
- [x] 1.4 Resolve `.mcp.json` and the instruction file copy across roots in order (first existing wins).
- [x] 1.5 Wire `rail-isolated-launch.ts`: pass `fallbackSourceRoots: [baseRepo]` when relocated at BOTH the overlay-apply and `revalidateOverlayCleanupEvidence` sites.
- [x] 1.6 Fix the stale `workspace-manager.ts` comment claiming `/opsx:*` lives in the framework `commands/` subtree.
- [x] 1.7 Tests: repo-fallback entries reach the worktree (opsx from repo + specrails from workspace), merged-dir creation, resume conversion of prior whole-dir links/copies, fallback-to-primary promotion, same-target foreign-symlink preservation, first-root-wins on file/type conflicts, checkout-wins, commit-exclusion of merged leaves, evidence authentication across roots, legacy single-root byte-identical.

## 2. Explore mcp=true spawn cwd

- [x] 2.1 Route `_resolveSpawnCwd`'s `mcp === true` branch through `resolveProjectExecution`: workspace when relocated, `project.path` legacy; `SPECRAILS_EXPLORE_LEGACY_CWD=1` still forces `project.path`.
- [x] 2.2 Tests: relocated project + mcp=true spawns from the workspace with relocation env on initial, persistent-stdin, and crash-respawn paths; an old cwd-scoped Explore session's exact `No conversation found with session ID` failure causes one bounded-context fresh workspace retry (never repo) in both spawn-per-turn and persistent transports, invalidating the stale id while unrelated errors remain unchanged; Contract Refine performs one no-tools, ticket-seeded fresh workspace retry for that exact failure; legacy + mcp=true and the kill switch remain unchanged.

## 3. Verification

- [x] 3.1 `npm run typecheck`, `npm test`, coverage thresholds (server 80/80/80/70, global 70) pass locally.
- [x] 3.2 Update CLAUDE.md overlay bullet + `docs/internals/safe-pr-review-flow.md` overlay section to document the multi-source semantics.
