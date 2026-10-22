## Context

Missions drive the app through the Specrails MCP bridge (`specrails_*`), gated by the per-turn capability and tier ladder. Provider adapters already know a `read-only` tool policy for pure-output work: Claude uses plan mode, `--safe-mode` and `Read,Grep,Glob`; Codex uses the read-only sandbox; Gemini uses plan mode; the local runner uses read-only built-ins. Kimi rejects it. Those modes were designed for transforms without MCP. Missions are the opposite case: MCP is their only effector.

## Goals / Non-Goals

**Goals:** missions cannot write workspaces with native tools on any transport where the provider can enforce it. Specrails MCP tools keep working for every provider. The change can be rolled back with an env flag. Providers that cannot comply are documented honestly.

**Non-Goals:** changing Core drivers. Changing the MCP tier ladder. Restricting user-configured MCP servers or claude.ai connectors. Building Flow.

## Decisions

1. **Live verification decided the per-provider argv.** A stub stdio MCP server, a temporary directory and a three-step prompt (MCP call, read, write) were run against each candidate.
   - **Claude 2.1.299.** `plan + --safe-mode` unloads `--mcp-config`. `plan` without safe mode, with or without `--allowedTools mcp__specrails`, makes the model refuse state-changing MCP calls. `--dangerously-skip-permissions --tools Read,Grep,Glob` keeps MCP and refuses writes.
   - **Codex 0.160.1.** `--sandbox read-only` keeps MCP and refuses writes.
   - **Gemini 0.49.0.** `--approval-mode plan` hides MCP tools. Adding `--policy` with `toolName="*" mcpName="specrails" decision="allow" modes=["plan"]` restores them and still denies `write_file`.
2. **`retainMcpTools` instead of a new `toolPolicy` value.** `read-only` keeps its meaning (no workspace writes) and its capability gate (`toolPolicies`). The flag only selects the MCP-compatible realisation. Claude is the only adapter whose argv changes. Codex and the local runner already keep MCP. Gemini needs a file, which belongs in the MCP wiring (`prepareAgentMcp`, `readOnly: true`) rather than in a pure argv builder.
3. **Claude's mission tool set is `Read,Grep,Glob,Agent,WebFetch,WebSearch`.** None of these write or execute. Sub-agents inherit the restricted set (verified). Web tools keep research available. Missions previously had the full default set.
4. **Core session mapping is an adapter capability (`missionReadOnlySession`), not a provider branch.** Core's Claude driver maps `permissions: 'read-only'` to plan mode, which has the same MCP problem, so Claude keeps `bypass` and requests `tools.mode: 'read-only'`. Codex has no tool filtering but enforces `permissions: 'read-only'` through its sandbox. A `tools` restriction is only sent to a driver advertising `toolFiltering`; otherwise the legacy mapping stays, because Core refuses unenforceable policies.
5. **Kill switch in `feature-flags.ts`** (`SPECRAILS_MISSION_READ_ONLY !== 'false'`), consistent with the other server gates. With it off, argv and session policy are identical to before the change.
6. **The operator prompt stays static** (byte stability). The manual stops promising a raw shell and says the session is read-only. Every operator feature (code reads, git/gh, background apps, recovery patches) already runs server-side through MCP.

## Risks / Trade-offs

- Claude missions on Core sessions lose native sub-agents, because Core's read-only tool set has no `Agent` tool. Mitigation: delegated sub-agents still work, and a Core follow-up can add `Agent` when native sub-agents are allowed.
- `--dangerously-skip-permissions` remains on Claude mission turns. The boundary is the tool set, not the permission mode. MCP servers keep their own governance, so external MCP servers and claude.ai connectors that can write remain outside the boundary (documented).
- Gemini can still write plan Markdown files into its own `~/.gemini` plans directory, outside every workspace.
- Kimi missions stay write-capable until Kimi Code gets a headless read-only mode.
- A future Claude or Gemini release could change how plan mode or `--tools` treat MCP. The adapter tests pin the argv, and the internals doc records the smoke procedure to repeat.
