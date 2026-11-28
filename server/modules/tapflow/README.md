# tapflow

App-global plugin for [Tapflow](https://github.com/jo-duchan/tapflow) (MIT): iOS Simulator and Android
emulator streaming, with an MCP server agents can drive. Not installed and inactive by default; offered
only on macOS on Apple Silicon, where Tapflow's agents run. OpenSpec change: `add-tapflow-plugin`.

Lifecycle: **Install** opens an installer terminal (app scope `__app__`) that installs the pinned
`tapflow@0.33.0` and `@tapflowio/mcp-server@0.33.0`, and their whole dependency tree from
[pinned/package-lock.json](pinned/package-lock.json) with `npm ci`, with Specrails' Node and npm into
`~/.specrails/tools/tapflow`, then runs Tapflow's interactive `tapflow setup`; exit 0 records the install.
**Activate** starts a supervised `tapflow start` on port 4310 (lean, no audio, display sleep allowed, one
automated devices, one per platform), kept on loopback by a preload, and creates its admin account and token on first use.
**Deactivate** stops it with SIGTERM. A crash shows as inactive with the reason; an active service is
started again at app start; a Tapflow the person runs themselves is shown as running-external and never
stopped.

## Updating Tapflow (only on purpose)

Tapflow never updates itself, and an install never resolves newer dependencies. To move to a new version:
bump `TAPFLOW_VERSION` in [domain.ts](domain.ts) and the two versions in
[pinned/package.json](pinned/package.json), regenerate the lockfile in a scratch folder with Specrails'
Node (`npm install --package-lock-only` there, then copy `package-lock.json` into `pinned/`), run the
tapflow tests (they check the lockfile matches the version and that every package has an integrity hash),
and verify iOS and Android live before shipping it.

## Where to change behavior

| Change | Owner |
| --- | --- |
| Pinned version, eligibility, status derivation, service environment/config, installer script, resource roots by signature | [domain.ts](domain.ts) (pure) |
| Install / activate / deactivate / uninstall / boot restore / shutdown and their ports | [application.ts](application.ts) |
| Managed install paths, Node/npm resolution, installer terminal, supervised service, loopback preload | [adapters/process.ts](adapters/process.ts) |
| Liveness probe, admin + token bootstrap, 0600 secrets | [adapters/relay.ts](adapters/relay.ts) |
| `desktop_settings` key `plugins.tapflow.state` | [adapters/store.ts](adapters/store.ts) |
| `GET/POST /api/global-plugins/tapflow[/install|activate|deactivate|uninstall]` | [adapters/http.ts](adapters/http.ts), mounted by [global-plugins-router.ts](../../global-plugins-router.ts) |
| Wiring (bundled Node, terminal manager, WS `plugin.tapflow_status`) | [runtime.ts](runtime.ts), created in [index.ts](../../index.ts) |

## Test in Mobile Device (`factory:mobile-test`, OpenSpec change `add-mobile-device-testing`)

Two Desktop host tasks build the app (`mobile.build`, [adapters/mobile-build.ts](adapters/mobile-build.ts):
the project's own tools; a Gradle build gets ANDROID_HOME and a JDK 17+ from
[adapters/android-toolchain.ts](adapters/android-toolchain.ts), since a worktree has no `local.properties`)
and put it on a device (`tapflow.deliver`, [adapters/delivery.ts](adapters/delivery.ts): upload, pick or the
chosen device, boot, install, launch, always disconnect). The run's target lives in `mobile_test_runs`
(migrations 98-99). It starts three ways, all through `startMobileTest` in
[adapters/mobile-offer.ts](adapters/mobile-offer.ts):

- the mission card after a delivery (the delivery's worktree, or the checkout after a local merge);
- Loops ▸ Test in Mobile Device ▸ Run on a device (the checkout as it is, a delivery on review, or a branch
  built in a temporary worktree beside the project database, removed when the run ends);
- the agents' MCP `specrails_integrations(mobile_test)` with the same targets.

A mission sees its runs: the agent of an Intent session runs the app with `specrails_background`
`mobile_test` (in-app v1 catalog; external clients: `specrails_integrations` `mobile_test` target `mission`) on the Intent worktree (persona section in
[agent-flow-prompt.ts](../missions/runtime/agent-flow-prompt.ts)). A run with a mission shows in its
Processes as an observed background process ([adapters/mobile-run-process.ts](adapters/mobile-run-process.ts):
the run log, Tapflow's service log tailed during the run, the build PID, the outcome; history in the
background process store), and in its Resources (`missionTapflowRoots`: the launched device while it runs,
the build in progress, the service). The app-wide Resources' Tapflow category lists builds, devices (simulators
by name, [adapters/simulator-names.ts](adapters/simulator-names.ts)) and the service.

Routes under `/api/projects/:id/mobile-test`: `POST /start`, `GET /options` (what the dialog offers,
Tapflow's devices included while it is on), `GET /runs/:runId`, `POST /dismiss`. The loop is an editable
built-in: it keeps its id (never copied), and publishing an edit keeps its build and device steps
(`mobileTestGraphContractErrors`).

The Resources view lists a `tapflow` category (service tree, one root per booted simulator's
`launchd_sim` and per emulator) through `listAppResourceRoots` in
[app-resources-router.ts](../../app-resources-router.ts), only while a Tapflow service runs.

## Facts measured in the spike (2026-11-28, Apple Silicon, Xcode 26.4, Tapflow 0.33.0)

- Install with the bundled Node: 5 s, 80 MB. The Node that installs runs it (`better-sqlite3` ABI).
- The relay binds `::` with no option: the preload rewrites wildcard listens to `127.0.0.1` (checked with `lsof`).
- `tapflow start` ignores `TAPFLOW_ADMIN_*`; `POST /api/v1/auth/init` from loopback creates the account.
- Idle service: one process, 60–130 MB, 0 % CPU. One iPhone with an app: ~0.7–0.9 GB in all.
- A session left connected is never released (restart the service); capture keeps running after a
  disconnect until `shutdown_device`. Later changes must always disconnect and shut devices down.
- SIGTERM stops everything in 0.1 s without orphans; SIGKILL would orphan XCUITest runners (last resort only).

## Tests

`npx vitest run server/modules/tapflow` — domain rules, use cases over fakes, and adapters against real
processes (the preload binding a wildcard listen to loopback, the supervised service's SIGTERM stop) and a
fake relay (account and token once, 0600 secrets).
