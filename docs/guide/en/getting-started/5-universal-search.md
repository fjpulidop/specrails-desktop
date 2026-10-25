# Universal search (⌘K)

Press **⌘K** (**Ctrl+K** on Windows and Linux) to search almost everything in Specrails from one place: missions, specs, job logs, files, settings and this guide. Type a plain query to search missions, projects, specs and recent jobs as before, or start with a **prefix** to search one source only.

## Prefixes

| Type | Searches | Enter opens |
| --- | --- | --- |
| `#` | Specs: title, summary, description, labels, out-of-scope notes, addenda and comments. `#12` finds spec 12. | The spec |
| `@` | Missions: title and conversation content. | The mission |
| `/` | Settings (Desktop and project) by name or by what you would call them. | The settings window at that block, scrolled into view and focused |
| `f:` | Files of the project, by name or path. | The file in the Code explorer |
| `log:` | Job logs: commands, loop names, phase titles and failure diagnoses. | The job |
| `?` | This guide: page titles and headings. | The guide at that heading |

When you type a prefix it becomes a **chip** in the search box and the box keeps only your query. Press **Backspace** on an empty box (or click the chip's ×) to drop the scope. With an empty box, the palette lists the prefixes under the box; click one to start. `>` still lists actions, as before.

## Highlights

Results show a short snippet around the first match, with the matching text highlighted. Matching ignores case and accents, so `revision` finds "Revisión".

## Settings

`/` knows the main settings blocks, in your language: theme, language, editor, budgets, notifications, webhooks, updates, branch, environment, telemetry, rules and more. Project settings are offered when a project is open. Pick one and the right window opens at that block. Without a prefix, a strong match (three or more characters) adds up to three settings to the normal results.

## Job logs

`log:` searches a compact index, not the raw output of a run: the command, the loop name, the phase titles and the short diagnosis of a failed, blocked or stalled run. It never stores token streams or tool output, so it stays small and fast. It is kept per project and holds the latest runs.

## Good to know

- `#`, `f:` and `log:` search the active project; open a project first.
- The files scope respects the Code explorer's ignore rules.
- Each group shows only its best few results; refine the query to narrow it down.
