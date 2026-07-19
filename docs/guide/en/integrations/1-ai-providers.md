# AI providers (Claude, Codex, Gemini, Kimi)

Specrails isn't tied to a single AI. Explore, rails, chat, loops, and the
terminal's "Open AI CLI" action run through a provider adapter; pure-output
surfaces additionally require a safe tool policy. You choose the provider set
for a project and can switch among compatible engines per invocation.

## The four providers

| Provider | CLI | Made by | Notes |
|---|---|---|---|
| **Claude** | `claude` | Anthropic | Native billed-cost events and persistent interactive stdin. |
| **Codex** | `codex` | OpenAI | Needs codex `0.128.0+`. Reads its MCP servers from your global `~/.codex/config.toml`. |
| **Gemini** | `gemini` | Google | Needs gemini `0.11.0+`. Uses native telemetry and a `GEMINI.md` instructions file. |
| **Kimi Code** | `kimi` | Moonshot AI | Needs Kimi Code `0.27.0+`. Uses CLI-only `-p` execution and `.kimi-code` directory-form skills. |

All four are registered by default. A provider is selectable in **Add Project**
when its CLI is installed, executable, and on `PATH`. Once its `--version`
command works in a fresh terminal, Specrails can use it. Kimi users must also
complete `kimi login`; the setup probe does not spend quota merely to test
authentication.

## Installing one provider for a project

When you add a project, the setup wizard asks which provider(s) to install.
Pick one, click through the install step, and you're done. From there on the
project has that provider, while each surface checks its advertised
capabilities. See [Using Kimi](../../../kimi.md) for Kimi's exact matrix.

If a CLI you want isn't offered in Add Project, it's almost always because the CLI isn't installed or isn't on your `PATH`. Install it, then reopen Add Project.

## Installing several providers for one project

You can install **more than one** provider into the same project — for example Claude *and* Gemini. In **Add Project**, the provider list becomes a set of checkboxes; tick everything you want. The first one you select becomes the project's **primary** (default) provider; the rest are available as alternatives.

A few things worth knowing about multi-provider projects:

- **One provider behaves exactly like before.** If a project has just a single provider, you'll never see a provider picker anywhere — the app stays clean and simple.
- **Capability checks drive the sidebar.** Sections are visible only when their
  backing behavior is supported by the relevant installed providers. Kimi
  advertises profiles, custom roles, and Freestyle; it does not advertise
  structured actions that require an enforceable no-tools boundary.
- **Provider choice is locked after creation.** In this version you choose your providers when you add the project and they can't be changed later from Settings. If you need a different mix, that's a fresh project.

## Picking a provider per invocation

The real payoff of a multi-provider project is choosing the right AI for each task — without changing any global setting. Wherever an AI runs, a small provider picker appears (only when the project has more than one):

- **Add Spec** — an engine selector lets you Explore with a compatible
  provider. Quick Spec only lists providers that can enforce its pure-output
  boundary; Kimi uses Explore or the agentic Quick Launcher instead.
- **Rail header** — pick the engine, model, profile, and supported reasoning
  effort for that rail.
- **Terminal** — the "Open AI CLI" (Sparkles) button opens a provider menu so you can drop into any installed CLI in that project's directory.

Your choice is remembered per project, defaulting to the primary provider, so you don't have to re-pick every time.

## Capability differences

The application exposes the same provider-independent workflows where the CLI
contract can support them. Native telemetry and transport still differ:

- **Claude** reports billed USD cost and supports a long-lived stdin chat
  transport.
- **Codex and Gemini** report enough usage to estimate cost from the local rate
  card.
- **Kimi** emits text, tool activity, errors/retries, and a resumable session
  hint, but no authoritative token or USD-cost envelope. Those fields remain
  unavailable.
- **Kimi user-global MCP** cannot be isolated per child process. Specrails uses
  additive project `.kimi-code/mcp.json` integration and does not expose the
  Claude-style "load my approved user MCPs" toggle for Kimi.
- **Kimi `-p` permission mode** is autonomous and offers no per-invocation
  native equivalent of Claude's `--tools __none__` or Codex's read-only
  sandbox. Quick Spec, AI Edit, Contract Refine, SMASH/Re-SMASH, Project
  Builder blueprint/milestone generation, Loop Decider, file summary and
  construction-story AI, and Agent Studio generation/test/refine are
  therefore hidden or rejected before spawn. AI auto-title uses a
  deterministic fallback.
- Kimi still supports Project/Agent Chat, Explore/proposals, agentic Quick
  Launcher commands (including `/opsx:ff`), rails, loops without a Decider,
  profiles/manual roles, terminal, project MCP, Serena, attachments, and
  truthful invocation metadata.

## Cost tracking across providers

The **Analytics** page tracks every invocation regardless of provider. Claude
cost is provider-reported; Codex/Gemini values may be estimated from the rate
card. Kimi invocation duration, outcome, model, and session are recorded, while
cost and token fields stay null when the CLI did not report them.

## Troubleshooting

- **A provider I installed isn't offered.** Confirm the CLI is on your `PATH`
  (`claude --version`, `codex --version`, `gemini --version`, or
  `kimi --version`) in a fresh terminal.
- **Kimi reports a login/model error.** Run `kimi login`, then retry. Specrails
  intentionally avoids a billable setup prompt.
- **Codex MCP servers aren't loading in chat.** Codex reads MCP servers from your global `~/.codex/config.toml` — register them there with `codex mcp add`.
- **Emergency disable.** A provider can be turned off app-wide via an environment variable (`SPECRAILS_CODEX_BETA=0` or `SPECRAILS_GEMINI_BETA=0`). This only hides the provider from *selection*; it's rarely needed.

## See also

The dedicated [Kimi provider guide](../../../kimi.md), Codex guide, and Gemini
guide cover setup and provider-specific behavior in depth.
