# Internals

These docs are primarily for contributors and people building on the app's API. They mostly describe how the app works under the hood — though a couple (like the profiles quick start) double as practical how-tos.

If you're a user looking for **how do I do X?** docs, head back to the [user guides](../README.md).

## Contents

| Doc | What it covers |
|-----|----------------|
| [architecture.md](architecture.md) | Server modules, client layout, WebSocket protocol, process spawning, security model |
| [api-reference.md](api-reference.md) | REST endpoint catalogue under `/api/*` and `/api/projects/:projectId/*` |
| [configuration.md](configuration.md) | Settings, env vars, kill switches, advanced flags |
| [operations-runbook.md](operations-runbook.md) | Start/stop, port conflicts, recovery procedures, backups |
| [openspec-workflow.md](openspec-workflow.md) | `opsx:*` change lifecycle — used by the app itself for structured change management |
| [adding-a-provider.md](adding-a-provider.md) | How to add a new AI CLI: one adapter file plus one entry in the registry |
| [profiles.md](profiles.md) | Agent profiles quick start: open the Agents section, pick a profile per rail at launch, author custom agents in Agent Studio. For the true file-format and snapshotting internals, read `server/profile-manager.ts` and the profile-manager section of `CLAUDE.md` |

**See also:** the app supports multiple AI CLIs as first-class, interchangeable engines — Claude Code, Codex CLI, and Gemini CLI. See [`../codex.md`](../codex.md) and [`../gemini.md`](../gemini.md) for the per-provider detail. Gemini is **enabled by default** (selectable whenever the `gemini` CLI is on `PATH`); the emergency rollback is `SPECRAILS_GEMINI_BETA=0` (only the exact string `0` disables it). Codex parallels this with `SPECRAILS_CODEX_BETA=0`.

## Contributing

For coding conventions, file naming, the coverage policy, and how WebSocket handlers are expected to be wired, see [`CLAUDE.md`](../../CLAUDE.md) at the repo root. That file is the authoritative source for project-wide rules.

When adding a feature, follow the OpenSpec workflow: `/opsx:new → /opsx:ff → /opsx:apply → /opsx:verify → /opsx:archive`. The `/opsx:*` invocations resolve to command files under `.claude/commands/opsx/*.md` (the related skills under `.claude/skills/` are named `openspec-*`).
