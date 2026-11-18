# If the local server stops {#server-recovery}

Specrails runs a small server on your computer that keeps your projects, rails, missions and terminals going. The desktop app watches it and brings it back if it stops.

## What happens when the server stops

- **Specrails restarts it for you.** The server comes back on the same address and the open windows reconnect on their own; the status bar shows **Reconnecting** for a few seconds.
- **A banner explains what happened**: when the server stopped and why (an exit code or a signal). Work that was running at that moment may have been interrupted: check its status and retry it if needed.
- **At most three restarts a minute.** If the server keeps stopping, Specrails stops restarting it so it does not hide a problem, and shows a dialog. Choose **Try again** to start it now, or quit and reopen Specrails. Your saved projects stay on disk.
- **The next start explains it too.** If Specrails was closed while the server was stopped, the banner appears the next time you open it.

Choose **Dismiss** on the banner once you have read it; it will not appear again for those stops.

## Report a problem {#report-a-problem}

**Report a problem** saves a ZIP on your computer that helps someone understand what went wrong. Nothing is uploaded: you decide whether to share it, and with whom.

Open it from:

- **Report a problem** on the banner,
- **Settings ▸ About ▸ Report a problem**,
- the command palette (**⌘K**), by typing *report a problem*.

Before you save, the window lists every file in the report and shows its content. The ZIP contains exactly what you see:

| File | Contents |
| --- | --- |
| `README.txt` | What the report is and what each file holds |
| `system.json` | App and Core versions, operating system, memory |
| `settings.json` | App settings, without tokens, keys, passwords, environment values or headers |
| `server.log` | Output of the running server since it started |
| `sidecar-stderr.log` | Recent error output of the server, including earlier runs that stopped (desktop app) |
| `desktop.log` | When the server started, stopped and was restarted (desktop app) |
| `crashes.json` | Each unexpected stop, with its last error lines |
| `stalls.json` | Moments the server was unresponsive |

Tokens, API keys, passwords, private keys and credentials in URLs are replaced with `***` or `[REDACTED]`, and your home folder is shown as `~`. Read the files before you share them all the same: a project name or a file name you consider private can still appear.

## Responsiveness {#responsiveness}

The **Resources** popover in the status bar also shows **Responsiveness**: how many times the server was unable to answer for 200 ms or more, the longest of those moments and what it was doing at the time. Frequent long stalls are worth a problem report.
