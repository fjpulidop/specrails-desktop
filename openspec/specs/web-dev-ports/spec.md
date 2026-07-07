# web-dev-ports Specification

## Purpose

Allow developers to run a browser-only Specrails dev stack on non-default local ports while keeping Desktop/Tauri on the default ports.

## Requirements

### Requirement: Web dev backend port can be configured by environment
The web dev backend SHALL use `SPECRAILS_DEV_SERVER_PORT` as its default port when no explicit `--port` argument is provided.

#### Scenario: Env var sets backend dev port
- **WHEN** the server dev process starts with `SPECRAILS_DEV_SERVER_PORT=4300`
- **AND** no `--port` argument is provided
- **THEN** the Express server listens on port `4300`

#### Scenario: CLI port keeps highest priority
- **WHEN** the server dev process starts with `SPECRAILS_DEV_SERVER_PORT=4300`
- **AND** `--port 4400` is provided
- **THEN** the Express server listens on port `4400`

#### Scenario: Defaults are preserved
- **WHEN** no dev port environment variable or CLI port is provided
- **THEN** the Express server listens on port `4200`

### Requirement: Vite web dev server can be configured by environment
The Vite web dev server SHALL use `SPECRAILS_DEV_CLIENT_PORT` for its own port and `SPECRAILS_DEV_SERVER_PORT` for backend proxy targets and the injected WebSocket URL.

#### Scenario: Env vars set web dev pair
- **WHEN** Vite starts with `SPECRAILS_DEV_SERVER_PORT=4300`
- **AND** `SPECRAILS_DEV_CLIENT_PORT=4301`
- **THEN** the Vite dev server uses port `4301`
- **AND** `/api` and `/hooks` proxy to `http://localhost:4300`
- **AND** `__WS_URL__` is `ws://localhost:4300`

#### Scenario: Vite defaults are preserved
- **WHEN** no dev port environment variables are provided
- **THEN** the Vite dev server uses port `4201`
- **AND** `/api` and `/hooks` proxy to `http://localhost:4200`
- **AND** `__WS_URL__` is `ws://localhost:4200`

### Requirement: Tauri/Desktop defaults remain unchanged
This change SHALL NOT alter Tauri/Desktop dev URL, CSP, sidecar startup, or client runtime fallbacks that intentionally point to `4200`/`4201`.

#### Scenario: Desktop config remains fixed
- **WHEN** the configurable web dev ports are added
- **THEN** `src-tauri/tauri.conf.json` still declares the existing Desktop/Tauri dev URL and CSP behavior
- **AND** browser-only Vite proxy configuration is the only frontend development path changed
