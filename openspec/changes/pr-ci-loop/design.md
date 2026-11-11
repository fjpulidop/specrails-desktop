## Context

The PR continuation (`active-pr-continuation.ts`) already relaunches a rail on an open PR's branch and pushes the verified SHA to that PR at settlement. A CI loop additionally needs to push mid-run and to wait for GitHub, both host effects. Core gains a generic `host-task` machine interrupt (paired change); Desktop supplies the graph and the adapters. The loop logic (rounds, budgets, stall detection, routing) stays in the definition Core executes.

## Verified before coding (plan §10)

1. **Settlement with host commits mid-run.** For a continuation, settlement commits what is left (nothing after a `pr.sync`), verifies `HEAD == refs/heads/<branch>`, computes `changed = initialSha != finalSha` and, when ready, pushes `finalSha` with a non-forced raw refspec; pushing an SHA the remote already has exits 0, and the post-push observation finds the exact head. A run that wrote nothing (CI already green) is `no_changes` and leaves the PR untouched. Caveats fixed: (a) the hygiene audit rejected active OpenSpec changes merged in from the base — continuations now allow the changes present at `origin/<base>`; (b) `git commit --only` refuses a prepared merge — `commitWorktreeAndVerify` commits the audited index when `MERGE_HEAD` exists.
2. **candidateHash.** Core hashes the content of tracked + untracked, non-ignored files; it never reads HEAD. A host commit/push keeps it, a prepared merge changes it.
3. **MERGE_HEAD during a role turn.** Core's candidate and change-set measurement do not read `MERGE_HEAD`; unmerged paths listed once per stage are deduplicated. Resume does not compare the tree with the paused state.

## Decisions

- **Graph (`loop-pr-ci-recipe.ts`).** `init → base (pr.update-base, write) → checks (pr.checks, read) → green`; red → round budget → fixer (`correct`, structured `{summary, cause, blocker?}`) → blocker? → progress? → local verify → push (`pr.sync`, `effect: read`, `requiresVerified: true`) → checks. Conflicts → conflict budget → resolver (`resolve`, `MERGE_SAFE`) → local. The fixer classifies each failing check (code, flaky, infrastructure) and fixes only code; with no change, a non-code cause ends `not-fixable` (reported, never retried or iterated) and a code cause ends `stalled`. Budgets 5 rounds / 3 conflict rounds, 60 min per CI wait. Evidence travels through run variables so no prompt references an output that may not exist yet.
- **`pr.sync` is `read`.** Committing and pushing keep the tree, so Core keeps the verification; `requiresVerified` makes Core refuse the request for an unverified candidate, and the handler re-checks Core's attestation.
- **`deliveryRequiresVerified: false`.** Success is "CI green on GitHub"; a run that finds CI already green verifies nothing. Every push is still gated by local verification inside the graph.
- **Progress detection.** Core's host-task output carries the candidate hash measured on resume; `progress` compares the fixer's hash with the hash CI judged.
- **Identity from frozen records.** Handlers resolve the PR (url, branch, base, worktree, overlay excludes) from the generation's isolated-settlement snapshot, never from workflow input; `delivery.loop_id = factory:pr-ci` marks the purpose (no new column).
- **Dispatcher.** `(runId, interruptId)` persisted before acting and the result before resuming (`host_task_dispatches`, migration 88); a restart replays a known result and re-runs an unknown one (handlers are idempotent). Startup recovery re-dispatches paused runs with a pending host task through the same retained-resume path as the HTTP resume.
- **Offer.** A `pr-ci-offer` system row keyed `pr-ci-offer:<deliveryId>`, projected after every delivery change; the CI loop generation updates the row of the generation it replaced. No automatic agent turn; the row never marks the conversation unread.

- **Multi-repository deliveries.** One Core run covers every repository (one worktree and one child PR per repository), and the multi-repository continuation already exists. The handlers therefore resolve every PR of the run (`resolvePrCiTargets`: one isolated-settlement snapshot per child, same run id) and aggregate: CI is green only when every PR is green, failures and conflicts name their repository, a closed PR or a refused identity anywhere stops the push of all of them, and each changed repository is pushed to its own PR branch. Admission (`ciFixAllowed`) requires a PR for every repository still under review; settled repositories (merged, completed, no changes) are ignored. One offer lists every PR.

## Risks / Trade-offs

- Required checks that never report end at `timeout`; external checks without logs reach the fixer as name + URL + summary.
- A run that fails after a prepared merge leaves `MERGE_HEAD` in the preserved worktree (blocked settlement, nothing pushed).
- GitHub API load: one watcher per PR (one continuation per rail), backoff 30 s → 2 min.
- Out of scope (v1): automatic start without the card, review comments (followUp exists), fork PRs, GitLab/Bitbucket, publishing or merging when green.
