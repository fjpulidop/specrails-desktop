# Picking an engine per rail

## When the selector appears

The **engine selector** lives in the rail header, right alongside the mode control. It only renders when the project has **more than one** provider installed.

> **Single-provider projects behave byte-identically.** If a project has just one engine, no selector shows and nothing about provider selection changes — it just runs on that engine. The selector is purely for multi-provider projects.

When it does appear, your choice is **per rail and per launch** — different rails can run different engines, and your pick is remembered per project (defaulting to the project's primary engine).

## How to pick an engine

The selected engine runs every phase of that rail's pipeline. If the chosen engine's CLI isn't installed, the launch fails fast — nothing spawns. Install the missing CLI and try again.

## What each engine is good at

Both run the standard **Implement** pipeline. Here's a practical guide to choosing:

| Engine | Reach for it when… | Notes |
|--------|--------------------|-------|
| **Claude** | You want native billed cost, persistent job interaction, and the richest hard tool-policy controls. | Supports profiles, Freestyle, and structured transforms such as Contract Layer/SMASH. |
| **Codex** | You prefer the OpenAI Codex CLI or want to compare implementations across providers. | `codex` ≥ 0.128.0. No native cost reporting — the app fills in cost from its rate card. Profiles don't apply. |

### Capability differences

A few things need a provider with the matching capability:

- **Freestyle** — Claude supports this autonomous,
  pipeline-bypassing mode with provider-specific models.

## A practical workflow

Multi-provider projects shine when you want to **compare** or **cost-tune**:

- **Compare implementations.** Put the same spec on two rails, set one to Claude and one to Codex, launch both (across projects, or one after the other in the same project's queue), then use the **Compare** button on the Jobs page to diff the results.
- **Default sensibly.** Set your most-used engine as the project's primary so rails default to it, and only switch per-rail when a specific spec wants a different engine.

## Things to keep in mind

- **Provider selection is immutable after project creation** (v1). You choose installed providers when you add the project; there's no Settings toggle to add or remove one later.
- **The terminal's "Open AI CLI" button** also offers a provider picker on multi-provider projects, if you'd rather drive a CLI by hand.

## Where to go next

- [Using Codex](../integrations/using-codex) — install and sign in.
- [Rails & jobs](rails-and-jobs) — the queue and launch flow.
- [Tracking cost](../analytics/tracking-cost) — per-engine cost breakdown.
