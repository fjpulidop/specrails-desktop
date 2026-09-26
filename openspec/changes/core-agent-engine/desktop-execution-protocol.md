# Desktop Core execution projection

Decision recorded on 2026-09-26 before D1 execution / D2 / D3 changes.

A definition graph selects one Core executor port before Desktop's legacy
traversal. Existing launch admission, project/job identity, ticket ownership,
worktree settlement and terminal callbacks retain one owner in LoopRunManager.
The definition helper observes Core; it does not invoke AI, shell or decisions.

The runtime bridge freezes the effective configuration once. A pure definition
compiler callback receives that same resolved configuration, then Core validates
with the frozen config path. Desktop writes the returned canonical definition
exclusively with mode 0600. Resume uses the retained runtime and frozen inputs.
The callback itself never enters durable launch data.

Durable Core invocation events carry the physical invocation ID, provider,
model, actual startedAt/finishedAt and nullable usage. Projection deduplicates
that identity, uses the existing loop-step recovery transaction and shared
integer allocation, and records each invocation once. Runtime aggregate usage
is not inserted as a second invocation. Event/accounting persistence errors are
execution observer failures; they must not be silently swallowed as UI logging.

Parallel node attempts are tracked by attemptId and branch/scope metadata, not
one mutable open-step slot. Committed lifecycle events create existing loop
step events. Core's runtime verdict and business completion remain separate;
successful execution with completion.ok false is not eligible for delivery.

Paused human input uses the existing job composer and LoopRunManager's single
live owner. Resume selects an interrupt ID when branches have multiple pending
interrupts. Cancellation during a pause settles without spawning a resume.
Restart reconstruction and linked fork persistence require the D4 durable request
fields; no original run is mutated when forking.
