# AI providers (Claude, Codex, Gemini)

Specrails isn't tied to a single AI. Every part of the app that talks to an AI — Explore Spec, Quick spec, rails, chat, AI Edit, the terminal's "Open AI CLI" button — can run through any of three first-class providers. You pick which ones a project uses, and you can even switch on a per-task basis.

## The three providers

| Provider | CLI | Made by | Notes |
|---|---|---|---|
| **Claude** | `claude` | Anthropic | The most fully featured. The only provider for Agents (profiles) and Freestyle rails, and for Contract Refine. |
| **Codex** | `codex` | OpenAI | Needs codex `0.128.0+`. Reads its MCP servers from your global `~/.codex/config.toml`. |
| **Gemini** | `gemini` | Google | Needs gemini `0.11.0+`. Uses native telemetry and a `GEMINI.md` instructions file. |

All three are **enabled by default**. A provider shows up in **Add Project** whenever its CLI is installed and on your `PATH`. So the first step is always the same: install the CLI you want and log in with it, exactly as that tool's own docs describe. Once `claude --version` (or `codex`, or `gemini`) works in your terminal, Specrails can use it.

## Installing one provider for a project

When you add a project, the setup wizard asks which provider(s) to install. Pick one, click through the install step, and you're done. From there on the project just *has* that provider — you never have to think about it again. Specs, rails, chat, and analytics all work the same regardless of which one you chose.

If a CLI you want isn't offered in Add Project, it's almost always because the CLI isn't installed or isn't on your `PATH`. Install it, then reopen Add Project.

## Installing several providers for one project

You can install **more than one** provider into the same project — for example Claude *and* Gemini. In **Add Project**, the provider list becomes a set of checkboxes; tick everything you want. The first one you select becomes the project's **primary** (default) provider; the rest are available as alternatives.

A few things worth knowing about multi-provider projects:

- **One provider behaves exactly like before.** If a project has just a single provider, you'll never see a provider picker anywhere — the app stays clean and simple.
- **The right sidebar only shows sections every installed provider supports.** Because Agents (profiles) is a Claude-only concept, the **Agents** section disappears the moment a project includes any non-Claude provider. Everything else (Specs, Code, Analytics, Integrations, Terminal, Chat) stays.
- **Provider choice is locked after creation.** In this version you choose your providers when you add the project and they can't be changed later from Settings. If you need a different mix, that's a fresh project.

## Picking a provider per invocation

The real payoff of a multi-provider project is choosing the right AI for each task — without changing any global setting. Wherever an AI runs, a small provider picker appears (only when the project has more than one):

- **Add Spec** — an engine selector lets you Explore or Quick-generate a spec with whichever provider you like.
- **Rail header** — pick the engine for that specific rail before launching it.
- **Terminal** — the "Open AI CLI" (Sparkles) button opens a provider menu so you can drop into any installed CLI in that project's directory.

Your choice is remembered per project, defaulting to the primary provider, so you don't have to re-pick every time.

## What only Claude can do

A handful of features are Claude-specific by nature, so they're either hidden or skipped when another provider is in play:

- **Agents (profiles)** — the per-project agent catalog and model routing. Hidden on any project that includes a non-Claude provider.
- **Freestyle rails** — always run on Claude.
- **Contract Refine** — the extra "Contract Layer" pass on a committed spec runs only when the conversation's provider is Claude.
- **Add Spec advanced modes** (SMASH / Contract Layer) — hidden for non-Claude engines.

Everything else — Explore, Quick spec, the full rails pipeline, AI Edit, chat, cost analytics — works across all three.

## Cost tracking across providers

The **Analytics** page tracks every billable invocation regardless of provider. On multi-provider projects it adds engine filter chips so you can compare spend by provider. Claude reports its own exact cost; for Codex and Gemini, Specrails estimates cost from a built-in rate card, so the numbers are close approximations rather than billed amounts.

## Troubleshooting

- **A provider I installed isn't offered.** Confirm the CLI is on your `PATH` (try `claude --version` / `codex --version` / `gemini --version` in a fresh terminal). The app probes provider CLIs through your system `PATH`.
- **Codex MCP servers aren't loading in chat.** Codex reads MCP servers from your global `~/.codex/config.toml` — register them there with `codex mcp add`.
- **Emergency disable.** A provider can be turned off app-wide via an environment variable (`SPECRAILS_CODEX_BETA=0` or `SPECRAILS_GEMINI_BETA=0`). This only hides the provider from *selection*; it's rarely needed.

## See also

The dedicated provider guides go deeper on each CLI: the Codex guide and the Gemini guide each cover setup, what works, and provider-specific quirks.