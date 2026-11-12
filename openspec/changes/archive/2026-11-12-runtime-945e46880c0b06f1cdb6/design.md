# Design

## Context

See proposal.md for motivation. This is a string-formatting change with several lifecycle entry points, not a delivery lifecycle redesign. Source inspection found two additional in-scope generators beyond the ticket's initial file list: historical isolated snapshot reconstruction and programmatic-runtime continuation settlement. Leaving them unchanged would violate the recovery criterion. Final Git-command inventory also found default merge subjects in PR batch assembly, local integration assembly and the retained legacy merge-back path; these are message-only changes required by the generated-subject invariant.

The actual `TicketNamingInput` uses `ticketId: number`, optional nullable title/labels, and optional nullable Jira key; preserve that source contract rather than the ticket appendix's illustrative string id. `buildPrTitle(tickets, opts = {})` remains unchanged. Add `ConventionalType` and preserve `ChangeType` as a compatibility alias. No schema or installed dependency changes. Installed versions inspected: TypeScript 7.0.2, Vitest 5.0.3; Node engine >=20.19.0. React is unaffected.

## Goals / Non-Goals

**Goals:** One deterministic Conventional Commit subject implementation; retained references; accurate completed-run classification; release-neutral housekeeping; run provenance in bodies; safe restart replay.

## Non-Goals

Do not alter Core-agent PR creation, branch names, existing Git history/PR titles, release-please configuration, commitlint, GitHub merge settings, UI, locales, data schemas, leases, transaction ownership, outbox effects or provider behavior.

## Clarifications

No unanswered requester clarification changes the design. The frozen ticket explicitly selects suffix references, all merge modes, chore housekeeping and exclusion of Core-agent PRs. Checkout inspection cannot establish live GitHub merge settings for desktop/core/web; the implementation supports all three modes and requires no choice of setting. Only this Desktop checkout is in scope.

## Assumptions

- How is a CI sync with an outstanding merge classified? Use non-breaking `chore` when `MERGE_HEAD` exists, preserving the existing prepared-merge flow; use `fix` for a standalone verified CI correction. This is the one non-obvious policy assumption, and can suppress a separate CI-fix changelog entry when that correction shares a merge commit. The original implementation commit remains release-relevant.

## Local reference patterns

- `server/modules/delivery/runtime/pr-naming.ts`: `classifyChangeType`, `batchChangeType`, `ticketRef`, `titleChangeSummary`, `buildPrTitle`; tests in adjacent `pr-naming.test.ts` use table-like Vitest assertions and protect existing branch/type heuristics. `titleChangeSummary` currently strips controls and caps the summary at 72; it currently does not reject emoji-only or remove colons. Preserve its other consumers; sanitize further in the subject formatter.
- `runtime/isolated-worktree.ts::ticketNamingInput` resolves authoritative Jira links and tolerates unreadable specs. `runtime/rail-isolated-launch.ts::worktreeCommitMessage` and `createIsolatedRunSettlement` already inject commit-message callbacks, freeze full/partial messages and reattach them. `rail-isolated-launch.test.ts` uses injected Git/runtime fixtures and in-memory SQLite. Test fresh, partial and replay subjects through these existing seams rather than exporting an effectful helper solely for tests.
- `adapters/decisions/create.ts` calls `buildPrTitle` and builds the canonical body; `rail-pr-decision.test.ts` asserts `gh --title`, Jira precedence and unreadable-store fallbacks. Leave its signature and failure ladder unchanged. `runtime/pr-publisher.ts::publishDraftPr` passes title via argv to gh; its generic transport does not parse the old shape. No production client consumer of the old `[ref]type -` grammar was found.
- `runtime/pr-ci/pr-ci-handlers.ts::createPrCiHandlers` prepares merges without committing, then `pr.sync` commits a verified candidate. Its adjacent tests use disposable real Git repos/bare remotes and scripted gh, with cleanup in afterEach. Retain rejection of unverified candidates, closed PRs, unsafe commits and force pushes.
- `runtime/local-restore-branch.ts::restoreCommitMessage` is the actual local restore formatter; `adapters/decisions/local-changes.ts` passes its result through clean and resolver paths. `runtime/local-stash.test.ts` asserts real Git `%s` and worktree/stash isolation.
- `adapters/decisions/recovery.ts` commits follow-ups under an authenticated worktree and lease; `rail-pr-decision.test.ts` covers blocked recovery and command messages. `runtime/isolated-settlement-reconstruction.ts::ensureIsolatedSettlementSnapshot` has adjacent transaction rollback/idempotency tests. `server/modules/agent-runtime/runtime/agent-runtime-settlement.ts::settleRuntimeContinuation` has adjacent injected-commit tests for verified recovery, original history, usage and repeat settlement.
- `server/worktree-manager.ts::commitWorktreeAndVerify` already sends a complete message as one `-m` argv value; embedded blank-line-separated bodies need no Git API changes. Keep its exclusions, hygiene checks and error results.

No frontend async rendering/state changes apply. Await existing Git calls in their current lock/lease boundaries; do not add detached work. Existing commit failures continue through the same failed/rejected/blocked results, and lookups remain best-effort. Do not expose ticket content or raw credentials in new logs.

## Decisions

### Pure formatting and validation

Extend pr-naming.ts with `ConventionalType = 'feat' | 'fix' | 'chore' | 'docs'`, `ConventionalSubjectInput { type; change; ref; breaking? }`, `formatConventionalSubject`, and `isConventionalCommitSubject(subject): boolean`. The validator checks the entire subject: accepted type, optional `!`, colon-space, nonempty description, no control/newline characters, <=100 characters. It accepts suffix-free housekeeping and the required empty-ticket fallback as well as ticket subjects; it is not a general commitlint implementation. Validator-negative fixtures must independently reject the old grammar, unsupported types, injected newlines, empty descriptions and overlong strings, so formatter/validator cannot agree on a malformed format unnoticed.

The formatter normalizes whitespace/control characters (including Unicode line separators), removes colons from the change, retains meaningful Unicode words, preserves the existing acronym/CamelCase/lowercase-first behavior and falls back to `implement <ref>` for empty/emoji-only changes. Detect usable text by Unicode letters/numbers, not ASCII alone. Build prefix and suffix separately, reserving the full ` (<ref>)` length before truncating only change with an ellipsis. Empty ref intentionally omits the suffix for housekeeping; an empty-ticket PR returns exactly `chore: specrails delivery` regardless of loopName. Check the resulting subject with the validator before returning; deterministic fallback must remain conventional, not throw because ticket text is unreadable.

A corrupt/oversized Jira value cannot simultaneously be retained verbatim and fit in 100 characters. At ticket-backed subject call sites, use the numeric local id if a ref contains controls or cannot leave room for a nonempty change within the cap; keep valid Jira keys intact. Do not alter shared `ticketRef`/branch naming behavior. The formatter's direct invalid-ref input uses a bounded safe fallback rather than throwing; cover it explicitly. Normal ticket refs and batch suffixes remain lossless. This is defensive handling of corrupt reference data, not truncation of a supported reference.

Keep existing label-before-title classification and homogeneous-batch rule. Breaking is a trimmed case-insensitive exact label `breaking` or `breaking-change`, never inferred from title text; any breaking ticket makes a batch breaking. Branch type/slug logic receives no breaking marker. Suppress breaking for partial/failed and housekeeping commits even when source tickets are breaking.

Use the same formatter for PRs and completed-run subjects. A full implementation message is subject + blank line + `Run: <runId>`. Retain the local ticket cross-reference in the body when Jira is primary, preserving the existing Jira development-panel purpose. Partial messages use `chore`, no bang, and a `(partial)` body marker; never include run id in the subject. Treat run id as single-line metadata, preventing injected body trailers.

### Lifecycle integrations

- Fresh isolated runs and their newly frozen full/partial messages use the new naming logic through existing ticketNamingInput. No new lookup transport or cache.
- Reattachment keeps already-conventional frozen messages exactly. Convert only legacy free-form frozen messages at the commit callback into a non-breaking `chore: recover follow-up (<ref>)` plus `Run:` body and partial marker where applicable. Preserve frozen allocation/identity and stored messages; no snapshot migration or historical commit rewrite. Use recorded ticket ids for deterministic fallback rather than mutable live ticket labels during legacy replay.
- Historical reconstruction creates conventional non-breaking recovery/partial messages from durable ticket ids and run id; keep its immediate transaction intact.
- Explicit follow-up and runtime continuation recovery use `chore: recover follow-up` with an optional known local ticket suffix and `Run:` body. Do not invent feature/breaking metadata when recovery only has durable ids. Keep all verification, project identity, group claims and rollback/retry behavior unchanged.
- Remote-branch merge in PR CI uses `chore: merge origin/<branch>` and `Run:` body. In pr.sync, inspect the existing pending merge at the current repository lock before commit: merge completion uses chore; standalone verified CI fixes use fix. Sanitize summary through the formatter, avoiding double prefixes by consuming an optional allowed Conventional prefix as input metadata rather than embedding `fix:` in change. Pending merge housekeeping never inherits `!` from summary text. No changes to the prepared-merge lifecycle, locks or push behavior.
- `restoreCommitMessage` uses chore, retains a compact primary local reference and remaining-count suffix for batches, and keeps existing local restore ownership/resolver behavior. It has no run id to invent.

No blanket guard in the generic worktree manager or PR publisher: their injectable APIs serve callers beyond this naming feature and accept arbitrary messages. The formatter's runtime validator guard protects all Desktop-generated subjects at their generation seam.

### Assembly merge subjects

`runtime/rail-pr-delivery.ts::deliverRailAsPr` currently auto-commits each unit with `merge --no-ff --no-edit`; pass an explicit formatter-produced `chore: merge delivery branch (<ticketId>)` via `-m`, retaining the immutable source object as the last argument. `adapters/decisions/merge-local.ts` likewise needs an explicit bounded chore message for its assembly merges, with a local delivery reference where known. Its final `--ff-only` operation creates no new commit. `runtime/merge-manager.ts::mergeBack` needs the same explicit chore message both on clean merges and the post-resolver `commit` (replace `--no-edit` there with `-m`). Keep ordering, resolver calls, aborts, integrated verification and rollback unchanged. The existing `fix: integrate parallel rail branch` recovery commit in rail-merge-orchestrator.ts is already conventional and represents its actual fix pass; leave it alone.

Reference tests: `runtime/rail-pr-delivery.test.ts` asserts immutable merge argv and abort/teardown; `runtime/rail-pr-decision.test.ts` covers local assembly and stale/failed integration; `runtime/merge-manager.test.ts` uses an injected GitRunner and verifies clean/conflict resolution/rollback order. Update positional argv test readers carefully so appending `-m` cannot make them mistake the message for a source ref. These are existing delivery commit generators, not new integration behavior.

### Boundaries

Keep naming inside delivery. Runtime continuation can consume a focused `delivery/runtime/pr-naming` public subpath, declared in server/modules/boundaries.json alongside actual import edges; do not import the large rail-isolated-launch coordinator or eagerly export infrastructure. Update the reviewed manifest explicitly, not by widening core rules. No port, class, new module, dependency or source file is needed.

### Rejected alternatives

- Title-only normalization: leaves merge/rebase histories unclassified.
- Ticket-as-scope: contradicts suffix choice and changes grouping.
- Unprefixed housekeeping: fails the generated-subject invariant.
- A global commit guard or history rewrite: changes unrelated caller/recovery contracts.
- Recompute all frozen messages from live tickets on replay: changes previously frozen intent and can turn incomplete work into a feature.
- Commit prepared clean base merges early: changes PR CI lifecycle ownership unnecessarily.

## Blast radius

All paths relative to the frozen specrails-desktop checkout; no other implementation file may change.

| File | Reason |
| --- | --- |
| server/modules/delivery/runtime/pr-naming.ts | Pure formatter/validator/types; PR grammar, breaking and suffix-safe cap |
| server/modules/delivery/runtime/pr-naming.test.ts | Exact grammar, negative validator, Unicode/unsafe title, fallback, breaking, batch, long ref and branch regression matrix |
| server/modules/delivery/runtime/rail-isolated-launch.ts | Completed/partial subjects and Run body; safe legacy frozen-message replay |
| server/modules/delivery/runtime/rail-isolated-launch.test.ts | Fresh Jira/local, fix/breaking, partial/failed, frozen/replayed/legacy message assertions |
| server/modules/delivery/runtime/pr-ci/pr-ci-handlers.ts | Conventional remote/base merge completion and standalone CI fix messages |
| server/modules/delivery/runtime/pr-ci/pr-ci-handlers.test.ts | Real Git subjects/bodies; prepared merge vs standalone fix; existing refusals |
| server/modules/delivery/adapters/decisions/recovery.ts | Conventional follow-up housekeeping and Run body |
| server/modules/delivery/runtime/rail-pr-decision.test.ts | Single/batch/fix/breaking/truncation/unreadable-store PR assertions and recovery subjects |
| server/modules/delivery/runtime/local-restore-branch.ts | Existing restoreCommitMessage becomes conventional with bounded references |
| server/modules/delivery/runtime/local-stash.test.ts | Clean/resolver restore subject and failure-path expectations |
| server/modules/delivery/runtime/isolated-settlement-reconstruction.ts | Newly reconstructed messages follow recovery/partial grammar |
| server/modules/delivery/runtime/isolated-settlement-reconstruction.test.ts | Assert full/partial messages, Run body and atomic replay |
| server/modules/agent-runtime/runtime/agent-runtime-settlement.ts | Conventional runtime-recovery housekeeping message |
| server/modules/agent-runtime/runtime/agent-runtime-settlement.test.ts | Assert injected commit message; verification rejection/idempotency unchanged |
| server/modules/delivery/runtime/rail-pr-delivery.ts | Explicit conventional chore subject for each PR batch assembly merge |
| server/modules/delivery/runtime/rail-pr-delivery.test.ts | Immutable merge source and conventional subject; abort/teardown unchanged |
| server/modules/delivery/adapters/decisions/merge-local.ts | Explicit conventional chore subject for local assembly merge commits |
| server/modules/delivery/runtime/merge-manager.ts | Explicit conventional subjects for clean and conflict-resolved legacy merges |
| server/modules/delivery/runtime/merge-manager.test.ts | Merge/commit argv grammar with resolver/rollback regression coverage |
| server/modules/boundaries.json | Declare naming public subpath and reviewed new import edges only |
| server/modules/delivery/README.md | Document shared naming, replay compatibility and public seam |
| docs/internals/safe-pr-review-flow.md | Replace stale title examples; document commits, breaking/partial/housekeeping and release semantics |

Planning artifacts under openspec/changes/runtime-945e46880c0b06f1cdb6: proposal.md, design.md, specs/safe-pr-workflow/spec.md, tasks.md. The existing main safe-pr-workflow spec receives only these additive requirements during Core-owned finalization, not during implementation. No new/moved source files mean no source-map regeneration is needed. No locale, API route/WS, config example, migration or persisted-format artifact becomes stale.

## Risks / Trade-offs

- Reference truncation could erase Jira linkage → reserve suffix before shortening the description; corrupt refs fall back to local ids.
- Shared formatter mistakes affect multiple paths → start with exact/negative unit fixtures, then prove actual Git `%s` and `%b` at lifecycle seams.
- Legacy snapshot strings could create fresh invalid subjects → normalize at replay only, preserve existing conventional messages and immutable evidence.
- CI merge plus fix shares a chore commit → see the explicit assumption; standalone fix commits and original feature/fix commits remain release-relevant.
- Release PR creation depends on installed release automation, credentials and releasable changes → desktop release.yml uses release-please-action v5.0.0 and node manifest mode; no runtime promise that chore/docs-only deliveries open a release. The official release-please guide documents feat/fix/breaking interpretation and recommends squash: https://github.com/googleapis/release-please#how-should-i-write-my-commits . Branch commits retain useful subjects for other merge modes; GitHub's own merge wrapper subject is outside Desktop generation.
- Existing safe-pr-workflow spec contains older automatic draft/merge-authority language that differs from current manual create/local merge paths → preserve it untouched; add only naming requirements.

Performance assumption: formatting is linear in supplied text/ticket count on delivery/commit boundaries, not a hot streaming path. Use existing bounded title logic and no I/O in the pure formatter. No speculative caching or optimization.

## Migration Plan

No database migration. Deploy new string generation for future commits and PR creation. Existing subjects/titles stay intact; legacy uncommitted replay gets a conventional housekeeping message at commit time. Rollback restores old generation without changing stored entities or Git history. Core owns verification, release observation and delivery; this plan does not merge a PR to prove the operational outcome.
