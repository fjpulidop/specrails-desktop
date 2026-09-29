# Claude handoff — 28 September 2026

This checkpoint supersedes earlier continuation headers. User requested a handoff,
so implementation is paused here. Preserve all existing working-tree edits.

## Locations and committed baselines

- Core: `/private/tmp/specrails-core-engine-v2`, `feat/core-engine-v2`, HEAD
  `056dca59`; implementation `04ea46639dbc18e92373f9a60ecc03d74aa08969`.
  Clean and tracking origin at handoff. PR #389 (base feat/core-engine-c0).
- Desktop: `/private/tmp/specrails-desktop-engine`, `feat/core-engine-desktop-v2`,
  HEAD `95e49162`; implementation `c2de60d5`. Tracking origin at handoff.
  Uncommitted retention implementation detailed below. PR #708 (base feat/core-engine-d0).
- Web: `/private/tmp/specrails-web-engine-docs`, `docs/core-engine-rollout`,
  HEAD `c5a2984`, clean. PR #218 (base main).
- Stable Desktop validation checkout: `/private/tmp/specrails-desktop-engine-validation`,
  detached `c2de60d5`, shared dependency symlinks. Do not confuse its coverage
  with coverage of the uncommitted retention work.
- C1: `/private/tmp/specrails-core-engine-c1`, branch `feat/core-engine-c1`,
  HEAD `7ef947df`. Three commits still NOT integrated: d2569939, e1e25589, 7ef947df.

User explicitly said “Haz merge si lo necesitas” after the prior merge block.
Local C1 integration is now authorized; no merge was performed after that message.
Earlier checkpoint restrictions against publishing releases still apply. Do not
infer that a draft PR is ready to merge from permission alone. Use DCO sign-offs.

## Read order

Read this file, then CHECKPOINT-GLOBAL.md and Core CHECKPOINT.md, the relevant
D1-D3 / D1B-D5 / D4 / C3-C7-C8 notes, contracts.md and c3-protocol.md, and OpenSpec
tasks. For retention read RUNTIME-RETENTION-DECISION.md and its nearest tests.
Earlier headers saying retention HTTP/UI are absent are OUTDATED.
Follow repository AGENTS.md and preserve project isolation and lifecycle ownership.

## Completed and verified baseline

Core catalog 5 has 17 kinds. It adds scoped archived OpenSpec handling and preserves
structured command failure. Earlier catalog 3 assignments and catalog 4 required-work
decider guards are implemented. Core full coverage: 102 suites, 1282 passes plus one
existing Windows-only skip; statements/branches/functions/lines 88.09/80.34/93.39/94.14.
Typecheck, build, focused acceptance and installed-package run/resume/fork passed.
Log: /private/tmp/core-catalog5-full-coverage.log.

Desktop generic legacy conversion is committed. It retains original backups,
produces editable Drafts, freezes selected decider roles and compiles bounded repair,
iteration, retry and required-work semantics. Actual Core tests cover Implement,
Batch, Quick SDD, blocked decisions, exceptions and empty responses. All 48 factory
shapes validate against the real Core SDK; three fixtures compare actual legacy
LoopRunManager behavior. CI pins Core 04ea4663 and runs paired tests on three platforms.
Full server coverage on immutable c2de60d5: 411 suites, 9102 passes + 7 existing skips,
87.07/80.37/90.96/90.15. Full client: 396 suites, 4710 passes,
89.77/84.21/75.66/89.77. Typecheck, build, architecture/source audits, actionlint,
source map and installed production package acceptance passed. Logs:
/private/tmp/desktop-conversion-committed-coverage.log (remove the space after /),
/private/tmp/desktop-conversion-client-coverage.log,
/private/tmp/desktop-conversion-package-network.log.

Web eight-language converter documentation is committed. Guide sync, six sync tests
and production build passed. No full Web coverage rerun for this documentation-only
change; older full baseline is 38 suites / 263 passes.

These are LOCAL verified baselines, not a claim that latest remote CI is green.
Prior Core CI failed its Windows engine permission spike; inspect latest runs after
C1 integration. Do not lower coverage thresholds or manufacture rollout evidence.

## Uncommitted Desktop retention implementation

Everything listed here is WIP, not ready to ship. git status is the source of truth.
No actual user history was collected; deletion tests use disposable fixtures.

- agent-runtime-retention.ts: pure policy (indefinite by default, otherwise 1..3650
  days), fail-closed evidence and reserve/inspect/quarantine/expire/remove coordinator.
- agent-runtime-package-lock.ts: SQLite immediate transaction serializes package
  publication and GC; OS releases ownership on crash. Existing package adapter uses it.
- agent-runtime-package-gc.ts: scan all pins before mutation, preserve referenced
  packages, reject corrupt/symlinked evidence, collect old unreferenced packages and
  owned garbage/staging directories. Latest staging test has NOT been rerun.
- agent-runtime-retention-records.ts: project-local immutable expiration records
  and policy. Additive migration 69 creates two tables; existing accounting unchanged.
- agent-runtime-retention-quarantine.ts: UUID-scoped quarantine, intent and inode
  identity; restores unexpired runs and finishes expired cleanup after restart.
- agent-runtime-retention-host.ts: admission claims, fresh Core status and host jobs,
  delivery/fork protections, history summary and package collection adapter.
- agent-runtime-controls.ts/router: policy GET/PUT, collection POST (preview default),
  startup recovery, expired summaries/HTTP handling; loop-runs-store blocks admission
  of expired runs and preserves collection ownership.
- RuntimeRetention.tsx: lazy-loaded project-scoped settings, explicit save/preview/
  collect, eight locales; AgentRuntimeRuns includes it and marks expired history.
- boundaries.json and source-map have partial updates; docs still need final updates.

Focused evidence: 79 lifecycle/controller/store tests passed in
/private/tmp/desktop-retention-lifecycle.log; 47 UI/runtime list/locale tests passed
in /private/tmp/desktop-retention-client.log. Foundation policy, locks, records,
quarantine and DB tests passed earlier, but not every last edit has been rerun.
No complete coverage/build/package claim for retention.

## Concrete next fixes — do not skip

1. agent-runtime-retention-paired.test.ts currently FAILS before launching Core:
   bridge requires configPath AND change. Fixture omitted change; add a valid change
   identity, then run the real test. Log /private/tmp/desktop-retention-paired.log.
   It must prove one expired run is removed while a recent run retains the shared
   pinned package, then package becomes collectible after both expire; accounting
   and original Core source must remain. Add passing test to required paired CI.
2. Quarantine crash windows require design/test repair: crash after creating UUID
   directory but before intent leaves an empty orphan; recursive deletion can remove
   intent before journal and leave unrecoverable state. Delete/record ordering needs
   durable recovery at every boundary. After restoring journal but before removing
   intent, verify original identity before cleanup. Never delete replacement data.
3. Add host tests for delivery pending/discarded, parent/child fork expiration and
   restart ownership. Review direct external Core CLI race: host claims only fence
   Desktop admission; do not claim stronger cross-process Core fencing without proof.
4. RuntimeRetention UI can retain an old eligible preview if a later preview fails.
   Clear stale report on new preview/failure and test it before enabling collection.
5. Add controls-router -> agent-runtime-retention-records dependency to reviewed
   server manifest. Client manifest is capability-level; do not treat it as file map.
   Regenerate source map, update runtime module README/API and narrow guides in all
   Desktop/Web locales. Visual UI review has not been performed.
6. Run focused lifecycle/module tests, typecheck, audits, then commit source and run
   full coverage on a stable source revision. Do not introduce new files while a
   coverage/architecture inventory run is underway.
7. Integrate C1 commits, resolve/fix Windows permission spike, run CI and update
   Desktop Core pin only to a validated source revision. Reconcile C2 documentation.
8. Continue ALL remaining OpenSpec tasks. D8 migration/retirement is NOT complete;
   historical parity and migration rollout still need work. Two zero-legacy-release
   telemetry and published Core7 acceptance are external evidence, not facts to invent.
   Retention implements only part of task 10.5; do not check off the entire task.

## Environment and commands

Core uses Node 22.22.3:
PATH=/private/tmp/specrails-engine-tools/node-v22.22.3-darwin-arm64/bin:$PATH
Desktop uses system Node 25.9. Do not rebuild shared node_modules (native ABI).
For paired tests export both SPECRAILS_CORE_SOURCE_DIR and
SPECRAILS_EFFICIENCY_CORE_ROOT=/private/tmp/specrails-core-engine-v2.
Set SPECRAILS_CORE_BIN only for check-core-compat, not the entire suite.
For isolated package checks use npm_config_cache=/private/tmp/specrails-engine-tools/npm-cache.
Root/client have separate Vitest versions/dependency trees. Full server command:
npx vitest run --coverage --maxWorkers=2 --reporter=dot --bail=0
Web sync tests: npm run test:docs-sync.
Build rewrites tracked src-tauri/binaries/specrails-{local-runner,mcp}.js; inspect
and restore only those known generated changes when unrelated to source work.
Do not install/rebuild shared dependencies or erase worktrees. Git metadata/network
may require sandbox escalation. Sign commits with git commit -s.

## Handoff preservation

A local backup branch codex/checkpoint-claude-2026-09-28 is created from Desktop HEAD
with ALL tracked and untracked WIP plus this document using an alternate Git index.
It leaves the integration branch and working edits in place. Inspect that branch's
commit before applying it elsewhere; do not apply it on top of identical dirty files.
This checkpoint is intentionally not an implementation-complete assertion.
