# Implementation efficiency — operator and release handoff

The paired change lives on `codex/implement-efficiency-runtime` in Desktop and Core. Core owns graph semantics, transport support, checks, receipts and evidence; Desktop owns provider connections, role settings, launch intent, original-runtime retention and delivery. There is no additional verifier model.

## User-facing behavior

- Project role settings remain authoritative. A selected rail/Mission provider applies to **all three roles**; explicit launch model/effort applies to all three as well. Without a selected provider, project role assignments remain authoritative. Provider-specific model defaults apply only where a model is absent. New runs record the resolved selections and origins; resume retains the original request.
- Effort is optional and is offered from the actual installed model/transport response. An unconfirmed saved value remains visible, and admission rejects it until it is supported or replaced by provider default. Base and optional same-provider escalation models are queried separately. Provider/model edits invalidate displayed compatibility.
- Advanced efficiency settings control context, review, planning, developer-proposed checks and a one-to-four concurrency limit. They do not fabricate reusable or independent checks. Higher-tier routing is unset by default and cannot create additional attempts.
- Board and Mission use the same implementation/evidence section. Sources and stdout/stderr load on demand with bounded pagination. Wheel and keyboard scrolling are independently available in the list and output panes.
- Results identify the repository, check origin and executed/reused/not-run disposition. Requested role configuration is separate from observed values, which stay unknown unless reported. A later failed continuation replaces the current projection even if it lacks optional metrics. Older usage remains historical; Core settlement gates remain authoritative.
- Removing the worktree or original runtime disables continuation and delivery. Validated historical projections can still show the recorded result; evidence remains readable while its original retained runtime and evidence files exist. Historical success is not proof that a current candidate remains valid.

## Compatibility and recovery

New runs retain their Core package **and production dependency closure**, fingerprinted by contents. Replacing the active package cannot redirect existing jobs. Restore the retained package on integrity failure; do not substitute a similarly versioned runtime. Legacy requests without recorded provenance are intentionally not guessed or rewritten. The v4 compatibility fixture was created with the original runtime and continued through Desktop's actual retainer without changing its frozen request/checksums.

To roll back new-run behavior, select the prior released Core for new admissions. Keep referenced retained runtimes and state. Do not delete `runtime-packages` while saved jobs refer to them. The efficiency controls require a matching capability-enabled Core; old API1 remains usable without requesting new fields.

## Reproducible local checks

```sh
# Core
npm run ci
node bin/specrails-core.mjs runtime evaluate --output /tmp/specrails-efficiency-evaluation

# Desktop, after building both repositories
npm run ci
node scripts/smoke-agent-runtime-pair.mjs --core /absolute/path/to/core/dist/agent-runtime/index.js
node scripts/smoke-runtime-evidence.mjs
```

The paired smoke uses an isolated deterministic local HTTP provider and real OpenSpec, including a failed check and developer correction, a bounded reviewer escalation, a persisted harness, evidence discovery, conservative reuse, archive approval, fresh verification on nonterminal continuation and zero model replay on terminal reads. Browser smoke uses the actual shared React section, built client CSS, synthetic data and a short viewport; it reads no user database and calls no AI provider.

Core ships generated schema1 summary fixtures for ordinary success, correction, failure, reuse, invalidation, incomplete metrics and unavailable evidence. Desktop keeps an exact test copy so parser tests do not require a sibling checkout. The paired package check compares the shipped fixture when available.

## Release boundary

The working Core package is still version 5.3.0 with a different content identity; it is **not** a newly published 5.3.0. Do not overwrite that release or update Desktop to a guessed version. Publish a new authorized Core version, record its npm integrity, then update `scripts/assemble-bundled-core.lock.json` and `.github/workflows/desktop-release.yml` together. Assemble and smoke that exact production bundle separately from source-build checks. Run the existing Windows and macOS release matrix before distribution.

No real-provider benchmark has been authorized or run. The final offline fixture accepted 5/5 cases in each mode and reduced the fixed correction prompt by 63.4%; this is not a monetary or speed claim. Real model selections, aggregate spend and any decision to enable economic routing remain explicit experiment inputs.
