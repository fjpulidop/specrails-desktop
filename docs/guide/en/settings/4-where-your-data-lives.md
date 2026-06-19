# Where your data lives

Short version: **Specrails keeps your repositories pristine.** When you point the app at one of your projects, it does not move in, scatter config files around, or rewrite anything you didn't ask it to. Your code stays yours, and clean.

## Your repo stays clean

Specrails's own files — its databases, per-project state, agent definitions, settings, telemetry, summaries, and everything else it needs to run — live in a single tidy home under your home directory:

```
~/.specrails/
```

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
