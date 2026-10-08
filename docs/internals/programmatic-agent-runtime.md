# Programmatic agent runtime

Desktop owns the Implement, Freestyle and Quick SDD workflow graphs and their loop agent definitions. With Core's `implementationSteps: 1` capability, Implement invokes architect, developer, fixer, deterministic verification, reviewer and archive as independent operations. Core executes the graph through LangGraph and owns durable evidence and recovery. Desktop keeps project/worktree selection, rail lifecycle, logs, accounting and delivery ownership.

This is the only implementation engine in the current source tree. It applies to implementation rail steps and their Core completion check. Mission chat and unrelated AI features keep their existing transports. Provider-native implementation prompts and skills are not invoked inside the programmatic phases.

## Build the paired source

Use Node **22.22.3+** for Core; Node **22.22.3** matches Desktop's native CI runtime. Provider requirements can be higher. Both repositories' dependencies must be installed.

```sh
cd ../specrails-core
npm ci
npm run build
npm run check:package
cd ../specrails-desktop
npm ci
npm ci --prefix client
node scripts/assemble-bundled-core.mjs --source ../specrails-core
npm run dev
```

The assembly command stages the built Core checkout into `src-tauri/core`, installs its locked production dependency closure, and runs an offline workflow smoke test. It can download npm dependencies; it does not invoke an AI provider. Build Core first and repeat assembly after changing its runtime. Native development uses `npm run dev:desktop` instead of `npm run dev`; stop the existing app first and follow the [native development instructions](../../README.md#develop-from-source).

To verify the complete paired execution boundary without paid model calls:

```sh
npm run build:server
node scripts/smoke-agent-runtime-pair.mjs
```

This runs the compiled Desktop bridge and real bundled Core against a temporary localhost model fixture. It checks tool writes, a real verification subprocess, archive approval, resume, usage and host Git ownership. The fixture explicitly selects the `free` agent loop; Core's compact pipeline has its own protocol tests. It uses a temporary repository and deletes it afterward. Pass `--core /absolute/path/to/Core/dist/agent-runtime/index.js` to exercise another built Core checkout.

For web development, an explicit runtime override can point to the built module:

```sh
# macOS shell, from specrails-desktop
export SPECRAILS_CORE_RUNTIME_PATH="$PWD/../specrails-core/dist/agent-runtime/index.js"
npm run dev
```

```powershell
# PowerShell, from specrails-desktop
$env:SPECRAILS_CORE_RUNTIME_PATH = (Resolve-Path ../specrails-core/dist/agent-runtime/index.js).Path
npm run dev
```

Use this override when an activated managed or globally installed Core is newer than the source bundle and does not yet expose API 1. Merely assembling an older-version checkout does not override Desktop's selected installation. Keep its installation/lifecycle selection intact while testing the explicitly selected execution module.

The override identifies **index.js**, not the package directory or CLI file. Runtime discovery checks it first, then the existing Core resolver's selected installation, including activated managed updates. An authoritative managed, override or bundled installation is not silently replaced when its runtime is missing or incompatible. Production does not fall back to a sibling checkout. Development can also resolve an installed `specrails-core/agent-runtime` export or a sibling Core build when no authoritative runtime is available.

Desktop negotiates `runtime api` and sends configuration to `runtime validate --stdin` through its bundled/system Node interpreter. This keeps the Core ESM runtime outside Desktop's CommonJS/pkg process and avoids relying on unsupported dynamic imports inside the native sidecar.

`SPECRAILS_CORE_RUNTIME_PATH` selects this execution module. The existing `SPECRAILS_CORE_BIN` controls the installation/lifecycle resolver and is a different setting. Prefer a paired source bundle when testing the complete installation and execution flow.

## Configure a loop and its project checks

1. Open the loop builder and edit **Loop agents**. Definitions, models, effort,
   turn limits, fixer routing, custom roles and workflow policy belong to the loop.
   Publishing a builtin applies to future runs in every project; duplicate it for
   a specialized flow.
2. Configure provider connections under **General settings → Specrails Agents →
   Provider connections**. Connections remain global; loop agents reference them.
3. Open **Project settings → Verification commands** for repository checks.
   **Detect project checks** finds local commands without AI. Each row retains its
   repository, command, arguments and metadata. With no configured checks the
   Implement architect proposes checks; unverified repositories remain explicit.
4. Publish the loop and launch it through the normal rail flow. Review thresholds
   may only tighten Core's floors (70 overall, 75 security, 60 other aspects).
   Archive approval and low-confidence architect behavior are loop policies.

Only verification is read from the project's `.specrails/agent-runtime.json` for
new loop-owned recipes. Historical roles remain available for explicit import
and old saved graphs. The editor never silently imports a project's settings
into a shared builtin. Connections remain in `~/.specrails/runtime-providers.json`.
Admission freezes the resolved graph, roles, checks and Core package; resume
uses that snapshot. See [migration and recovery](desktop-owned-workflows.md).

Desktop owns editable role definitions; Core owns their artifact protocol and execution permissions. The developer role edits and runs commands inside its CLI sandbox (the same autonomy as the legacy Implement step); architect and reviewer are read-only. A legacy rail profile/model selection does not override the runtime's per-role provider configuration. The JSON schema is [server/schemas/agent-runtime.schema.json](../../server/schemas/agent-runtime.schema.json), mirrored from Core. For a complete configuration, custom executor examples, Kimi capabilities and API tooling details, see [Core's runtime guide](https://github.com/fjpulidop/specrails-core/blob/main/docs/agent-runtime.md) in the paired revision.

The built-in Claude adapter supports its native dollar cap. Built-in Codex, Gemini, Kimi and OpenAI-compatible adapters reject `maxCostUsd`; remove that limit for mixed-provider/local runs. Kimi also rejects token caps because its usage is unavailable. Unknown cost/tokens remain unknown in accounting, rather than becoming zero. Attempt, timeout and tool limits remain available. Existing provider services, licenses and inference costs are separate from the free open-source orchestration runtime.

Gemini architect/reviewer roles require native `--admin-policy` support. Core applies a temporary read-only tool allowlist that remains effective if user settings disable plan mode. If system policies prevent per-run enforcement, Core rejects that role with an actionable capability error; it does not replace managed policies. The developer role retains its normal editing transport.

## State, approvals and continuation

The rail creates a frozen Core execution context for its original repository/worktree paths. State is kept below the project's execution `.specrails/pipeline/<runId>/` directory:

| File | Purpose |
| --- | --- |
| `desktop-context.json` | Selected repositories, original worktrees, frozen scope and ownership |
| `desktop-runtime-config.json` | Admission snapshot of project settings with verification commands restricted to the selected repositories; project settings remain unchanged |
| `desktop-runtime-host.json` | Allowlisted host settings needed to reconstruct execution |
| `agent-runtime-request.json` | Core's frozen configuration and change name |
| `state.json`, `receipts/` | Core gates and verification receipts |
| `agent-workflow/<runId>/checkpoint.json` | Durable phases, attempts, approvals and usage |

A run pauses (Core exit code 2) either on an **approval** (`pendingApproval`, for example before archive) or on a **question** (`pendingQuestion: { stepId, requestedAt, question }`) when the architect is configured to ask on low confidence. A pending question can only be resumed together with an answer: the runs panel shows the question with a textarea and an **Answer and resume** action, which posts `{ "answer": "…" }` (nonempty, at most 20,000 characters). Resuming without an answer while a question is open is rejected with `400 answer_required`. Once Core records `answeredAt`, the question is history and ordinary resume applies again. The bridge reports a paused run's reason in the job log: awaiting approval, or the pending question text.

**Implementation cards and job detail** expose resume, archive approval, question answering, interrupted-step recovery and continuation cancellation actions next to the work. Cards query their latest job by original rail identity; job detail queries its exact run. Legacy jobs render no runtime panel. **Jobs → Saved executions** retains the cross-run history. Project settings contain repository verification commands; the loop owns agents and policy. A continuation resumes from the phase shown, in the original worktree, and writes its progress into that job's log (a `[runtime] continuation started from phase …` banner, tool activity, phase notes and the final outcome). Resuming a run that stopped at the developer attempt limit grants a fresh attempt budget. Wait for the original rail execution to settle before resuming. Active rail jobs are stopped through their job controls; the continuation's Cancel action owns only continuations started from this panel.

Resume retains valid completed phases and rechecks Core evidence. Changed code or environment requires fresh verification/review. An ambiguous interrupted write requires an explicit recovery action after inspecting partial changes. A changed frozen config/identity requires a new run. Missing original worktrees or mismatched execution manifests block recovery; the controller never invents a replacement worktree.

Saved executions link directly to the original job log. Continuations broadcast readable logs and raw runtime events to that job, publish `runtime.continuation` lifecycle updates, and reserve the original implementation card until settlement. Jobs list/detail project the continuation as running while it is active (including the running filter); the failed attempt remains in history. Job and card cancellation route to the continuation process. After a successful continuation, Desktop revalidates Core receipts, commits the exact preserved worktrees locally, and reconciles the job and repository delivery cards to completed / ready for review. A new completion event supersedes the earlier failed summary while retaining the failed attempt and its usage. The activity reservation then clears.

**A continuation prepares local delivery for review after Core succeeds; it does not create a PR or merge code.** Use the normal delivery card actions to review and publish. Older successful continuations expose **Prepare delivery**, which performs the same receipt validation and local settlement without invoking a model. This also applies when approval is granted after the original rail has settled. Core archive success is not a claim that a PR was created. The initial uninterrupted successful rail retains its normal host delivery flow.

Disabling project runtime settings affects future admission. Existing runs retain their frozen runtime request and remain available for explicit continuation; they do not switch back to a platform prompt.

## API and logs

All routes are under `/api/projects/:projectId`:

| Method/path | Result |
| --- | --- |
| `GET /agent-runtime/config` | Saved/default config and runtime availability |
| `PUT /agent-runtime/config` | Validate and atomically save configuration |
| `GET /agent-runtime/runs` | Recent run status, `traceId`, pending approval or question, recoverable phases and available controls |
| `POST /agent-runtime/runs/:runId/resume` | Accept `{}`, `{ "approve": ["archive"] }`, `{ "recover": ["developer"] }`, explicit `invalidate` phase IDs, or `{ "answer": "…" }` for a pending question (required while one is open) |
| `POST /agent-runtime/runs/:runId/cancel` | Cancel a continuation owned by this controller |

Host blockers (Core `hostBlockers: 1` / `setupCommands: 1`): the Implement recipe opts its `verify` nodes into host-owned environment repair and the `blocked` outcome. Core emits `[environment] <command> (<repository>)` and `Environment: installed …` lines on the `verification-output` channel, so they reach the readable job log through the same projection as checks. A precondition Core cannot satisfy (no network for a browser download, registry credentials, a failing `setup` command, a missing toolchain) ends the run at `host-blocked` with `completion.blocker = { kind, reason, command, args, cwd, requiredAction, evidenceId? }`; a fixer-declared `blocker` ends it at `fixer-blocked`. A developer-declared `blocker` ends the run at `developer-blocked` only for kinds the person must provide (`credential`, `network`, `environment-variable`); any other kind is confirmed by host verification first (`confirm-blocker` sets `blockerCheck`): a host precondition ends at `host-blocked`, a reproduced failure goes to the fixer as a correction, and passing checks (`blocker-check`) send the developer back within its implementation budget. The developer loop is bounded like corrections: when `tasks` finds approved tasks still unchecked, the developer runs again only while its last turn changed the candidate (`implementation-progress`, otherwise `implementation-stalled`) and within `implementationLimit` = 3 attempts (`implementation-exhausted`); both ends report the developer's `incomplete` list and summary. The bridge maps that completion (`ok: false`) to `runtimeStatus: 'blocked'`, the run row shows the blocked badge and the loop log renders "Blocked by the host environment" with the localized kind, the failing command and cwd, the required action and a copy button. Older Core packages receive the pre-blocker definition and no `setup` list.

Resume responds `202` after admission and continues asynchronously. Legacy phase IDs are `architect`, `developer`, `fixer`, `verify`, `reviewer` and `archive`. For engine v2, use `POST /loop-runs/:runId/resume` instead. `recover` contains exact attempt IDs from `GET /loop-runs/:runId/recovery`; approval and answer controls use pending interrupt IDs. Node paths are display context, not recovery identities. The saved-execution panel and job header expose explicit per-attempt selection. Core's lease and Desktop's execution/mount claim jointly prevent competing writers. Resident human pauses keep their original settlement callback; restart recovery reconnects to the frozen delivery allocation and terminal outbox.

Desktop launches `node <Core>/dist/agent-runtime/cli.js` with structured argv (`--approve`, `--recover`, `--invalidate`, `--answer <text>` on resume) and consumes JSON lines for phase events (`workflow-event`), agent output (`agent-event`), verification output, trace spans (`span`: `{ traceId, spanId, name, stepId, attempt, visit, startedAt, endedAt, status, usage?, error? }`) and the terminal `runtime-result`. Spans are stored verbatim as job events for diagnostics and are not narrated in the log. `runtime status --compact` returns `state.traceId`, `pendingApproval`, `pendingQuestion` and per-step `{ status, visits }`. Desktop probes `runtime api` once per executable package content digest; `runtime validate --stdin` runs on every save. The job log shows phase transitions (`[runtime] step_started: developer`), live tool activity per role (`[developer] Read src/app.ts`, `[developer] Bash npm test`) and Core's own phase notes (architecture written, verification passed, review approved or corrections requested); the final JSON of architect and reviewer is not echoed. The narrated view (Relato) derives its milestones from the same events: each runtime phase, the tools used, correction loops and a stopped workflow with Core's structural reason. Accounting uses the invocation's new attempts, so resuming a completed phase does not bill its cumulative history twice. Status queries use `--compact`, are read-only and do not invoke providers; accumulated logs stay in Core's checkpoint instead of overflowing the process status response.

Provider invocation/cancellation supports native macOS processes and Windows executables/npm shims. Actual provider behavior still depends on the installed CLI version and capabilities. The offline tests cover fake CLI/ACP frames, Windows argv rules, a local HTTP coding fixture and real verification subprocesses; live provider smoke tests and Windows CI remain separate validation.

## Definition catalog compatibility (D0)

Desktop accepts optional `engineVersion`, `nodeKindsVersion`, `nodeKinds` and
`builtins` metadata from `runtime api`; malformed descriptors are protocol errors.
An empty catalog can use version 0. The integration contract target is 5.1;
engine/catalog/builtin metadata is informational and older supported Core
packages remain compatible. D0 does not enable definition execution.

`validateWorkflowDefinition` invokes `workflows validate --stdin` only when Core
advertises `workflowDefinitions: 1`. Core returns the canonical hash and graph or
structured node errors, including valid error responses with exit 1. Desktop
does not calculate a competing definition hash.

Compact v2 status normalizes `nextNodePath` to existing controls and accepts
metrics from the top-level response. Resume validates syntax first, then exact
membership in the run's step catalog. Role metrics use the frozen runtime config,
so later settings changes cannot add roles to an existing run. Legacy readers
remain the fallback when no catalog exists. Historical projections will gain the
authoritative graph catalog in D2; D0 does not infer one from metrics themselves.
V2 inspection is uncached because a legacy journal does not track SQLite/WAL
changes. C0 published-package pairing remains a separate release gate.

## Rollout and release pairing

The committed registry bundle lock and `CORE_BUNDLE_VERSION` currently pin **Core 6.0.0**, a previously published package. The inspected source pair is Core 6.0.1 with workflow identity 7 and role instructions 10; D0 keeps those identities intact. That pin does not incorporate these source changes. Source assembly is the supported development route until the paired Core runtime release is available.

A production release must:

1. Publish a reviewed Core package containing API 1, `dist/agent-runtime/` and its production dependencies.
2. Update `scripts/assemble-bundled-core.lock.json` and `CORE_BUNDLE_VERSION` together to that exact release, capturing the full dependency integrity closure.
3. Run Core package checks, Desktop compatibility/package checks and both macOS/Windows native validation before packaging the paired app.

Do not relabel an existing 6.0.0 bundle or copy only `dist/agent-runtime`: LangGraph and the complete runtime dependency closure are required. Source assembly writes `source-bundle.json` with the Core version, runtime API and lock hash for traceability; it does not publish Core or update the production registry lock.

Verify role outputs, delivery ownership and saved-run recovery before releasing the paired app. Implementation has no legacy fallback; profile v1 remains only for other workflows. Core's programmatic archive writes reviewed **complete specification replacements**; it does not merge partial OpenSpec delta snippets. Preserve unchanged requirements in the architect's output and inspect that behavior during the pilot.

See [Core runtime selection and recovery](core-runtime-updates.md) for the separate framework-update lifecycle and [the original evaluation](agent-runtime-framework-evaluation.md) for the architecture rationale.

The [implementation verification record](programmatic-agent-runtime-validation.md) lists the completed checks and outstanding release validation.

## Efficiency metrics

Core's additive runtime metrics v1 are passed from compact status to each saved run's optional `metrics` field. The contextual run panels and Jobs history render a collapsed **Usage and time** panel with reported cost, active execution/agent time, calls and token/cache totals, plus per-phase attempts, duration, provider calls and cost. All eight locales include the panel labels.

Older Core versions continue to work without the panel. The server validates numeric fields and legacy phase IDs, or the authoritative step and frozen-role catalogs of a v2 run, drops unsupported/malformed metrics and projects only the supported fields; it never forwards arbitrary transcripts from the metrics object. Missing billing is displayed as unavailable rather than zero. Cache tokens are already included in input tokens, and agent duration already includes native tool work. The panel does not estimate savings or measure implementation quality.

The paired `agent-runtime-efficiency` OpenSpec change in specrails-core documents verification ownership, efficient API tools and the measurement contract. Core exposes the same report through `runtime status` / `runtime-result`, so a fixed set of real tasks can be compared without a Desktop database migration.

## Diagnose before retrying

`GET /agent-runtime/runs/:runId/diagnosis` (MCP: `specrails_jobs runtime_diagnose`)
returns the original scope, historical completed steps, up to eight recent
failed/interrupted attempts, verification and acceptance reasons, and a recovery
recommendation. It performs no provider calls or mutations. Repeated matching
step/error pairs recommend repairing the precondition before retrying. A missing
history on an older retained Core is unknown, not zero failures.

MCP `runtime_evidence` accepts `evidenceId`, `section`, `sourceId`, `cursor` and
`limit` to inspect the actual evidence beyond its index. `canResume` only means
resume is available. Changed receipts can still cause verification and review
to repeat; no zero-cost promise is made. A succeeded run awaiting settlement
should use `runtime_settle`, preserving the existing implementation.

Paired Core now preserves OpenSpec's output when archive exits successfully
without creating its destination, and distinguishes that from multiple matching
destinations. Retrying a failed archive keeps valid verification/review receipts;
changed candidate files or environment still require fresh evidence. These Core
fixes require a newly bundled/released runtime; retained original runtimes are
not silently replaced or migrated. Diagnosis does not add arbitrary file-write
access: repairs without a supported scoped tool are reported as concrete manual
steps instead of being disguised as a reason to relaunch.

## Repair the original worktree

`specrails_recovery` calls `POST /agent-runtime/runs/:runId/recovery` with a
strict action-specific request. It never constructs a new context/worktree.

| Action | Inputs and permission | Result |
| --- | --- | --- |
| inspect | read | Original repository IDs, registered check definitions, recent attempts |
| list_files / read_file / diff | repositoryId + relative path; read | Bounded directory/line/diff output; read_file includes SHA-256 |
| history | optional offset; read | Latest attempts first, pages of 20 with nextOffset |
| patch | repositoryId, path, expectedHash, oldText, newText, operationId UUID, reason; write | One unique replacement in an existing file, atomic publication |
| check | kind openspec or verification; saved checkId for verification; operationId + reason; destructive | Real validation evidence, bounded output and durable outcome |

Patches are limited to 16 KiB fragments and files readable within 128 KiB.
Runtime/provider metadata, secret paths, frozen OpenSpec changes/config/archives,
agent instructions, traversal, symlinks and platform aliases are rejected. New
files, deletions and arbitrary commands are not supported. Explicit repository IDs
prevent cross-project resolution. Verification runs one registered command with a
45-second deadline; full acceptance remains the normal resume/settlement path.

Desktop blocks admission while project executions are active and reserves the
run/rail. Core takes the same cross-process lease as Resume. An interrupted write
requires `acknowledgeInterrupted` after inspecting partial changes. Completed or
archived runs cannot be patched or checked through recovery. Inspection remains
available. This is an application boundary, not an OS sandbox against unrelated
processes modifying the worktree concurrently.

Core stores at most 100 attempts in `recovery-history.json` beside the pipeline
state, separate from checkpoints. Each mutation has a write-ahead operation ID,
request fingerprint, cause, before/after hashes where relevant and final outcome.
Reuse the exact request/ID after transport uncertainty. A pending patch whose
after-hash is present is reconciled; other pending operations become interrupted
and are not rerun. Repeating a failed check on unchanged candidate code requires
a documented `changedPrecondition`; this records the operator's explanation, not
an independent proof that an external prerequisite changed.

Resume still enforces verification, review and acceptance. Scoped verification
uses Core's existing evidence/receipt store and cannot mark workflow phases done.
OpenSpec checks validate real files without copying or archiving them. Old retained
Core packages lacking `scopedRecovery` are not upgraded/migrated behind the run's
back: the tool returns a manual-repair limitation rather than recommending Relaunch.

### Definition cancellation after restart

`POST /loop-runs/:runId/cancel` accepts an optional stable `requestId`. A `202`
means the retained Core inbox acknowledged cancellation. The original resident
execution still owns its callback. For a restarted execution, Desktop observes
Core until its writer lease is inactive, then replays terminal events through
Loop Manager and reconnects the original isolated settlement. A completed result
that wins the race remains completed; cancellation never rewrites its verdict.

The observer stops on project shutdown and leaves Core's durable intent for
startup recovery. Unavailable status or a lease that remains active beyond the
bounded observation window records a `definition-control-error` event in the
original job. That diagnostic does not mark the job or delivery successful.
Recovery preserves repository mounts, frozen verification policy, accounting,
worktree ownership and the terminal outbox. Missing original isolated allocation
data blocks settlement instead of treating the execution as a standalone job.
For historical v2 multi-repository records, explicit recovery can reconstruct a
missing allocation snapshot when the original frozen manifest/context, worktree
ledger and delivery branch records agree, including the captured initial SHA and
never-commit exclusions. All repository legs restore atomically. Reconstruction
checks the original Git common directory, grants no automatic cleanup permission
and does not infer missing values from current checkouts or project settings.
Incomplete records and borrowed-PR continuations without their original contract
remain blocked with a recovery diagnostic.

### Lost fork acknowledgement

Once Desktop adopts a child, the parent remains immutable history. Restart does
not mark that historical parent as a new interrupted execution. Active-run counts,
workflow edit guards and repository execution references follow the child; a
completed child therefore does not leave its paused parent blocking edits forever.
The host crash fixture kills the settlement process between two repository legs,
reopens the real project database and replays startup reconciliation before retry.
It checks one commit and one provenance receipt per leg, cleared orphan claims,
verified delivery to review and unchanged parent database/journal state.

Core forks may include a stable `requestId`. The retained engine stores the exact
fork request and original receipt before publication. Desktop preserves a child
if acknowledgement or host metadata writing fails, and reuses that request ID to
finish missing frozen files. Existing files must match exactly. A conflicting
request or destination is rejected; the source and child Core databases are never
replaced by host cleanup. Older children without receipts cannot be adopted by a
new request.

### Workflow decision role

Factories and starters use `loop-decider` for evidence-based continuation. The
bridge binds this role only when the compiled definition declares it, after
effective provider/model overrides. Its default inherits the review engine with
`access: read`, `artifacts: none` and no OpenSpec skill. Explicit project engine
and prompt settings win; incompatible permission/skill settings fail before
execution. The generated descriptor and selection origin are frozen per run,
without modifying the project config. The config endpoint exposes available
workflow defaults separately for builder choices. Native implementation's
reviewer still requires its original OpenSpec workflow.

### Paired engine CI

The required `paired-core-engine` matrix builds the commit-pinned Core checkout
on Linux, macOS and Windows and exports both source-root variables. It checks
schema parity, four factories, custom-role read-only CLI arguments, durable
fork/control recovery, real host/Core crashes during read/write/human pauses or between nodes,
and two-repository settlement. Crash acceptance retains production lease TTLs,
requires exact write-attempt recovery and verifies frozen configuration plus
idempotent physical-call accounting. Transport fixtures make no
paid provider calls. Review and advance the Core pin with paired changes; ordinary
coverage lanes may omit optional source fixtures, but the required matrix cannot.

### Inspecting released workflow mounts

Definition recovery can inspect an existing retained Core journal after its
original repository mount disappears. This uses the read-only `status --run-dir`
operation against the original owned journal, rejects redirected journal paths,
and does not recreate a worktree or replace frozen paths with current settings.
Status retains Core's recorded completion or pause and reports
`runtime_scope_unavailable`; resume remains disabled until the original scope is
available and validated. Inspection alone does not authorize delivery settlement.

### Per-piece invocation limits

With a Core catalog that exposes them, `prompt`, `role-turn` and `decider` accept
`timeoutMs` and `idleTimeoutMs` in their parameter forms. An explicit `0` disables
that invocation timer; removing the optional field restores the inherited
default. Workflow duration/cost/token budgets and cancellation still apply.
Role repair and session fallback retain the selected bounds, including Kimi ACP
transport. A verification prompt reporting `LOOP_BLOCKED` pauses for the human
answer before its success sentinel can be accepted.

## Loop-owned workflows

New Desktop recipes on Core with `implementationSteps: 1` own their graph and
agent definitions. Project settings retain verification commands. See
[workflow ownership, migration and frozen recovery](desktop-owned-workflows.md).
Historical project role fields remain readable for legacy runs and explicit import.
