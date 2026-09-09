# Pipeline telemetry & diagnostics

Telemetry records pipeline diagnostics locally. It is **on by default** for projects without a saved preference. You can turn it off per project; an explicitly saved choice is preserved.

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


## Completion evidence

Loop history stores a terminal result independently of optional provider telemetry.
It separates process execution from Core acceptance and delivery, and distinguishes
steps, decider evaluations and agent turns. Phase durations and attempts come from
Core's journal; no per-phase cost is inferred from the total. Older runtimes keep
acceptance evidence unavailable. See the implementation result in the batch guide.
