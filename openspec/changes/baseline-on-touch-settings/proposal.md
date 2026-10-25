## Why

Core can now describe legacy code before changing it (Core `baselineOnTouch: 1`, contract 5.7): characterization tests proven on the unchanged code plus a minimal as-built spec. Desktop must let a project opt in, show what was created, keep its cost apart and explain the blocker when the tests fail on the base. This is Phase 3 task 3.4 (Desktop) of the feedback-2026-10 program.

## What Changes

- **Setting.** Project setting `baselineOnTouch` (default off), forwarded to Core's runtime config only when Core announces the capability. The bridge also strips `architect.clarifications` for a Core without `architectClarifications`. The vendored runtime schema matches Core 5.7 byte for byte.
- **Packet.** **Spec created where the work passed**: module described, as-built requirements per capability (demonstrated count from the spec trace), characterization tests, status and Core's reason when blocked.
- **Cost apart.** The baseline spend (`efficiencySummary.baseline`) appears in the section and as "baseline $X of it" in the cost line. The efficiency summary reader accepts the `baseline` invocation kind.
- **Blocker.** `baseline_characterization_failed` becomes a clear sentence in the run's error text.

## Capabilities

### New Capabilities
- `baseline-on-touch-settings`: the per-project switch, packet section, separate cost and blocker message for Core's baseline on touch.

## Impact

- **Server:** `project-settings`, `agent-runtime` (bridge switches, error text, metrics reader, schema), `loops/runtime/loop-executors.ts` (`projectRuntime`), `project-registry.ts`, `delivery` (run records, harvest, packet).
- **Client:** settings switch, `PacketBaseline`, packet cost line, locales (settings, packet ×8).
