# Contributing to specrails-desktop

Thank you for your interest in contributing to specrails-desktop. This document covers how to set up a development environment, run tests, and submit changes.

## Prerequisites

- **Node.js** >= 20 (declared in `package.json` engines; CI runs Node 20)
- **npm** 9+
- **claude** CLI on your PATH ([Claude Code](https://claude.com/claude-code)) — needed to test job spawning
- **codex** CLI on your PATH (optional) — second supported provider; needed only to test the multi-provider paths. See [docs/codex.md](docs/codex.md) and the internals guide [docs/internals/adding-a-provider.md](docs/internals/adding-a-provider.md).
- **OS:** macOS, Linux, or Windows 10/11 (1809+). The app is cross-platform; the desktop build ships as `.dmg` (macOS) and `.exe`/`.msi` (Windows). See [docs/platforms/windows.md](docs/platforms/windows.md) for Windows-specific notes.

## Local Setup

```bash
git clone https://github.com/fjpulidop/specrails-desktop.git
cd specrails-desktop

# Install server + CLI dependencies
npm install

# Install client dependencies (separate node_modules tree)
cd client && npm install && cd ..
```

> **Note:** This repo has two separate `node_modules` trees — one at the root (server + CLI) and one inside `client/` (Vite + React). Both installs are required. If you see `sh: tsc: command not found` during `npm run build`, one of them is missing.

### Git hooks

Enable the repo's git hooks so a secret scan runs before every commit (it mirrors the gitleaks gate CI enforces) plus a commit-message helper:

```bash
git config core.hooksPath .githooks
```

This wires up `.githooks/pre-commit` (staged-file secret scan) and `.githooks/prepare-commit-msg`. Do this once after cloning to avoid pushing secrets that CI will reject.

## Project Structure

```
specrails-desktop/
├── cli/          # CLI bridge (specrails-desktop command)
├── client/       # Web UI (Vite + React + Tailwind v4)
├── server/       # Express server (API + WebSocket + SQLite)
├── src-tauri/    # Tauri v2 desktop shell (Rust host + bundling)
├── docs/         # Documentation portal source
├── CLAUDE.md     # Claude Code project instructions
└── CONTRIBUTING.md
```

> The desktop app is built with [Tauri v2](https://tauri.app). Most PRs don't touch it; if you do, `npm run dev:desktop` runs the desktop build in dev and `npm run build:desktop` produces a bundle.

## Running Locally

```bash
npm run dev          # Start server (4200) + client (4201) concurrently
npm run dev:server   # Server only with tsx watch
npm run dev:client   # Vite dev client only
```

The client (port 4201) proxies all `/api` and `/hooks` requests to the server (port 4200). Access the dashboard at `http://localhost:4201` in development.

## Running Tests

```bash
npm test             # Run vitest (server + CLI tests), then the core-compat contract check
npm run test:watch   # Vitest in watch mode
```

`npm test` runs `vitest run` and then `tsx scripts/check-core-compat.ts`, which validates the app's checkpoints/verbs against specrails-core (it exits 0 cleanly if core isn't installed locally).

Run a single file:

```bash
npx vitest run server/db.test.ts
```

Tests use `:memory:` SQLite databases. No cleanup or external services required.

## Coverage

**Coverage is a hard CI gate — PRs below threshold are blocked.** Mirror the CI checks locally before pushing:

```bash
npm run test:coverage              # server + CLI coverage
cd client && npm run test:coverage # client coverage
```

Enforced thresholds:

| Scope  | Lines | Functions | Statements | Branches |
|--------|-------|-----------|------------|----------|
| Global | 70%   | 70%       | 70%        | —        |
| Server | 80%   | 80%       | 80%        | 70%      |
| Client | 80%   | 70%       | 80%        | —        |

If a change drops coverage below these, add tests until every threshold passes — never lower the thresholds.

You can reproduce the full CI run with one command:

```bash
npm run ci   # typecheck + npm test + server coverage + client coverage
```

## TypeScript Check

```bash
npm run typecheck    # Checks both server and client
```

Both `server/` and `client/` have separate TypeScript configurations. Typecheck runs both. CI blocks on any TypeScript error.

## Making Changes

1. Fork the repository and create a branch from `main`.
2. Make your changes. Keep PRs small and focused — one concern per PR.
3. Run `npm run typecheck` — fix any TypeScript errors.
4. Run `npm test` — all tests must pass.
5. Run `npm run test:coverage` (and `cd client && npm run test:coverage`) — every threshold must pass.
6. Run `npm run build` — verify there are no build errors.

Tip: `npm run ci` runs typecheck + tests + both coverage gates in one shot.

## Conventions

- **File naming:** kebab-case for server/CLI files, PascalCase for React components
- **No magic strings:** use constants or enums
- **No `any`** unless genuinely unavoidable
- **API calls in client:** always use `getApiBase()` from `lib/api.ts`, never hardcode `/api/...`
- **State per project:** never use module-level caches that could bleed between projects — use `useProjectCache` or per-project Maps in refs
- **WS handlers:** always filter `msg.projectId` against active project via ref, not stale closure

## Commit Convention

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add run history export
fix: correct websocket reconnect timeout
docs: update CLI reference
chore: bump vitest to latest
refactor: extract metrics aggregation
```

Commit prefixes affect automated versioning: `feat:` → minor bump, `fix:` → patch bump, `feat!:` → major bump.

Breaking changes must be flagged with `!` or a `BREAKING CHANGE:` footer:

```
feat!: change WebSocket message protocol format
```

## Submitting a Pull Request

- Target the `main` branch.
- Write a clear PR description: what problem does it solve, how was it tested.
- CI must pass before merge: a **gitleaks** secret scan, **typecheck**, **tests** (`npm test`), and the **coverage gates** (server + client). The coverage gate is the most common contributor PR failure — run it locally first.
- One approving review required.
- Tag your PR with the appropriate label (`feat`, `fix`, `docs`, `chore`).

## Testing Guidelines

- Write tests for all critical paths
- Use real SQLite `:memory:` databases — do not mock the database
- Server-side tests go in `server/*.test.ts`
- Client-side tests match `client/src/**/*.test.ts` or `*.test.tsx` — colocated next to the source they cover, or under a `__tests__/` folder

```typescript
// Good: real in-memory DB
const db = initDb(':memory:')

// Bad: mock
vi.mock('./db')
```

## Reporting Issues

Use [GitHub Issues](https://github.com/fjpulidop/specrails-desktop/issues). Include:
- Your OS and Node.js version
- The command you ran
- The full error output or screenshot

**Found a security vulnerability?** Do not open a public issue — follow the disclosure process in [SECURITY.md](SECURITY.md).

## Code of Conduct

By participating in this project you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
