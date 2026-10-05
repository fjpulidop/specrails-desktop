# Verification: nested repository dependency mapping

| Dimension | Result |
| --- | --- |
| Completeness | 7/7 implementation and preparation tasks complete; one added requirement implemented |
| Correctness | All four scenarios covered by dependency and release integration tests |
| Coherence | Shared checkout projection, bounded discovery, exact cleanup proof and original registered identities retained |

`server/util/checkout-path.ts` contains the unchanged resolver formerly exported by `server/core-execution.ts`; its re-export preserves existing consumers. `server/worktree-node-modules.ts` projects destinations and cleanup evidence while retaining source-relative discovery. It authenticates historical links individually and rejects symbolic-link ancestors. No repository/project names occur in the implementation.

The nine new dependency regressions fail against the original helper (17 pre-existing tests pass) and pass with the correction: 26/26 total. They use real Git checkouts/worktrees, a registration named `apps/catalog`, actual Node package resolution, readable Yarn state, local cache writes, unchanged source contents, relative-depth bounds, restart evidence and rejected foreign/symlinked paths. Source registrations from a Git worktree exercise `.git` files too.

Release tests pass 26/26, including three new cases covering live evidence reconstruction without persisted warm evidence and preserving a package replaced by a directory or foreign link. The real Git runner keeps `repository_path` and its source working directory unchanged, and uses non-force release with quarantine.

The wider delivery, worktree, Core execution scope and architecture run passes 1,297 tests; three optional/platform-specific tests are skipped. Typecheck, architecture audit, production build, package installation smoke check, bundled Core 6.2.1 contract check and strict OpenSpec validation pass. Core compatibility used the actual bundled package; the default unconfigured lookup only reports a skip.

No critical, warning or design-coherence findings remain. Actual Yarn/application tests were not run: the user's installation is on another host. The reported independent application Prettier failure is outside this change.
