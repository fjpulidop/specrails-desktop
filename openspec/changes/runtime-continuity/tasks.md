## 1. Implementation and validation

- [ ] 1.1 Expose and round-trip separate total and inactivity limits with accurate localized defaults.
- [ ] 1.2 Prepare isolated writable caches while preserving authenticated warm dependency reuse and cleanup.
- [ ] 1.3 Capture native prerequisite and test configuration facts before agent work and carry them into runtime context.
- [ ] 1.4 Verify original-scope explicit recovery and paired Core/Desktop environment/configuration boundaries.
- [ ] 1.5 Run focused regressions, typecheck/build and OpenSpec validation; commit and push both branches.

Status 2026-10-21: not archivable — 1.1 not shipped: no configurable inactivity limit (Core config accepts only
`timeoutMs`; Desktop exposes only `timeoutMs`; Implement hardcodes `idleTimeoutMs` in `loop-compat.ts`), so the
"Deadline settings round trip" scenario is false. 1.2 shipped in #664 (`WORKTREE_DEPENDENCY_CACHES` per worktree). 1.3
not found: no native prerequisite/test-configuration facts are captured into runtime context (setup commands and host
blockers from #730 are a different mechanism). 1.4 recovery surface exists (`/runs/:runId/recovery`, `/resume` with
`recover`) but no timeout-interrupted-write test was found. 1.5 cannot be verified. Trim the change to 1.2/1.4 or keep
it open for 1.1/1.3.
