# Tasks — Safe PR Workflow

## 1. Designated integration branch (`loop-integration-branch`)
- [x] 1.1 Add a per-project `integrationBranch` setting (`ProjectSettings`, stored as a `queue_state` KV `config.integration_branch` — no migration needed as-built); default resolver = `git symbolic-ref refs/remotes/origin/HEAD` → else current `HEAD`.
- [x] 1.2 Pure resolution module (`server/integration-branch.ts` + tests) — precedence explicit → project setting → repo default → head-fallback, returning `{branch, source}`.
- [x] 1.3 Make `CreateWorktreeInput.baseRef` live: `rail-isolated-launch.ts` resolves the integration branch once and passes it as `baseRef` to every `createWorktree` (was implicit `HEAD`).
- [x] 1.4 Server API + client picker DONE: `PATCH /settings` accepts+validates `integrationBranch` (`isValidBranchName`), `GET /:projectId/integration-branch` resolves `{configured, branch, source}`; `ProjectIntegrationBranchSection` in project Settings lets the user set it and shows the resolved base (`Rails branch off <branch>`), i18n ×8 (parity green). **Deferred:** surfacing the resolved base in the rail-launch header (Settings surfaces it today).

## 2. App-owned git/PR primitive (`safe-pr-workflow` / `core-git-agnostic-contract`)
- [x] 2.1 New desktop primitive (`server/pr-publisher.ts` + tests): `git push -u origin <branch>` → `gh pr create --draft --base <baseBranch> --head <branch>`; parses + returns the PR URL.
- [x] 2.2 Degradation ladder in the primitive + WS surfacing DONE — `rail.pr_delivered` broadcast carries `{delivery, prState, prUrl, branch}` (`server/types.ts` + `rail-isolated-launch.ts`).
- [~] 2.3 Flag-gated draft-PR delivery path added (`SPECRAILS_RAIL_DELIVER_PR`, default OFF): when on, a settled isolated rail delivers a draft PR instead of merging back (`server/rail-pr-delivery.ts`, wired in `rail-isolated-launch.ts`). **Full retirement of the local merge-back is deferred** — the default path is still merge-back until the PR path is validated in the field.
- [ ] 2.4 Hard git guardrails: block force-push and direct commits to the integration branch (technical block, not prompt text).

## 3. Platform-law enforcement (`safe-pr-workflow`)
- [x] 3.1 `server/loop-effect.ts` `classifyLoopEffect` — server-authoritative, derived from node content (read-only iff no `ai-step`/`shell` node), unit-tested.
- [x] 3.2 Wired into `rails-router.ts` (replaces the hardcoded `readOnly:false`): the isolation gate now derives read-only from content, so a custom loop cannot declare itself read-only to escape isolation (there is no user flag to lie with — it's derived).
- [~] 3.3 Client mirror deferred — there is no user-facing read-only flag to mirror (the classifier is purely server-derived), so an advisory client mirror is moot until a UI exposes the effect.

## 4. Cross-repo git-agnostic contract (`core-git-agnostic-contract`)
- [ ] 4.1 **specrails-core**: parse `--no-ship` (and read `SPECRAILS_GIT_AUTO`) in `implement.md` Phase 0; short-circuit Phase 4c/4d like `GIT_AUTO=false`.
- [ ] 4.2 **specrails-core**: reconcile `backend-developer.md`/`frontend-developer.md` self-commit behavior under git-agnostic mode; document the signal in the desktop↔core integration contract.
- [ ] 4.3 **desktop**: pass the git-agnostic signal on every rail invocation (all 3 providers, both `all`-scoped and per-ticket paths).
- [ ] 4.4 **desktop**: run `{{cmd:implement}}` per-ticket isolated (change from `ticketScope:'all'`); verify dependency ordering.
- [ ] 4.5 Interim stopgap: write `git_auto:false` for all projects + ensure present inside the worktree (until 4.1 ships).

## 5. Combined batch PR (`combined-batch-pr`)
- [x] 5.1 `server/rail-pr-delivery.ts` `deliverRailAsPr` assembles N ticket branches onto `sr/<slug>/batch-<railKey>` off the designated integration branch (transient worktree, `git merge --no-ff`), kept clean.
- [x] 5.2 One draft PR per batch; body = per-ticket checklist (`buildBatchPrBody`); per-ticket commit history preserved (`--no-ff`, no squash). (AI-resolver-assisted conflict resolution during assembly = follow-up; v1 uses plain merge.)
- [x] 5.3 Safe failure mode: conflict → `merge --abort` + teardown of the batch branch/worktree → `assembly-failed` (ticket branches left for a human); the base is never touched.

## 6. Relocation overlay blocker (D7)
- [ ] 6.1 Implement the per-run workspace overlay so a relocated project under isolation has `.specrails/` (agents, `.mcp.json`, `/specrails:*`) inside the worktree.
- [ ] 6.2 Verify `{{cmd:implement}}` runs correctly in an isolated worktree on a relocated project.

## 7. Product-builder "Review & Approve" surface (`safe-pr-workflow`)
- [~] 7.1 Delivery is now SURFACED to the user: `DashboardPage` handles the `rail.pr_delivered` WS event → toast with the draft-PR link (`Open PR`) / pushed / local-only / assembly-failed, i18n ×8 (parity green). **Deferred:** the full plain-language "what changed + proof" review bundle (needs a product/UX decision).
- [ ] 7.2 Approve → draft PR promoted to ready + reviewer notified/assigned; Discard → close PR + drop branch/worktree. (Deferred with 7.1's bundle.)
- [x] 7.3 i18n for the delivery toasts across all 8 locales (parity test passes). (Remaining builder-facing strings ship with 7.1/7.2.)

## 8. Coverage & docs
- [ ] 8.1 Unit tests: integration-branch resolution, mutating/read-only classifier, git-agnostic-signal propagation, combined-PR assembly (server ≥80%, client ≥80%).
- [ ] 8.2 Update `CLAUDE.md` (worktree/loops/PR sections) + a short "how specrails creates PRs safely" doc for developers.
