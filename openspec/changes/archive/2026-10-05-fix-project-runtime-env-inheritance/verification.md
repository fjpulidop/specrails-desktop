## Completeness

All six tasks and four added requirements are implemented. The parent project remains the owner of the configured names; no per-repository setting, database migration or Core contract change is required. Configuration and both affected module guides describe recovery, scope and refresh behavior.

## Correctness

- The supplied execution stops Yarn before tests because NODE_AUTH_TOKEN is missing. The source already applies the parent project's environment to new multi-repository rails. The log alone cannot establish which shell condition occurred on the originating computer.
- Desktop previously mutated process.env during project recovery, permanently suppressed names after their first shell probe, selected sh when SHELL was absent, and omitted project recovery when reconstructing retained runtime controls.
- The project-environment regressions produced nine failures against the old project assembly and pass after scoped recovery. Failed/empty probes and successful values expire after 30 seconds; changed settings or shell identity invalidate the cache. Non-empty inherited values take precedence, and removal drops a recovered value immediately.
- A real temporary zsh login profile supplies a synthetic credential when SHELL is absent. No personal shell profile or real credential was inspected or modified.
- Published Core 6.2.1 receives a synthetic parent-project credential in tool subprocesses and host verification in two real isolated Git worktrees. Assertions cover both repository roots and absence of the credential in global process.env, project SQLite, frozen runtime files, ledger, prompts and captured logs.
- Resume and scoped recovery resolve current project credentials while retaining the original host identity and worktree scope. Removing the setting also affects the next retained operation.

## Validation

- Affected runtime, loop, execution and project-settings modules, registry/routes, workspace resolution, environment and architecture suites: 1,800 tests passed; 61 optional/platform-specific tests skipped. Local HTTP tests required normal permission to bind temporary test servers.
- The focused path-resolver suite passed 66 tests, including the real temporary .zprofile scenario; project environment passed 13 tests and retained controls passed 57 tests. These are included in the broad suite above.
- Full paired suite against the staged published Core 6.2.1 package: 27/27 passed. Executors are deterministic and local; Core CLI, Git worktrees and verification subprocesses are real.
- All root, CLI, MCP bridge, local runner and client TypeScript checks passed.
- Server/frontend architecture audits and git diff --check passed. The one new runtime dependency was reviewed explicitly in the boundary manifest.
- Published Core 6.2.1 / integration contract 5.1 compatibility passed using node --import tsx; the tsx launcher initially hit the sandbox's IPC restriction.
- Production build and package consumer installation, CLI, MCP bridge, shell resources and tarball integrity passed. Packaging required normal npm cache/network access; no cache ownership or permission changes were made.
- The OpenSpec change passed strict validation before archival; the added capability is synchronized by the archive command.

## Coherence and limitations

Recovered values remain in a short-lived cache owned by the project's database connection and are overlaid only on live subprocesses. Windows continues using its inherited environment. Existing global startup provider-auth APIs retain their intentional backfill behavior. Core and bundled versions are unchanged.

The original machine's exact shell failure is unconfirmed, and this validation does not certify unrelated dependency/type/test issues described in the supplied execution. No dummy credential or test bypass is introduced. GitHub CI is checked separately after publishing the PR.
