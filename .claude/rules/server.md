---
paths:
  - "server/**"
  - "cli/**"
---

# Server & CLI Conventions

## TypeScript

- CommonJS output (`"module": "commonjs"` in `tsconfig.json`) — use `require()` for imports where needed, but prefer `import` syntax compiled to CJS
- Strict mode enabled — no implicit `any`
- File naming: kebab-case (e.g., `queue-manager.ts`, `desktop-router.ts`)

## Express patterns

- Project-scoped routes are composed by `server/project-router.ts` from sub-routers (`server/project-router-*.ts`, module `adapters/http.ts` / `*-router.ts`)
- App-scoped routes are composed by `server/desktop-router.ts` from `server/desktop-router-*.ts` and module routers
- Route handlers should be thin — delegate business logic to manager classes
- Always validate `projectId` existence via `ProjectRegistry` before accessing `ProjectContext`

## SQLite (better-sqlite3)

- **Always use parameterized queries** — never string-interpolate user input into SQL
  - Wrong: `` db.prepare(`SELECT * FROM jobs WHERE id = ${id}`) ``
  - Right: `db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)`
- All DB initialization happens via the `MIGRATIONS` array in `server/db/migrations.ts` — add new migrations at the end, never modify existing ones
- Use `:memory:` in all tests — never use real file paths in tests
- The `ProjectContext` holds the DB instance — never create `new Database(...)` inside route handlers

## WebSocket protocol

- Every project-scoped message MUST include `projectId`
- Client-side handlers filter by `activeProjectId` using a ref (not state) to avoid stale closures
- App-level messages (`desktop.project_added`, `desktop.project_removed`, `desktop.projects`) have NO `projectId` field
- Use `boundBroadcast` closures to inject `projectId` — do not pass it as a constructor argument

## Process spawning

- `QueueManager` and `ChatManager` spawn `claude` CLI processes — always set `cwd` to `project.path`
- Validate and sanitize any user-provided arguments before passing to `spawn()` or `exec()`

## Super mode

- Server runs in Super mode by default — one Express process, multiple projects
- `ProjectRegistry` loads every `ProjectContext` in a background warm-up after `listen` (most recently used first); `getContext(id)` loads a not-yet-warmed project on demand. Code that needs every project at startup waits for `registry.whenWarm()`
- `~/.specrails/desktop.sqlite` — app-level SQLite (project registry)
- `~/.specrails/projects/<slug>/jobs.sqlite` — per-project SQLite

## Testing

- Test framework: Vitest with Node.js environment
- Test files: `<module>.test.ts` alongside source files in `server/` or `cli/`
- Always use `initDb(':memory:')` — never real file paths
- Reset DB state in `beforeEach` with a fresh `initDb(':memory:')`
- Use Supertest for Express route tests: `import request from 'supertest'`
- Coverage: `server/**/*.test.ts` and `cli/**/*.test.ts` (no client tests)
