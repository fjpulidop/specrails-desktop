# The dashboard tour

With a project added, you're looking at your **project dashboard** — your home base for turning specs into shipped code. Here's how to find your way around.

## The big picture

The window has three zones:

- **Left sidebar** — your list of projects. Click any project to switch to it instantly; everything else in the window updates to match. The **Add project** button lives here too.
- **Main area** — the dashboard for the active project: your specs and the pipeline that runs them.
- **Right sidebar** — navigation between the sections of the current project.

## The main dashboard

This is where the work happens. The dashboard shows:

- **Your specs** — the tickets you've created, organized by status (Backlog/To-Do through Done). You can view them as a list, a grid, or sticky-note cards, whichever you prefer.
- **A way to add a spec** — start a new piece of work. You can write a quick spec directly, or open a guided **Explore** chat that helps you shape it through conversation and drafts the ticket for you.
- **Rails** — these are the lanes where specs get built. Drop a spec onto a rail and launch it to send it through the Architect → Developer → Reviewer → Ship pipeline. Multiple rails can run at once, so you can work on several things in parallel.

When a spec is running, you'll see its pipeline progress and live logs — the AI's real-time output as it designs, codes, and reviews your change.

## The right sidebar: project sections

The right sidebar is your switchboard for the current project. Hover it to expand, or pin it open. The sections you'll see:

- **Dashboard** — the specs board and rails (where you just were).
- **Jobs** — every pipeline run for this project, past and present, with status, duration, and the ability to dig into any run's detail and logs.
- **Analytics** — what your AI usage is costing. Spending broken down by day, by activity, by model, and by ticket — so there are no surprises.
- **Agents** — your project's agent profiles: which agents run in the pipeline and which AI models they use. *(Claude-powered projects only.)*
- **Code** — a read-only file browser with plain-language AI summaries, and chips showing which files the AI has touched. Great for non-developers who want to follow along.
- **Integrations** — optional add-ons, like connecting your specs to a **Jira** board or enabling extra tooling for the AI.
- **Settings** — per-project options (telemetry, budgets, provider configuration, and more).

> Some sections only appear when they make sense for the providers you chose — for example, **Agents** is specific to Claude. If you don't see a section, it simply doesn't apply to this project's setup.

## The status bar

A thin strip runs along the very bottom of the window. It's small but handy:

- **Connection indicator** (left) — a coloured dot and label showing the app is live: green for *connected*, amber while *reconnecting*, blue while *syncing* just after a reconnect. You'll rarely need it, but it's reassuring when you do.
- **Total spend** (right) — a running total of what you've spent, so cost is always one glance away.
- **Terminal toggle** (far right) — open the built-in terminal panel. Press **Cmd+J** (macOS) or **Ctrl+J** (Windows/Linux) to toggle it any time. It's a full shell, opened right in your project folder.

## A few handy shortcuts

- **Cmd/Ctrl+B** — pin or collapse the sidebars.
- **Cmd/Ctrl+J** — toggle the terminal panel.
- **Cmd/Ctrl+K** — open search.

## Where to go next

That's the lay of the land. From here, the natural first move is to **add a spec** and launch it on a rail — watch the pipeline run end to end, then check **Analytics** to see what it cost. Welcome aboard.