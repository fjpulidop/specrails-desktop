## Context

See the proposal for the measured facts. Specrails already has an app-global service plugin (Headroom, `server/headroom-manager.ts`), a per-project plugin contract (`server/plugins/`), a PTY terminal manager, and an app Resources sampler. Tapflow is machine-wide (one agent per Mac, a singleton socket in `/tmp`), so it is app-global like Headroom, but built as a capability module with a pure core instead of extending Headroom's manager.

## Decisions

- **Module shape.** `domain.ts` (pure: eligibility, state derivation, service environment and config, resource roots by signature), `application.ts` (use cases over narrow ports: installer, service, relay, store, terminal), adapters (`process.ts`, `relay.ts`, `store.ts`, `http.ts`), public `index.ts`.
- **Pinned version.** `TAPFLOW_VERSION = '0.33.0'`. Tapflow uses SimulatorKit private APIs that break on Xcode majors; an upgrade is a reviewed change, never `latest`.
- **Node.** The bundled Node (`resolveBundledNodeExe`) when present, else the `node` on PATH if ≥ 22. The Node that installs is recorded and is the one that runs (`better-sqlite3` ABI).
- **Loopback.** Tapflow hard-codes `listen({ host: '::' })`. The service runs with `NODE_OPTIONS=--require <tools>/specrails-loopback.cjs`, which rewrites wildcard listens to `127.0.0.1` in that process only (verified with `lsof` in the spike). To be removed when Tapflow accepts a bind host upstream.
- **Port.** 4310 by default (not Tapflow's 4000, so a person's own Tapflow keeps its port); `TAPFLOW_PORT` from the stored setting.
- **Auth bootstrap.** On first activation: `POST /api/v1/auth/init` from loopback with a generated admin, `POST /auth/login`, `POST /api/v1/tokens {scope:'view,builds:write'}`. Secrets in `<tools>/secrets` (dir 0700, files 0600). Never logged, never sent to the client.
- **State.** `desktop_settings` key `plugins.tapflow.state`: `{ installedVersion, nodePath, active, port }`. Liveness is never stored: it is probed (`GET /api/v1/auth/status`, 1.5 s timeout) and the supervised child is tracked in memory.
- **Status model.** `unsupported | not-installed | installing | installed | starting | running | running-external | failed`; `installed` is the inactive state. A supervised child that exits unexpectedly yields `installed` with `lastIssue`.
- **Installer terminal.** `TerminalManager.create(scope, { command: { file, args, env } , onExit })` spawns the program directly in the PTY (no shell, no shell integration). The installer is `/bin/zsh -lc` running the npm install then `tapflow setup` (macOS only, so a POSIX shell is fine and gives the person Tapflow's own prompts). The packages on disk decide the install; a non-zero setup exit is a `setup-incomplete` issue (Run setup again reopens the installer), because `tapflow setup` exits non-zero when an optional step such as the network filter is declined.
- **Stop.** SIGTERM, wait up to 10 s, then SIGKILL (the spike stops in 0.1 s; SIGKILL would orphan TreeRunners, so it is the last resort only).
- **Resources.** `tapflowResourceRoots(table, { servicePid })`: the service tree; per booted iOS device the `launchd_sim` whose command names `CoreSimulator/Devices/<UDID>`; per Android emulator `qemu-system-*` / `emulator` with `-avd <name>`; only while a Tapflow service (supervised or external) is running, so a simulator Xcode booted alone is not mislabelled.

## Risks

- Tapflow is v0.x and changes fast: pinned version, contract tests on the endpoints used.
- `tapflow setup` needs sudo, Homebrew and System Settings approvals: it is the person's terminal, Specrails only reads its exit.
- A session left connected is never released (spike): later changes always disconnect, and restarting the service is the recovery.
