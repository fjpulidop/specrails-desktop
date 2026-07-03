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
- [~] 2.4 `server/git-guardrails.ts` `assertGitAllowed` blocks force-push and direct push to the integration branch, wired into `pr-publisher` (the app's sanctioned push path) as defense-in-depth. **Deferred:** blocking git issued by the AI agent *inside* a loop turn needs a per-worktree pre-push hook (documented follow-up).

## 3. Platform-law enforcement (`safe-pr-workflow`)
- [x] 3.1 `server/loop-effect.ts` `classifyLoopEffect` — server-authoritative, derived from node content (read-only iff no `ai-step`/`shell` node), unit-tested.
- [x] 3.2 Wired into `rails-router.ts` (replaces the hardcoded `readOnly:false`): the isolation gate now derives read-only from content, so a custom loop cannot declare itself read-only to escape isolation (there is no user flag to lie with — it's derived).
- [~] 3.3 Client mirror deferred — there is no user-facing read-only flag to mirror (the classifier is purely server-derived), so an advisory client mirror is moot until a UI exposes the effect.

## 4. Cross-repo git-agnostic contract (`core-git-agnostic-contract`)
- [ ] 4.1 **specrails-core** (NOT done by desktop autonomously — the user is actively rewriting `implement.md` on branch `okfix/implement-local-tickets-only`; coordinate there). EXACT change: in `implement.md` **Phase 0**, after resolving `GIT_AUTO` from config, add one rule — *"If the environment variable `SPECRAILS_GIT_AUTO` is `false`/`0`, set `GIT_AUTO=false` (desktop owns version control)."* This reuses the existing `GIT_AUTO=false` manual-ship path (§4c already does no branch/commit/push/PR), so nothing else changes. Desktop already sends `SPECRAILS_GIT_AUTO=false` when `SPECRAILS_RAIL_DELIVER_PR` is on (PR #496).
- [ ] 4.2 **specrails-core**: same one-rule guard for `backend-developer.md`/`frontend-developer.md` self-commit (`git add -A && git commit` → skip when `SPECRAILS_GIT_AUTO=false`); document `SPECRAILS_GIT_AUTO` in the desktop↔core integration contract.
- [x] 4.3 **desktop**: injects `SPECRAILS_GIT_AUTO=false` into every rail spawn when `SPECRAILS_RAIL_DELIVER_PR` is on — both the loop-engine path (`loop-executors.ts`) and the legacy QueueManager path (`queue-manager.ts`, covers implement/batch/ultracode). The signal travels with the invocation (survives into a worktree), superseding the fragile backlog-config stopgap. Gated OFF ⇒ no change.
- [ ] 4.4 **desktop**: run `{{cmd:implement}}` per-ticket isolated (change from `ticketScope:'all'`); verify dependency ordering. (Deferred — orthogonal to the git-agnostic signal.)
- [x] 4.5 Superseded by 4.3: a travelling env signal (`SPECRAILS_GIT_AUTO=false`) is more robust than writing `git_auto:false` into a gitignored backlog-config that is absent in a fresh worktree.

## 5. Combined batch PR (`combined-batch-pr`)
- [x] 5.1 `server/rail-pr-delivery.ts` `deliverRailAsPr` assembles N ticket branches onto `sr/<slug>/batch-<railKey>` off the designated integration branch (transient worktree, `git merge --no-ff`), kept clean.
- [x] 5.2 One draft PR per batch; body = per-ticket checklist (`buildBatchPrBody`); per-ticket commit history preserved (`--no-ff`, no squash). (AI-resolver-assisted conflict resolution during assembly = follow-up; v1 uses plain merge.)
- [x] 5.3 Safe failure mode: conflict → `merge --abort` + teardown of the batch branch/worktree → `assembly-failed` (ticket branches left for a human); the base is never touched.

## 6. Relocation overlay blocker (D7)
- [ ] 6.1 Implement the per-run workspace overlay so a relocated project under isolation has `.specrails/` (agents, `.mcp.json`, `/specrails:*`) inside the worktree.
- [ ] 6.2 Verify `{{cmd:implement}}` runs correctly in an isolated worktree on a relocated project.

## 7. Product-builder "Review & Approve" surface (`safe-pr-workflow`)
- [~] 7.1 Delivery is now SURFACED to the user: `DashboardPage` handles the `rail.pr_delivered` WS event → toast with the draft-PR link (`Open PR`) / pushed / local-only / assembly-failed, i18n ×8 (parity green). **Deferred:** the full plain-language "what changed + proof" review bundle (needs a product/UX decision).
- [x] 7.2 Approve/Discard action DONE: `POST /rails/pr-review {prUrl, action:'ready'|'discard'}` (`gh pr ready` / `gh pr close --delete-branch`) + the dashboard delivered-PR toast now offers **Approve** (promote draft→ready, hands off to the engineer) alongside **Open PR**, i18n ×8. **Deferred:** the plain-language what-changed + proof bundle and reviewer auto-assignment (product/UX decision).
- [x] 7.3 i18n for the delivery toasts across all 8 locales (parity test passes). (Remaining builder-facing strings ship with 7.1/7.2.)

## 8. Coverage & docs
- [x] 8.1 Unit tests shipped with each slice (integration-branch resolution, PR primitive + degradation ladder, combined-PR assembly, loop-effect classifier, git guardrails, branch-name guard, client picker); every merged PR held server ≥80% / client ≥80%.
- [x] 8.2 `CLAUDE.md` "Safe PR workflow (in progress)" section added (knobs, modules, deferred list); the developer-facing design lives in this OpenSpec change (`proposal.md` + `design.md`).
