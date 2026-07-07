## Why

Developers sometimes need to run the Tauri/Desktop app on its default local ports while also running a separate web-only dev instance for debugging. Today the web dev stack assumes backend port `4200` and frontend port `4201`, so a second local instance collides with the desktop runtime.

## What Changes

- Allow the web dev backend port to be configured with `SPECRAILS_DEV_SERVER_PORT`.
- Allow the Vite web dev frontend port to be configured with `SPECRAILS_DEV_CLIENT_PORT`.
- Make the Vite dev proxy and injected WebSocket URL point at the configured backend port.
- Preserve existing defaults: backend `4200`, frontend `4201`.
- Keep Tauri/Desktop development behavior unchanged for this change.

## Capabilities

### New Capabilities
- `web-dev-ports`: configurable ports for the browser-only local development server pair.

### Modified Capabilities
<!-- None. This adds a web-only development capability without changing Tauri/Desktop runtime requirements. -->

## Impact

- **Client dev config**: `client/vite.config.ts`
- **Server startup**: `server/index.ts`
- **Tests**: add focused coverage for server port resolution and Vite dev port/proxy configuration
- **No production/runtime dependency changes**
