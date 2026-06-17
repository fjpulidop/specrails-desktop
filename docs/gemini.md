# Using Specrails with the Gemini CLI

Specrails supports Google's [Gemini CLI](https://github.com/google-gemini/gemini-cli)
as a third AI provider alongside Claude Code and the Codex CLI.

> **Beta — opt-in.** Gemini is gated behind `SPECRAILS_GEMINI_BETA` and is **off by
> default**. Until you set it, Gemini is invisible everywhere (it won't show in Add
> Project and can't be selected). See [Enabling the beta](#enabling-the-beta).
>
> **Scope today.** With the beta on, Gemini powers the *non-pipeline* surfaces —
> Explore Spec, Quick spec, AI Edit, the terminal launcher, and cost analytics.
> The full **rails pipeline** (`/specrails:implement`, `batch-implement`) needs a
> Gemini artifact target in `specrails-core` (`.gemini/commands/*.toml` +
> `.gemini/agents/sr-*.md`), which ships separately. Rails are hidden for Gemini
> projects until then.

## Prerequisites

- **Gemini CLI ≥ 0.11.0** on your `PATH` (`npm i -g @google/gemini-cli`; `gemini --version`).
  Older versions lack `--output-format stream-json` and headless `--resume`.
- **A Gemini API key.** Specrails spawns Gemini headlessly, so it needs
  non-interactive auth: set `GEMINI_API_KEY` (a paid Gemini Developer API key from
  [Google AI Studio](https://aistudio.google.com/apikey)). The free OAuth
  "Login with Google" tier exists but is being wound down for the CLI and is not a
  reliable unattended path — use an API key.

## Enabling the beta

Set the env var where the Specrails server runs, then restart the app:

```bash
SPECRAILS_GEMINI_BETA=1   # or 'true'
```

With it set, `GET /api/available-providers` reports Gemini's real install status,
Add Project shows a **Gemini** checkbox, and projects can select it.

## Adding a Gemini project

Add Project → tick **Gemini** (visible once the beta is on and `gemini` is on PATH).
A project can install Gemini alongside Claude/Codex; the first provider selected is
the primary/default, and per-invocation engine pickers let you choose per spec/rail.

## What's different vs Claude

- **Cost is estimated, not native.** Gemini does not report a USD cost in its
  stream, so Specrails estimates it from a rate card (`server/pricing.ts`,
  keys `gemini:<model>`). Token counts (incl. cached) come straight from the run.
- **No per-agent profiles / SMASH / Contract Refine.** These are Claude-only; on a
  mixed project the capability intersection hides them (same as Codex).
- **System prompt is folded.** Gemini has no `--system-prompt` flag, so for
  non-Explore actions the system prompt is folded into the user prompt. Explore
  turns stay user-only and trust the app-managed `GEMINI.md` in the explore cwd.
- **OTEL is native.** Unlike Codex, Gemini emits OTLP via `GEMINI_TELEMETRY_*`, so
  pipeline telemetry needs no synthetic bridge.

## Models

Curated catalog (`server/providers/gemini-adapter.ts`): `gemini-2.5-pro` (default),
`gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-3.1-pro-preview`. Concrete GA
ids are pinned (preview ids rotate). Free-tier API keys serve Flash; Pro/preview
need billing.

## Trusted folders (headless)

Gemini's "trusted folders" gate silently overrides `--yolo` back to `default` —
blocking *every* tool call — in a directory it doesn't trust. Specrails injects
`GEMINI_CLI_TRUST_WORKSPACE=true` into every Gemini spawn (`server/util/cli-prompt.ts`
`spawnGemini`) so headless rails/explore can actually run tools. No action needed
from you.

## Troubleshooting

- **"Gemini" never appears in Add Project** → the beta is off (`SPECRAILS_GEMINI_BETA`
  unset), or `gemini` isn't on PATH. Check `GET /api/available-providers`.
- **Tools never run / job does nothing** → almost always auth or trust. Confirm
  `GEMINI_API_KEY` is set in the server env; the trust var is handled automatically.
- **`limit: 0` / quota errors on Pro** → free-tier API keys don't serve Pro models;
  use a Flash model or enable billing.
- **Cost shows `—`** → no `gemini:<model>` pricing row for the model used; add one to
  `server/pricing.ts`.

## Emergency rollback

Unset `SPECRAILS_GEMINI_BETA` (or set it to `0`). Gemini disappears from the UI and
becomes unselectable immediately; existing non-Gemini projects are unaffected. The
adapter stays registered but dormant.

## Architecture pointers (for specrails-desktop developers)

- Adapter: `server/providers/gemini-adapter.ts` (`nativeCostUsd:false`,
  `nativeOtelEnv:true`, `systemPromptArg:false`, `instructionsFilename:'GEMINI.md'`,
  `mcpRegistration:'project-json'`). Registered in `server/providers/index.ts`.
- Stream schema (validated against gemini 0.46): `init{session_id,model}` /
  `message{role,content,delta}` / `tool_use{tool_name,tool_id,parameters}` /
  `tool_result` / `result{stats}`. `stats.input_tokens` includes `stats.cached`.
- Beta gate + provider list: `server/desktop-router.ts` (`isGeminiBetaEnabled`,
  `/available-providers`, `POST /projects`).
- Trust-folder env: `server/util/cli-prompt.ts` `spawnGemini`.

## See also

- [`docs/codex.md`](./codex.md) — the Codex provider (the other non-native provider).
- [`docs/adding-a-provider.md`](./adding-a-provider.md) — how to add a provider.
- [`docs/gemini-cli-provider-study.md`](./gemini-cli-provider-study.md) — the design study.
- [`docs/gemini-core-support-evaluation.md`](./gemini-core-support-evaluation.md) — the rails/core work.
