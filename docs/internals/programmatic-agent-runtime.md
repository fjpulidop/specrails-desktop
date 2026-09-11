# Programmatic agent runtime

Desktop can hand implementation to Core's **runtime API 1**. Core runs architect, developer, deterministic verification, reviewer and archive as separate LangGraph phases. Desktop keeps project/worktree selection, rail lifecycle, logs, accounting and delivery ownership.

This is an opt-in path in the current source tree. It applies to implementation rail steps and their Core completion check. Mission chat and unrelated AI features keep their existing transports. Provider-native implementation prompts and skills are not invoked inside the programmatic phases.

## Build the paired source

Use Node **20.19.0+** for Core; Node **22.22.3** matches Desktop's native CI runtime. Provider requirements can be higher. Both repositories' dependencies must be installed.

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

This runs the compiled Desktop bridge and real bundled Core against a temporary localhost model fixture. It checks tool writes, a real verification subprocess, archive approval, resume, usage and host Git ownership. It uses a temporary repository and deletes it afterward. Pass `--core /absolute/path/to/Core/dist/agent-runtime/index.js` to exercise another built Core checkout.

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

## Enable a project

1. Open **Project settings → Agent runtime** (its own section in the project dialog).
2. Choose a provider per role. The model dropdown lists each CLI's catalog with the default marked; turns, attempts and timeout show their defaults in the fields. Claude, Codex, Gemini and Kimi remain available; open **Show provider connections** to add an OpenAI-compatible endpoint for a local or remote model (local endpoints do not require a key; API providers need an explicit model).
3. Verification commands are optional. A project that never saved runtime settings is prefilled with the checks Desktop detects offline (`package.json` test/type-check/lint scripts with the right package manager, Cargo, Go, pytest, Gradle, Maven, .NET, Make); **Detect project checks** re-runs that detection. Each row is a repository plus one command line (`npm run test -- --strict`; quotes group arguments). Leave the list empty and the architect proposes the project's own checks on each run; repositories with no automated check are still reviewed and recorded as unverified in Core's receipt.
4. Enable the runtime and save.
5. Start an implementation through the normal rail flow.

Settings are saved at `<project execution .specrails directory>/agent-runtime.json`. Missing or disabled configuration preserves legacy execution. Malformed configuration blocks admission with an error; it is not ignored. Enabling also verifies that Core exposes the expected API.

Core owns role instructions and permissions. The developer role edits and runs commands inside its CLI sandbox (the same autonomy as the legacy Implement step); architect and reviewer are read-only. A legacy rail profile/model selection does not override the runtime's per-role provider configuration. The JSON schema is [server/schemas/agent-runtime.schema.json](../../server/schemas/agent-runtime.schema.json), mirrored from Core. For a complete configuration, custom executor examples, Kimi capabilities and API tooling details, see [Core's runtime guide](https://github.com/fjpulidop/specrails-core/blob/main/docs/agent-runtime.md) in the paired revision.

The built-in Claude adapter supports its native dollar cap. Built-in Codex, Gemini, Kimi and OpenAI-compatible adapters reject `maxCostUsd`; remove that limit for mixed-provider/local runs. Kimi also rejects token caps because its usage is unavailable. Unknown cost/tokens remain unknown in accounting, rather than becoming zero. Attempt, timeout and tool limits remain available. Existing provider services, licenses and inference costs are separate from the free open-source orchestration runtime.

Gemini architect/reviewer roles require native `--admin-policy` support. Core applies a temporary read-only tool allowlist that remains effective if user settings disable plan mode. If system policies prevent per-run enforcement, Core rejects that role with an actionable capability error; it does not replace managed policies. The developer role retains its normal editing transport.

## State, approvals and continuation

The rail creates a frozen Core execution context for its original repository/worktree paths. State is kept below the project's execution `.specrails/pipeline/<runId>/` directory:

| File | Purpose |
| --- | --- |
| `desktop-context.json` | Selected repositories, original worktrees, frozen scope and ownership |
| `desktop-runtime-host.json` | Allowlisted host settings needed to reconstruct execution |
| `agent-runtime-request.json` | Core's frozen configuration and change name |
| `state.json`, `receipts/` | Core gates and verification receipts |
| `agent-workflow/<runId>/checkpoint.json` | Durable phases, attempts, approvals and usage |

**Agent runtime → Saved executions** lists recent runs and exposes available resume, archive approval, interrupted-step recovery and continuation cancellation actions. A continuation resumes from the phase shown, in the original worktree, and writes its progress into that job's log (a `[runtime] continuation started from phase …` banner, tool activity, phase notes and the final outcome). Resuming a run that stopped at the developer attempt limit grants a fresh attempt budget. Wait for the original rail execution to settle before resuming. Active rail jobs are stopped through their job controls; the continuation's Cancel action owns only continuations started from this panel.

Resume retains valid completed phases and rechecks Core evidence. Changed code or environment requires fresh verification/review. An ambiguous interrupted write requires an explicit recovery action after inspecting partial changes. A changed frozen config/identity requires a new run. Missing original worktrees or mismatched execution manifests block recovery; the controller never invents a replacement worktree.

**A continuation completes Core's work in the original worktree; it does not restart the former rail's delivery phase, create a PR, or mark backlog delivery complete.** Inspect the resulting worktree and deliver through an explicit host/Git operation. This also applies when approval is granted after the original rail has settled. Core archive success is not a claim that a PR was created. The initial uninterrupted successful rail retains its normal host delivery flow.

Disabling project runtime settings affects future admission. Existing runs retain their frozen runtime request and remain available for explicit continuation; they do not switch back to a platform prompt.

## API and logs

All routes are under `/api/projects/:projectId`:

| Method/path | Result |
| --- | --- |
| `GET /agent-runtime/config` | Saved/default config and runtime availability |
| `PUT /agent-runtime/config` | Validate and atomically save configuration |
| `GET /agent-runtime/runs` | Recent run status, pending approval, recoverable phases and available controls |
| `POST /agent-runtime/runs/:runId/resume` | Accept `{}`, `{ "approve": ["archive"] }`, `{ "recover": ["developer"] }` or explicit `invalidate` phase IDs |
| `POST /agent-runtime/runs/:runId/cancel` | Cancel a continuation owned by this controller |

Resume responds `202` after admission and continues asynchronously. The valid phase IDs are `architect`, `developer`, `verify`, `reviewer` and `archive`. Core's lease remains the cross-process concurrency guard. A run cannot be resumed while its original Desktop execution is active.

Desktop launches `node <Core>/dist/agent-runtime/cli.js` with structured argv and consumes JSON lines for phase events, agent output, verification output and the terminal result. The job log shows phase transitions (`[runtime] step_started: developer`), live tool activity per role (`[developer] Read src/app.ts`, `[developer] Bash npm test`) and Core's own phase notes (architecture written, verification passed, review approved or corrections requested); the final JSON of architect and reviewer is not echoed. The narrated view (Relato) derives its milestones from the same events: each runtime phase, the tools used, correction loops and a stopped workflow with Core's structural reason. Accounting uses the invocation's new attempts, so resuming a completed phase does not bill its cumulative history twice. Status queries use `--compact`, are read-only and do not invoke providers; accumulated logs stay in Core's checkpoint instead of overflowing the process status response.

Provider invocation/cancellation supports native macOS processes and Windows executables/npm shims. Actual provider behavior still depends on the installed CLI version and capabilities. The offline tests cover fake CLI/ACP frames, Windows argv rules, a local HTTP coding fixture and real verification subprocesses; live provider smoke tests and Windows CI remain separate validation.

## Rollout and release pairing

The committed registry bundle lock and `CORE_BUNDLE_VERSION` currently pin **Core 5.1.1**, a previously published package. That pin does not incorporate these source changes. Source assembly is the supported development route until the paired Core runtime release is available.

A production release must:

1. Publish a reviewed Core package containing API 1, `dist/agent-runtime/` and its production dependencies.
2. Update `scripts/assemble-bundled-core.lock.json` and `CORE_BUNDLE_VERSION` together to that exact release, capturing the full dependency integrity closure.
3. Run Core package checks, Desktop compatibility/package checks and both macOS/Windows native validation before packaging the paired app.

Do not relabel an old 5.1.1 bundle or copy only `dist/agent-runtime`: LangGraph and the complete runtime dependency closure are required. Source assembly writes `source-bundle.json` with the Core version, runtime API and lock hash for traceability; it does not publish Core or update the production registry lock.

Enable one project first, verify role outputs and delivery ownership, exercise approval/recovery, then expand. Existing legacy workflows and profile v1 remain supported during this rollout. Core's programmatic archive writes reviewed **complete specification replacements**; it does not merge partial OpenSpec delta snippets. Preserve unchanged requirements in the architect's output and inspect that behavior during the pilot.

See [Core runtime selection and recovery](core-runtime-updates.md) for the separate framework-update lifecycle and [the original evaluation](agent-runtime-framework-evaluation.md) for the architecture rationale.

The [implementation verification record](programmatic-agent-runtime-validation.md) lists the completed checks and outstanding release validation.
