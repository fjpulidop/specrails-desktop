# Using Specrails with the Gemini CLI

Specrails supports **three AI providers**: Anthropic's
[Claude Code](https://claude.com/claude-code), OpenAI's
[Codex CLI](https://developers.openai.com/codex), and Google's
[Gemini CLI](https://github.com/google-gemini/gemini-cli). You pick one,
two, or all three when you add a project, and the rest of the app behaves
the same across them.

> **Gemini is enabled by default** (parity with Claude and Codex). It shows
> up in **Add Project** and is selectable whenever the `gemini` CLI is on
> your `PATH`. To disable it as an emergency rollback, set
> `SPECRAILS_GEMINI_BETA=0` in the app's environment — only the exact string
> `0` disables it; `1`, `true`, and unset all mean **enabled**. (Unlike
> Codex, there is no legacy `SPECRAILS_HUB_*` fallback name.)

**What works with Gemini:** Explore Spec, Quick spec, AI Edit, the terminal
"Open AI CLI" launcher, cost analytics, **and the full rails pipeline**
(`/specrails:implement`, `batch-implement`). The one exception is
**Freestyle rails**, which remain Claude-only.

## Prerequisites

| What | Why | How |
|---|---|---|
| `gemini` CLI ≥ 0.11.0 | Earlier versions lack `--output-format stream-json` + headless `--resume`, which the app relies on | `npm i -g @google/gemini-cli` · check with `gemini --version` |
| A Gemini API key | The app spawns Gemini headlessly, so it needs non-interactive auth | Set `GEMINI_API_KEY` to a paid Gemini Developer API key from [Google AI Studio](https://aistudio.google.com/apikey) |
| `specrails-core` ≥ 4.8.0 in the project | 4.8.0 ships the Gemini provider target (`.gemini/` commands + agents) that the rails pipeline needs | The Add-Project install flow uses `specrails-core@^4.8.0` automatically |
| `git`, `node`, `npm`, `npx` | Same as Claude — needed for `specrails-core init` | Use your usual installer |

> **Two different minimums.** The `gemini` **binary** floor is **0.11.0**.
> The `specrails-core` **package** floor is **4.8.0** (a single shared
> version for all providers). They are separate things — the binary on your
> machine vs. the artifacts installed into the project.

**On the API key.** The free OAuth "Login with Google" tier exists, but it
is being wound down for the CLI and is not a reliable unattended path. Use a
real `GEMINI_API_KEY` so headless rails and Explore turns can authenticate
without a browser prompt. Free-tier keys serve the Flash models; Pro/preview
models need billing enabled.

The app's **Add Project** dialog runs a live prerequisites check. It disables
the Gemini provider checkbox with a "not found" hint when the binary isn't on
`PATH`, and shows install commands if you click "More info".

## Adding a Gemini project

1. Open the app UI and click **Add Project**.
2. Pick the project's path.
3. In the **AI providers** row, check **Gemini** (you can check Claude and/or
   Codex too — see [Running multiple providers in one
   project](#running-multiple-providers-in-one-project)). The first provider
   you select becomes the project default.
4. Submit. The app writes `.specrails/install-config.yaml` and spawns
   `npx --yes --prefer-online specrails-core@^4.8.0 init --yes --from-config <file>`.
   The install produces the `.gemini/` artifacts (commands + `sr-*` agents),
   plus a `GEMINI.md` instructions file.

The provider **set** you choose is **immutable after creation** — you can't
add or remove a provider on an existing project. Install everything you may
want up front.

## Using Gemini (per-spec and per-rail)

When more than one provider is installed, **per-invocation engine pickers**
let you choose which CLI runs each piece of work:

- **Per spec:** Dashboard → **+ Add Spec** → the engine selector at the top
  of the dialog → choose **Gemini**. The Explore/Quick session then runs on
  Gemini.
- **Per rail:** open a rail's header → the **engine selector** → choose
  **Gemini** → **Launch**. The rail job spawns `gemini` headlessly.
- **In the terminal:** the **Open AI CLI** (Sparkles) button → pick
  **Gemini** to launch an interactive `gemini` session in the project dir.

Your last-used engine is remembered per project (defaulting to the primary),
so you don't have to re-pick every time. On a single-provider Gemini project
these pickers don't render — there's nothing to choose.

## Running multiple providers in one project

A single project can install **Claude, Codex, and Gemini** in any
combination. In **Add Project** the **AI providers** control is a
multi-select; check the ones you want and the app runs each provider's
install sequentially. The first you select is the **primary/default**.

Once more than one is installed:

- **Engine pickers** (above) appear on Add Spec, the rail header, and the
  terminal launcher.
- **Capability intersection.** The right sidebar only shows sections that
  *every* installed provider supports. Because Gemini and Codex have no
  agent profiles, the **Agents** section is **hidden** on a mixed project.
  The **Integrations** section stays visible (it hosts the
  provider-agnostic Jira card); only the Serena **plugin** entry inside it
  is filtered per-provider. In the Add Spec dialog, the SMASH and Contract
  Layer options are hidden when the selected engine is Gemini.

When only one provider is installed the app behaves byte-identically to a
single-provider project — no engine pickers, no provider persisted on spawns.

## What's different vs Claude

| Capability | Claude | Codex | Gemini |
|---|---|---|---|
| **CLI / project dir** | `claude` / `.claude/` | `codex` / `.codex/` | `gemini` / `.gemini/` |
| **Instructions file** | `CLAUDE.md` | `AGENTS.md` | `GEMINI.md` |
| **Native cost report** | ✅ `total_cost_usd` | ❌ estimated | ❌ estimated |
| **Native OTEL** | ✅ | 🔧 synthesized by the app | ✅ native (no bridge) |
| **`--system-prompt` flag** | ✅ | ❌ folded into prompt | ❌ folded into prompt |
| **Rails pipeline** | ✅ | ✅ | ✅ |
| **Freestyle rails** | ✅ | ❌ Claude-only | ❌ Claude-only |
| **Agent profiles on rails** | ✅ | ❌ forced legacy | ❌ forced legacy |
| **SMASH / Contract Refine** | ✅ | ❌ Claude-only | ❌ Claude-only |
| **Plugins (Serena)** | ✅ | ❌ | ⚠️ offered, doesn't load (known gap) |

A few of these deserve a fuller explanation:

- **Cost is estimated, not native.** Gemini reports token counts (including
  cached) but no USD cost in its stream, so Specrails estimates the cost from
  a rate card (`server/pricing.ts`, keys `gemini:<model>`). Estimated rows
  show a `~` prefix on the Analytics page.
- **OTEL is native.** Like Claude, Gemini honours the standard `OTEL_*`
  telemetry env vars, so QueueManager injects the same telemetry env
  (`buildTelemetryEnv`) for Gemini rail spawns — no synthetic bridge (unlike
  Codex). There is no Gemini-specific OTEL env builder.
- **System prompt is folded.** Gemini has no `--system-prompt` flag, so for
  non-Explore actions the system prompt is folded into the user prompt.
  Explore turns stay user-only and trust the app-managed `GEMINI.md` in the
  explore cwd.
- **Agent profiles aren't selectable for Gemini rails.** The rails router
  forces the profile to `null` (legacy mode) for any non-Claude engine. (UI
  limitation: the rail header may still render a profile picker for a Gemini
  rail, but the server ignores the selection.)
- **Plugins are offered but don't actually load (known gap).** Gemini is
  declared a `project-json` MCP provider, so the Integrations page offers
  plugins such as **Serena** and installing one writes
  `<project>/.mcp.json` — but gemini-cli has **never read `.mcp.json`**
  (a Claude convention). Its only MCP surface is `mcpServers` in
  `settings.json` (`~/.gemini/` or `<cwd>/.gemini/`), so the plugin's MCP
  server silently never loads in Gemini rail spawns. Fixing this means
  writing into the repo's `.gemini/settings.json`, which conflicts with
  the keep-the-repo-pristine policy — it's a deliberate deferred change.
  (The desktop **Agent Chat** registers its own Specrails MCP for Gemini
  correctly, via `.gemini/settings.json` in the app-owned agent cwd plus
  `GEMINI_CLI_TRUST_WORKSPACE=true`; there Gemini sees the tools with an
  FQN prefix, `mcp_specrails_<name>`.) Details:
  [internals/gemini-mcp-registration.md](internals/gemini-mcp-registration.md).

## How rails work headlessly (`prepareHeadlessSpawn`)

Rails run `gemini -p` in headless mode. Gemini *discovers*
`<project>/.gemini/agents/*.md` but only *enables* a project's custom
subagents after an interactive "New Agents Discovered → Acknowledge and
Enable" prompt — which never fires in a headless spawn. Without
acknowledgment, `invoke_agent sr-architect` returns "Subagent not found" and
the pipeline silently falls back to a generic agent.

The Gemini adapter implements a unique `prepareHeadlessSpawn` hook
(`server/providers/gemini-agent-ack.ts`) that QueueManager calls right before
each Gemini rail spawn. It writes the acknowledgment file
(`~/.gemini/acknowledgments/agents.json`, keyed by project root, value =
sha256 of each agent's markdown) so the specialised `sr-architect` /
`sr-developer` / `sr-reviewer` personas load in headless mode. This is the
load-bearing mechanic that makes the rails pipeline actually work on Gemini.
It's best-effort and merged, so other projects and agents are never disturbed.

## Models

The curated catalog (`server/providers/gemini-adapter.ts`) is:

- **`gemini-3.5-flash`** — the default.
- `gemini-3.1-pro-preview`
- `gemini-3.1-flash-lite`
- `gemini-2.5-flash-lite`

Concrete GA ids are pinned (preview ids rotate). Free-tier API keys serve the
Flash models; Pro/preview need billing.

> A few older ids (`gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-3-flash-preview`)
> are **not** selectable models. They survive only as historic pricing rows in
> `server/pricing.ts` so that already-recorded invocations on those models still
> price correctly.

## Trusted folders (headless)

Gemini's "trusted folders" gate silently overrides `--yolo` back to
`default` — blocking *every* tool call — in a directory it doesn't trust.
Specrails injects `GEMINI_CLI_TRUST_WORKSPACE=true` into every Gemini spawn
(`server/util/cli-prompt.ts`, `spawnGemini`) so headless rails and Explore
turns can actually run tools. **No action is needed from you.**

## Troubleshooting

**"Gemini" never appears in Add Project** — `gemini` isn't on `PATH`, or the
emergency rollback is active (`SPECRAILS_GEMINI_BETA=0`). Check
`GET /api/available-providers`; install the CLI and restart the app so PATH
refreshes if needed.

**"gemini 0.10.0 is older than required 0.11.0"** — upgrade with
`npm i -g @google/gemini-cli`. Earlier versions lack the stream-json and
headless resume support the app relies on.

**Tools never run / a job does nothing** — almost always auth or trust.
Confirm `GEMINI_API_KEY` is set in the server env; the trust var is handled
automatically.

**A rail's agents don't specialise (`Subagent not found`)** — the project's
`.gemini/agents/*.md` weren't acknowledged. This is normally handled
automatically by `prepareHeadlessSpawn` (above); make sure the project was
installed with `specrails-core` ≥ 4.8.0 so the `.gemini/` agents exist.

**`limit: 0` / quota errors on Pro** — free-tier API keys don't serve Pro or
preview models; use a Flash model or enable billing.

**Cost shows `—`** — there's no `gemini:<model>` pricing row for the model
that ran (e.g. a brand-new model Google shipped after our last review). Cost
estimation fails soft (it returns nothing rather than guessing). Add a row to
`server/pricing.ts` and reload.

## Emergency rollback

To disable the Gemini path, set `SPECRAILS_GEMINI_BETA=0` in the app's
environment. For a source checkout that's:

```bash
SPECRAILS_GEMINI_BETA=0 npm run dev
```

For the packaged desktop app, set the variable in the environment the app
process inherits. Only the exact string `0` disables Gemini — `1`, `true`,
and unset all mean enabled.

With it set, `GET /api/available-providers` reports `gemini: false` and
`POST /api/projects` refuses new Gemini projects. Existing non-Gemini projects
are unaffected; the adapter stays registered but dormant.

## Architecture pointers (for specrails-desktop developers)

- **Adapter:** `server/providers/gemini-adapter.ts` (`nativeCostUsd: false`,
  `nativeOtelEnv: true`, `systemPromptArg: false`, `profileEnvSupport: true`,
  `instructionsFilename: 'GEMINI.md'`, `mcpRegistration: 'project-json'`,
  `minCliVersion: '0.11.0'`). Registered in `server/providers/index.ts`.
- **Headless subagent ack:** `server/providers/gemini-agent-ack.ts`
  (`acknowledgeGeminiProjectAgents`), wired as the adapter's
  `prepareHeadlessSpawn` and called by `server/queue-manager.ts` before each
  rail spawn.
- **Stream schema** (pinned to the gemini-cli 0.11 contract, locked by the
  fixtures under `server/providers/__fixtures__/gemini-*.ndjson`):
  `init{session_id,model}` / `message{role,content,delta}` /
  `tool_use{tool_name,tool_id,parameters}` / `tool_result` / `result{stats}`.
  `stats.input_tokens` includes `stats.cached`.
- **Beta gate + provider list:** `server/desktop-router.ts`
  (`isGeminiBetaDisabled` — returns `true` only when
  `SPECRAILS_GEMINI_BETA === '0'`; `/available-providers`, `POST /projects`).
- **Pricing / cost estimation:** `server/pricing.ts` (`gemini:<model>` rows +
  `estimateCostUsd`, which returns `null` when no row matches).
- **Trust-folder env:** `server/util/cli-prompt.ts`, `spawnGemini`.

## See also

- [`docs/codex.md`](./codex.md) — the Codex provider (the other provider with
  estimated cost).
- [Adding a provider](internals/adding-a-provider.md) — the developer guide to
  wiring a new AI CLI adapter (Gemini is the freshest worked example).
- [`docs/gemini-cli-provider-study.md`](./gemini-cli-provider-study.md) — the
  original design study.
- [`docs/gemini-core-support-evaluation.md`](./gemini-core-support-evaluation.md)
  — the rails/core support work.
