# Git invocations: optional locks, index.lock and prompt diff budgets

Specrails runs `git` constantly: in the person's checkouts (the git bar, checkout
preflight, local integration) and in run worktrees while an agent is working
there (non-convergence fingerprint, settlement, release, Changes tab). Three
shared helpers in `server/util/` keep those calls from getting in the agent's or
the person's way.

## Reads never take optional locks — `git-invocation.ts`

`git status`, `git diff` and similar reads refresh the index as a side effect and
write that refresh back under `index.lock`. A Specrails poll landing while an
agent runs `git add`/`git commit` in the same worktree could make the agent's
command fail with "index.lock: File exists".

`isReadOnlyGitInvocation(args)` classifies an argv (global options such as
`-c k=v`, `-C dir`, `--literal-pathspecs` are skipped). `gitInvocationEnv(env, args)`
adds `GIT_OPTIONAL_LOCKS=0` for a read and returns the env untouched for a write.
The classifier is conservative: unknown subcommands, and known ones used in a
writing form (`branch -D`, `config k v`, `symbolic-ref HEAD <ref>`, `stash push`),
count as writes. `merge-tree` and `stash create` count as reads (they write
objects, never refs or the index).

Every git spawn routes its env through it:

| Spawn | File |
| --- | --- |
| Bounded exec (`runBounded`/`execBounded`, whenever the command is `git`) | `server/util/bounded-exec.ts` |
| Delivery `GitRunner` (`defaultGitRunner`) | `server/worktree-manager.ts` |
| PR/remote exec (`createBoundedExec`) | `server/modules/delivery/runtime/pr-publisher.ts` |
| Review packet Changes reader | `server/modules/delivery/runtime/delivery-changes.ts` |
| Git bar and checkout | `server/project-git.ts` |
| `specrails_git` diagnostics | `server/git-diagnostics.ts` |
| Code explorer ignore probe | `server/modules/code/runtime/code-explorer-router.ts` |
| Sync probes (repository identity, change-id probe, verification suggestions) | `project-repositories.ts`, `loops/runtime/loop-executors.ts`, `agent-runtime/runtime/agent-runtime-verification-suggestions.ts` |

Write paths (clone, blueprint init, push, commit) are unaffected by design.

## index.lock awareness — `git-index-lock.ts`

- **Live lock.** A `status` through the `GitRunner`, the git bar and the
  `specrails_git` status/diff diagnostics first waits up to 1 s (50 ms polls) for
  an existing `index.lock` to go away, so it reads the settled index instead of
  a half-staged commit.
- **Stale lock.** The same lock (inode + mtime) that survives the full wait is
  remembered (bounded, 64 entries) and later reads do not wait for it again; a
  different lock gets its own wait.
- **Messages.** A git write that fails on the lock gets an explanation appended
  to its stderr (lock path, how long it has been unchanged, that Specrails never
  deletes it). The diagnostics result carries `indexLock` (`path`, `stale`,
  `ageMs`, `note`). Release verification that finds dirt while a lock remains
  says so instead of only "changes made after settlement".
- The lock path is resolved from the filesystem (`.git` directory or a linked
  worktree's `gitdir:` file); no git process is spawned. Specrails never removes
  a lock.

## Fair diff budgets for prompts — `diff-prompt-budget.ts`

`truncateDiffForPrompt(diff, budget)` splits a unified diff at `diff --git`
boundaries, gives every file an equal share, redistributes what small files do
not need (`allocateBudgetFairly`), clips each oversized file on a line boundary
with a `…(diff truncated, N characters omitted)` marker and ends with a summary
(`N of M files truncated, K omitted`). The result never exceeds the budget. A
lockfile can therefore no longer hide every other change.

Desktop consumers: the file-story summary patch/excerpt
(`code/runtime/file-story.ts`) and the Intent derivation diffstat
(`intent/adapters/bindings.ts`, whole-line clip). Reviewer, merge-resolver and
PR-body prompts in Desktop do not embed diff text today (the agents read the
worktree themselves; the PR body uses `--shortstat`/`--name-status`); any new
prompt that embeds a diff must use this helper rather than `slice`.
