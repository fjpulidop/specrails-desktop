# AI providers (Claude, Codex)

Specrails isn't tied to a single AI. Explore, rails, chat, loops, and the
terminal's "Open AI CLI" action run through a provider adapter; pure-output
surfaces additionally require a safe tool policy. You choose the provider set
for a project and can switch among compatible engines per invocation.

## The two providers

| Provider | CLI | Made by | Notes |
|---|---|---|---|
| **Claude** | `claude` | Anthropic | Native billed-cost events and persistent interactive stdin. |
| **Codex** | `codex` | OpenAI | Needs codex `0.128.0+`. Reads its MCP servers from your global `~/.codex/config.toml`. |

## Providers are detected automatically

If a provider you want doesn't show up anywhere, it's almost always because the
CLI isn't installed or isn't on your `PATH`. Install it, sign in, and switch
back to the app — detection re-runs on focus and the provider appears
everywhere on its own, with its project workspace surface assembled in the
background. A provider that's installed but not signed in still appears, with
a *Not signed in* badge on the engine selectors.

A few things worth knowing about multi-provider machines:

- **One provider behaves exactly like before.** If only a single provider is detected, you'll never see a provider picker anywhere — the app stays clean and simple.
- **Nothing is locked.** Installing or removing a provider CLI updates every
  project automatically — there is no per-project provider setting to manage.

## Picking a provider per invocation

The real payoff of a multi-provider project is choosing the right AI for each task — without changing any global setting. Wherever an AI runs, a small provider picker appears (only when the project has more than one):

- **Rail header** — pick the engine, model, profile, and supported reasoning
  effort for that rail.
- **Terminal** — the "Open AI CLI" (Sparkles) button opens a provider menu so you can drop into any installed CLI in that project's directory.

Your choice is remembered per project, defaulting to the primary provider, so you don't have to re-pick every time.

## Capability differences

The application exposes the same provider-independent workflows where the CLI
contract can support them. Native telemetry and transport still differ:

- **Claude** reports billed USD cost and supports a long-lived stdin chat
  transport.
- **Codex** reports enough usage to estimate cost from the local rate
  card.

## Troubleshooting

- **Codex MCP servers aren't loading in chat.** Codex reads MCP servers from your global `~/.codex/config.toml` — register them there with `codex mcp add`.
