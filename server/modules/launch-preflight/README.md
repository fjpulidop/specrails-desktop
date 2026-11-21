# launch-preflight

What can make a batch of rails fail right after "Launch all", checked in one
glance: free disk at the project's worktrees location (fail under 1 GiB, warn
under 5 GiB), provider sign-in (`claude auth status`, `codex login status`),
`gh auth status` and the provider quota (from
[provider-quota](../provider-quota/README.md)).

- Probes run in parallel, each bounded (5 s) and asynchronous (bounded exec,
  `statfs` of the nearest existing ancestor); nothing blocks the event loop.
- Only exit codes are read: the status commands can print account details.
- Sign-in results are cached for a minute and concurrent asks share one probe;
  an unknown result (timeout) is not cached. The dialog fetches once per opening.
- A failing chip (disk under 1 GiB, a provider signed out or missing) blocks
  the launch; GitHub and quota only warn.
- A desktop GUI project (Electron, Tauri, NW.js, Neutralino or Wails, from the
  root `package.json` and marker files) gets a `headless` chip: whether a run's
  launches and UI tests keep their windows hidden. Runs set
  `SPECRAILS_HEADLESS=1` and Core's Electron guard hides Electron windows by
  itself (ok); another toolkit warns until a source file of the project names
  `SPECRAILS_HEADLESS` ([desktop-gui-probe.ts](runtime/desktop-gui-probe.ts):
  read-only, capped walk without dependencies, build output or dot folders).
  The remedy is a change the person makes or specs; Specrails never edits the
  repository for it. See [util/headless-env.ts](../../util/headless-env.ts).

The rail launch door runs the same disk and sign-in check for every launch, so a
direct API launch (MCP, scripts, the companion) is refused like the dashboard's:
409 `launch_preflight_blocked` with the failing chips and one sentence per fix
([rail-launch-preflight.ts](../delivery/runtime/rail-launch-preflight.ts), wired in
`desktop-router.ts`).

`GET /api/launch-preflight?projectId=<id>&providers=<engine,...>[&fresh=1]`
(an empty engine is the project's primary provider).

Run `npx vitest run server/modules/launch-preflight`.
