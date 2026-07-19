# Picking an engine per rail

Specrails desktop treats **Claude Code**, **Codex CLI**, **Gemini CLI**, and
**Kimi Code** as first-class engines. A project can install any compatible
combination and, when more than one is present, choose which engine runs each
rail.

## When the selector appears

The **engine selector** lives in the rail header, right alongside the mode control. It only renders when the project has **more than one** provider installed.

> **Single-provider projects behave byte-identically.** If a project has just one engine, no selector shows and nothing about provider selection changes — it just runs on that engine. The selector is purely for multi-provider projects.

When it does appear, your choice is **per rail and per launch** — different rails can run different engines, and your pick is remembered per project (defaulting to the project's primary engine).

## How to pick an engine

1. Make sure the rail's engine selector is showing (project has 2+ providers).
2. Click it and choose **Claude**, **Codex**, **Gemini**, or **Kimi**.
3. Launch the rail with **▶ Play**.

The selected engine runs every phase of that rail's pipeline. If the chosen engine's CLI isn't installed, the launch fails fast — nothing spawns. Install the missing CLI and try again.

## What each engine is good at

All four run the standard **Implement** and **Batch** pipelines. Here's a practical guide to choosing:

| Engine | Reach for it when… | Notes |
|--------|--------------------|-------|
| **Claude** | You want native billed cost, persistent job interaction, and the richest hard tool-policy controls. | Supports profiles, Freestyle, and structured transforms such as Contract Layer/SMASH. |
| **Codex** | You prefer the OpenAI Codex CLI or want to compare implementations across providers. | `codex` ≥ 0.128.0. No native cost reporting — the app fills in cost from its rate card. Profiles don't apply. |
| **Gemini** | You want Google's Gemini CLI, native telemetry, or a cheaper run for routine specs. | `gemini` ≥ 0.11.0 (set `GEMINI_API_KEY`). Native OTLP telemetry. Profiles don't apply. |
| **Kimi** | You want Kimi Code's autonomous agentic CLI for implementation, Batch, Freestyle, or loops without a Decider. | External `kimi` ≥ 0.27.0. Profiles/manual roles and K3 low/high/max effort are supported; tokens and USD cost are unavailable. |

### Capability differences

A few things need a provider with the matching capability:

- **Agent profiles** — Claude and Kimi support provider-scoped profiles. Codex
  and Gemini rails use legacy mode.
- **Freestyle** — Claude and Kimi support this autonomous,
  pipeline-bypassing mode with provider-specific models.
- **Loop Decider** — Kimi runs loops without a Decider. Its `continue`/`stop`
  verdict needs a pure-output boundary unavailable in `kimi -p`.
- **Structured spec and read-only AI transforms** — Quick Spec, AI Edit,
  Contract Layer, SMASH/Re-SMASH, Project Builder generation, file summary/
  construction story, and Agent Studio automation are unavailable for Kimi.

In mixed Claude/Kimi projects, profiles and integration state are scoped to the
selected provider; an identically named profile does not leak across engines.

## A practical workflow

Multi-provider projects shine when you want to **compare** or **cost-tune**:

- **Compare implementations.** Put the same spec on two rails, set one to Claude and one to Codex, launch both (across projects, or one after the other in the same project's queue), then use the **Compare** button on the Jobs page to diff the results.
- **Cost-tune by spec.** Run high-stakes specs on Claude with a `max` profile; run routine cleanup specs on Gemini to save on spend. Filter `/analytics` by engine to see the breakdown.
- **Default sensibly.** Set your most-used engine as the project's primary so rails default to it, and only switch per-rail when a specific spec wants a different engine.

## Things to keep in mind

- **Provider selection is immutable after project creation** (v1). You choose installed providers when you add the project; there's no Settings toggle to add or remove one later.
- **Available metrics are always tracked.** Codex/Gemini cost uses a rate card;
  Kimi has no authoritative token or USD-cost stream, so those fields remain
  unavailable rather than becoming a fabricated estimate.
- **The terminal's "Open AI CLI" button** also offers a provider picker on multi-provider projects, if you'd rather drive a CLI by hand.

## Where to go next

- [Using Codex](../integrations/using-codex) — install and sign in.
- [Using Gemini](../integrations/using-gemini) — install, `GEMINI_API_KEY`, telemetry.
- [Using Kimi](../../../kimi.md) — external CLI setup and complete capability matrix.
- [Rails & jobs](rails-and-jobs) — the queue and launch flow.
- [Tracking cost](../analytics/tracking-cost) — per-engine cost breakdown.
