# cli-entrypoint Specification

## Purpose
Define the npm CLI entrypoint, command naming, server resolution, and build output behavior.

## Requirements

### Requirement: CLI binary is named specrails-desktop
The npm package SHALL expose a binary named `specrails-desktop` (not `srm`). All user-facing documentation, UI text, and error messages SHALL use `specrails-desktop` as the command name.

#### Scenario: Binary available after global install
- **WHEN** the package is installed globally via `npm install -g specrails-desktop`
- **THEN** `specrails-desktop` is available as a shell command

#### Scenario: Old srm command is not exposed
- **WHEN** the package is installed
- **THEN** no binary named `srm` is registered

#### Scenario: Help text uses specrails-desktop
- **WHEN** the user runs `specrails-desktop --help`
- **THEN** the output references `specrails-desktop` (not `srm`) in usage examples

### Requirement: CLI locates the compiled server binary correctly
The CLI SHALL resolve the Express server path relative to its own compiled location so that `specrails-desktop start` can spawn the server process when installed via npm.

#### Scenario: CLI finds server in npm-installed package
- **WHEN** the CLI is run from an npm global install (CLI at `cli/dist/specrails-desktop.js`)
- **THEN** it resolves the server at `<package-root>/server/dist/index.js`

#### Scenario: CLI falls back to tsx in dev mode
- **WHEN** `server/dist/index.js` does not exist but `server/index.ts` does
- **THEN** the CLI spawns the server using `tsx server/index.ts`

### Requirement: Server TypeScript compiles to server/dist/
The server TypeScript source SHALL compile to `server/dist/` so the output is co-located with source and consistent with the CLI convention (`cli/dist/`).

#### Scenario: Build script produces server/dist/index.js
- **WHEN** `npm run build` is executed
- **THEN** `server/dist/index.js` exists and is runnable with `node`

#### Scenario: build script builds all three layers
- **WHEN** `npm run build` is executed
- **THEN** `client/dist/`, `server/dist/`, and `cli/dist/` are all produced
