## Context

Desktop 2.57.1 and Core 6.0.1 are the inspected baselines. Core currently uses
workflow identity 7 and role instructions 10; the supplied documents assumed 6/9.
The paired Core change freezes the actual identity. Source references in the
imported documents are historical lookup hints, not instructions to downgrade.
The complete roadmap remains in reference/core-agent-engine.md; contracts.md in
the paired Core change is the authoritative wire contract.

## Goals / Non-Goals

**Goals:** one durable Core execution engine, Desktop-owned authoring/delivery and
honest usage; incremental compatibility; explicit recovery and evidence gates.
D0 specifically prepares discovery and readers without enabling v2 execution.

**Non-Goals:** hosted LangSmith, provider-adapter unification, live in-turn steering,
new product terminology, changing legacy graph identity, premature runner deletion.

## Decisions

1. Keep Core behind its existing CLI/JSONL adapter. Core is ESM while the sidecar
   is CommonJS; subprocess isolation and retained runtime identities preserve
   package compatibility and recovery. Importing Core in-process is rejected.
2. Extend existing capability adapters with optional fields and explicit parsers.
   A legacy Core without capabilities remains valid. Unknown/malformed advertised
   values are protocol errors. Definition validation recovers exit-1 output only
   when it is a well-formed runtime-definition-validated event.
3. Separate syntactic resume validation from run-specific membership validation.
   Node paths allow safe slash-separated components; controls validate membership
   against the authoritative v2 status before invocation. Legacy paths keep their
   current allowlist. Metrics receive narrow catalogs instead of global registries.
4. Read role IDs from the frozen per-run runtime config when v2 status has no role
   catalog. Normalize nextNodePath for existing Desktop readers, retain engine
   version, and accept top-level metrics. Do not invent role IDs from metrics.
5. Keep pure definition compilation and policies inside their owning modules;
   effectful launch, CLI, persistence and settlement stay in runtime adapters.
   Wire dependencies explicitly, retain provider strategies and transactional
   outbox ownership, and update reviewed boundary manifests only for actual edges.
6. D1 freezes context/config/definition with exclusive creation and mode 0600;
   Core validates/hashes the definition, executes every node, and owns checkpoints.
   Desktop projects events into steps and accounting and owns git and delivery.
7. A successful process with completion.ok=false is a negative verdict, not an
   execution error. A graph that writes cannot be delivered without verification
   tied to the candidate. Unknown usage remains null; replay is idempotent.
8. Implementation proceeds by block/PR: C0, C1 and D0 first. D0 is prepared against
   C0 as a paired PR; published-package acceptance is a separate pending gate.
   Release numbers in the plan are targets, never fabricated package pins.
9. CI improvements must preserve coverage, platform checks and package evidence.
   Run independent jobs concurrently and cancel superseded PR runs; do not skip
   checks to make the refactor pass. Three-platform spikes gate C3.
10. D0 validates at most four safe node-path segments (three nested components
    and one leaf), excluding reserved node IDs, then checks run membership.
    Empty node catalog version 0 is valid before the engine is implemented.
    V2 status stays uncached: a legacy implementation checkpoint cannot invalidate
    SQLite/WAL state. Historical projections have no authoritative step catalog;
    they keep legacy validation until D2 projects the runtime graph.

## Risks / Trade-offs

- Schema drift → contract tests and recorded source corrections in the plan.
- Custom paths bypassing controls → syntax plus exact per-run membership checks.
- Duplicate accounting/settlement → durable idempotency and restart regression tests.
- Multiple old/new formats → capability gates and retained-package recovery.
- Whole roadmap cannot be certified locally → explicit pending release, telemetry
  and CI gates; no unchecked task is marked complete.
- Web contains unrelated untracked documents → preserve them; documentation changes
  for this initiative use an isolated branch and only stage owned files.

## Migration Plan

D0 is additive and can roll back without persistent format changes. D1–D7 add the
new path behind Core capabilities while retaining all legacy paths. D4 uses the
next migration number available at implementation time, not a stale fixed number.
D8 requires parity for every saved/factory graph and two releases without legacy
launches, a backed-up graph migration and explicit spec deltas. Core C10 follows
that gate; old runs keep their retained packages. Update Core, Desktop and Web
user documentation after implementation matches the published behavior.

## Open Questions

C1 determines SQLite binding, subgraph API limits and after-commit event delivery.
Store permissions and state patch semantics must be resolved in contracts before
those later blocks. Default map concurrency is 1; the contract allows up to 8
(the plan's suggested 4 is stale). No production v2 capability is advertised early.
