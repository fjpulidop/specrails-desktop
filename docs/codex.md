# Using Specrails with the Codex CLI

Specrails supports **four AI providers** — Claude, Codex, Gemini, and Kimi.
This guide covers OpenAI's
[Codex CLI](https://developers.openai.com/codex). For the others, see
[Claude Code](https://claude.com/claude-code) and the
[Gemini guide](gemini.md) or [Kimi guide](kimi.md).

> **Just want to get going?** Install the `codex` CLI, log in, then in
> the app click **Add Project → check Codex → Submit**. The rest of the
> app (specs, rails, chat, analytics) works the same as it does for
> Claude. Everything below is detail for when you need it.

You pick any subset of the four providers when you add a project — and
you can mix them in a single project too (see [Running more than one
provider in one project](#running-more-than-one-provider-in-one-project)
below). All four are registered by default.

> The codex path is enabled by default. To temporarily disable it
> (e.g. as an emergency rollback), set `SPECRAILS_CODEX_BETA=0` in the
> app's environment. **Only the exact string `0` disables it** — `false`,
> `off`, `1`, or leaving it unset all mean "enabled". The legacy
> `SPECRAILS_HUB_CODEX_BETA` name is still read as a fallback when the
> new variable is unset.

## Prerequisites

| What | Why | How |
|---|---|---|
| `codex` CLI ≥ 0.128.0 | Earlier versions don't support `exec --json` + `exec resume` semantics the app relies on | `npm i -g @openai/codex` · or download from https://developers.openai.com/codex |
| Authentication | Codex needs OAuth or an API key | `codex login` (ChatGPT OAuth) or set `OPENAI_API_KEY` |
| `uv` ≥ 0.1.0 (optional) | Required if you want to install the Serena plugin | `brew install uv` · `pipx install uv` · or the curl installer at https://docs.astral.sh/uv |
| `git`, `node`, `npm`, `npx` | Same as Claude — needed for `specrails-core init` | Use your usual installer |

The app's `Add Project` dialog runs a live prerequisites check. It
disables the Codex provider checkbox with a "not found" hint when the
binary isn't on `PATH`; it shows install commands if you click "More info".

## Adding a codex project

1. Open the app UI and click **Add Project**.
2. Pick the project's path.
3. In the **AI providers** row, check **Codex** (you can check
   **Claude**, **Gemini**, and/or **Kimi** too — see [Running more than one
   provider in one project](#running-more-than-one-provider-in-one-project)).
   The first provider you select becomes the project default.
4. Submit. The app writes `.specrails/install-config.yaml` (with
   `provider: codex` and `tier: quick` as YAML keys) and spawns
   `npx --yes --prefer-online specrails-core@^4.12.0 init --yes --from-config <file>`
   — the provider and tier live in the YAML, not as CLI flags. (The app
   pins `specrails-core@^4.12.0`; that floor is the version that ships the
   current provider targets, including Kimi and the Codex skill set.) The install
   produces:
   - `.codex/config.toml` — model, reasoning effort, sandbox mode, and
     approval policy (all top-level keys per the codex 0.128.0+ schema).
   - `.codex/skills/sr-*/SKILL.md` — general specrails skills
     (implement, batch-implement, why, compat-check, …).
   - `.codex/skills/rails/sr-*/SKILL.md` — the pipeline rails.
   - `AGENTS.md` — top-level instructions file with a sentinel-protected
     managed block. Anything outside the sentinels is preserved on
     updates.

   The exact rail and lifecycle skill set is produced by
   `specrails-core`, not the app, so the precise file list can vary by
   core version.

The provider **set** you choose is immutable after creation — you
can't add or remove a provider on an existing project (the on-disk
layouts are disjoint and we don't want to ask you to migrate the trees
in place). Install every provider you might want up front if you want
the choice later.

## Running more than one provider in one project

A single project can install **any combination** of Claude, Codex, Gemini, and
Kimi. In the **Add Project** dialog the **AI providers** control is a
multi-select — check the ones you want and the app runs each provider's
install sequentially. The first provider you select is the
**primary/default**; the helper text spells this out: *"The engines will
be set up. The first is the project default. Cannot be changed after
creation."*

Once more than one is installed:

- **Per-invocation engine pickers** let you choose which engine runs each
  time you spawn work. The picker appears in the **Add Spec** dialog
  (`AiEngineSelector`), in the **rail header** (`RailEngineSelector`),
  and in the terminal's **Open AI CLI** menu (`CliLaunchMenu`). On
  single-provider projects these pickers don't render — there's nothing
  to choose.
- The **selected engine is remembered per project** (it defaults to the
  primary), so you don't have to re-pick on every spawn.
- **Provider-scoped capabilities.** Claude and Kimi expose independent
  profile catalogs; Codex and Gemini run rails in legacy/no-profile mode.
  Integration entries and health are resolved for the effective provider:
  Serena supports Claude, Codex, and Kimi through each provider's native MCP
  registration, while Jira is provider-agnostic.

When only one provider is installed the app behaves byte-identically to
a single-provider project — no engine pickers, no provider persisted on
spawns, no overrides.

## What's different across providers

The table below includes all four registered providers. See the
[Kimi guide](kimi.md) for its full safety matrix.

| Surface | Claude | Codex | Gemini | Kimi |
|---|---|---|---|---|
| **CLI** | `claude` | `codex` | `gemini` | `kimi` |
| **Min CLI version** | none pinned | `0.128.0` | `0.11.0` | `0.27.0` |
| **Project dir** | `.claude/` | `.codex/` | `.gemini/` | `.kimi-code/` |
| **Instructions file** | `CLAUDE.md` | `AGENTS.md` | `GEMINI.md` | `AGENTS.md` |
| **Default model** | `sonnet` | `gpt-5.5` | `gemini-3.5-flash` | `k3` |
| **Reasoning efforts** | `low`–`xhigh` | model-dependent | none | `low`/`high`/`max`, K3 only |
| **Agent format** | `.claude/agents/<id>.md` | `.codex/skills/<id>/SKILL.md` | `.gemini/` target | `.kimi-code/skills/<id>/SKILL.md` |
| **Agent profiles** | ✅ | legacy | legacy | ✅ provider-scoped |
| **Implement / Batch** | ✅ | ✅ | ✅ | ✅ |
| **Freestyle** | ✅ | ❌ | ❌ | ✅ |
| **Pure-output transforms** | capability-dependent | capability-dependent | capability-dependent | ❌ fail closed |
| **MCP registration** | `.mcp.json` | isolated `CODEX_HOME` | `.gemini/settings.json` | `.kimi-code/mcp.json` |
| **Session resume** | `--resume` | `exec resume` | `--resume` | bound `--session=<id>` after resume hint |
| **Native cost report** | exact | estimated | estimated | unavailable |
| **Telemetry** | native | synthesized | native | unavailable |

A few Codex-specific behaviours worth calling out:

- **Rail sandbox.** Codex rail jobs spawn with `--sandbox danger-full-access`
  (not the `workspace-write` sandbox used for one-off `codex exec` runs), so
  a rail can read and write anywhere in the project. This is intentional —
  rails need to apply edits across the repo — but it's worth knowing if
  you're surprised by a rail touching files outside the working tree.
- **Freestyle rails require a capable provider.** Launching a Freestyle rail
  (`mode: freestyle`) on Codex or Gemini is rejected before spawn. Pick Claude
  or Kimi for that autonomous rail mode.

## Estimated cost

Codex does not report `total_cost_usd` natively. The app computes an
estimate from the captured `usage` (input / output / cached input
tokens × the local rate-card in `server/pricing.ts`) and stores it in
`ai_invocations.total_cost_usd` with `total_cost_usd_estimated = 1`.

The Analytics page surfaces this in two places:

- **The cost cell** in the Raw Invocations table shows a `~` prefix
  (e.g. `~$0.012`) and a tooltip explaining the fallback when you
  hover.
- **The Hero** shows a small italic suffix next to the invocation
  count (`· includes ~$X.XX estimated`) when any row in the active
  window came from the fallback.
- **A "By provider" card** between the Hero and the Timeline splits
  cost per provider into authoritative vs estimated whenever the project
  has invoked more than one. Claude rows are authoritative (the CLI
  reports cost); Codex and Gemini rows are estimated from token counts
  and the local rate-card.

The pricing table is reviewed quarterly. The reference date sits on
each entry as `lastReviewedAt`. If OpenAI raises prices mid-quarter,
ship an out-of-band update to `server/pricing.ts`.

## Plugins and MCP on codex projects

The **Integrations** section stays visible on Codex projects. Serena is
provider-aware and registers its server with `codex mcp add` in Specrails'
isolated per-project `CODEX_HOME`; Claude uses `.mcp.json`, and Kimi uses
`.kimi-code/mcp.json`. Install state and health are scoped to the selected
provider, so one provider's entry never masquerades as another's. Jira remains
provider-agnostic.

For MCP servers outside the managed plugin catalog, use Codex's native
configuration flow. Codex chat and Explore turns inherit the appropriate Codex
environment and read that MCP configuration.

## Troubleshooting

**"codex binary not found" when adding a project** — install codex CLI
and restart the app so PATH refreshes. The app's
`/api/setup-prerequisites` endpoint surfaces the absolute path it
resolved, useful for diagnosing Homebrew-vs-npm install collisions.

**"codex 0.120.0 is older than required 0.128.0"** — upgrade. The
adapter pins the minimum because earlier versions don't support
`exec --json` or `exec resume`.

**"codex mcp add serena failed: auth missing"** — run `codex login`
or set `OPENAI_API_KEY`. The app doesn't proxy auth.

**Cost shows as `—` for codex jobs even though tokens are non-zero**
— the spawned model isn't in `server/pricing.ts` (e.g. a brand-new
model OpenAI shipped after our last review). Update the pricing table
and reload the page.

**Cost on the Hero looks too high after a long Explore session** —
remember that codex Explore uses real `exec resume`, so every turn
re-feeds the prior conversation. Long sessions accumulate input-
token cost the same way Claude's `--resume` does. The Hero footnote
calls this out.

**"Enrich with Contract Layer" did nothing on a codex spec** — that's
expected. Contract Refine is a Claude-only capability; the Add Spec UI
hides the toggle for codex, and the server skips it defensively if a
codex conversation reaches the refine path. There's no error — the
spec just commits without a Contract Layer block.

## Emergency rollback

If you need to disable the codex path, set `SPECRAILS_CODEX_BETA=0`
in the app's environment. **Only the exact string `0` disables Codex** —
`false`, `off`, `1`, or unset all leave it enabled. For a source checkout
that's:

```bash
SPECRAILS_CODEX_BETA=0 npm run dev
```

For the packaged desktop app, set the variable in the environment the app
process inherits (the `npm run dev` form is for source runs only).

(Gemini has the same kill switch, `SPECRAILS_GEMINI_BETA=0`, but **no**
legacy `SPECRAILS_HUB_*` fallback name.)

`GET /api/available-providers` will report `codex: false` and
`POST /api/projects` will refuse new codex projects. Existing
codex projects keep functioning — the env var only gates creating
*new* codex projects.

## Architecture pointers (for specrails-desktop developers)

The codex integration lives in:

- `server/providers/codex-adapter.ts` — `ProviderAdapter`
  implementation for codex 0.128.0+. Fixtures under
  `server/providers/__fixtures__/codex/0.128.0/`.
- `server/pricing.ts` — local pricing table + `estimateCostUsd`.
- `server/codex-otel-bridge.ts` — synthetic OTEL traces / metrics /
  logs derived from JSONL events.
- `server/plugins/codex-mcp.ts` — `codex mcp add/remove/list` wrapper
  with per-project `CODEX_HOME`.

The contract every provider implements is at
`server/providers/types.ts`. Adding a provider is essentially one new
adapter file + one `register(...)` entry in `server/providers/index.ts`
(the rest of the codebase is registry-driven and provider-id-agnostic).
`server/providers/gemini-adapter.ts` is the freshest worked example —
see [Adding a provider](internals/adding-a-provider.md).

## See also

- [Using Gemini](gemini.md) — the Gemini CLI provider (the other
  provider with estimated cost).
- [Adding a provider](internals/adding-a-provider.md) — the developer
  guide to wiring an AI CLI adapter.
- [Tracking cost](tracking-cost.md) — how the Analytics page surfaces
  per-invocation cost across every surface (including the estimated
  codex rows described above).
