# Implementation reliability audit — 2026-09-05

Scope: built-in Implement, Batch Implement, Freestyle and SDD Quick loops;
custom-loop execution; mission-to-rail launches; delivery review, local
integration and Git worktree checkout. Implemented on `feat/codex-gpt-6-astra`,
preserving the unfinished Astra catalog changes already on that branch.

The subsequent startup/update disconnection investigation is documented in
[Startup and update recovery audit](./startup-recovery-audit.md).

## Findings and changes

| Area | Failure found | Resulting behavior |
| --- | --- | --- |
| Loop outcome | AI/shell errors could reach a successful End; a Decider STOP could override a failed step. | Failed passes cannot succeed. Repair must be followed by a successful verification. |
| Verification | A successful CLI invocation or parseable Decider reply was insufficient proof of verification. | Built-in verification requires an explicit final `VERIFICATION: PASS` line and a successful invocation. Failed/absent verdicts trigger repair. |
| Decider execution | JSON from a timed-out or failed CLI could be accepted. | Transport/process errors invalidate the decision. |
| Resident CLI errors | A terminal Claude error result could be treated as a successful turn while the process remained alive; an earlier PASS could survive when the error omitted text. | Terminal result errors stop the failed step after recording usage. Recoverable individual tool errors remain available for the agent to fix. |
| Progress detection | Hashing only HEAD and status/path names treated edits to the same files as no progress. | The fingerprint includes tracked/index binary diffs and untracked content, without following external symlinks. |
| Deadlines | The run deadline was checked only between steps; untimed built-ins could remain silent forever. | Remaining deadlines reach each executor. Both AI transports have a configurable inactivity watchdog; active long implementations retain their untimed behavior. |
| Inactivity retry | Retrying a stalled invocation reused its checkpoint and lost the first attempt's cost. | Every attempt has its own recorded checkpoint and usage; retries respect the remaining budget and deadline. |
| Provider limits | A throwing notification subscriber could disrupt settlement after a provider limit. | Reporting the provider limit cannot replace or interrupt the persisted execution outcome. |
| Run isolation | Shared settlement options could carry one run's stall reason into another run. | Each run receives independently derived settlement options. |
| SDD shell steps | Relocated projects executed shell commands in the artifact workspace. | Shell steps execute in the actual repository/worktree. |
| Gemini | Loop spawns skipped the provider's headless initialization. | The provider preparation hook runs before spawning, matching QueueManager. |
| Isolation failure | Operational worktree allocation failures fell back to the user's checkout. | Launch fails explicitly without executing the implementation in the shared checkout. Initial non-Git/unborn repositories retain their explicit degraded path. |
| Batch review | The Decider received only the first ticket's spec. | Every ticket's launch snapshot reaches the evaluation context. |
| Custom graphs | Duplicate IDs, invalid limits, ambiguous branches and unsupported fan-out could skip work silently. | Validation rejects graphs the sequential engine cannot execute faithfully. This does not add AND/OR execution semantics. |
| Rail profiles | The selected profile was resolved by the route but dropped before loop execution. | Isolated/shared launches and interactive/one-shot steps receive the selection. Named profiles get immutable snapshots and the orchestrator model is honored; explicit model selection wins. Missing named profiles fail before launch. |
| Model handoff | Mission launches could inherit effort while dropping the selected model. | Matching-engine launches inherit both together unless explicitly overridden. |
| Local integration | Any dirty checkout blocked integration, even unrelated files; a different checked-out branch also blocked it. | Integration assembles away from the user's checkout and uses a non-forced fast-forward. Compatible edits survive; conflicting tracked, untracked and ignored files remain protected. Another active branch remains untouched while the integration branch is updated through a temporary worktree. |
| Commit authority | Missing delivery SHA could fall back to a mutable branch tip. | Integration requires recorded, available commits; stale/missing evidence cannot authorize unrelated work. |
| Stacked milestone acceptance | With no assembled delivery SHA, proving only the first unit could complete tickets and clean branches for the whole delivery. | Every unit must have a valid immutable SHA and proven ancestry before acceptance or cleanup; incomplete evidence retains review state. |
| Integration races | A checkout change near the final advance could make cleanup unsafe. | Destination identity is checked before and after the advance; failure preserves work and does not mark tickets done. |
| Checkout | The UI required a remote PR, and dirty/cleanup guards blocked compatible local handoffs. | A single verified local result can be checked out before creating a PR. Branch/SHA checks remain mandatory. Cleanup warnings from other retained worktrees do not prevent a valid checkout. |
| Cleanup | A directory listed as ignored at settlement could gain new files before cleanup. | Its contents are preserved in a recorded safety archive before release, including subsequent additions. |
| Review evidence | Persisted `{line}` log envelopes were read as raw JSON; interrupted verification could still advertise PASS. | Logs are decoded, verdicts must occupy a verdict line, and incomplete/failed verification cannot provide green evidence. |
| Mission/board state | Every 409 was treated as already resolved; failed aborts could hide a running job; late Git responses could overwrite current state. | Only stale decisions reconcile neutrally. Real errors remain visible, rejected aborts retain the active session, and old responses cannot overwrite newer project state. |
| Project routing | A mission review card could open using the currently active project's API. | The review opens in the delivery's own project. |
| Agent instructions | The operator conflated implementation success with Done and omitted the local Git handoff contract. | Instructions distinguish `on_review`, acceptance, checkout and integration, and preserve user data when an action is blocked. |
| Astra | Partial catalog work omitted standalone loops and had an unresolved test import. Generic effort lists also offered unsupported model tiers. | Astra is available throughout the selectors and Max preset, with GPT-5.5 still the default and no invented pricing. Current Codex model-specific effort lists are reflected in client and server. |

## Verification

Regression tests exercise real temporary Git repositories for dirty indexes,
compatible and conflicting edits, untracked/ignored files, detached HEAD,
other checked-out branches, branch occupation, exact commit identity, retries,
batch conflicts, external branch changes and worktree cleanup. Provider process
tests inject controlled CLI streams, failures and inactivity rather than
spending quota on real model calls. UI tests cover mission and board actions,
project switching, stale responses, abort rejection and error presentation.

Final validation on 2026-09-05:

| Check | Result |
| --- | --- |
| `npm run test:coverage` (server/CLI/MCP) | 272 files, **7,263 tests passed**. |
| Server/CLI coverage | **87.81% lines**, 85.43% statements, 77.62% branches, 89.52% functions; all configured thresholds passed. |
| Client `npm run test:coverage -- --maxWorkers=2` | 348 files, **4,310 tests passed**. |
| Client coverage | **89.06% lines/statements**, 82.87% branches, 74.21% functions; all configured thresholds passed. |
| `npm run typecheck` | Passed across server, CLI, MCP bridge and client. |
| `npm run build` | Passed (server, client and CLI); existing Vite chunk-size advisory remains. |
| `npm run check-core-compat` | Passed against locally installed `specrails-core@4.11.1`. |
| `git diff --check` | Passed. |

Total: **11,573 passing tests**. The final terminal-result regression reproduced
eight failures before its fix. No test thresholds were lowered or files excluded
to obtain coverage. HTTP/IPC/Git suites ran outside the filesystem sandbox where
necessary for their temporary local sockets and repositories.

## Operational boundaries

`SPECRAILS_LOOP_INACTIVITY_MS` controls the AI-step inactivity watchdog
(milliseconds; default 1,800,000 = 30 minutes; `0` disables it). Output resets
this timer. Explicit graph run/step deadlines still apply independently.

Actual source conflicts and another checkout holding the integration branch
remain actionable blocks; local user data is never forcibly overwritten to
make an action appear successful. A preserved directory is exposed through the
delivery's safety-archive metadata and cleanup warnings.

These changes remove reproduced application faults. Provider quota, service
availability, model decisions, external Git writers and project-specific build
failures remain external inputs; the application must report and preserve work
when they fail. No live provider execution, remote PR publication or release
deployment is part of the automated validation.
