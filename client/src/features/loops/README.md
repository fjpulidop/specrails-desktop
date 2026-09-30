# loops

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/LoopPreviewModal.tsx](components/LoopPreviewModal.tsx)
- [components/LoopWindowSurface.tsx](components/LoopWindowSurface.tsx)
- [components/loop-log/LoopStepExplorer.tsx](components/loop-log/LoopStepExplorer.tsx)
- [components/loop-log/NarratedProgress.tsx](components/loop-log/NarratedProgress.tsx)
- [lib/loop-run-models.ts](lib/loop-run-models.ts)
- [lib/loop-ticket-need.ts](lib/loop-ticket-need.ts)
- [lib/loop-windows.ts](lib/loop-windows.ts)
- [lib/loops-api.ts](lib/loops-api.ts)
- [pages/LoopBuilderPage.tsx](pages/LoopBuilderPage.tsx)
- [pages/LoopsPage.tsx](pages/LoopsPage.tsx)

## Feature dependencies

- [browser](../browser/README.md)
- [jobs](../jobs/README.md)
- [missions](../missions/README.md)
- [projects](../projects/README.md)
- [providers](../providers/README.md)
- [settings](../settings/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.

Run the adjacent tests with `npm run test --prefix client -- src/features/loops`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.

The log explorer consumes Core's public `runtime-graph.graph` through the pure
`runtime-topology` parser. `RuntimeGraphExplorer` renders its actual transitions,
supports nested components, and focuses exact scoped attempts in the existing log
pipeline. It cannot edit or execute a graph; those actions belong to the builder
and server control routes. Recorded trace identifiers are optional.

## Workflow agents

The builder edits agent definitions and engines in `graph.config.agents`. These
settings are shared across projects using the published loop. Duplicate a loop
for specialized recipes. `LoopAgentsEditor` imports historical project agents
only on explicit action and discards responses after project switches. See
[workflow ownership](../../../../docs/internals/desktop-owned-workflows.md) for
compatibility and frozen-run behavior.

The inspector is empty until a node is selected. Selecting a step opens its
agent definition, engine and phase policy directly, including in custom loops.
Advanced settings contains workflow-wide limits, guardrails and composition;
clicking a node or the canvas closes it. Agent forms follow the roles used by the current graph and its referenced components, using
the same prompt-role assignment as the compiler. Saved definitions remain intact when switching steps; filtering the editor
never deletes them. Steps using the same role share its loop-owned configuration.


## Editor windows

Mission mode opens Loops in a modal over the current mission, with an
**Open in window** button in the library and builder. Successful window opening
dismisses the modal; failures keep it available. Board mode keeps its embedded library and builder; **Open in window**
opens the library or saves the current builder draft before moving to its own
window. Saving does not publish the loop. A failed save or window opening keeps
the embedded editor available.

`LoopWindowSurface` uses an isolated DesktopProvider initialized with the source
project, without persisting project selection or mounting mission/background
execution providers. `loop-windows` invokes the restricted native window command
or opens a browser popup during web development. Reopening the same project/loop
target focuses its existing window without replacing the editor's draft. Native
windows use exact capabilities and reject remote navigation; closing a loop
window removes its command privileges. Browser popup blocking is shown as an
error so the user can enable popups and retry.

New agent steps use loop-defined roles and editable task/schema/permissions rather
than Core phases. Implement and Ship recipes are capability-gated by
`workflowAgentSteps: 1`. See [the workflow guide](../../../../docs/internals/desktop-owned-workflows.md) for generic gates, compatibility and recovery.

The execution log graph highlights active nodes with the theme's primary color
and a progress indicator, completed nodes with a success check, and failed or
interrupted attempts with distinct states. Latest attempts are grouped by scope,
so a repeated node becomes active again. Full screen expands the same live graph
inside the app, retaining component navigation and attempt selection; Escape or
the exit button returns to the embedded view and restores keyboard focus. The
fullscreen graph and backdrop portal above the log modal and app overlays;
Escape is consumed by the graph so the log stays open.

The per-step provider selector defaults to **Inherit mission provider**. Builtin
recipes and newly added roles inherit the launching mission/rail engine unless
the user explicitly selects a provider for that role.
