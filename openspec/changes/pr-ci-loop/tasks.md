## 1. Core pairing and runtime host tasks

- [x] 1.1 `host-task` in `CORE_NODE_KINDS`, outcome derivation (server + client authoring)
- [x] 1.2 Bridge `--host-result`, executor plumbing, recovery probe and controls accept `host-task`
- [x] 1.3 Generic dispatcher (`host-task-dispatcher.ts`), migration 88, LoopRunManager wiring, cancellation, startup re-dispatch

## 2. PR handlers

- [x] 2.1 `pr.update-base`, `pr.sync`, `pr.checks`, `pr.rerun-failed` with real-git / fake-gh tests
- [x] 2.2 Merge commits in `commitWorktreeAndVerify`; base OpenSpec changes allowed at continuation settlement

## 3. Recipe and factory

- [x] 3.1 `loop-pr-ci-recipe.ts`, `factory:pr-ci` (`launchable: false`, `hostTasks`), `deliveryRequiresVerified`
- [x] 3.2 Recipe tests and pairing with the real Core

## 4. Launch and settlement

- [x] 4.1 `ciFixAllowed`, `POST /rails/:railIndex/pr-ci`, generic-door refusal, `GET /rails/pr-ci-availability`
- [x] 4.2 Route tests (flag, capability, legality, fork/closed, continuation contract)

## 5. Mission and dashboard

- [x] 5.1 `pr-ci-offer` projection, dismissal route, started/terminal states
- [x] 5.2 `AgentPrCiOfferCard`, no unread mark, run strip steps, Fix CI on the PR card and the rail strip
- [x] 5.3 i18n in the 8 locales

## 6. Docs and flags

- [x] 6.1 `SPECRAILS_PR_CI_LOOP`, `VITE_FEATURE_PR_CI_CARD`; internals docs, module READMEs, API reference, user guide
- [ ] 6.2 Manual check against a real GitHub PR with red CI and with a conflict
