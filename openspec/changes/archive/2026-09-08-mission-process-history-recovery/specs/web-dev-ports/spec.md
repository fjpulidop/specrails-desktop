## MODIFIED Requirements

### Requirement: Vite web dev server can be configured by environment
The Vite web dev server SHALL use `SPECRAILS_DEV_CLIENT_PORT` for its own fixed port and the backend's environment resolution for proxy targets and the injected WebSocket URL. Backend requests SHALL explicitly address `127.0.0.1`, matching the server listener.

#### Scenario: Env vars set web dev pair
- **WHEN** Vite starts with `SPECRAILS_DEV_SERVER_PORT=4300`
- **AND** `SPECRAILS_DEV_CLIENT_PORT=4301`
- **THEN** the Vite dev server uses port `4301`
- **AND** `/api` and `/hooks` proxy to `http://127.0.0.1:4300`
- **AND** `__WS_URL__` is `ws://127.0.0.1:4300`.

#### Scenario: Vite defaults are preserved
- **WHEN** no dev port environment variables are provided
- **THEN** the Vite dev server uses port `4201`
- **AND** `/api` and `/hooks` proxy to `http://127.0.0.1:4200`
- **AND** `__WS_URL__` is `ws://127.0.0.1:4200`.

#### Scenario: Backend fallback port is shared
- **WHEN** `SPECRAILS_PORT` is set and `SPECRAILS_DEV_SERVER_PORT` is absent
- **THEN** Vite SHALL use the same API port as the backend.

#### Scenario: Development port conflict
- **WHEN** the client port equals the backend port or the configured client port is already occupied
- **THEN** startup SHALL fail clearly rather than silently shifting the client to another port.

### Requirement: Tauri/Desktop defaults remain unchanged
Desktop default API and client ports SHALL remain `4200` and `4201`, with existing sidecar startup and CSP behavior. Native API and WebSocket fallbacks SHALL use explicit IPv4 loopback rather than ambiguous localhost; development overrides SHALL remain aligned with the selected API.

#### Scenario: Desktop configuration retains default ports
- **WHEN** no development override is configured
- **THEN** the native client SHALL address the Specrails API at `http://127.0.0.1:4200`
- **AND** the Desktop/Tauri development URL SHALL retain its configured `4201` port.
