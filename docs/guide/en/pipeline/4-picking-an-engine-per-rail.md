# Picking an engine per rail

Specrails desktop treats **Claude Code**, **Codex CLI**, and **Gemini CLI** as first-class engines. A project can have one, two, or all three installed — and when more than one is present, you choose which engine runs each rail. This page covers the per-rail engine selector and when to reach for each.

## When the selector appears

The **engine selector** lives in the rail header, right alongside the mode control. It only renders when the project has **more than one** provider installed.

> **Single-provider projects behave byte-identically.** If a project has just one engine, no selector shows and nothing about provider selection changes — it just runs on that engine. The selector is purely for multi-provider projects.

When it does appear, your choice is **per rail and per launch** — different rails can run different engines, and your pick is remembered per project (defaulting to the project's primary engine).

## How to pick an engine

1. Make sure the rail's engine selector is showing (project has 2+ providers).
2. Click it and choose **Claude**, **Codex**, or **Gemini**.
3. Launch the rail with **▶ Play**.

The selected engine runs every phase of that rail's pipeline. If the chosen engine's CLI isn't installed, the launch fails fast — nothing spawns. Install the missing CLI and try again.

## What each engine is good at

All three run the standard **Implement** and **Batch** pipelines. Here's a practical guide to choosing:

| Engine | Reach for it when… | Notes |
|--------|--------------------|-------|
| **Claude** | You want the full feature set: agent profiles, Freestyle, native cost reporting, the richest tool support. The default for most work. | The only engine that supports **agent profiles**, **Freestyle**, and a few Claude-only spec features (Contract Layer, SMASH). |
| **Codex** | You prefer the OpenAI Codex CLI or want to compare implementations across providers. | `codex` ≥ 0.128.0. No native cost reporting — the app fills in cost from its rate card. Profiles don't apply. |
| **Gemini** | You want Google's Gemini CLI, native telemetry, or a cheaper run for routine specs. | `gemini` ≥ 0.11.0 (set `GEMINI_API_KEY`). Native OTLP telemetry. Profiles don't apply. |

### The Claude-only features

A few things only work on Claude rails — pick Claude if you need them:

- **Agent profiles** — per-agent model routing. On Codex or Gemini rails the run always uses legacy mode and any selected profile is **ignored**. The profile picker is hidden for non-Claude engines.
- **Freestyle** — the autonomous, pipeline-bypassing mode. The `Freestyle` segment and its Haiku/Sonnet/Opus model picker only appear when the rail's engine is Claude.
- **Contract Layer & SMASH** — Claude-only spec-refinement features (these are Add-Spec options, not rail options, but the same constraint applies).

If a project mixes engines, the right sidebar only shows sections **every** installed provider supports — so the **Agents** section disappears entirely on a project that includes any non-Claude provider, because profiles are Claude-specific.

## A practical workflow

Multi-provider projects shine when you want to **compare** or **cost-tune**:

- **Compare implementations.** Put the same spec on two rails, set one to Claude and one to Codex, launch both (across projects, or one after the other in the same project's queue), then use the **Compare** button on the Jobs page to diff the results.
- **Cost-tune by spec.** Run high-stakes specs on Claude with a `max` profile; run routine cleanup specs on Gemini to save on spend. Filter `/analytics` by engine to see the breakdown.
- **Default sensibly.** Set your most-used engine as the project's primary so rails default to it, and only switch per-rail when a specific spec wants a different engine.

## Things to keep in mind

- **Provider selection is immutable after project creation** (v1). You choose installed providers when you add the project; there's no Settings toggle to add or remove one later.
- **Cost is always tracked**, even for engines without native cost reporting — the app falls back to a rate card so Codex and Gemini runs still show up in [analytics](../analytics/tracking-cost).
- **The terminal's "Open AI CLI" button** also offers a provider picker on multi-provider projects, if you'd rather drive a CLI by hand.

## Where to go next

- [Using Codex](../integrations/using-codex) — install and sign in.
- [Using Gemini](../integrations/using-gemini) — install, `GEMINI_API_KEY`, telemetry.
- [Rails & jobs](rails-and-jobs) — the queue and launch flow.
- [Tracking cost](../analytics/tracking-cost) — per-engine cost breakdown.
