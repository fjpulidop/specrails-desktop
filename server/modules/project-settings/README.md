# Project settings

Owns project configuration validation and the read/update application use cases.
The module is the first implemented ports-and-adapters slice described in the
[architecture decision](../../../docs/internals/modular-architecture.md).

## Where to change behavior

| Change | Owner |
| --- | --- |
| Settings shape, validation, defaults, environment-name normalization | [domain.ts](domain.ts) |
| Read/update orchestration | [application.ts](application.ts) |
| Persistence behavior contract | [ports.ts](ports.ts) |
| SQL, stored defaults, atomic update/read | [adapters/sqlite.ts](adapters/sqlite.ts) |
| HTTP routes, status codes, response/error translation | [adapters/http.ts](adapters/http.ts) |
| Public imports for callers | [index.ts](index.ts) |
| Production wiring | [project-router-settings.ts](../../project-router-settings.ts) |
| Existing persistence imports | [db/settings.ts](../../db/settings.ts), [db.ts](../../db.ts) |

Application/domain code must not import Express, SQLite, filesystem/process APIs
or the project registry. The repository is bound to a single project connection.
Unknown PATCH fields remain ignored; the historical boolean coercion remains
compatible. Read-only `orchestratorModelExplicit` cannot be written through the
application API. Environment configuration stores names, never secret values.

The repository port guarantees all-or-nothing update and returns normalized
persisted settings. Existing low-level DB functions remain available for legacy
consumers; prefer the application API for new feature callers.

Quick Contract Refine preference helpers remain in the SQLite adapter for legacy
compatibility; their routes have not been migrated to use cases yet. Agent model,
terminal, context-scope and integration-branch resolution routes are separate
concerns still wired in the legacy settings router.

## Verify a change

```bash
npx vitest run server/modules
npx vitest run server/project-router.test.ts server/db.test.ts server/project-env.test.ts server/integration-branch.test.ts
npm run typecheck
```

- [Application tests](__tests__/application.test.ts): fake port, no HTTP/SQLite.
- [SQLite contract tests](__tests__/sqlite.test.ts): project isolation and rollback.
- [HTTP tests](__tests__/http.test.ts): domain versus infrastructure error mapping.
- [Architecture tests](../architecture.test.ts): dependency direction and API access.
- [Existing route regressions](../../project-router.test.ts): full request behavior.

When adding a file, update the dependency rules and run `npm run docs:source-map`.

## Reviewed public entry points

- [adapters/http.ts](adapters/http.ts)
- [adapters/sqlite.ts](adapters/sqlite.ts)
- [index.ts](index.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/project-settings` and any affected consumers.
