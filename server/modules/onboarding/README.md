# onboarding

The **sample project** behind the Welcome screen's *Try it on a sample project* (see the
[frontend feature](../../../client/src/features/onboarding/README.md)). It owns no table: the
created sample is one JSON record in `desktop_settings` (`onboarding.sample`), and everything
else reuses the ordinary project, spec and rail machinery.

## Where to change behavior

| Change | Owner |
| --- | --- |
| Sample vocabulary, the first-run **preset** (Quick SDD, cheapest priced model, run cap, local engine), cost envelope, folder naming | [domain.ts](domain.ts) (pure) |
| Ports: files, git, specs, project registry, record store | [ports.ts](ports.ts) |
| Create (idempotent, rolled back on failure), current sample, remove | [application.ts](application.ts) |
| The bundled sample repository and its three specs in 8 locales (embedded source text, no Tauri resource) | [catalog.ts](catalog.ts) |
| Disk / `git init` + commit / ticket store / settings adapters | [adapters/runtime.ts](adapters/runtime.ts) |
| Providers as the preset chooser sees them (detection snapshot + rate card) | [adapters/providers.ts](adapters/providers.ts) |
| Routes; composition of the project registry port | [adapters/http.ts](adapters/http.ts), [desktop-router.ts](../../desktop-router.ts) |

## API

- `GET /api/onboarding/sample[?refresh=1]` - catalog, the current sample (or null), the default
  parent folder and `launch`: `{ ready, preset, localPreset, estimate, runCapUsd }` or
  `{ ready: false, reason: 'no_provider' | 'not_signed_in' }`. `refresh=1` re-probes providers.
- `POST /api/onboarding/sample` `{ sampleId?, locale?, path?, parentDir? }` - 201 created, 200 reused.
- `DELETE /api/onboarding/sample[?deleteFolder=1]` - unregister; optionally delete the folder.

The run itself is the ordinary `POST /rails/:n/launch`, which accepts a per-launch `runCapUsd`
(`> 0` caps this run, `0` waives the default; absent keeps the project/app default).

## Invariants

- The sample lives **strictly inside the home directory** and never overwrites a folder: the
  default layout takes the next free `name-N`; an explicit path must not exist.
- Creation order is files -> `git init -b main` + one commit (fixed identity, no signing) ->
  specs -> registration -> record. Any failure removes what this call created.
- The spec store (`.specrails/`) is git-ignored so a launch never starts from a dirty tree.
- Deleting the folder is opt-in and only for the exact recorded path, still strictly inside
  home and still a git repository.
- Readiness never throws: a failing detection is "not ready" (the client offers the recording).
- Costs are estimates; the soft cap uses the existing per-run cap and budget gate.

Run `npx vitest run server/modules/onboarding`.
