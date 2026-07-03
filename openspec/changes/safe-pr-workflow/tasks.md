# Tasks — Safe PR Workflow

## 1. Designated integration branch (`loop-integration-branch`)
- [x] 1.1 Add a per-project `integrationBranch` setting (`ProjectSettings`, stored as a `queue_state` KV `config.integration_branch` — no migration needed as-built); default resolver = `git symbolic-ref refs/remotes/origin/HEAD` → else current `HEAD`.
- [x] 1.2 Pure resolution module (`server/integration-branch.ts` + tests) — precedence explicit → project setting → repo default → head-fallback, returning `{branch, source}`.
- [x] 1.3 Make `CreateWorktreeInput.baseRef` live: `rail-isolated-launch.ts` resolves the integration branch once and passes it as `baseRef` to every `createWorktree` (was implicit `HEAD`).
- [~] 1.4 Server half DONE: `PATCH /:projectId/settings` accepts+validates `integrationBranch` (arg-injection guard `isValidBranchName`), `GET /:projectId/integration-branch` resolves `{configured, branch, source}` for pre-launch display. **Pending (own PR):** client picker in project settings + resolved base shown before launch + i18n ×8.

## 2. App-owned git/PR primitive (`safe-pr-workflow` / `core-git-agnostic-contract`)
- [x] 2.1 New desktop primitive (`server/pr-publisher.ts` + tests): `git push -u origin <branch>` → `gh pr create --draft --base <baseBranch> --head <branch>`; parses + returns the PR URL.
- [~] 2.2 Degradation ladder IMPLEMENTED in the primitive (`pr-created` / `pushed` / `local-only`, never throws). **Pending:** wiring the degraded outcome to a WS broadcast — done at integration time (with 2.3).
- [ ] 2.3 Retire local merge-back on the mutating path (`merge-manager.ts` `git merge --no-ff` into HEAD removed from this flow).
- [ ] 2.4 Hard git guardrails: block force-push and direct commits to the integration branch (technical block, not prompt text).

## 3. Platform-law enforcement (`safe-pr-workflow`)
- [ ] 3.1 Server-authoritative `mutating` vs `read-only` classifier derived from loop node content; unit-tested.
- [ ] 3.2 Enforce at launch: mutating loop ⇒ isolated worktree + draft PR; read-only ⇒ no branch/PR. Custom loops cannot opt out.
- [ ] 3.3 Client mirror of the classifier (advisory), server remains authoritative.

## 4. Cross-repo git-agnostic contract (`core-git-agnostic-contract`)
- [ ] 4.1 **specrails-core**: parse `--no-ship` (and read `SPECRAILS_GIT_AUTO`) in `implement.md` Phase 0; short-circuit Phase 4c/4d like `GIT_AUTO=false`.
- [ ] 4.2 **specrails-core**: reconcile `backend-developer.md`/`frontend-developer.md` self-commit behavior under git-agnostic mode; document the signal in the desktop↔core integration contract.
- [ ] 4.3 **desktop**: pass the git-agnostic signal on every rail invocation (all 3 providers, both `all`-scoped and per-ticket paths).
- [ ] 4.4 **desktop**: run `{{cmd:implement}}` per-ticket isolated (change from `ticketScope:'all'`); verify dependency ordering.
- [ ] 4.5 Interim stopgap: write `git_auto:false` for all projects + ensure present inside the worktree (until 4.1 ships).

## 5. Combined batch PR (`combined-batch-pr`)
- [ ] 5.1 Repurpose the AI merge-resolver to assemble N ticket branches onto `sr/<slug>/batch-<id>` (off the designated base), kept clean.
- [ ] 5.2 One draft PR per batch; body = per-ticket checklist + per-ticket verification; preserve per-ticket commit history (no squash).
- [ ] 5.3 Safe failure mode: cannot combine → fall back to N PRs or flag "needs a human to combine"; never touch the base.

## 6. Relocation overlay blocker (D7)
- [ ] 6.1 Implement the per-run workspace overlay so a relocated project under isolation has `.specrails/` (agents, `.mcp.json`, `/specrails:*`) inside the worktree.
- [ ] 6.2 Verify `{{cmd:implement}}` runs correctly in an isolated worktree on a relocated project.

## 7. Product-builder "Review & Approve" surface (`safe-pr-workflow`)
- [ ] 7.1 Plain-language "what changed + proof" review bundle per loop result (diff summarized, verification/tests/screenshots).
- [ ] 7.2 Approve → draft PR promoted to ready + reviewer notified/assigned; Discard → close PR + drop branch/worktree.
- [ ] 7.3 i18n for all new builder-facing strings across the 8 locales (parity test passes).

## 8. Coverage & docs
- [ ] 8.1 Unit tests: integration-branch resolution, mutating/read-only classifier, git-agnostic-signal propagation, combined-PR assembly (server ≥80%, client ≥80%).
- [ ] 8.2 Update `CLAUDE.md` (worktree/loops/PR sections) + a short "how specrails creates PRs safely" doc for developers.
