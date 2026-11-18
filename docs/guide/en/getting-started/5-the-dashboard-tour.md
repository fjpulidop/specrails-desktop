# The dashboard tour

With a project added, you're looking at your **project dashboard** — your home base for turning specs into shipped code. Here's how to find your way around.

## The big picture

The window has three zones:

- **Left sidebar** — your list of projects. Click any project to switch to it instantly; everything else in the window updates to match. The **Add project** button lives here too.
- **Main area** — the dashboard for the active project: your specs and the pipeline that runs them.
- **Right sidebar** — navigation between the sections of the current project.

## The main dashboard

This is where the work happens. The dashboard shows:

- **Your specs** — the specs you've created, organized by status (Backlog/To-Do through Done). You can view them as a list, a grid, or sticky-note cards, whichever you prefer.
- **A way to add a spec** — start a new piece of work. You can write a quick spec directly, or open a guided **Explore** chat that helps you shape it through conversation and drafts the spec for you.
- **Rails** — these are the lanes where specs get built. Drop a spec onto a rail and launch it to send it through the Architect → Developer → Reviewer → Ship pipeline. Multiple rails can run at once, so you can work on several things in parallel.

When a spec is running, you'll see its pipeline progress and live logs — the AI's real-time output as it designs, codes, and reviews your change.

## The right sidebar: project sections

The right sidebar is your switchboard for the current project. Hover it to expand, or pin it open. The sections you'll see:

- **Dashboard** — the specs board and rails (where you just were).
- **Jobs** — every pipeline run for this project, past and present, with status, duration, and the ability to dig into any run's detail and logs.
- **Integrations** — optional add-ons, like connecting your specs to a **Jira** board or enabling extra tooling for the AI.
- **Settings** — per-project options (telemetry, budgets, provider configuration, and more).

## The status bar

A thin strip runs along the very bottom of the window. It's small but handy:

- **Connection indicator** (left) — a coloured dot and label showing the app is live: green for *connected*, amber while *reconnecting*, blue while *syncing* just after a reconnect. You'll rarely need it, but it's reassuring when you do.
- **Total spend** (right) — a running total of what you've spent, so cost is always one glance away.
- **Resources** (right) — how much CPU and memory everything Specrails launched is using right now, and how many processes. Click it for the totals, a memory trend and the split by source: missions and chats, rails, loops and jobs, background processes, terminals, agent CLIs, MCP and runners, Git and the Specrails server itself. Expand a source to see its processes.
- **Terminal toggle** (far right) — open the built-in terminal panel. Press **Cmd+J** (macOS) or **Ctrl+J** (Windows/Linux) to toggle it any time. It's a full shell, opened right in your project folder.

## Windows of their own

In the desktop app, some screens open as real windows instead of panels inside the main window: **App settings**, the detail of a job opened from a mission, and **Loops** and **Plugins** in Mission mode. You can move them to another screen and keep working in the main window. Each one uses the system's own window controls; Settings and the job window also close with **Escape**. Changes you make there, such as the theme or the language, apply to the main window right away. In the browser version these screens open as panels.

## Notifications that need you {#attention}

Specrails tells you when something needs you: a question or a mission reply, a review ready to decide, a run that failed, got blocked or stopped moving, a spending limit, and a finished job. How depends on where you are:

- **Away from the app** — a system notification, naming the project and the cause. In the desktop app it cannot be clicked through, so when you come back a toast sums it up (**3 things need you**) and opens the item, or the inbox when there are several.
- **In the app, somewhere else** — a small toast with **Open**.
- **Already looking at it** — nothing. A mission you are watching never notifies its own replies; a stuck run is the exception and always alerts.

Each new state of an inbox item is announced once; after a restart nothing old is announced again. In the inbox, items you have not seen yet carry a dot; **Mark as unread** and **Mark as read** change it. In the desktop app the Dock icon (the launcher on Linux) shows how many items you have not seen.

Choose what you hear about in **Settings ▸ Notifications**: turn it all off, pick the categories (questions and replies, reviews, failures, spending limits, finished jobs), add a sound, hide the Dock badge, or turn a project off. The bell next to a project's name in the inbox mutes it too; its items still show in the inbox.

## The live board {#live-board}

The **live board** shows every run of every project in one place: rails, loops, Intent sessions and jobs. Open it from **Live board** in the left sidebar, with **Cmd+Shift+B** (**Ctrl+Shift+B** on Windows and Linux) or with **Open live board** in the command palette. It is a link too (`?live=1`), so **Back** closes it.

Choose how to read it with the selector in its header (your choice is remembered):

- **By status** — four columns. **Needs you** is exactly what the inbox lists (questions, failures, blocked runs, spending limits, Jira updates), oldest first. **In progress** holds what runs, then what waits in the queue. **To decide** holds work ready for your review. **Done today** holds what finished, merged or was stopped today, and clears at midnight. A run is always in one column only.
- **By mission** — one row per mission with every run it launched, its project, engine, number of runs and what it spent today. The missions that need you come first; runs that no mission started close the list under **Not from a mission**.

Each card shows the run's state, project, rail or kind, title, what it is doing now, its steps when it has them, the engine, how long it has run or waited, and its cost when known. A question shows its text. The button on the card is the same action as everywhere else: **Answer**, **Open review**, **Resume**, **Retry**, **Raise limit**, or **Open**, which opens the mission that launched the run, or the run itself. Filter by project, by kind (Rails, Loops, Intent, Jobs) or by engine; the header sums up how many need you, how many are in progress and what you spent today.

In the desktop app, **Open in window** moves the board to a window of its own, for a second screen. Its buttons act in the main window, which comes to the front.

## A few handy shortcuts {#shortcuts}

- **Cmd/Ctrl+B** — pin or collapse the left sidebar; **Option+Cmd+B** (**Ctrl+Alt+B**) does the same for the right sidebar.
- **Cmd/Ctrl+J** — toggle the terminal panel.
- **Cmd/Ctrl+K** — the command palette: search missions, projects and jobs, and **run actions**. Type a verb ("new", "launch", "move", "switch") or start with **>** to list actions: New spec (also in Explore), Launch or Move a spec, Open its review, Hand off or Pause an Intent session, New mission, Switch theme, Switch between Mission and Board mode, Open app or project settings on a section, Run a loop, toggle the sidebars, Go back or forward, Undo the last change, and Recently deleted. Actions that need a choice (a rail, a status, a theme, a section) open a second page; **Backspace** on an empty search returns. Each action shows its keyboard shortcut, so the palette teaches the keys. It only offers what works where you are, and it respects the same rules as the buttons (a spec that cannot launch is not offered). With an empty search it lists your **Recent actions** and **Recent places**.
- **Cmd+[ / Cmd+]** (**Alt+← / Alt+→** on Windows/Linux) or the **←  →** buttons in the title bar, or your mouse's back/forward buttons — go back or forward through the places you have been: specs, missions, jobs, projects and full-page panels. Right-click (or long-press) a button to see the last few places.
- **Cmd+Shift+I** (**Ctrl+Alt+I** on Windows and Linux) or the **Inbox** button in the title bar — the **Needs you** inbox: everything across all your projects that waits for you, in one list grouped by project. It collects reviews ready to decide, questions an agent is waiting on, runs that failed or got blocked, runs paused at the daily budget and Jira updates that could not sync. Each row has its main action right there (**Open review**, **Answer**, **Resume**, **Retry**) plus **Snooze** (1 hour or until tomorrow) and **Done**. A snoozed or done item comes back by itself if its state changes. The button shows how many items wait, and a provider-limit notification opens the inbox. The inbox is also a link (`?inbox=1`) and an action in the command palette.
- **M** — with a spec card focused on the board, opens a picker to move it to a status or a rail, the keyboard equivalent of drag and drop. It works on a multi-selection too, and the palette offers it as **Move focused spec…**.
- **?** — the shortcuts cheatsheet. Type in its search box to filter the shortcuts and to find matching pages and sections of this guide, which open in the guide without leaving your screen. The small **ⓘ** icons and **Learn more** links next to settings, rails, Intent, the context slider and budgets open the guide at the matching section the same way.

## Where to go next

That's the lay of the land. From here, the natural first move is to **add a spec** and launch it on a rail — watch the pipeline run end to end, then check **Analytics** to see what it cost. Welcome aboard.
