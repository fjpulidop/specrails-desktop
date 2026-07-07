# terminal-pty-bridge Specification

## Purpose
Define server-side PTY session management, WebSocket attach protocol, resize, input, and lifecycle behavior.

## Requirements

### Requirement: Server-side PTY session registry
The server SHALL maintain a global `TerminalManager` that holds all active PTY sessions keyed by UUID, with a secondary index by `projectId`. Sessions MUST be isolated by project: routes and WS endpoints MUST reject access to a session whose `projectId` does not match the URL-scoped project.

#### Scenario: Session creation returns metadata
- **WHEN** a client POSTs to `/api/projects/:projectId/terminals` with `{ cols, rows }`
- **THEN** the server spawns a new PTY, assigns a UUID, stores it in the registry under that `projectId`, and returns `{ id, name, cols, rows, shell, cwd, createdAt }`

#### Scenario: Cross-project access rejected
- **WHEN** a client connects to `/ws/terminal/:id` with an auth token valid for project A but the session's `projectId` is B
- **THEN** the server responds with HTTP 403 and closes the socket

#### Scenario: Project removal kills its terminals
- **WHEN** a project is removed from the app via `DELETE /api/projects/:id`
- **THEN** all terminal sessions whose `projectId` equals the removed project are killed (SIGTERM then SIGKILL after 2s grace) and removed from the registry

### Requirement: Shell selection and environment
PTY processes SHALL be spawned using the value of `process.env.SHELL`, falling back to `/bin/zsh` on macOS/Linux and `powershell.exe` on Windows. The spawn MUST pass login + interactive flags (`-l -i` for zsh/bash) on POSIX so user rc files load. The child environment MUST inherit `process.env` and MUST set `TERM=xterm-256color` and `COLORTERM=truecolor`.

#### Scenario: zsh loads user rc
- **WHEN** a macOS user with `SHELL=/bin/zsh` and a valid `~/.zshrc` creates a terminal
- **THEN** the spawned zsh loads `.zshrc` (verifiable because custom PROMPT from `.zshrc` appears in the first render)

#### Scenario: Cwd is project path
- **WHEN** a terminal is created for project at `/Users/x/repos/foo`
- **THEN** the PTY's initial working directory is `/Users/x/repos/foo` and `pwd` outputs that path

#### Scenario: TERM and COLORTERM set
- **WHEN** a terminal is created
- **THEN** `echo $TERM` outputs `xterm-256color` and `echo $COLORTERM` outputs `truecolor`

### Requirement: Scrollback ring buffer
Each session SHALL maintain a ring buffer of raw PTY output with capacity of 262144 bytes (256 KB). When output exceeds capacity, the oldest bytes MUST be dropped. The ring buffer MUST be retained while the session is alive, independent of whether any client is currently attached.

#### Scenario: Buffer drops old data
- **WHEN** a session has emitted more than 262144 bytes of output
- **THEN** the ring buffer contains only the most recent 262144 bytes

#### Scenario: Buffer survives zero clients
- **WHEN** a client attaches, writes `ls`, disconnects, then reattaches
- **THEN** on reattach the client receives the full scrollback containing the `ls` output before any new live data

### Requirement: WebSocket attach protocol
Clients SHALL attach to a session by opening a WebSocket to `/ws/terminal/:id?token=<auth>`. The server MUST send the full ring buffer contents as a single binary message before forwarding any live output. Messages from server to client MUST be either binary (raw PTY output) or JSON text (control). Messages from client to server MUST be JSON text for control or binary for stdin writes.

#### Scenario: Replay before live
- **WHEN** a client opens `/ws/terminal/:id`
- **THEN** the first frame sent is a binary frame containing the current ring buffer, followed by a JSON frame `{"type":"ready","cols":N,"rows":M}`, followed by live binary frames as output arrives

#### Scenario: Multiple clients attached simultaneously
- **WHEN** two WebSocket clients are attached to the same session
- **THEN** both receive identical live output frames
- **AND** input from either client is written to the PTY without mixing client identifiers

#### Scenario: Client disconnect does not kill PTY
- **WHEN** all clients disconnect from a session
- **THEN** the PTY remains running and continues to append to the ring buffer

### Requirement: Resize propagation
Clients SHALL send resize control messages `{"type":"resize","cols":N,"rows":M}` when the xterm container resizes. The client-side resize emission MUST be debounced (trailing) so a sustained transition or drag produces a single final resize after the geometry stabilises. The server MUST call `pty.resize(cols, rows)` and update the session's stored dimensions. If multiple clients are attached with different viewport sizes, the server MUST honor the most recent resize.

#### Scenario: Resize reaches child process
- **WHEN** client sends `{"type":"resize","cols":100,"rows":30}`
- **THEN** the PTY is resized and `stty size` in the shell outputs `30 100`

#### Scenario: Resize coalesced during sidebar transition
- **WHEN** an ancestor sidebar transitions over 200ms and the ResizeObserver ticks 12 times during that window
- **THEN** the client sends at most one `resize` message — emitted after the trailing 120ms debounce or upon the ancestor's `transitionend`, whichever fires first
- **AND** if both occur, only the first emission is sent and the second is suppressed for the same final dimensions

#### Scenario: Resize from drag handle still snappy
- **WHEN** the user manually drags the panel height producing 50 resize events in 200ms
- **THEN** at least one resize message is sent during the drag, and exactly one final resize is sent within 120ms after drag end

### Requirement: Input forwarding
Client-to-server binary frames SHALL be forwarded unmodified to `pty.write()`. Text JSON frames with `type: "write"` and a string `data` MUST also be accepted for fallback. The server MUST NOT interpret or transform input bytes.

#### Scenario: Keystroke reaches shell
- **WHEN** the client sends bytes `ls\n` as a binary frame
- **THEN** the shell executes `ls` and the resulting output is streamed back

#### Scenario: Raw escape sequences preserved
- **WHEN** the client sends arrow-key escape sequence bytes
- **THEN** the shell receives them unchanged (verifiable by shell history recall behavior)

### Requirement: Rename operation
Clients SHALL rename a session via `PATCH /api/projects/:projectId/terminals/:id` with body `{ name: string }`. The server MUST update the session's `name` and broadcast a control message `{"type":"renamed","id":"...","name":"..."}` to all attached WebSocket clients and on the app-level WebSocket so other project tabs see the update on return.

#### Scenario: Rename persists in session metadata
- **WHEN** a client PATCHes a session with `{"name":"build watcher"}`
- **THEN** subsequent GETs return that name and the broadcast message is received by all attached clients

#### Scenario: Name is non-empty and length-bounded
- **WHEN** a rename request has empty name or name longer than 64 characters
- **THEN** the server responds with HTTP 400 and does not modify the session

### Requirement: Kill semantics
Killing a session via `DELETE /api/projects/:projectId/terminals/:id` SHALL send `SIGTERM` to the PTY, remove it from the registry, and close all attached WebSockets with code 1000. If the process has not exited within 2 seconds, the server MUST send `SIGKILL`. No confirmation prompt or waiting period MUST be enforced at the API boundary.

#### Scenario: Fast kill path
- **WHEN** a DELETE is issued to a well-behaved shell
- **THEN** SIGTERM is sent, the process exits within 2s, the WS closes, and the session is gone from the registry

#### Scenario: Stuck process SIGKILL fallback
- **WHEN** a DELETE is issued and the process ignores SIGTERM for more than 2s
- **THEN** SIGKILL is sent and the session is removed regardless of exit status

### Requirement: Per-project terminal limit enforcement
The server MUST refuse to create a new terminal when the requesting project already has 10 active sessions. The response MUST be HTTP 409 Conflict with body `{ error: "terminal_limit_exceeded", limit: 10 }`.

#### Scenario: 11th creation rejected
- **WHEN** a project has 10 active terminals and a create POST is issued
- **THEN** the server responds 409 with the error body and does not spawn a PTY

### Requirement: Cross-platform PTY support
The implementation MUST work on macOS (arm64, x64), Linux (x64), and Windows (x64 via ConPTY). The sidecar build MUST bundle the correct prebuilt `pty.node` for the target triple and register a resolver so the pkg-packaged binary can load it, mirroring the existing `better_sqlite3.node` handling.

#### Scenario: Dev mode spawns shell on any supported OS
- **WHEN** a developer runs `npm run dev` on macOS, Linux, or Windows
- **THEN** creating a terminal succeeds with the platform's default shell

#### Scenario: Packaged desktop app loads pty.node
- **WHEN** the Tauri-packaged macOS `.app` is launched and a terminal is created
- **THEN** the sidecar binary resolves `node-pty`'s native addon from `Contents/Resources/pty.node` without ENOENT

### Requirement: Graceful shutdown
On server shutdown (SIGTERM or SIGINT), the `TerminalManager` MUST iterate all sessions, send SIGTERM to each PTY, wait up to 2 seconds, and escalate to SIGKILL for any survivors. Shutdown MUST NOT be blocked waiting for PTY exit beyond the 2-second window.

#### Scenario: Clean shutdown
- **WHEN** the server receives SIGTERM with 3 active terminals running well-behaved shells
- **THEN** all 3 are killed within 2 seconds and the server exits cleanly

### Requirement: REST endpoints
The server SHALL expose these endpoints under the project router:
- `GET /api/projects/:projectId/terminals` → list active sessions
- `POST /api/projects/:projectId/terminals` → create session; body `{ cols?, rows? }`; returns session metadata
- `PATCH /api/projects/:projectId/terminals/:id` → rename; body `{ name }`
- `DELETE /api/projects/:projectId/terminals/:id` → kill session

All endpoints MUST require the existing auth token.

#### Scenario: Unauthenticated request rejected
- **WHEN** any of these endpoints is called without a valid auth token
- **THEN** the server responds HTTP 401

### Requirement: Shell-integration shim composition at spawn time
At PTY spawn time, the `TerminalManager` SHALL consult `resolveTerminalSettings(projectId)` and, when `shellIntegrationEnabled` is `true`, compose shell-specific arguments and environment overrides that load the bundled shell-integration shim. The composition logic MUST be encapsulated in a single helper (`composeShellIntegrationSpawn`) returning `{ args: string[], env: Record<string,string>, shimPath: string | null }` so the spawn site remains shell-agnostic. When `shellIntegrationEnabled` is `false`, the helper MUST return `{ args: [], env: {}, shimPath: null }` and the spawn MUST proceed exactly as before.

#### Scenario: zsh spawn args unchanged when integration off
- **WHEN** `shellIntegrationEnabled = false` and the resolved shell is zsh
- **THEN** the spawn arguments are the existing `["-l", "-i"]` and `env.ZDOTDIR` is not set by the manager

#### Scenario: zsh spawn args extended when integration on
- **WHEN** `shellIntegrationEnabled = true` and the resolved shell is zsh
- **THEN** the spawn arguments are `["-l", "-i"]` (unchanged), and `env.ZDOTDIR` is set to a per-session writable directory containing a generated `.zshrc` that sources the user's `~/.zshrc` then loads the bundled shim

#### Scenario: Per-session shim path is unique and chmod 600
- **WHEN** two sessions are spawned for the same project with shell integration enabled
- **THEN** each receives a distinct `shimPath` under `~/.specrails/projects/<slug>/terminals/<sessionId>/`
- **AND** every generated shim file has mode `0600`

### Requirement: OSC 133 / OSC 1337 mark forwarding over the existing terminal WebSocket
The existing `/ws/terminal/:id` socket SHALL gain a new server-to-client JSON control message: `{ "type": "mark", "kind": "prompt-start" | "prompt-end" | "pre-exec" | "post-exec" | "cwd", payload?: object, ts: number }`. The bytes corresponding to those OSC sequences MUST also continue to flow as part of the binary stream so the renderer (and image addon) can observe them. The control frame MUST NOT be sent for malformed sequences. No new WebSocket endpoint and no protocol version bump are required.

#### Scenario: Prompt-start mark control frame
- **WHEN** the PTY emits `\x1b]133;A\x07` and shell integration is on
- **THEN** the server sends a JSON text frame `{"type":"mark","kind":"prompt-start","ts":<unixMs>}`
- **AND** the binary frame containing those bytes is also delivered to xterm

#### Scenario: Post-exec mark with exit code payload
- **WHEN** the PTY emits `\x1b]133;D;0\x07`
- **THEN** the server sends `{"type":"mark","kind":"post-exec","payload":{"exitCode":0},"ts":<unixMs>}`

#### Scenario: Mark frames absent when integration off
- **WHEN** `shellIntegrationEnabled = false` and the session never emits OSC 133 sequences
- **THEN** no mark frames are ever sent
- **AND** the binary stream is forwarded unchanged

### Requirement: Per-session shim cleanup
The `TerminalManager` SHALL delete the per-session shim directory when its PTY exits (clean kill or process exit). On server startup, the manager SHALL scan `~/.specrails/projects/*/terminals/` for shim directories whose owning session is no longer alive (no matching active session in the registry on cold start, since the registry is volatile) and remove any directory older than 24 hours.

#### Scenario: Shim cleanup on session kill
- **WHEN** a session with shell integration is killed
- **THEN** the directory `~/.specrails/projects/<slug>/terminals/<sessionId>/` and all contents are removed before the kill response returns

#### Scenario: Stale shim cleanup on startup
- **WHEN** the server starts and finds a 48-hour-old shim directory under `~/.specrails/projects/foo/terminals/<orphan>/`
- **THEN** that directory is removed during the first 5 seconds of server start
- **AND** directories younger than 24 hours are left alone
