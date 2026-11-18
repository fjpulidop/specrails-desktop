# Agent safety policy {#agent-safety-policy}

Agents in rails, loops and missions work without asking you before each command. That keeps them fast, but a few actions are too risky to leave to the agent. Specrails checks every tool call a **Claude** agent makes against a short deny list, before the call runs, and blocks the ones on the list.

## What is blocked, and why

| Blocked | Why |
|---|---|
| **Force-push** (`--force`, `--force-with-lease`, `+branch`, `--mirror`) | It rewrites shared history. |
| **Push to the integration branch** (your project's default branch, `main` or `master`) | Work reaches it only through a pull request a person merges. |
| **Deleting a remote branch** | Branches are cleaned up with the delivery, not by the agent. |
| **`git reset --hard` off the run's own branch** | Allowed on the run branch inside the run; anywhere else it can destroy someone's work. |
| **Deleting branches** that are protected, the run's own, or outside the run | Same reason. |
| **Merging a pull request** (`gh pr merge`) | You decide what gets merged. |
| **Recursive deletes outside the run** (`rm -rf`, `rimraf`, `find -delete`, `git clean -f`) | Only the run's worktree and temp folders may be wiped. A delete whose target cannot be known (`rm -rf "$DIR"`, `xargs rm -rf`) is blocked too. |
| **Reading or writing credentials**: `~/.ssh`, `~/.aws`, `~/.gnupg`, keychains and the Specrails secret store | Agents never need your keys. |
| **Changing the policy's own files** | So an agent cannot switch it off. |

Everything else runs as before.

## What you see

- The agent gets the reason and carries on without that action, or explains what it needs.
- The run log or the mission shows a **Blocked by Specrails policy** row with the rule and the reason.
- The [agent actions audit](3-reviewing-a-delivery.md) records each denial (source `policy-hook`), next to the attempted action.

## Where it applies

- Isolated rails, loops and Intent sessions (each runs in its own worktree) and missions.
- **Claude only.** Codex has no equivalent Specrails can install without changing your own Codex configuration; for Codex runs, Specrails keeps checking the branch and the delivery after each turn.
- Runs that work directly in your project folder (not isolated) are not covered: Specrails never writes into your own checkout.
- macOS and Linux. On Windows the policy is not installed yet.

## Good to know

- This is a guard rail, not a sandbox. It stops the common destructive commands; it does not make a hostile agent safe.
- If the check itself fails, the call goes ahead, except when it looks like something on the deny list: then it is blocked. A broken check never stops every agent.
- To switch it off in an emergency, start Specrails with `SPECRAILS_AGENT_POLICY_HOOK=false`.
