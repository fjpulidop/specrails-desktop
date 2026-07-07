# server-sidecar Specification

## Purpose
Define desktop server sidecar build, bundling, and packaging behavior.

## Requirements

### Requirement: Server compiles to a platform-native binary via Node.js SEA
The build system SHALL produce a self-contained native executable from the Express server using Node.js 20 Single Executable Application (SEA). The binary SHALL include all JS dependencies bundled via esbuild. Native addons (`.node` files, e.g. `better-sqlite3`) SHALL be copied alongside the binary and resolved at runtime.

#### Scenario: Build sidecar script runs successfully
- **WHEN** `npm run build:sidecar` is executed on a supported platform (macOS arm64, macOS x64, Windows x64)
- **THEN** esbuild bundles `server/index.ts` and all JS dependencies into `build/server-bundle.js`
- **AND** Node SEA injects the bundle into a copy of the Node.js executable
- **AND** the resulting binary is placed at `src-tauri/binaries/specrails-server-<tauri-target-triple>` (e.g. `specrails-server-aarch64-apple-darwin`)
- **AND** `better-sqlite3` prebuilt `.node` addon is copied to the same directory

#### Scenario: Missing Rust toolchain
- **WHEN** `npm run build:desktop` is executed without Rust/Cargo installed
- **THEN** the build fails with a clear error referencing `rustup` installation instructions

### Requirement: Sidecar binary is bundled inside the Tauri app package
The Tauri build SHALL include the `specrails-server` binary as an external sidecar resource, copied into the final `.app`/`.exe` bundle.

#### Scenario: App bundle contains server binary
- **WHEN** `npm run build:desktop` completes successfully
- **THEN** the output `.app` (macOS) or `.exe` installer (Windows) contains the `specrails-server` binary
- **AND** the binary is executable with correct permissions

### Requirement: `build:desktop` script orchestrates the full desktop build
A single npm script SHALL chain sidecar compilation and Tauri build.

#### Scenario: Full desktop build
- **WHEN** `npm run build:desktop` is executed
- **THEN** `build:server` compiles TypeScript (existing step)
- **AND** `build:sidecar` compiles the SEA binary
- **AND** `tauri build` packages the Tauri shell with the sidecar
- **AND** the installer artifact is output to `src-tauri/target/release/bundle/`
