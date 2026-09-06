## Context

Core 5 has deterministic installation and scoped verification, but provider-specific templates diverge and Desktop still uses enrichment-era setup. Desktop can discover global packages, its own managed npm installation and project framework snapshots. These are separate versions and must not be conflated. Multi-repo rails already freeze a manifest and own delivery.

## Goals / Non-Goals

**Goals:** consistent provider execution; safe resumption with evidence; clear ownership and paths; reliable Core updates from both CLI and Desktop; truthful restart-stable version reporting.

**Non-Goals:** changing user specifications; skipping semantic review; publishing releases; running paid provider calls in tests; updating live user projects as part of development.

## Decisions

- Introduce a versioned execution-context file with immutable spec scope, repository paths, artifact/backlog roots and host/core ownership. Use a deterministic runtime journal outside the active OpenSpec change. Provider templates call the same operations instead of rewriting incompatible state.
- Verification receipts bind successful commands, environment and repository content to scope. Reuse requires validation, while semantic acceptance review remains mandatory. Unknown or changed evidence triggers verification rather than a false pass.
- All gates precede archive/delivery; blocked is distinct from intentionally skipped. Retry resumes the earliest invalid phase and does not recursively launch the full coordinator.
- Resolve package candidates from explicit provenance and compatibility. Persist and validate the selected managed installation; recompute project framework versions from actual artifacts. Startup cannot silently replace a newer compatible install with an older bundled/default version.
- Core updates preflight before mutations, defer successful version metadata, preserve custom artifacts and restore usable state on failure. Partial component updates do not claim the entire framework has advanced.
- Adapt Desktop setup to Core 5 CLI capabilities, with clear legacy compatibility rather than invoking removed enrich commands.

## Risks / Trade-offs

- Provider CLIs change independently → isolate adapters, test generated artifacts and negotiate supported capabilities.
- Fingerprints can become invalid during concurrent edits → fail closed on mismatches and never reuse incomplete checks.
- Several workspaces share framework files → preserve version snapshots, make publication atomic and test failure rollback.
- Existing dirty branch contains unrelated requested work → keep changes additive and run targeted regressions before broader checks.

## Migration Plan

Keep journal/context schema versioned and support legacy Core installations without assuming receipts exist. Adopt Core 5 after setup and integration contracts pass local packaged-fixture tests. Verify updates and restart against isolated homes; preserve prior installation on failed migration.
