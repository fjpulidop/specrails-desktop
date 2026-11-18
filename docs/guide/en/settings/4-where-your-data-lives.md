# Where your data lives

Short version: **Specrails keeps your repositories pristine.** When you point the app at one of your projects, it does not move in, scatter config files around, or rewrite anything you didn't ask it to. Your code stays yours, and clean.

## Your repo stays clean

Specrails's own files — its databases, per-project state, agent definitions, settings, telemetry, summaries, and everything else it needs to run — live in a single tidy home under your home directory:

```
~/.specrails/
```

**Settings ▸ About** shows the exact database location and the version of the app you are running.

That folder is the app's private workspace. It's where the project registry, per-project databases, bundled tooling, and all the operational bits live. Your actual code repositories are never used as a dumping ground for any of it.

This means:

- Your repo's `.gitignore` is **not** rewritten by the app.
- Your repo isn't littered with tool config or hidden state directories.
- Removing a project from Specrails doesn't leave a mess behind in your code.

If you've used tools before that quietly added folders and files all over your project, this is a deliberate departure. Specrails is built so that pointing it at a repo is a **non-event** for that repo's git history.

## The one thing that *is* committed — by design

There's exactly one intentional exception, and it's the whole point of the tool: **your OpenSpec specs.**

Specs live in your repository, under:

```
openspec/
```

This is on purpose. Your specs are a **deliverable** — a versioned, reviewable record of what you decided to build and why. They belong next to your code, tracked in git, visible in pull requests, shared with your team. That's the value: specs aren't disposable scratch state, they're part of your project's history.

So the rule is simple and honest:

- **`openspec/`** → lives in your repo, committed, by design.
- **Everything else Specrails needs** → lives under `~/.specrails/`, out of your way.

## Why it works this way

Specrails runs the AI tooling from its own private workspace (under `~/.specrails/`) and reaches back into your real repository only for the things that genuinely need to touch it — reading your code, and writing the specs you asked for. The tooling, the framework definitions, and the bookkeeping all stay in the app's home folder.

The upshot for you: you can add a project, run pipelines, explore specs, and try things out with confidence that your repository's working tree and git history only ever change in ways you'd expect — your committed specs, and the code your pipelines write. Nothing else sneaks in.

## Removing a project

When you remove a project from Specrails, the app cleans up its own per-project state under `~/.specrails/`. The specs already committed to your repo stay where they belong — in your repo — because they're yours.

## Run worktrees kept on disk {#retained-worktrees}

Each rail run works in its own Git worktree under `~/.specrails/projects/<project>/worktrees/`. When a run settles, Specrails removes that worktree — but only when it can prove nothing would be lost. When it can't (uncommitted changes, files that exist only there, or a removal that failed), it keeps the worktree. Over time these add up.

**Settings ▸ Storage** lists them for every project. You can also get there from the status bar's **App resources** popover. Each worktree shows its size (measured in the background), how long it has been idle, its PR, and what removing it would lose:

- **Nothing to lose**: no uncommitted changes, and every ignored file is regenerable (`node_modules`), a link, or identical to the same file in your main checkout (a copied `.env`, for example). Every commit on its branch is on a remote or on another branch, or its delivery was merged.
- **Waiting for you**: something still needs you. Each reason is listed: uncommitted changes, ignored files that exist only here, commits only on this branch, a delivery that still waits for your decision, recent activity (the last hour), or Git couldn't check it. When Git can't check a worktree, it is never treated as clean.

Select worktrees and choose **Remove**. The confirmation says how much disk you get back and what happens to branches:

- Branches are **kept** by default, so their commits stay available.
- With **Also delete branches that hold nothing new**, a branch is deleted only when it has nothing to lose, and only if it still points at the commit Specrails checked.

Worktrees with uncommitted changes or files that exist only there can't be selected. Commit, copy or discard that work first. A worktree that belongs to an Intent session is listed but handled from its session. Right before removal, each worktree is checked again: if anything changed after you confirmed, it is kept and the result says why. Processes left running in a removed worktree (a dev server, for example) are stopped.
