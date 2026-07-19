# Using Kimi Code with Specrails Desktop

Kimi Code is a first-class, independent provider in Specrails Desktop. Desktop
launches the external `kimi` CLI directly; it does not bundle a Kimi runtime,
start `kimi server`, invoke `kimi acp`, or install a persistent service.

## Requirements

- Specrails Desktop with Kimi provider support.
- `specrails-core` 4.12.0 or newer with the `.kimi-code` framework target.
- Kimi Code 0.27.0 or newer.
- A completed Kimi login or a valid user-managed Kimi model configuration.

Install Kimi from its official documentation:

```bash
# macOS / Linux
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
kimi login
```

```powershell
# Windows PowerShell
irm https://code.kimi.com/kimi-code/install.ps1 | iex
kimi login
```

The official npm package (`@moonshot-ai/kimi-code`) is also supported, but its
current CLI requires Node.js 22.19 or newer. On Windows, Kimi also requires Git
for Windows because it uses Git Bash; set `KIMI_SHELL_PATH` when `bash.exe`
lives outside the standard locations. Specrails never installs any of these
dependencies for you.

Restart Desktop after changing `PATH`. Setup checks `kimi --version` without
sending a model prompt. Kimi 0.27 does not provide a non-billing command that
conclusively proves OAuth readiness, so the first real request may still ask
you to run `kimi login`.

### Windows prompt transport

Desktop never invokes a Kimi command shim through `cmd.exe`. For the standard
npm `kimi.cmd`/`kimi.bat`, it launches the package's JavaScript entry with Node
and carries the complete materialized prompt over `stdin`; multiline text,
Unicode, and long SpecRails workflows therefore do not consume the Win32
command-line budget.

A native `kimi.exe` is launched directly with no shell and works for prompts
whose complete command line is at most 30,000 UTF-16 code units. Kimi 0.27 has
no equivalent stdin or response-file option for that native executable, so
Desktop rejects a larger native invocation before spawn instead of truncating
the workflow. Install the official npm package
(`npm install -g @moonshot-ai/kimi-code`, Node.js 22.19+) when complete long
workflows are required on Windows. No Kimi server is involved in either path.

## Add or build a project

Kimi appears in Add Project and Project Builder when the executable is
available. Selecting it asks Core to materialize:

```text
.kimi-code/
├── AGENTS.md
├── mcp.json
├── rules/
└── skills/
    ├── specrails-*/SKILL.md
    ├── openspec-*/SKILL.md
    └── sr-*/SKILL.md
```

Kimi scans directory-form skills as direct children of the skills root.
SpecRails therefore keeps roles at `skills/sr-*/SKILL.md` rather than in a
nested catalog that the stable engine would not discover.

In a multi-provider project, Kimi is an independent engine choice on
capability-compatible chat, rail, loop, profile, integration, and terminal
surfaces. Switching to it does not rewrite a Claude, Codex, or Gemini tree.
Provider membership is fixed when the project is created; re-register the
project to choose a different set.

## Models and effort

Desktop stores Kimi's public model ids:

| Model id | UI label |
|----------|----------|
| `k3` | Kimi K3 |
| `kimi-for-coding` | Kimi for Coding |
| `kimi-for-coding-highspeed` | Kimi for Coding Highspeed |

At the CLI boundary only, those three ids map to managed aliases such as
`kimi-code/k3`. Already-prefixed and custom aliases pass through unchanged.

K3 offers `low`, `high`, and `max` reasoning effort. Those controls are shown
only when the effective model is `k3` or `kimi-code/k3`; the two
`kimi-for-coding` models and custom aliases do not inherit K3 effort. Desktop
defaults K3 to its upstream `high` setting and applies a valid selection to one
child process through
`KIMI_MODEL_THINKING_EFFORT` and removes inherited effort otherwise,
preventing cross-provider or cross-model leakage.

Every Desktop-managed spawn also removes `KIMI_CODE_EXPERIMENTAL_FLAG` from
the child environment. The integration is qualified against Kimi Code 0.27's
stable v1 engine and JSONL contract; a user-level opt-in to the experimental v2
engine must not silently switch Desktop to a different, unqualified runtime.
It also forces `KIMI_DISABLE_CRON=1`: prompt mode auto-approves tools, while
Desktop has no scheduler lifecycle or UI for Kimi's persistent `CronCreate`
facility, so an owned child must not leave scheduled work behind. Background
task drain/steer behavior inside the live child is unchanged. Finally,
`KIMI_CODE_NO_AUTO_UPDATE=1` disables Kimi's startup update preflight so a job
runs the external version that passed Desktop's compatibility check instead of
self-updating mid-invocation. All three controls replace inherited keys
case-insensitively.

## Execution and resume

A new Kimi turn uses:

```bash
kimi -m kimi-code/k3 \
  -p "<ordinary prompt or Desktop-materialized Kimi skill prompt>" \
  --output-format stream-json
```

A subtle but load-bearing distinction applies here. Kimi's interactive TUI and
ACP client intercept `/skill:<name>` and call the skill-activation API, but the
0.27 print runner sends `-p` text directly to `session.prompt()`. Desktop
therefore never relies on a literal `/skill:…` surviving into `-p`. It resolves
the direct-child `SKILL.md`, substitutes Kimi's argument placeholders, adds the
same `<kimi-skill-loaded>` envelope used by upstream activation, and then
passes that materialized prompt to the external CLI. Missing or unsafe skill
paths fail before process creation instead of becoming a zero-work success.
The prompt seen by the model matches Kimi's activation format; because print
mode itself still receives an ordinary user prompt, Kimi does not emit its
internal `skill.activated`/`skill_invoked` telemetry for this host-side
materialization. Desktop does not depend on those private events.

On a resume, `${KIMI_SESSION_ID}` can be expanded from the known session value.
On a fresh print session Kimi creates the ID internally and reveals it only in
the terminal resume hint, so Desktop rejects a skill that requires that
placeholder instead of substituting a false value. SpecRails' generated
workflow and role skills do not use that placeholder.

A known session resumes with the bound `--session=<session-id>` form so even an
option-shaped value cannot become a new CLI flag. Desktop accepts only Kimi's
upstream-safe session alphabet (`A-Z`, `a-z`, digits, `.`, `_`, `-`), rejects
`.`/`..` and ids longer than 128 characters at both JSONL parsing and argv
construction, and trusts an id only after Kimi emits the terminal
`session.resume_hint`; it never invents one from process ids or local paths.

Kimi can put assistant text and several function calls in one JSONL record.
Desktop expands that record into every corresponding UI event, so text,
activity chips, errors, and session state are not dropped. Unknown future
events remain diagnostic records instead of crashing the stream.

Cancel, Stop, app shutdown, and project removal terminate the owned process
tree. There is no server lifecycle to manage.

Kimi Code does ship optional `kimi acp` and `kimi server` entry points. This
integration deliberately uses the documented `-p` non-interactive contract:
it already runs tools agentically under Kimi's automatic prompt-mode policy,
maps cleanly to Desktop's owned-child lifecycle, and avoids installing a
service, opening a local port, or retaining an extra daemon. “No server
lifecycle” means Specrails starts and owns no Kimi server; it does not mean the
upstream CLI lacks that optional subcommand.

## Feature coverage

The important distinction is not “chat versus command”; it is whether a
surface deliberately launches an **autonomous agent** or requires a
**pure-output/read-only transform**. `kimi -p` is agentic and automatically
approves tool use. Desktop therefore enables Kimi where that posture is part
of the feature, and fails closed where the feature contract promises no tools
or read-only behavior.

### Available with Kimi

| Surface | Kimi behavior |
|---|---|
| Project Chat and Agent Chat | Text, tools, errors, cancellation, session resume, attachments, and proposals use a fresh owned `kimi -p` process per turn. |
| Explore | Conversation and proposal/draft work are available under Kimi's autonomous prompt-mode policy. It is not a filesystem sandbox. |
| Quick Launcher | Agentic commands such as `/opsx:ff` are available. This is distinct from the pure-output **Quick Spec** form. |
| Rails | Implement, Batch, Freestyle, retry/rerun, worktree isolation, cancellation, and ask-first PR delivery use Core's Kimi skills. |
| Loops | Built-in and custom loops are available when the graph has no **Loop Decider**. AI and shell steps keep their normal agentic semantics. |
| Project Builder delivery | Selecting Kimi as a target project provider and launching an already committed milestone through its Batch rail are available. Blueprint and milestone generation are not. |
| Profiles and roles | Provider-scoped profiles, exact Kimi models, per-role routing, and manual `custom-*` role creation/editing/execution are available. |
| MCP and integrations | Project `.kimi-code/mcp.json`, the Desktop bridge, provider-scoped plugins, and Serena are available through additive merges. |
| Terminal and attachments | The integrated terminal launches the external CLI. Text and validated image references are available; Kimi reads images with `ReadMediaFile`. |
| Analytics | Provider, model, duration, outcome, and session metadata are recorded. Unreported tokens and cost remain unavailable. |

### Unavailable and rejected before spawn

| Surface | Why it fails closed for Kimi |
|---|---|
| Quick Spec generation | Its structured output contract assumes a hard no-tools/read-only boundary that `kimi -p` cannot express. Use Explore or an agentic Quick Launcher command. |
| AI Edit / Continue Editing refine | This pure-output rewrite must not be allowed to mutate the workspace with tools. |
| Contract Refine | Requires an enforceable no-tools transform. |
| SMASH and Re-SMASH | Structured decomposition requires a safe tool boundary; Re-SMASH is also destructive, so existing children are never deleted before the capability check. |
| Project Builder blueprint and milestone generation | Day-0 blueprint snapshots and later detailed milestone batches are pure structured output. Kimi can still be a target provider and run a committed milestone rail. |
| Loop Decider | The `continue`/`stop` verdict must be a constrained pure-output decision. Kimi loops containing a Decider are rejected. |
| File summaries and construction-story AI | Code Explorer's generated summaries/story are read-only transforms. Existing deterministic/read-only explorer data remains usable. |
| AI auto-title | No Kimi process is spawned; Desktop uses its deterministic title fallback. |
| Agent Studio automation | Agent generation, smoke test, and AI Refine require the same boundary. Manual custom roles remain available. |

These are server-side capability gates, not cosmetic UI omissions. A direct
request that bypasses the hidden/disabled control is rejected before Kimi is
spawned and, for destructive operations, before any state mutation.

### Serena and provider-scoped plugin state

In a project with more than one AI provider, Integrations asks which provider
the Serena install targets. A Kimi install:

- merges `mcpServers.serena` into `<project>/.kimi-code/mcp.json`;
- contributes the managed Serena guidance block to
  `<project>/.kimi-code/AGENTS.md`;
- records Kimi independently under
  `<project>/.specrails/plugins/state.json`;
- verifies both `uv` and the Kimi MCP registration before committing; and
- is included only in Kimi rail snapshots.

Claude's `.mcp.json`/`CLAUDE.md`, Codex's isolated MCP registry plus root
`AGENTS.md`, and Kimi's `.kimi-code/mcp.json` plus
`.kimi-code/AGENTS.md` remain independent. Removing a provider's Serena
installation therefore removes only that provider's managed guidance and MCP
registration.

## Native differences from Claude

Application feature parity does not make unlike CLI protocols identical:

- Kimi has no persistent stdin transport. Interactive conversations resume by
  spawning a new `kimi -p` process with the recorded session id.
- Kimi stream JSON has no terminal token/cost result. Desktop records model,
  duration, status, and session, and leaves cost/tokens unavailable.
- Kimi has no dedicated image argv; Desktop validates the managed attachment
  path and includes explicit media-tool guidance in the prompt.
- Prompt mode runs under Kimi's autonomous permission behavior and cannot be
  combined with `--auto`, `--yolo`, or `--plan`.
- Kimi has no per-spawn hard `none`/read-only tool flag. Desktop therefore
  disables structured transforms that require a no-tools boundary instead of
  treating prompt wording as a security sandbox.
- Kimi loads its user-level MCP configuration according to Kimi's own rules.
  Because Desktop cannot isolate that source per spawn, the user-MCP opt-in
  control stays unavailable for Kimi; project `.kimi-code/mcp.json` remains
  supported.

## MCP

Desktop merges its project bridge and integrations into
`.kimi-code/mcp.json`. Existing server definitions are preserved. Invalid JSON
fails safely instead of being replaced, and credentials are never copied into
the project by the provider adapter.

## Troubleshooting

### Kimi is missing from the provider picker

Run `kimi --version` in a fresh terminal, then restart Desktop. On Windows,
confirm `where kimi` resolves `kimi.cmd`.

### The CLI is too old

Upgrade Kimi using its official installer. Desktop requires 0.27.0 or newer
because its prompt-mode stream and session contract is the tested baseline.

### Login or model alias error

Run `kimi login`. Managed login creates aliases under `kimi-code/`. If you use
a custom provider, make sure the exact alias stored in the profile exists in
your `~/.kimi-code/config.toml`.

### A Kimi project is missing skills

Update Core/framework from Setup. OpenSpec 1.4.1 writes Kimi skills to a legacy
`.kimi/skills` path; Core normalizes recognized `openspec-*` directories into
`.kimi-code/skills` while preserving unknown and user-owned files.

### A control is disabled for Kimi

Check the [feature coverage matrix](#feature-coverage). Quick Spec, AI Edit,
structured decomposition/refinement, blueprint/milestone generation, Loop
Decider, Code Explorer AI transforms, AI auto-title, and Agent Studio
automation deliberately do not spawn Kimi 0.27. This is a safety boundary, not
an installation or authentication error.

## References

- [Kimi Code documentation](https://www.kimi.com/code/docs/en/)
- [Kimi Code getting started](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started)
- [Kimi Code environment variables](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/env-vars.html)
