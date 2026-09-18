# Local AI engines (OpenAI-compatible endpoints)

Specrails Desktop can run on models you host yourself — Ollama, llama.cpp,
LM Studio, vLLM, LocalAI, or any server that speaks the OpenAI
`/v1/chat/completions` API. A configured endpoint is a **first-class AI
engine**: it appears in every engine selector (rail header, Add Spec Quick /
Explore, sidebar chat, agent missions) exactly like Claude, Codex, Gemini or
Kimi, and rails run their Architect → Developer → Reviewer pipeline on it.

## Add a connection

1. Open **Settings ▸ Specrails Agents ▸ Provider connections**.
2. **Add local engine**. Give it an id (`local`, `lan-box`, …), the base URL
   (`http://127.0.0.1:11434/v1`, `http://192.168.1.20:8080/v1`), and — when the
   server needs a key — the **name of the environment variable** that holds it
   (for example `LOCAL_OLLAMA_API_KEY`). The key itself is never stored by
   Specrails; it is read from the app process environment at spawn time.
3. **Test connection**. Specrails calls `GET <baseUrl>/models`, shows the
   reachability pill and lists the discovered models. Pick a default model.
4. **Save**. The engine is registered immediately: open a rail header or Add
   Spec and it is selectable without a restart.

Optional per connection:

- **Rates** (USD per 1M input / output tokens). Without rates, cost is reported
  as *unknown* — never `$0`. With rates the cost badge shows an **estimate**.
- **Reasoning effort**: only switch it on when the server accepts the OpenAI
  `reasoning_effort` request field (Ollama with reasoning models, vLLM, LM
  Studio). When on, every call carries the role's configured effort, and the
  Compact architect raises it to `high` while writing the plan — models that
  "think privately and answer tersely" plan far better that way. Off ⇒ the
  field is never sent.

### The API key comes from the environment

`apiKeyEnv` names a variable that must exist in the process that runs the
Desktop server. When you launch the app from Finder/Dock or the Windows Start
menu, shell-only exports (`~/.zshrc`) are **not** inherited. The connection card
warns with *"not set in the app process"* when that is the case. Fixes: set it
system-wide (`launchctl setenv`, Windows user environment variables), or
launch the app from a terminal that has it. Local servers that need no key work
without any of this.

## What runs where

| Surface | How the local engine executes |
|---|---|
| Rails: implement / batch / custom loops | specrails-core's programmatic runtime, all three roles on the connection (`OpenAICompatibleExecutor`) |
| Rails: freestyle, verify / fix / decider steps, loop ai-steps | the bundled **local agent runner** |
| Add Spec Quick + Explore, sidebar chat | the local agent runner (read-only tool set for Explore) |
| Agent chat / missions | the local agent runner with the Specrails MCP bridge + your enabled external MCP servers |
| Project Builder (day-0 blueprint chat) | the local agent runner in pure-output mode (no tools); expect a capable model — the blueprint contract is strict |

### Local-only machines

Nothing has to be selected by hand. Provider availability is a machine
property: every surface offers the engines the app can actually run, and the
default follows the same rule everywhere — a detected CLI in the fixed order
(Claude → Codex → Gemini → Kimi), else the first reachable local engine.

- Project surfaces (rails, Add Spec, sidebar chat) already derive the
  project's primary from the detected set, so with one local engine the
  selectors stay hidden and everything runs on it.
- **Agent missions and the Project Builder** start a fresh conversation on that
  same machine default (server `defaultMachineProvider`, client
  `preferredProvider`), so a local-only machine composes on its local engine
  instead of an uninstalled Claude. Existing conversations keep the provider
  they were created on — the selector still lets you switch.
- A local engine counts as *available* only while its endpoint answers the
  bounded `GET /models` probe. `/api/available-providers` (the gate the Agent
  composer and the Builder read) reports local ids from that probe, never from
  the PATH lookup of the bundled node that runs them — an endpoint that is
  down leaves the engine out of the list instead of failing the first turn.
- Selectors show the connection's **label** (or its id when unlabeled).

The runner is a small process shipped inside the app (`specrails-local-runner`)
that performs the streaming tool loop (Read / Grep / Glob / Bash / Write / Edit),
keeps resumable sessions under `~/.specrails/local-runner/sessions/`, and
speaks the same event stream the Claude CLI does, so every Desktop surface
treats it like one more CLI. Details: `docs/internals/local-agent-runner.md`.

## Quick setup for small models

Each local connection card has a **Recommended for small models** button. One
click sets the Compact agent loop, forwards the reasoning effort and a 32k
context window (a larger configured window is kept) — the combination
validated with 7–14B models. Every field stays editable afterwards. When the
effort switch is off, the card notes that the rail header hides the effort
selector for that engine.

## Agent loop: Compact vs Free

Each local connection has an **Agent loop** setting that decides how the
implement pipeline drives the model:

- **Compact** (default). The host drives the Architect as a short sequence of
  structured calls — inventory → proposal → design → specs → tasks — each with
  a tiny tool set (or none) and a JSON schema answer; the host renders the
  OpenSpec artifacts from that JSON. The Developer runs one bounded mini-loop
  per task with a tool-call budget; the Reviewer answers the review schema
  directly. Old tool results are compacted before the context window fills.
  Fewer, shorter model calls; works with 7–14B models.
- **Free.** One agentic loop per role, exactly like a CLI provider. Needs a
  ~30B+ model with reliable tool calling. Guardrails (repetition detection,
  argument repair, empty-reply nudge, context compaction) apply here too.

Planning steps (proposal, design, specs, tasks, review) are sent with generic
OpenAI generation controls — `temperature 0.2` and a wide `max_tokens` — so any
small model answers literally and is never truncated; developer tool turns keep
the server defaults. Specrails also checks the plan itself: every requirement of
the spec must be covered by a task, tasks must be sentences of work (not file
names) in at least two groups, and nothing may target the frozen `openspec/`
folder; a plan that fails is sent back once with the exact reason. None of this
names a model: it is the host validating results, so it holds for any server.

Set **Context window (tokens)** to the server's real context size
(`n_ctx` / `num_ctx`, default 32768) so compaction triggers before the server
rejects the request. Both fields are sent to specrails-core only when the paired
core supports them (`capabilities.compactAgentLoop`); older cores never see them.

## Hybrid setups: one engine per role

You do not have to run everything on one model. Each role can have its own engine — cloud or local, mixed freely — and the rail launches with the **Roles** engine to use them:

| Role | Where it runs | Configure in |
|---|---|---|
| Architect | Core runtime | Settings ▸ Specrails Agents ▸ runtime (per-role provider + model + effort) |
| Developer | Core runtime | same |
| Reviewer | Core runtime | same |
| Fixer (correction rounds after a failed verification or a rejected review) | Core runtime | same — **Inherit developer** by default, or its own engine |
| Verifier (verify / fix and any custom loop ai-step) | the loop | Settings ▸ Specrails Agents ▸ **Loop roles** |
| Decider (the Loop Decider) | the loop | same |

A sensible split for a local setup: **architect on a cloud model** (judgement and planning), **developer on the local coder** (volume), **fixer on a stronger model** (repairs are few and precise — this is where a cloud model pays off most), **reviewer on a cloud model**, **verifier local**, **decider on the cheapest fast model you have**.

The correction loop is verification ⇄ fixer: the host runs your test command, a failure goes to the fixer with the exact output and the offending lines already read, and only a green verification reaches the reviewer. A rejected review also goes to the fixer.

How it works:

- In the rail header pick **Roles** as the engine. The rail hides its model/effort/profile selectors (they belong to each role now) and shows a *Roles* chip.
- The launch carries no provider override, so Core keeps the per-role runtime settings. The loop's own steps use the verifier role; the Loop Decider uses the decider role.
- A loop role that is not set inherits the project's primary engine. A role whose provider is not detected any more falls back to the primary engine instead of blocking the launch; a stale model falls back to the provider's default; an effort the engine cannot honour is dropped.
- Freestyle has no roles — it is one autonomous agent — so a Roles rail cannot launch in freestyle mode (`400 roles_engine_unsupported_mode`).
- REST: `GET/PUT /api/projects/<id>/agent-runtime/loop-roles` with `{ roles: { verifier?: { provider, model?, effort? }, decider?: {…} } }`. Stored in `<workspace>/.specrails/loop-role-engines.json`. MCP: `specrails_rails(set_engine, aiEngine: "roles")` / `launch(aiEngine: "roles")`.

## Guardrails (tuning the process)

The compact loop wraps a local model in process rules so a small model does not derail: a validated plan, frozen planning artifacts, one test file per module, evidence before a task is ticked, a host that repairs the environment, a silence timeout that stops hanging tests, a per-group check (the repository's test command runs after every task group and a failure is fixed in place before moving on — a lightweight TDD loop), and more. They are all **on by default** and listed in **Project settings ▸ Agent engine ▸ Guardrails**, grouped by phase (architect · developer · host), each with what it does and why it exists. Switch one off only to tune the process for an experiment; the setting is per project and persists as `guardrails: { "<id>": false }` in the project's `agent-runtime.json`. CLI providers are never affected. Pure correctness fixes are not listed — they cannot be switched off.

## Which models work

The wiring is model-agnostic; quality is not. The pipeline relies on **reliable
tool calling** and long-context instruction following:

- Recommended: tool-calling-tuned coder models ≥ 30B (Qwen3-Coder, Devstral,
  GLM-4.x-class, DeepSeek-Coder-V2/V3 quantised) on a server that advertises
  `tools` support.
- Usable for chat / Explore / Quick spec: 7–14B instruct models.
- Not recommended for rails: models without native tool calling (they emit
  malformed calls the runner has to bounce back).

Start with **Freestyle** or an Explore session before trusting a full implement
rail to a new model.

## Capability matrix

| Capability | Local engine |
|---|---|
| Rails, freestyle, loops, chat, Explore, Quick spec, missions | ✅ |
| Persistent multi-turn (interactive jobs, Explore fast path) | ✅ |
| Resume by session id | ✅ |
| Read-only / no-tools boundaries (Explore, deciders) | ✅ native runner policies |
| MCP servers in missions | ✅ (`--mcp-config`, tools as `mcp__<server>__<tool>`) |
| Agent profiles / custom roles / Agent Studio AI | ❌ |
| SMASH, Contract Layer, Project Builder generation | ❌ (need structured-action guarantees) |
| Native cost | ❌ — unknown unless you set rates |
| OTEL pipeline telemetry | ❌ |
| Images / attachments | ❌ |

## Analytics

Every invocation records `provider = <connection id>`, the raw model id, and
real token counts from the server's `usage` block. Cost is `NULL` (rendered as
*cost unknown (local engine)*) unless rates are configured, in which case it is
flagged **estimated**. The engine filter on the Analytics page lists local
engines once they have rows.

## Kill switch

`SPECRAILS_LOCAL_ENGINES=false` (or `0`/`off`) disables the feature: no adapter
is registered, connections are not probed, engine selectors show CLIs only, and
the runner is never spawned. Connections stay editable and remain valid as
per-role providers of the programmatic runtime. `VITE_FEATURE_LOCAL_ENGINES=false`
hides the test / models UI of the connection card.

## Troubleshooting

- **Engine missing from selectors** — the last probe failed. Test the
  connection; probes run every 60 s and are bounded at 3 s.
- **`401` / "not authorized" pill** — the key env var is unset in the app
  process or wrong. See *The API key comes from the environment*.
- **Rail fails with `Unknown command: /specrails:implement`** — the project
  workspace has no command files for the runner to read; re-run Add Project
  assembly (Settings ▸ Projects) so the framework surface is materialised.
- **Mission / chat turn fails with `exceeds the available context size`** — the
  server's context window is too small for the agent surfaces. A mission turn
  carries the operator prompt plus the Specrails MCP tool schemas (≈ 20–30k
  tokens before the model says a word); Explore/Quick specs need less. Raise
  the window on the server: Ollama `OLLAMA_CONTEXT_LENGTH=65536` (or `num_ctx`
  in the Modelfile), llama.cpp `-c 65536`, LM Studio *Context Length*. 64k+
  is the comfortable floor for missions; 32k works for chat and Explore.
- **Turn ends with a context-length error** — the runner evicts old tool
  results and retries once; a second failure surfaces the server message. Use
  a larger context window or a smaller spec.
- **Cost shows `—`** — expected without rates. Configure rates for an estimate.
