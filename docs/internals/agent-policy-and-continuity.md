# In-turn agent policy and restart continuity

Two safety nets around agent work that the run's own permission mode cannot
provide:

- **In-turn policy** — a Claude `PreToolUse` hook that denies a short list of
  destructive or credential-touching tool calls *before* they run, in every
  Specrails-owned run directory.
- **Restart continuity** — durable markers for mission turns in flight, a
  "Pick up where you left off" dialog after a restart, and an update card that
  waits until nothing is running.

User guide: [Agent safety policy](../guide/en/pipeline/6-agent-safety-policy.md),
[Updates](../guide/en/settings/6-updates.md). Modules:
[agent-policy](../../server/modules/agent-policy/README.md),
[continuity](../../server/modules/continuity/README.md),
[client continuity](../../client/src/features/continuity/README.md).

## Why a hook

Claude runs and missions launch with `--dangerously-skip-permissions`
(`server/providers/claude-adapter.ts`, Core's Claude driver and role executor).
Claude Code still runs `PreToolUse` hooks in `bypassPermissions` mode and honours
a `deny` decision — verified on Claude Code 2.1.322 with a haiku turn: the tool
result became `PreToolUse:Bash hook error: <reason>` and the stream carried
`tool_result_meta[].permission_decision.source: "hook"`. The hook is therefore the
only enforcement point that covers adapter-launched runs, Core sessions and Core's
role executor alike.

## Deny list

Implemented in `server/modules/agent-policy/domain/rules.ts`; the git rules come
from [`server/git-guardrails.ts`](../../server/git-guardrails.ts), the same file the
app's own push path (`pr-publisher`) uses — one rule set.

| Rule id | Denies |
|---|---|
| `git-force-push` | `push --force`/`-f`/`--force-with-lease[=…]`/`--mirror`/combined short flags, `+src:dst` refspecs |
| `git-push-protected` | a push whose destination is `main`, `master`, the run checkout's `origin/HEAD` branch or the target repo's; an implicit push (`git push`, `HEAD`) resolves to the current branch; an unresolvable destination is denied |
| `git-push-delete` | `push --delete`/`-d`, `:dst` refspecs |
| `git-reset-hard` | `reset --hard` unless the target dir is inside the run directory, on the run's own branch, and that branch is not protected |
| `git-branch-delete` | deleting a protected branch, the run's own branch, or any branch when the target is outside the run directory |
| `gh-pr-merge` | `gh pr merge` |
| `rm-outside-run` | `rm -r*`, `rimraf`, `npx rimraf`, `find … -delete`/`-exec rm`, `git clean -f` whose targets are not strictly inside the run directory or a temp dir (`os.tmpdir()`, `/tmp`, `/private/tmp`); targets that cannot be resolved (`$VAR`, `$(…)`, `xargs`) are denied; a trailing `/` follows a symlinked operand (warm `node_modules` links point at the base checkout) |
| `secret-access` | any tool path or shell word resolving (lexically or through symlinks) into `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/Library/Keychains`, `/Library/Keychains`, or the Specrails secret store (`<home>/.specrails/{jira-secret.key,desktop.token,hub.token,mcp.token}`); `security find-*-password`/`dump-keychain`/`export`/`unlock-keychain` |
| `policy-tamper` | writes into `<home>/.specrails/agent-policy/` |
| `policy-error` | fail-closed fallback, below |

The run directory is `CLAUDE_PROJECT_DIR` (Claude sets it for hooks): the worktree
or the app-owned mission cwd. Git facts (current branch, `origin/HEAD`) are read
from `.git` files — the hook never spawns `git`. The shell reader
(`domain/shell.ts`) splits commands on `;`, `&&`, `||`, `|`, `&`, newlines and
parentheses, follows `cd`/`pushd`, strips wrappers (`sudo`, `env`, `command`,
`timeout`, `nice`, assignments), reads nested scripts (`$(…)`, backticks,
`bash -c`, `eval`) and skips heredoc bodies. It is a guard rail, not a sandbox:
an agent determined to evade it (writing a script then running it, an
interpreter one-liner) is out of scope.

## Failure policy (fail open, except the deny list)

`hook/policy-hook.ts` documents it; tests cover each case.

- The hook never answers `allow` (that would skip Claude's own permission checks
  such as plan mode or `--disallowedTools`); it prints `{}` (no decision) or a deny.
- Malformed/empty input, another event, no tool name → `{}`.
- An exception while evaluating → deny (`policy-error`) only if the raw tool input
  matches a deny-list shape (`DENY_LIST_HINT`), else `{}`.
- 3 s watchdog → `{}`. Claude's own `timeout: 10` → non-blocking error (tool runs).
- The hook cannot start (Node missing, script deleted, app moved) → Claude reports
  a non-blocking hook error and the tool runs. A broken install must never wedge
  every tool call of every run; the server rewrites the script at startup and the
  settings on the next mission turn or worktree overlay pass.

Measured cost: ~70 ms per tool call (Node start + evaluation).

## Installation

- **Script**: `scripts/build-policy-hook.mjs` bundles `hook/main.ts` (rules +
  `git-guardrails.ts`, no dependencies) into a CommonJS string in
  `hook/policy-hook-bundle.generated.ts` (checked in; a test fails when stale;
  `npm run build:policy-hook`). The server writes it at startup to
  `<home>/.specrails/agent-policy/specrails-policy-hook-<hash>.cjs` (0600), so dev,
  npm package and packaged sidecar ship it identically with no extra resource.
  Superseded versions are kept 14 days for runs still referencing them.
- **Command**: `'<node>' '<script>' --specrails-home '<home>'`; `<node>` is the
  bundled runtime when present, else `node` on PATH.
- **Where**: `.claude/settings.local.json` (Claude runs use
  `--setting-sources project,local`), only in directories Specrails owns:
  - the app-owned mission cwd (`<home>/.specrails/agent-cwd`), merged before each
    Claude mission turn; the connectors deny-list writer
    (`writeClaudeConnectorDenyFile`) now owns only `deniedMcpServers` and keeps
    every other key, and the policy owns only hook entries whose command names
    `specrails-policy-hook` (`domain/settings.ts`);
  - isolated worktrees (rails, loops, PR-CI runs, Intent sessions) through the
    worktree overlay: `.claude/settings.local.json` becomes an overlay-managed
    COPY of the sources' file plus the hook (never a link that could write through
    to the workspace or the person's repo). It is in the overlay's created paths
    (excluded from commits, removed at release) and its cleanup evidence is
    authenticated structurally (stripping our hook yields the source content). A
    checkout that brings its own `settings.local.json` keeps it and the run goes
    without the hook (overlay warning).
- **Not covered**: runs in the person's own checkout (non-isolated rails, Explore,
  setup) — Specrails never writes there; Windows (the rules are POSIX); Codex
  (its hooks live in the user's Codex home and require trust approval, so
  installing them would change the person's own Codex configuration — Codex runs
  keep the post-turn git checks of the delivery path).
- **Kill switch**: `SPECRAILS_AGENT_POLICY_HOOK=false` stops installing and strips
  the entry from the files Specrails writes next.

## Reporting a denial

The hook needs no port, token or server. Denials travel two ways:

1. **In band.** The deny reason ends with `[specrails-policy:<rule>]`. Every
   stream Specrails consumes carries the blocked call's error result:
   - Claude stream-json (`user` frames): the audit stream tap records a row
     (`source: policy-hook`, target `denied by policy (<rule>): <attempted target>`)
     next to the attempt it already recorded, and `extractDisplayText` writes one
     log line `[specrails-policy:<rule>] <reason>` that the Job and Loop log viewers
     render as a **Blocked by Specrails policy** row;
   - legacy mission turns (`tool-result` events) and Core sessions (`turn.tool`
     completed, `isError`) record the audit row and post a `policy-denied`
     system row in the mission (deduplicated per tool-use id).
   Recognition (`parsePolicyDenial`) requires the text to start with the hook's
   lead (`Blocked by Specrails policy:`, optionally behind Claude's prefix) and end
   with the marker, so command output that prints the marker is not a denial.
2. **Disk spool.** Core's role executor (engine-v2 steps) forwards only
   `tool-start` events. The hook also writes each denial to
   `<home>/.specrails/agent-policy/denials/*.json` (0600, at most 1000 waiting).
   The server drains it every 15 s after a 20 s grace (streams record first),
   matches the worktree to `rail_worktrees.run_id`, skips denials the stream
   already recorded (`hasPolicyDenial`), redacts the command and records the row.
   Mission-cwd reports are dropped (always in band); unmatched ones are kept an
   hour. Those runs get the audit row but no transcript row until Core forwards
   tool results.

## Restart continuity

Server: `server/modules/continuity` (state file
`<home>/.specrails/turn-continuity.json`, 0600, atomic).

- `AgentChatManager` reports turn start/settle through `setTurnLifecycleObserver`.
  A start writes a marker `{conversationId, startedAt, provider, sessionId,
  trigger: 'crash'}`; a settle removes it, except `interrupted` settles and anything
  after shutdown began.
- `shutdown()` calls `recordShutdown()` first: markers become `quit`, or `update`
  when the client announced an update restart (`POST /api/continuity/shutdown-intent`
  within 5 minutes); it also records the loop runs still `running`. A marker never
  stamped stays `crash`.
- Startup promotes markers to offers before any turn runs. `offers()` drops
  stale ones: mission deleted/archived/running now, provider changed, or a different
  session — compared by root: the session the turn started with must still be the
  mission's; a session born during the cut turn (null at start) still matches. A new
  turn in the mission removes its offer.
- Routes: `GET /api/continuity/resume-offers` (offers, interrupted runs, `bootedAt`),
  `POST /api/continuity/resume-offers/settle` (`{conversationIds, runs?}`),
  `POST /api/continuity/shutdown-intent` (`{trigger:'update'}`),
  `GET /api/continuity/active-work` (`missions`, `runs`, `total`).

Client:

- `ResumeAfterRestartDialog` (main window, once per launch) lists offers and the
  runs the restart paused (matched to their Inbox items). Nothing runs without a
  click. A mission resumes through the normal send path with a short localized
  continuation message and queue id `resume-<conversation>-<startedAt>`
  (idempotent); its provider session is resumed (`--resume` / Core session). A run
  uses the Inbox's Resume (`POST /loop-runs/:id/resume`), so rail restart-pause
  semantics are unchanged. "Not now" dismisses the offers; runs stay in the Inbox.
  Pending messages still show their `interrupted` receipt; they are never replayed.
- Launch order is owned by `client/src/lib/startup-queue.ts`: crash banner (not
  modal) → this dialog (the only launch modal; it holds the queue) → product tour
  (clean first launch only; deferred after a crash or with offers) → the update
  offer (a status-bar chip after ~30 s idle with no dialog open) → attention
  toasts held during a launch modal, then grouped.
- The update card asks `/active-work` before restarting. Busy → it says what would
  stop and offers **Install when nothing is running** (polls every 5 s, restarts at
  zero) or **Restart now**. Every restart first posts the `update` intent.
- Crash-interrupted runs are not listed in the dialog (no shutdown record); they
  remain in the Inbox.

## Session ids passed to `--resume`

`server/providers/session-id.ts` rejects ids that are empty, longer than 512
characters, padded, start with `-`, or contain control characters. Applied in the
Claude, Codex, Gemini and local adapters and to Core's `providerSessionRef`
(`core-session-runner.ts`); Kimi already validated its ids.

## Follow-ups

- Core: forward `tool-end` with the error text from the role executor (transcript
  rows for engine-v2 denials) and accept a settings path for its Claude driver (so
  runs in a person's own checkout can be covered without writing there).
- Codex: an opt-in Codex hook in a Specrails-managed `CODEX_HOME`.
- Use `Stop`/`Notification` hook events for exact Core-session waiting/finished
  status (not done: Core already reports turn boundaries, and an extra hook on every
  stop adds latency for little gain today).
- Record runs in flight continuously so crash-interrupted runs can be offered too.
