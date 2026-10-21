## Context

`implement` already runs a rail's tickets as one aggregate run, so Batch was a
second name for the same capability with a different Core template. Stored
state (rails rows, saved custom loops, localStorage rails, historical runs,
agent conversations) can still name Batch.

## Decisions

- **Aliases at the boundary, not in storage consumers.** The rails router
  normalizes `batch-implement` / `batch` to `implement` for launches and
  `PUT /tickets` (including a stored legacy mode it preserves). A migration
  rewrites stored rails once. The client normalizes persisted rails on load.
  `factory:batch` resolves to the Implement factory through `FACTORY_ALIASES`.
- **`{{cmd:batch}}` is a hidden catalog alias.** It resolves to the same
  `LoopCommand` object as `implement`, so expansion, scope and ticket-need all
  match; `/loops/commands` does not list it.
- **Legacy conversion.** A saved legacy Batch step converts to one aggregate
  `implementation` node, identical to Implement. The map/join projection is gone.
- **Core compatibility.** `batch-implement` is tolerated in a contract command
  list and no longer required in provider workflows.
- **Milestone chain.** Chunk size 1; `orderChainTickets` is a stable
  topological sort (Kahn) restricted to the milestone's todo specs; cycles
  fall back to tie order. Rail naming `M<n> · #<id>`. Rail reuse order: the
  retried chunk's rail, a rail with the same name, a rail this chain used, any
  builder-named rail; free = no undecided delivery, no active run, and not the
  in-flight rail of another chain. A reused rail is renamed best effort.
- **Parallel requests.** `mode: 'parallel'` is accepted and runs sequentially
  (the 202 body echoes `mode: 'sequential'`) so old clients and agents do not
  fail; any other mode is a 400. Historical `parallel` rows still render.
- **Rail limit.** When `POST /rails` answers `rail_limit_reached`: on the first
  spec, nothing launches and the route relays 409 `rail_limit_reached` (the
  chain row is cancelled, as for every first-launch refusal); mid-chain, the
  chain pauses with `pause_reason = rail_limit_reached` and Resume retries the
  same spec.

## Risks / Trade-offs

- Another change concurrently adds a project migration; the migration number
  may need renumbering at merge (append-only rule).
- Stacked one-spec rails hold one undecided PR each, so long milestones reach
  the 12-rail limit unless PRs are decided; the pause reason says so.
