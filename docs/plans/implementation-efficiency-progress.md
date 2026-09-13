# Implementation efficiency — verification record

The local implementation is on `codex/implement-efficiency-runtime` in both repositories. This record supersedes the earlier in-progress notes. Core owns graph semantics and evidence; Desktop owns configuration, presentation, runtime retention and delivery. No additional AI verifier was introduced. Official OpenSpec remains mandatory for architect, developer and reviewer.

## Completeness

The paired OpenSpec task lists record completed local work individually. Remaining unchecked tasks are distribution gates: native OS/Node release validation, publishing a new authorized Core version, updating both exact Desktop pins and testing that pinned production bundle. A development tarball with package version 5.3.0 is **not** a new published release and must not overwrite the existing one. Do not archive the paired changes before these gates are resolved.

## Correctness and implementation mapping

| Plan area | Implementation | Evidence |
| --- | --- | --- |
| C0 / D0 capabilities and original runtimes | Core capabilities/runtime-identity/core-host; Desktop loader/package retainer | Actual original v4 tarball continuation through Desktop, unchanged saved fingerprints; retained dependency closure and nested versions; absent/corrupt provenance recovery; installed CLI/API checks |
| C1 context and review | repository-context, review-context, role-state, graph/roles | Fair bounded multi-repository packets, explicit truncated/deleted sources, confirmed-session deltas, narrow fresh-session fallback, complete acceptance recertification |
| C2 role routing | role-routing, transport executors, graph/roles | Two failed candidates counted once each; maxAttempts2 cannot add an attempt; maxAttempts3 routes third candidate; sessionless bounded repair/deepen; requested effort admission |
| C3 persisted checks | verification-plan, pipeline-state, scoped API/MCP tools | Immutable baseline and harness history, pre-write manifest bounds, source and plan fingerprints, paged output/source access, redaction, pending evidence integrity, installed standalone harness |
| C4 reuse and scheduling | pipeline-state | Host-only exact snapshot reuse, ignored dependency changes invalidate, external resources ineligible, contiguous independent waves, process-close/cancellation barriers and no successful partial receipt |
| C5 accounting | workflow ledger, efficiency-summary; Desktop metrics/events/history | Invocation IDs persisted before dispatch, replay deduplication, unknown measurements stay unknown, newer failed/cancelled projections supersede old success, built Core fixtures parsed without sibling checkout |
| C6 evaluation | evaluation/evaluation-corpus and runtime evaluate CLI | Five frozen cases, full/optimized pairs, independent acceptance and defective variants; opt-in real mode is not executed |
| D1 / D2 controls | effective-config, bridge, settings router and role controls | Selected launch provider applies to all roles (user clarification); frozen provenance; key/label/cwd/env/timeout/policy survive edits and reordering; actual effort capability gates; eight locales |
| D3 shared evidence and narration | RuntimeExecutionEvidence, AgentRuntimeRuns, narration-model | Repository-attributed check activity, requested versus reported selection, lazy historical sources/output, bounded pagination, replay-safe narration, real Chromium wheel/keyboard tests in Mission and Board |

## Actual validation

- Core full CI test stage: **62 files, 883 passed, 1 skipped**, coverage passed. Its expanded package smoke initially exposed an incorrect standalone import; corrected and package gate passed separately.
- Desktop full `npm run ci`: **8,367 server tests passed (8 skipped)** and **4,897 client tests passed**; coverage, scripts, compatibility, build and package gates passed.
- Follow-up changes were revalidated with focused suites rather than repeating every unrelated slow suite: Core workflow/metrics/plan/pipeline group **103 passed**; API/MCP/CLI/Kimi group **71 passed**; final pipeline/plan group **63 passed**; pending-evidence/event/cancellation group **13 passed**. Desktop settings/loader **48 passed**, controls/metrics **43 passed**, final settings/evidence/narration **70 passed**.
- Core and Desktop typechecks/builds passed after their respective final source edits. The installed Core package checks two CLI entries, a symlinked CLI entry, four provider assemblies, four frozen journals, and a persisted multi-file harness/evidence resolver. Desktop production npm package checks passed again after final UI changes.
- Final compiled Desktop + isolated npm-installed Core smoke: **passed** failure/correction, configured reviewer escalation, persisted harness, reuse and invalidation, archive approval, fresh nonterminal recertification and zero replay on terminal continuation. The source sibling was not selected.
- Directory-alias retention regression: **5 passed, 1 optional sibling integration skipped**; the actual installed-package paired smoke above independently covers the distribution path.
- Actual v4 continuation: passed through original retained runtime. Actual retained current runtime/dependency-closure boot: passed. No saved request/checksum was rewritten to make a fixture pass.
- Real Chromium short-viewport evidence smoke: **Mission and Board passed** wheel scrolling and keyboard access to long lists and output. All eight locale key sets match.
- Both changes pass `openspec validate implementation-efficiency --strict`; both repositories pass `git diff --check`.

The full suites preceded small final fixes; the focused checks above are the final-change evidence, not a claim that every full suite was rerun after every edit. Native Windows/macOS release jobs cannot be certified from this local development run. Existing script/parity/package tests passed; native distribution remains a release gate.

## Coherence and explicit limits

- Five graph phases remain; deterministic verification does not call a model. Acceptance and host delivery gates were not relaxed.
- API metadata is cached by runtime content identity. Transport/model capability probes are deduplicated within a query and refreshed across queries, deliberately avoiding stale installed-provider/configuration evidence.
- Context and check reuse fail closed when compatibility or identities cannot be proven. Requested models/efforts are never reported as provider-observed values.
- The offline report measures fixed fixture mechanics, not actual AI billing or production throughput. No paid model benchmark has run, and economic tiers remain opt-in.
- Local Core artifact identity and downstream handoff are recorded in `implementation-efficiency-artifact.json`. Its source commit is the branch baseline because these development changes are uncommitted; content integrity identifies the actual artifact. Commits made afterwards do not retroactively change that build-time manifest.
- No npm release or new production pin has been created. The user subsequently authorized new branches, commits and paired pull requests.

## Archive assessment

Local implementation and regression evidence are recorded here. **Release-blocking incomplete tasks remain**: Core 8.2 (native matrix portion), Desktop 5.4 (native matrix portion), 6.1 (published package/pins) and 6.2 (pinned production bundle). Complete those explicit release steps before archive. The unrun paid experiment is a measurement limitation, not an implementation blocker.
