## Context

Core reads `baselineOnTouch` from `.specrails/agent-runtime.json`; an older Core rejects unknown keys. Core writes `baseline.json` and reports `efficiencySummary.baseline {invocations, roles, costUsd, inputTokens, outputTokens}` plus a sixth invocation kind `baseline`.

## Goals / Non-Goals

**Goals:** opt-in per project without breaking older Cores; show the baseline honestly with its cost apart; make the blocker obvious.

**Non-Goals:** enabling by default (pending measurement); estimating a baseline cost the provider did not report.

## Decisions

- **Project setting in SQLite, injected at launch.** Loop executors read `projectRuntime()` at each launch; the bridge applies `applyPhase3RuntimeSwitches` with the loaded Core's capabilities right before validation.
- **Reader compatibility.** `readRuntimeEfficiencySummary` previously required exactly five invocation kinds and would have dropped every 5.7 summary; it now accepts the optional sixth.
- **Cost source.** The run's runtime history (engine-2 definition runs); otherwise "not reported".

## Risks / Trade-offs

- Baseline cost is unavailable for runs without a runtime history → the section says so instead of showing zero.
