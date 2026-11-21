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

A thin strip runs along the very bottom of the window. It looks the same in Mission and Board mode, and it stays quiet: when there is nothing to say, a spot is simply empty.

- **Connection** (left) — empty while everything is fine. It reads *Reconnecting…* (amber) or *Offline* (red) only when the app loses its local server, and *Syncing…* for a moment after it reconnects.
- **Update** (right) — appears when a new version is ready and the app has been idle for about half a minute. Click it for the update card (see [Updates](../settings/6-updates.md)).
- **Plan usage** (right) — one meter for the provider closest to its limit. It stays neutral until 80 %, turns amber with the provider's name from 80 % and red from 90 %, and shows *limit · resets 15:00* when the provider refuses requests. Hover or click it for every provider's windows and today's spend in this project.
- **App resources** (right) — an icon and the number of processes, only while work runs. Click it for CPU and memory, a memory trend and the split by source: missions and chats, rails, loops and jobs, background processes, terminals, agent CLIs, MCP and runners, Git and the Specrails server itself. Expand a source to see its processes. Below the sources, **Ports of run worktrees** lists the ports each rail's dev or test server is serving (rail, spec, project and process), and warns when another process sits in a rail's assigned ports. In the desktop app, **Keep computer awake** is also here; while it is on, a cup icon in the status bar says so (click it to allow sleep again).
- **Terminal toggle** (far right) — open the built-in terminal panel. Press **Cmd+J** (macOS) or **Ctrl+J** (Windows/Linux) to toggle it any time. It's a full shell, opened right in your project folder.

## Windows of their own

In the desktop app, some screens open as real windows instead of panels inside the main window: **Settings**, the detail of a job opened from a mission, and **Loops** and **Plugins** in Mission mode. You can move them to another screen and keep working in the main window. Each one uses the system's own window controls; Settings and the job window also close with **Escape**. Changes you make there, such as the theme or the language, apply to the main window right away. In the browser version these screens open as panels.

## Notifications that need you {#attention}

Specrails tells you when something needs you: a question or a mission reply, a review ready to decide, a run that failed, got blocked or stopped moving, a spending limit, and a finished job. How depends on where you are:

- **Away from the app** — a system notification, naming the project and the cause. In the desktop app it cannot be clicked through, so when you come back a toast sums it up and offers the way back: one item is named with its own action (**Alpha · #6 is waiting for your answer** → **Answer**), several are counted (**3 pending items**, or **2 questions and 1 review pending**) and open the inbox. Toasts that arrive while **Pick up where you left off** or the product tour is open wait until you close it, and then arrive as one.
- **In the app, somewhere else** — a small toast with **Open**.
- **Already looking at it** — nothing. A mission you are watching never notifies its own replies; a stuck run is the exception and always alerts.

Each new state of an inbox item is announced once; after a restart nothing old is announced again. In the inbox, items you have not seen yet carry a dot; **Mark as unread** and **Mark as read** change it. In the desktop app the Dock icon (the launcher on Linux) shows how many items you have not seen.

Choose what you hear about in **Settings ▸ Notifications**: turn it all off, pick the categories (questions and replies, reviews, failures, spending limits, finished jobs), add a sound, hide the Dock badge, or turn a project off. The bell next to a project's name in the inbox (**Mute notifications from …**) mutes it too, and so does **Mute notifications from …** in a row's **More actions** menu; its items still show in the inbox.

An item reads the same everywhere: the inbox row, its live board card and its notification use the same title and the same words for why it waits (for example **Project daily limit reached** · **Work paused** · **$5.12 of $5.00 spent**).

## The live board {#live-board}

The **live board** shows every run of every project in one place: rails, loops, Intent sessions and jobs. Open it from **Live board** in the left sidebar, with **Cmd+Shift+B** (**Ctrl+Shift+B** on Windows and Linux) or with **Open live board** in the command palette. It is a link too (`?live=1`), so **Back** closes it.

Choose how to read it with the selector in its header (your choice is remembered):

- **By status** — three columns. **Needs attention** is exactly what the inbox lists (reviews ready to decide, questions, failures, blocked runs, spending limits, Jira updates), oldest first, and its number is the inbox's number; each card keeps its own state lamp, so a review and a question are easy to tell apart. **Open inbox** at the top of the column opens the full list. **In progress** holds what runs, then what waits in the queue, then what is paused (with the paused lamp). **Done today** holds what finished, merged or was stopped today, and clears at midnight. A run is always in one column only.
- **By mission** — one row per mission with every run it launched, its project, engine, number of runs and what it spent today. The missions that need you come first; runs that no mission started close the list under **Not from a mission**.

Each card shows the run's state, its rail or kind (and its project when the board spans several), title, what it is doing now, its steps when it has them, the engine, how long it has run or waited, and its cost when known. A question shows its text once. A delivery that would conflict shows a short chip (**2 conflicts**); point at it or focus it to read the full sentence. The button on the card is the same action as everywhere else: **Answer**, **Open review**, **Resume**, **Retry**, **Raise limit**, or **Open**, which opens the mission that launched the run, or the run itself. Filter by project, by kind (Rails, Loops, Intent, Jobs) or by engine; the header sums up how many need you and how many are in progress (the counts of the columns you see) and what you spent today.

In the desktop app the board always opens as a window of its own, so you can keep it on a second screen: every way in brings that window forward, and **Cmd+Shift+B** shows or hides it. Its buttons, **Open inbox** included, act in the main window, which comes to the front.

## A few handy shortcuts {#shortcuts}

- **Cmd/Ctrl+B** — pin or collapse the left sidebar; **Option+Cmd+B** (**Ctrl+Alt+B**) does the same for the right sidebar.
- **Cmd/Ctrl+J** — toggle the terminal panel.
- **Cmd/Ctrl+K** — the command palette: search missions, projects and jobs, and **run actions**. Type a verb ("new", "launch", "move", "switch") or start with **>** to list actions: New spec (also in Explore), Launch or Move a spec, Open its review, Hand off or Pause an Intent session, New mission, Switch theme, Switch between Mission and Board mode, Open app or project settings on a section, Run a loop, toggle the sidebars, Go back or forward, Undo the last change, and Recently deleted. Actions that need a choice (a rail, a status, a theme, a section) open a second page; **Backspace** on an empty search returns. Each action shows its keyboard shortcut, so the palette teaches the keys. It only offers what works where you are, and it respects the same rules as the buttons (a spec that cannot launch is not offered). With an empty search it lists your **Recent actions** and **Recent places**.
- **Cmd+[ / Cmd+]** (**Alt+← / Alt+→** on Windows/Linux) or the **←  →** buttons in the title bar, or your mouse's back/forward buttons — go back or forward through the places you have been: specs, missions, jobs, projects and full-page panels. Right-click (or long-press) a button to see the last few places.
- **Cmd+Shift+I** (**Ctrl+Alt+I** on Windows and Linux) or the **Inbox** button in the title bar — the **Needs attention** inbox: everything across all your projects that waits for you, in one list grouped by project. It collects reviews ready to decide, questions an agent is waiting on, runs that failed or got blocked, runs paused at the daily budget and Jira updates that could not sync. Each row has one button for its main action (**Open review**, **Answer**, **Resume**, **Retry**, **Raise limit**); the rest is in its **More actions** menu (**⋯**): **Snooze 1 hour**, **Snooze until tomorrow**, **Done**, **Mark as read** or **Mark as unread**, and **Mute notifications from** the project. The arrow keys walk the rows' main buttons; **Tab** reaches **⋯**, the arrows move inside the menu and **Esc** closes just the menu. A snoozed or done item comes back by itself if its state changes. The button shows how many items wait; that number is the one the live board and the command palette show too. A provider-limit notification opens the inbox. The inbox is also a link (`?inbox=1`) and an action in the command palette.
- **M** — with a spec card focused on the board, opens a picker to move it to a status or a rail, the keyboard equivalent of drag and drop. It works on a multi-selection too, and the palette offers it as **Move focused spec…**.
- **?** — the shortcuts cheatsheet. Type in its search box to filter the shortcuts and to find matching pages and sections of this guide, which open in the guide without leaving your screen. The small **ⓘ** icons and **Learn more** links next to settings, rails, Intent, the context slider and budgets open the guide at the matching section the same way.

## Where to go next

That's the lay of the land. From here, the natural first move is to **add a spec** and launch it on a rail — watch the pipeline run end to end, then check **Analytics** to see what it cost. Welcome aboard.
