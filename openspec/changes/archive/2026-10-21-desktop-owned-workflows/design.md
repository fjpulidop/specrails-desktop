## Context

Desktop's `coreFactoryGraph('implement')` wraps the Core implementation subgraph. Core's phase operations contain important OpenSpec participation, verification, acceptance, scope, correction and archive policies. Loop rows are global; runtime settings are project-local. Existing runs retain their Core package and frozen inputs.

## Goals / Non-Goals

Goals: independent visible steps; editable loop-local agent definitions; global builtin behavior; immutable published/run configuration; safe compatibility. Non-goals: replace Core's scheduler/ledger, change provider transports or move repository verification commands into a globally shared recipe.

## Decisions

1. Add a Core `implementation-step` operation that executes exactly one selected phase and returns named outcomes. It reuses phase policy, never compiles or executes the implementation subgraph. Desktop owns all successor edges, including correction and recovery. Existing wrapper support is compatibility-only.
2. Independent operations share private state committed with the durable terminal result. User-editable variables cannot forge acceptance or completed phase state. Verification receipts and journal snapshots retain existing ownership. Nested or parallel scopes must not accidentally share a journal.
3. Add versioned `graph.config.agents` configuration with loop-owned assignments, prompts and workflow policy. It is part of draft/published snapshots, export and duplication. New factory defaults are deterministic and do not depend on the active project. Engine defaults resolve only from the selected global connection.
4. New admissions combine loop workflow settings with project-owned verification and global connections. Project agent assignments and prompts do not override loop-owned values. Resume continues using frozen files and the retained package.
5. The loop editor owns agent model, effort, thinking, turns, escalation and editable definitions. Project settings retain host/repository settings. Legacy files remain available for explicit import and old executions; they are not deleted or silently applied to the shared builtin.
6. Capability-gate the expanded factory graph. Preserve edited builtin rows and legacy graphs; migration is explicit for user content. Recovery is tested against the selected operation and candidate evidence, not a fabricated success flag.

## Risks / Trade-offs

- Splitting execution loses hidden state → store operation state in protected terminal results and test restart/correction paths.
- Project-dependent builtin defaults → seed neutral global defaults and test different projects resolving identical agents.
- Removing wrapper policies weakens completion → reuse phase policies, keep evidence gates and real paired execution tests.
- Existing custom loops inherit project roles → preserve them until explicitly migrated; expose import in the loop editor.
- Updating an edited builtin overwrites user work → leave edited rows intact and make restore/duplicate explicit.

## Migration Plan

Ship the Core capability first, then Desktop's gated factories/editor/admission. Unmodified defaults refresh through the existing seed protocol. Edited recipes remain intact. Export/import and duplication retain agent configuration. Old project files and retained packages remain recoverable. Rollback uses existing retained-run packages and preserved original recipes rather than rewriting live snapshots.

## Open Questions

None requiring user input: the user explicitly selected global loop agents and duplication for project-specific variants.


## Scope correction: workflow-defined steps

The earlier implementation-step split preserved fixed Core phase presets. New
recipes instead use generic role-turn pieces and custom loop-defined role IDs.
The loop owns prompts, permissions, OpenSpec skill binding, structured output
schemas, confidence questions, review thresholds and correction edges. Core
provides reusable artifact-contract checks, verified candidate guards, approval
interrupts, verification receipts and scoped checkpointing, with no phase choice
in newly authored agent steps. Legacy pieces remain readable/executable only for
saved workflows and retained snapshots. Generic gates must reject altered frozen
artifacts, incomplete tasks, stale review/approval candidates and uncovered
verification repositories. Artifact contracts are scoped durable host state;
agent text and editable workflow variables cannot replace them.
