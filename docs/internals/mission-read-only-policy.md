# Read-only missions

Mission agents (the in-app agent chat) drive Specrails through the
`specrails_*` MCP tools. They do not edit workspaces themselves. Until
2026-10 that rule was held up by an app-owned working directory
(`~/.specrails/agent-cwd`), the operator prompt and the MCP permission ladder:
every provider still spawned in its write-capable mode. Since the
`mission-read-only-policy` change, mission turns use each provider's native
read-only boundary, so the rule holds even if a model ignores its prompt. Flow
(see [Flow mode](flow-mode.md)) is the only write-capable mission mode, and it
uses its own session; see [The Flow exception](#the-flow-exception).

Source: [`mission-tool-policy.ts`](../../server/modules/missions/runtime/mission-tool-policy.ts).
Kill switch: `SPECRAILS_MISSION_READ_ONLY=false` (see
[configuration](configuration.md#mission-read-only-policy)).

## Per-provider mapping

The legacy transport covers one-shot turns and native live sessions (Claude
stream-json, Codex app-server). The Core session column applies when the
mission runs on Core agent sessions.

| Provider | Legacy transport argv | Core session policy | MCP tools |
| --- | --- | --- | --- |
| Claude | `--dangerously-skip-permissions --tools Read,Grep,Glob,Agent,WebFetch,WebSearch` | `permissions: 'bypass'`, `tools: { mode: 'read-only' }` (Core's `--tools Read,Grep,Glob`) | ✅ |
| Codex | `--sandbox read-only` (resume: `-c sandbox_mode="read-only"`; app-server `sandbox: 'read-only'`) | `permissions: 'read-only'` (read-only sandbox; the driver has no tool filtering) | ✅ |
| Gemini | `--approval-mode plan --policy <cwd>/.gemini/specrails-plan-mcp-policy.toml` | no Core session driver | ✅ through the policy file |
| Local engines | runner `--tools Read,Grep,Glob` | not applicable | ✅ (runner always adds `--mcp-config` tools) |
| Kimi | unchanged (prompt mode auto-approves every tool) | not applicable | ✅ |

### Why Claude does not use plan mode

`toolPolicy: 'read-only'` alone maps Claude to `--permission-mode plan
--safe-mode --tools Read,Grep,Glob`, which is correct for pure-output transforms
but breaks missions. This was checked on claude 2.1.299 with a stub MCP server
whose tool is described as state-changing:

| Argv | MCP call | Write refused |
| --- | --- | --- |
| `--permission-mode plan --safe-mode --tools Read,Grep,Glob` | ❌ `--safe-mode` unloads `--mcp-config` servers | ✅ |
| `--permission-mode plan --tools Read,Grep,Glob` | ❌ the model refuses state-changing calls in plan mode | ✅ |
| same + `--allowedTools mcp__specrails` | ❌ still refused by the model | ✅ |
| `--permission-mode dontAsk --tools Read,Grep,Glob --allowedTools mcp__specrails` | ✅ | ✅ (but connectors and external servers would need explicit allow rules) |
| `--dangerously-skip-permissions --tools Read,Grep,Glob` | ✅ | ✅ |

Missions use the last row, so MCP behaviour is unchanged. The boundary is the
tool set: no built-in tool that writes files or runs commands exists in the
session. `SpawnOptions.retainMcpTools` selects it. The added `Agent` tool is
safe because native sub-agents inherit the restricted set. In the test, a
sub-agent asked to create a file reported only read-only tools and could not.
The Core claude driver maps `tools.mode: 'read-only'` to Core's fixed
`Read,Grep,Glob`, and Core's plan-mode mapping for `permissions: 'read-only'`
has the same MCP problem. The Core policy therefore keeps `bypass` and requests
the read-only tool set.

### Gemini plan mode and MCP

Gemini's plan mode (gemini-cli 0.49.0) removes every MCP tool from the session.
Its built-in `plan.toml` denies `toolName = "*"` at priority 40. When a mission
turn is read-only, the MCP wiring writes a user-tier policy file with one rule
per registered server (`specrails` plus injected external servers whose names
match `[A-Za-z0-9_-]`):

```toml
[[rule]]
toolName = "*"
mcpName = "specrails"
decision = "allow"
priority = 100
modes = ["plan"]
```

The rules apply only in plan mode, so they cannot widen a default or yolo turn.
Built-in write and shell tools stay denied by plan mode. Plan mode still lets
Gemini write plan Markdown files under its own `~/.gemini` plans directory,
outside every workspace.

## What stays outside the boundary

- **MCP servers.** The boundary covers the provider's own built-in tools. MCP
  servers keep their own semantics: Specrails' tools are governed by the mission
  permission ladder (observe / edit / operate / autonomous). Claude.ai connectors
  and user-configured external MCP servers run as before. Specrails does not
  vet the tools those servers expose.
- **Kimi.** Kimi Code prompt mode installs an approval handler that approves
  every tool call and rejects `--plan`. Kimi has no native read-only mode, so
  Kimi missions keep the previous behaviour. The adapter rejects `read-only`
  explicitly, so Kimi never pretends to enforce it. The turn log records
  `tools=default(unsupported)`.
- **Codex shell reads.** Codex's read-only sandbox still runs shell commands
  that do not write, such as `git status` or `ls`. Writes fail inside the
  sandbox.
- **Core sessions without tool filtering.** If a Core driver for an adapter that
  needs `tools: 'read-only'` does not advertise `toolFiltering`, Desktop keeps
  the legacy policy. Core would otherwise reject the session with
  `policy_unenforceable`.
- **Claude native sub-agents on Core sessions.** Core's read-only tool set has
  no `Agent` tool, so a Claude mission on Core sessions cannot start native
  sub-agents. Delegated sub-agents (`subagentRuntime.mode: 'delegated'`) are
  launched by Core, so the missing `Agent` tool does not affect them. Keeping
  `Agent` with read-only tools requires a Core change.

## The Flow exception

A conversation with an ACTIVE Flow runs its turns in a separate Core session
(`flow:<flowId>`) whose cwd is the Flow worktree and whose policy is the rail
write-role level: `permissions: 'bypass'`, default tools (Claude
`--dangerously-skip-permissions`, Codex `--sandbox danger-full-access`). The
agent can therefore write, run the typecheck and tests, and install
dependencies in the worktree without interactive approvals. Long-lived apps
run as Specrails background processes in the worktree, admitted below the
Autonomous level after the user's explicit confirmation, and stopped with the
Flow.

The containment is honest but not a sandbox, exactly as for rails: the cwd,
the persona rule never to touch anything outside the worktree, and the
worktree's own branch (Flow delivers only that worktree). Details:
[Flow mode › Permissions](flow-mode.md#permissions).

Everything in this document still applies to every other mission turn: when
the Flow is paused or ended, the conversation's next turn is a normal
read-only mission turn again.

## Operator features that need no native write tool

Everything the operator manual asks for already goes through MCP on the server
side. That includes code reads (`specrails_code`), git and gh diagnostics
(`specrails_git`), background applications and their logs
(`specrails_jobs background_*`), rails, specs, recovery patches
(`specrails_recovery`) and support. The manual no longer promises a raw shell.
It says that a shell, if one exists, is only for read-only git/gh diagnostics.

## Verification

- Unit and integration tests:
  [`mission-tool-policy.test.ts`](../../server/modules/missions/runtime/mission-tool-policy.test.ts),
  the read-only block of
  [`agent-chat-manager.test.ts`](../../server/modules/missions/runtime/agent-chat-manager.test.ts),
  the read-only block of
  [`mission-core-sessions.test.ts`](../../server/modules/missions/runtime/mission-core-sessions.test.ts),
  adapter argv tests, and the Gemini policy tests in
  [`agent-mcp-config.test.ts`](../../server/agent-mcp-config.test.ts).
- Live smokes (2026-10-21) used the adapter-built argv against a temporary
  directory with a stub MCP server.
  - **Claude 2.1.299 (haiku):** the MCP call ran, `secret.txt` was read, and no
    file was created, including by a sub-agent.
  - **Codex 0.160.1:** `exec --sandbox read-only` with the `-c mcp_servers.*`
    overrides. The MCP call ran, the read succeeded, and the write was refused
    by the sandbox.
  - **Gemini 0.49.0:** plan mode with the generated policy. The MCP call ran,
    the read succeeded, and `write_file` was denied by policy. Without the
    policy, the MCP tool was absent.
