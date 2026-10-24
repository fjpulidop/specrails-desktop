## Why

Teams already write their rules in CLAUDE.md, AGENTS.md and CONTRIBUTING and already run gates (lint, type checks, architecture tests, CI). Core's rules inventory (`.specrails/rules.json`, annex D.5, Core `rulesInventory: 1`) classifies each rule as enforced, automatable or human-only. Desktop must show it, turn automatable rules into work, remind reviewers of the human-only ones and reuse the gates. This is Phase 4 task 4.4 (Desktop) of the feedback-2026-10 program.

## What Changes

- **Module `project-rules`.** Pure parser (gates, rules, counts, human-only list, gate → verification command, rule → spec draft), effectful reader/runner, HTTP adapter.
- **Project settings panel.** **Project rules**: gates, rules grouped by status, **Re-run inventory**, **Create spec** for automatable rules (ticket source `rules`).
- **Packet.** **Needs human eyes** lists the human-only rules frozen at settle.
- **Default verification plan.** The verification suggestions offer the inventory's plain gate commands first.
- **Capabilities endpoint.** `GET /core/phase3-capabilities` for the settings UI.

## Capabilities

### New Capabilities
- `project-rules-inventory`: the project's gates and classified rules surfaced in settings, specs, the review packet and the verification suggestions.

## Impact

- **Server:** new `modules/project-rules`, `project-router-rules.ts`, ticket source `rules`, `delivery/runtime/phase3-harvest.ts`, `agent-runtime-settings-router.ts`, architecture rule and manifest.
- **Client:** `ProjectRulesSection`, `NeedsHumanEyes`, locales (settings, packet ×8).
