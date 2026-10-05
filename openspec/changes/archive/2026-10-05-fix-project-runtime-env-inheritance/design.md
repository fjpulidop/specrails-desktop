## Context

The parent project's DB already feeds loop executors even when a rail spans repositories. Core passes inherited environment variables to provider processes and host verification. Desktop currently imports project credentials into process.env, permanently remembers attempted login-shell names, falls back to sh when SHELL is absent, and omits project passthrough when retained runtime controls reconstruct their environment.

## Goals / Non-Goals

**Goals:** Consistent names-only project configuration for all admitted repositories, correct account-shell recovery for GUI launches, recoverable failed probes, retained-run parity, and no cross-project exposure of recovered values.

**Non-Goals:** Per-repository credential stores, reading arbitrary dotenv files, modifying personal shell profiles, changing Core contracts or bypassing package-manager authentication. The originating machine's exact failed shell condition cannot be established from the supplied log alone.

## Decisions

- Resolve the shell from explicit SHELL, then os.userInfo().shell, then the existing portable sh fallback. Keep probes bounded and discard unsuccessful results. Reuse this selection for startup PATH/auth and synchronous project recovery.
- Add a non-mutating synchronous shell reader. Project assembly uses a WeakMap keyed by the owning database connection; cache only the selected names and their lookup result for 30 seconds. Expire both success and failure so a fixed profile/rotated token can recover without restarting; changes in configured names or shell/home identity invalidate the cache. Non-empty explicit inherited values always take precedence. Existing callers supplying a custom sourceEnv retain deterministic source-only behavior.
- Retain global startup backfill only for existing provider-auth APIs. Project recovery overlays each spawn and never writes the recovered values into process.env, SQLite, runtime snapshots, prompts or diagnostics.
- Reuse project-env in runtime controls before applying saved host identity. This preserves frozen worktree ownership while obtaining current project credentials on continuation.
- Reproduce multi-repository verification through real subprocesses/Core with synthetic credentials; cover project isolation, failed probes, refresh, and retained controls independently.

## Risks / Trade-offs

- A login shell may be slow or unavailable → retain bounded timeout and short cache; unresolved values remain absent rather than fabricated.
- Shell changes can take up to 30 seconds to refresh → document the bound and always prefer newly supplied inherited values.
- Secrets remain briefly in process memory → bind cache to the project DB, never serialize values, and filter returned names against current configuration.
- The supplied run also mentions test/dependency issues → verify propagation itself without claiming those unrelated checks will pass.

## Migration Plan

No database or Core migration. Existing project name lists apply to new and retained runs after updating Desktop. Rollback restores prior assembly behavior without changing saved project data.
