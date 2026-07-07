## Context

`npm run dev` starts two independent development processes:

- `npm run dev:server`, which runs `server/index.ts` and currently defaults to port `4200`
- `npm run dev:client`, which runs Vite from `client/vite.config.ts` and currently defaults to port `4201` while proxying `/api` and `/hooks` to `http://localhost:4200`

That hardcoded pair prevents a developer from keeping the Desktop/Tauri app on `4200/4201` while running a second web-only debug stack on another pair such as `4300/4301`.

## Decision

Add environment-variable overrides for the browser-only dev workflow:

- `SPECRAILS_DEV_SERVER_PORT`: backend Express port
- `SPECRAILS_DEV_CLIENT_PORT`: Vite frontend port

`server/index.ts` should resolve the backend port in this order:

1. explicit `--port <n>` CLI argument
2. `SPECRAILS_DEV_SERVER_PORT`
3. `SPECRAILS_PORT`
4. default `4200`

`client/vite.config.ts` should resolve:

- frontend port from `SPECRAILS_DEV_CLIENT_PORT`, defaulting to `4201`
- backend target from `SPECRAILS_DEV_SERVER_PORT`, defaulting to `4200`
- `__WS_URL__` from the same backend target in development mode

## Out of Scope

- Tauri dev port configurability
- Production static serving port behavior
- Desktop sidecar startup, CSP, `origin.ts`, `auth.ts`, or Tauri fallback URLs
- Changing published defaults

## Risks

- Invalid env var values could make Vite or Express fail in confusing ways. Keep parsing conservative: only accept positive integer port values; fall back to defaults otherwise.
- Tests that assume `4200` in dev configuration need to keep passing when env vars are absent.
