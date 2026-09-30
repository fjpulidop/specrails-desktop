# Code explorer

The **Code** section gives you a friendly, read-only window into your repository — designed especially for people who want to understand what the AI has been building without living in an editor. You get a file tree on the left, a code viewer on the right, and, above the code, a plain-language summary of what each file actually does.

It's strictly read-only in this version: nothing you do here changes your files. Think of it as a reading room, not a workshop.

Open it from the right sidebar (**Code**), and like everything else it's scoped to your current project.

## The file tree

The left pane is a virtualised tree of your project's files — fast even on large repos. It respects your `.gitignore` and a built-in deny-list, so you see the files that matter, not a sea of build artifacts and `node_modules`.

Next to files you'll notice **provenance chips** — little markers that tell you a file was *touched by AI*. This is the heart of the Code explorer: Specrails records which files each pipeline job created or modified, and ties them back to the ticket that prompted the work. So you can answer, at a glance, "did the AI write this, or did I?"

At the top of the tree there's a filter:

- **Tocado por IA / Touched by AI** (the default) — only files the AI has changed.
- **All files** — the full tree.

Your choice is remembered per project, so if you mostly care about AI-authored changes you'll see them first every time.

## The code viewer

Click a file and it opens in a full-featured viewer (powered by Monaco, the same engine as VS Code) with proper syntax highlighting that matches your chosen app theme. A few sensible limits keep things smooth: binary files are politely refused, and very large files (over 2 MB) won't load.

Your current file is saved in the page URL, so you can bookmark or share a link straight to a specific file.

Since editing isn't part of this version, the viewer offers an **Edit in external editor** button that copies the file's absolute path — paste it into your editor of choice and pick up there.

## AI summaries

Above the code you'll see a **plain-language summary** of the file — what it's for, what it does — written so a non-developer can follow along. These are generated for you and cached, so opening a file you've looked at before is instant.

Summaries are smart about staying fresh: they're keyed to the file's contents, so when a file genuinely changes the summary is regenerated, but unchanged files don't get re-summarised needlessly. If you edit a file yourself, its summary is marked as stale rather than silently regenerated — you stay in control of when it's refreshed. There's a **regenerate** action when you want a fresh take on demand.

A couple of guardrails keep costs sane: summary generation runs within a **monthly budget** (a few dollars by default, configurable in Settings), and there are caps on how many summaries a single job will kick off. If a summary is skipped, the app tells you why — budget reached, a per-job cap, or the file simply not being found.

You can also choose the **summary language** (English or Spanish) in the global settings under the *Code section* area.

## The construction story

Beneath the code viewer lives the **construction story** — a chronological timeline of every spec and job that built the file you're looking at. Each chapter is a card: which spec intervened (with its live status), when, whether the file was created, modified or deleted, and how big the change was (lines added and removed). Click a spec card to open that ticket's detail. Loop-based rails record their file touches too, so work done in isolated worktrees shows up in the story just like regular pipeline jobs.

For any chapter you can ask for a plain-language explanation: press **Explain this change** and the app writes one to three sentences describing what that specific change contributed to the file — no code, no jargon. Explanations share the same monthly budget as file summaries, and until one is generated the card falls back to the honest facts it knows: the kind of change, the spec, and the date. Prefer the raw data? A **Story / Log** toggle switches to the classic touch-history list with on-demand diffs. The same story panel appears in Agent Mode's **Files** pane.

## Connecting code back to specs

The provenance link runs both ways. Inside the Code explorer, clicking a ticket chip on a file opens that ticket's detail. And from the other direction, the **ticket detail** view has a *Files touched by this ticket* section — click a file there and you jump straight into the Code explorer with it open. It closes the loop between "here's the spec we wrote" and "here's the code that came out of it."

## What it doesn't do (yet)

To set expectations clearly, this first version intentionally leaves a few things out: in-app editing, per-symbol or directory-level summaries, a narrative diff view, and conversational "ask the AI about this file." Provenance attributes a file to its primary ticket only. These are the kinds of things that may grow over time.

## Turning it off

The Code explorer is on by default. It can be disabled with the `VITE_FEATURE_CODE_EXPLORER` (client) or `SPECRAILS_CODE_EXPLORER` (server) flags — set either to `false`. Turning it off leaves all your recorded data and summaries safely on disk, untouched, in case you switch it back on.
