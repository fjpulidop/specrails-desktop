# The integrated terminal

Specrails has a real terminal built right in — the panel that slides up from the bottom of the window, just like the one in VS Code or Cursor. It runs your actual shell, in your actual project directory, so you can run `git`, `npm`, tests, or anything else without leaving the app.

## Opening and closing it

The fastest way is the keyboard: **Cmd+J** (macOS) or **Ctrl+J** (Windows/Linux) toggles the panel open and closed, and focuses the terminal the moment it appears so you can start typing immediately. You can also use the chevron in the status bar.

The panel has three states:

- **Hidden** — tucked away.
- **Restored** — the normal split-height panel.
- **Maximized** — taking over the work area when you need room to read output.

Minimizing the panel (the chevron) does **not** stop anything — your shells keep running in the background. The only thing that actually ends a session is closing it (the trash icon, or the per-tab ✕).

## Multiple sessions

You can run several terminals at once in the same project — up to ten. Each gets its own tab; you can rename them so "dev server" and "tests" don't get confused. They all start in your project folder and load your shell profile (`.zshrc`, `.bashrc`, and so on), so your aliases and PATH are exactly what you'd expect.

Here's the important part: your terminals **survive switching projects and tabs**. Specrails keeps each session alive and intact behind the scenes — scrollback, running processes, everything — so flipping over to Analytics and back doesn't reset your shell or interrupt a long-running command. Sessions only end when you explicitly close them (or when you remove the whole project).

## Per-project, remembered

Whether the panel is open, how tall you've dragged it, which tabs exist — all of that is remembered **per project**. Come back to a project and it's set up the way you left it.

## The premium features

This isn't a bare-bones console. The terminal ships with the niceties you'd want from a first-class one:

- **Fast, crisp rendering** via WebGL (with an automatic fallback so it never breaks), full Unicode width handling, and font ligatures.
- **Search your scrollback** with **Cmd+F** — great for finding that error buried 500 lines up.
- **Font zoom** with **Cmd+=**, **Cmd+-**, and **Cmd+0** to reset.
- **Clipboard shortcuts** — Cmd+C / Cmd+V to copy and paste, Cmd+K to clear — plus a right-click context menu.
- **Drag-and-drop file paths** (in the desktop app): drop a file onto the terminal and its path is inserted, correctly quoted for your shell.
- **Smooth resizing** — dragging the panel height or collapsing the sidebar won't make the output jitter.
- **Inline images** — terminals that emit Sixel or iTerm2-style images render them right in place.
- **Shell integration** — Specrails knows where each command starts and ends, so it can track your command history and notify you when a long-running command finishes (a desktop notification, with a browser fallback). If your shell can't be instrumented for some reason, it degrades quietly and tells you once.

## Settings

Terminal preferences live in two layers: an app-wide default and an optional per-project override. The per-project setting wins when present, so you can keep a global look-and-feel while tweaking one project that needs something different.

## Turning it off

The terminal is on by default. If you'd rather not have it, it can be disabled via the `VITE_FEATURE_TERMINAL_PANEL` (client) or `SPECRAILS_TERMINAL_PANEL` (server) flags — set either to `false`. Most people will simply leave it on.
