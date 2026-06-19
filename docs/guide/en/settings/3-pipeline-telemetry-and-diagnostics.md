# Pipeline telemetry & diagnostics

When a pipeline job doesn't go the way you expected, telemetry gives you a detailed, behind-the-scenes record of what the AI CLI actually did. It's **off by default** and entirely opt-in, per project — turn it on only when you want it.

## What it is

Telemetry captures structured diagnostic signals (traces, metrics, and logs) emitted by the AI CLI while it runs a pipeline job. Think of it as a flight recorder for your pipeline runs: timings, token usage, and step-by-step activity, captured locally so you can inspect a job after the fact.

It's built on **OpenTelemetry**, an open, standard format — so the data isn't locked into a proprietary box.

## Turning it on

Telemetry is configured **per project**:

1. Open the project's **Settings** page (the per-project settings route).
2. Find the **Pipeline telemetry** toggle.
3. Switch it on.

From that point forward, pipeline jobs in that project record telemetry. Other projects are unaffected — each project decides for itself.

### What's covered

Telemetry applies to **pipeline jobs** (the queued Architect → Developer → Reviewer → Ship rail runs). Interactive sessions like chat and the setup wizard are intentionally left out — telemetry is meant for the repeatable, inspectable pipeline runs, not one-off conversations.

## Where the data lives

Everything stays on your machine, under your home directory (`~/.specrails/`) — never in your repo. Raw recordings are stored compressed alongside their job, and older recordings are automatically condensed into compact summaries after a week to keep things tidy. You never have to manage any of this by hand.

## Exporting a diagnostic bundle

The most useful thing telemetry unlocks is the **diagnostic export** — a single ZIP that packages up everything about a job for troubleshooting or sharing.

When a job has telemetry recorded, an **export button** appears on its job card. Click it to download a ZIP containing:

- **`job-metadata.json`** — the job's identity and parameters
- **`telemetry.ndjson`** — the raw recorded signals
- **`logs.txt`** — the captured log output
- **`summary.md`** — a human-readable summary of the run

If the project uses plugins, the bundle also includes a snapshot of which plugins were active for that job.

This is the bundle to grab when you want to understand a tricky run, keep a record, or hand details to someone helping you debug.

## Turning it off

Flip the toggle back off any time. New jobs stop recording immediately. Anything already captured stays on disk until it's compacted or you remove the project — nothing is sent anywhere or lost behind your back.
