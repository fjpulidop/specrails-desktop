# production-static-serving Specification

## Purpose
Define production static serving, SPA fallback routing, and published package runtime artifacts.

## Requirements

### Requirement: Server serves built React client in production
The system SHALL serve the compiled React client assets from `client/dist/` via Express static middleware when the directory exists, enabling the dashboard to be accessed from the same port as the API server.

#### Scenario: Dashboard accessible at server root in production
- **WHEN** the server is started and `client/dist/` exists
- **THEN** a GET request to `/` returns the React `index.html`

#### Scenario: Static assets are served
- **WHEN** the browser requests a JS, CSS, or image asset built by Vite
- **THEN** the server returns the file from `client/dist/`

#### Scenario: Dev mode unaffected
- **WHEN** the server is started via `npm run dev` (Vite on port 4201 handles the client)
- **THEN** API routes continue to work; Vite dev server is not disrupted

### Requirement: SPA client-side routing is supported
The system SHALL serve `index.html` for any GET request that does not match an API route, enabling React Router (or equivalent) to handle routing on the client side.

#### Scenario: Deep link returns index.html
- **WHEN** a GET request arrives for a non-API path (e.g., `/projects/abc/jobs`)
- **THEN** the server returns `client/dist/index.html` with HTTP 200

#### Scenario: API routes are not intercepted by fallback
- **WHEN** a request arrives for `/api/*` or `/hooks/*`
- **THEN** the fallback route does NOT handle it; the API router handles it normally

### Requirement: Package files manifest includes all runtime artifacts
The `package.json` `files` field SHALL list exactly the directories needed at runtime — no source files, no test files, no config — so that `npm publish` produces a minimal, correct package.

#### Scenario: Published package contains compiled server
- **WHEN** the package is installed from npm
- **THEN** `server/dist/index.js` is present

#### Scenario: Published package contains compiled CLI
- **WHEN** the package is installed from npm
- **THEN** `cli/dist/specrails-desktop.js` is present

#### Scenario: Published package contains built client
- **WHEN** the package is installed from npm
- **THEN** `client/dist/` with all Vite build artifacts is present

#### Scenario: Published package excludes source files
- **WHEN** the package is installed from npm
- **THEN** `server/*.ts`, `cli/*.ts`, `client/src/` are NOT present
