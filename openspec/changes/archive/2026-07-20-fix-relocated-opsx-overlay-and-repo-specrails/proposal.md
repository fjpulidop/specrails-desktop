# Fix relocated artifact-surface gaps: opsx overlay + repo `.specrails` pollution

## Why

Three relocation-hygiene bugs were confirmed on a relocated project (live evidence: an `SDD Quick (OpenSpec)` loop on `brain-ai-coach-service`):

1. **Isolated rails lose `/opsx:*` commands.** OpenSpec installs its provider command dirs into the REPO (`<repo>/.claude/commands/opsx/*.md`, untracked — the documented repo-resident carve-out; `installOpenSpecProject(codeRoot, …)` in specrails-core). The bundled framework's `commands/` contains only `specrails/`, so a relocated workspace has no `opsx/` either. The per-run worktree overlay sources ONLY the workspace for relocated projects (`overlaySourceRoot = workspaceDir`), so a `git worktree add` checkout (tracked files only) never receives the untracked repo-resident opsx commands. The claude CLI reports `Unknown command: /opsx:ff|apply|verify`, every SDD-Quick step completes in 0.0s doing nothing, and the loop decider blocks. Legacy projects are unaffected (their overlay source IS the repo).

2. **Explore with MCP writes `.specrails/local-tickets.json` into the repo.** `ChatManager._resolveSpawnCwd` returns `<project.path>` whenever `contextScope.mcp` is `true`, bypassing the relocation gate. The Explore system prompt instructs the model to "write directly to .specrails/local-tickets.json" (cwd-relative), and at the high tier the model retains Bash — so on a relocated project it creates `<repo>/.specrails/local-tickets.json`, violating the pristine-repo guarantee AND writing to a store the desktop never reads (the real store is in the workspace). For a relocated project the correct MCP-honouring cwd is the WORKSPACE: that is where `.mcp.json` and `.specrails/` live after relocation.

3. **Pre-existing Explore sessions cannot be resumed from the corrected cwd.** Claude's resumable sessions are cwd-scoped. An MCP-enabled Explore conversation created before this fix has its session under the repo cwd, so its first corrected `--resume` from the workspace can fail with the specific diagnostic `No conversation found with session ID`. Returning to the repo would recreate bug 2; the compatibility path must instead recover once as a fresh workspace turn with bounded conversational context. Contract Refine inherits the same old-session boundary because it normally resumes the Explore session.

## What Changes

- The worktree overlay accepts ordered fallback source roots. Relocated isolated launches pass `[workspace, repo]`: the workspace stays the primary source (framework surface), and the repo's untracked on-disk provider-dir entries (openspec's `/opsx:*` commands, `openspec-*` skills, user extras) fill the gaps — restoring parity with legacy behaviour. First root wins on conflicts; checkout content still always wins over any source.
- When more than one source root contributes children to the same directory, the overlay materializes a REAL directory with per-child links instead of a whole-dir symlink. On resume it rebuilds authenticated prior whole-dir links/copies when merging is required or a higher-priority root becomes the winner; foreign entries remain untouched. Cleanup-evidence authentication accepts any configured root.
- Explore turns with `contextScope.mcp === true` route through the relocation gate: relocated ⇒ spawn cwd is the WORKSPACE, legacy ⇒ `<project.path>` (byte-identical). The `SPECRAILS_EXPLORE_LEGACY_CWD=1` escape hatch keeps forcing `<project.path>` everywhere.
- For a pre-existing relocated Explore session, only the exact missing-session diagnostic triggers one compatibility retry: a fresh turn from the workspace (never the repo) carrying a bounded excerpt of persisted conversation context. The same recovery applies to spawn-per-turn and persistent-stdin transports; the latter replaces only the stale child and otherwise retains its transport/lifecycle semantics. Contract Refine uses the same narrow trigger to retry fresh from the workspace with tools disabled and the target ticket seeded into its prompt.

## Capabilities

### Modified Capabilities

- `rail-parallel-isolation`: the per-run worktree overlay requirement gains multi-source semantics (workspace primary + repo fallback for relocated projects).
- `explore-spec`: the Explore spawn-cwd requirement's `mcp: true` branch becomes relocation-aware (workspace when relocated).

## Impact

- `server/worktree-overlay.ts` — `fallbackSourceRoots` on `WorktreeOverlayInput`, N-way merge, multi-root evidence authentication.
- `server/rail-isolated-launch.ts` — passes `[workspace, repo]` roots at both the overlay-apply and evidence-revalidation sites.
- `server/chat-manager.ts` — `_resolveSpawnCwd` mcp-true branch routes through `resolveProjectExecution`; persistent and crash-respawn paths retain the relocation env; old cwd-scoped sessions get the one-shot fresh-workspace compatibility retry.
- `server/contract-refine-runner.ts` — the resumed Contract Refine turn mirrors the same relocation-aware Explore cwd and falls back once to a no-tools, ticket-seeded fresh workspace invocation for the exact missing-session diagnostic.
- `server/workspace-manager.ts` — corrects a stale comment claiming `/opsx:*` lives in the framework `commands/` subtree.
- **Out of scope:** installing opsx into the shared framework bundle; shared-cwd (non-isolated) relocated spawns that need `/opsx:*` from the workspace itself; auto-deleting a stray `<repo>/.specrails/` (manual cleanup — the app must never delete repo content it cannot prove it owns); the dormant setup-enrich spawn (`_spawnSetupWithAdapter`, legacy flow not exposed in the app) and the ai-edit read-only cwd.
