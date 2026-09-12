# Programmatic agent runtime: implementation verification

Validated locally on **2026-09-11**, on macOS with Node 25.9.0. The complete paired execution was also validated with Desktop's bundled **Node 22.23.1**. This records the paired source implementation in Specrails Core and Desktop; it is not a published release or a Windows runner result.

## Result

Core owns a typed LangGraph workflow for architecture, development, deterministic verification, review, bounded corrections and archive. Provider adapters execute individual roles. Desktop admits the configured workflow into its existing scoped worktree/rail execution and exposes configuration, progress, durable continuation, approval and cancellation.

The supported built-in transports are Claude, Codex, Gemini, Kimi and an OpenAI-compatible HTTP tool loop. A programmatic executor registry supports additional providers without changing the workflow. The new orchestration infrastructure is free and open source; existing model services and local hardware retain their own costs and terms.

## Automated checks

| Check | Result |
| --- | --- |
| Core full coverage suite | 50 files passed; 750 tests passed, 1 skipped |
| Core coverage | 90.86% lines, 86.44% statements, 79.63% branches, 93.23% functions |
| Desktop server/CLI full coverage suite | 336 files passed, 2 skipped; 8,276 tests passed, 7 skipped |
| Desktop server/CLI coverage | 89.36% lines, 86.67% statements, 79.66% branches, 90.64% functions |
| Desktop client full coverage suite | 390 files passed; 4,877 tests passed |
| Desktop client coverage | 90.04% lines/statements, 84.28% branches, 76% functions |
| TypeScript | Core and Desktop typechecks passed |
| Builds | Core build; Desktop server, client, CLI and MCP bridge builds passed |
| Script regressions | Core 19 and Desktop 75 tests passed |
| Core npm package | Actual tarball installed in an unrelated consumer; both CLI entries, four provider assemblies, runtime export/declarations and a LangGraph execution passed |
| Desktop npm package | Actual tarball installed in an unrelated consumer; CLI, assets, schemas and compiled CommonJS-to-external-Core-CLI negotiation/validation passed, including simulated pkg execution without bundled Node |
| Paired source assembly | Locked Core production dependencies staged in `src-tauri/core`; offline workflow smoke passed |
| Complete paired workflow | Compiled Desktop bridge → real Core CLI → localhost HTTP tool fixture → real verification → approval → archive passed on Node 25.9.0 and bundled Node 22.23.1; two resumes preserved completed roles, usage and Git ownership |
| Sidecar bundle | Server esbuild bundle using the native build's CJS/Node 22 options passed |
| New Desktop portability job | Workflow passed `actionlint`; its exact eight-suite command passed 111 tests locally on macOS |
| Existing Core compatibility | Desktop 2.43.1 and the locally selected installed Core 5.2.3 passed the existing contract check |

All existing coverage thresholds remained enabled. The client suite initially hit an unrelated AddProjectDialog timeout under concurrent heavy builds; its isolated suite and a complete rerun with two workers passed. Server tests that bind localhost were run with the required execution permissions after sandbox-only `EPERM` failures.

The Desktop full coverage figures above precede the final Node-launcher fallback fix. After that fix, the eight affected suites passed 105 tests, typecheck and the server build passed again, and the final installed-package plus paired Node 22 checks passed. The resolver preserves the running interpreter in ordinary Node, prefers a bundled interpreter when available, and uses PATH `node` from a packaged server whose bundled Node is missing. The new portability job also includes its regression suite.

The installed Core compatibility check preserves the legacy contract. The new API was separately exercised against the **paired source Core** through its installed package, assembled bundle and Desktop's compiled loader; an older published package is not evidence that API 1 is present.

## Live provider runs (2026-09-11, macOS, Claude Sonnet via the installed CLI)

Two end-to-end runs on a throwaway Node repository (`node --test`) using the source Core CLI directly, before and after the second round of changes:

| Run | Configuration | Outcome |
| --- | --- | --- |
| live-01 (previous runtime) | Claude for all roles, verification configured | Failed after 2 min and $0.18: the developer had no shell, left a "run the tests" task unchecked, and the verify step aborted the workflow with "Required implementation tasks remain incomplete" |
| live-02 (current runtime) | Claude for all roles, **no verification configured** | Succeeded in 72 s for $0.33: the architect proposed `npm test`, the developer ran the tests in its sandbox and ticked all six tasks, verification ran the proposed command, the reviewer approved with score 96, archive completed |

The same failure shape was reproduced by a user on a greenfield HTML project (a manual browser checklist task the developer could not tick). The changes that address it: developer tool parity with the legacy Implement step, optional/architect-proposed verification with admitted unverified repositories, unchecked tasks routed back as developer feedback, architect instructions that forbid manual or delivery tasks, session reuse on correction passes, native structured output with one in-session repair turn, readable phase notes instead of raw JSON in the log, and a fresh attempt budget on explicit resume.

## Behavioral evidence

- Offline workflow tests exercise success, correction limits, configuration identity, exclusive leases, persisted approvals, process interruption, explicit recovery, evidence invalidation and archive crash reconciliation.
- Core rejects invalid verification repository IDs/paths and known unsupported provider limits before any role executes. Injected executors declare their own limit capabilities.
- Provider tests exercise structured CLI events, old Kimi ACP plan mode, scoped tools, cancellation, incomplete responses, Windows argument handling and a real localhost OpenAI-compatible coding fixture. A local Kimi 0.27 capability probe initialized ACP and selected plan mode without submitting a model prompt.
- Gemini and Kimi ACP return the final assistant turn separately from tool-progress commentary. Gemini's native policy engine was also checked locally across 36 decisions with plan disabled and existing broad user approvals: only the designated read-only tools remained allowed. System policies that disable the per-run policy cause an explicit capability failure.
- Desktop integration tests execute real child processes and verification commands, validate final Core identity/evidence, preserve interrupted worktrees and retain original scope when resuming.
- `node scripts/smoke-agent-runtime-pair.mjs` additionally exercises the actual compiled Desktop/Core boundary against a deterministic local HTTP model fixture. The fixture edits only its temporary repository through Core tools and validates the complete approval/archive flow.
- Desktop adopts Core's paused-question contract: `pendingQuestion`, `traceId` and step `visits` from `status --compact`, `resume --answer`, tighten-only review thresholds (70/75/60 floors) and `architect.onLowConfidence`, plus tolerant parsing of `span` events. Unit tests cover the `answer_required` gate, the answer argv, the bridge's question-aware pause message and the memoized API probe.
- Continuation accounting reuses the existing durable recovery ledger. Replayed events do not duplicate usage; unavailable cost or token values remain unknown. Recovery also handles interrupted continuations before accepting another one.
- Core's existing CI matrix runs the new tests on macOS, Windows and Linux with Node 20.19.0, 22 and 24. Desktop adds focused runtime integration coverage on macOS and Windows. These remote jobs have not been dispatched from this session.

## Remaining release and operational limits

1. **Changes are local source, not a published release.** The production Desktop registry lock still pins Core 5.1.1; the local Core checkout identifies itself as 5.1.0. Publish and pin a reviewed paired Core release before distributing Desktop. Do not downgrade an activated managed Core installation to try this source feature; use the documented explicit development runtime override.
2. **Native Windows and live paid-provider execution remain unverified here.** Windows paths, process shims and protocol contracts have automated coverage, but native Windows execution must pass on its runner. No paid inference was invoked during implementation.
3. **Enable projects explicitly.** The runtime applies to implementation rail steps. Mission chat and other unrelated AI features keep their existing transports. A role still needs central model instructions; workflow ordering, gates, retries and archive are code-owned.
4. **Resume preserves host delivery boundaries.** A resumed Core workflow finishes in the original worktree. It does not automatically restart the former rail's PR/backlog delivery phase. The normal uninterrupted rail retains its existing delivery flow.
5. **Capabilities differ by provider.** Native dollar caps are available only for the built-in Claude executor. Kimi has no authoritative usage counters, and old ACP versions cannot expose every multi-repository read-only scope. Gemini read-only roles require enforceable native admin policies. Unsupported configurations fail explicitly. Local endpoints need function tool support.
6. **Archive uses complete reviewed specifications.** It replaces the corresponding main specification documents; it does not merge partial OpenSpec deltas.

A production dependency audit also found two high-severity advisories in the pre-existing `fast-uri` 3.1.0 and `js-yaml` 4.1.1 entries. Those exact versions were already in Core's original lockfile; the new runtime dependencies did not introduce them. This implementation does not claim a clean baseline dependency audit.

See [setup and recovery](programmatic-agent-runtime.md), [architecture evaluation](agent-runtime-framework-evaluation.md), and the paired Core checkout's `docs/agent-runtime.md` for configuration and programmatic APIs.
