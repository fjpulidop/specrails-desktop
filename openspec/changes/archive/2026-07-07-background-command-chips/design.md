# Design - background-command-chips

## Context
Specrails Desktop already tracks some fire-and-forget children in `server/transient-children.ts`, owns AI job children inside `QueueManager`, exposes project actions through MCP tools in `server/mcp/tools`, and streams project events over the existing websocket `WsMessage` bus. The frontend already has websocket-backed scoped providers such as `TerminalsContext`, composer chip patterns in `AgentComposer`, animated removable chips in `AttachmentChip`, Radix tooltip primitives, and elapsed-duration logic in `ActiveJobCard`. This change must reuse those patterns while keeping agent-launched shell processes scoped to the launching chat and project.

Scope: both, security-sensitive

## Goal
Add a confirmed agent-chat background shell command flow that starts, displays, updates, and kills long-running processes from scoped composer chips.

## Non-Goals
- Do not implement an interactive terminal, stdin, or full log viewer inside the chip.
- Do not persist background processes across app restarts or project/tab changes.
- Do not make background process chips global across chats.
- Do not change AI job queue semantics or reuse `specrails_jobs(spawn)` for free shell execution.
- Do not introduce new hardcoded colors outside existing theme accent tokens.

## Design

### Architecture
Add a background process registry beside the existing transient child registry. `startBackgroundProcess(command, cwd, chatId, projectId)` spawns a shell child in the given repo cwd, records its metadata, tracks stdout/stderr for broadcast, and registers cleanup handlers. `killBackgroundProcess(pid)` performs immediate tree termination with SIGTERM and a short SIGKILL escalation using the existing tree-kill pattern already used for job cancellation.

The server exposes lifecycle actions through a project-scoped surface used by the MCP tool. The MCP action is explicitly classified as at least `operate` because it executes arbitrary user shell. The frontend listens for `background_process.*` messages, stores only processes matching the active `projectId` and chat/conversation id, and renders chips in the composer row in insertion order until the process exits or is killed.

```
agent confirms command
  -> MCP background action
  -> project router starts child
  -> transient registry records child
  -> websocket events update active chat context
  -> composer renders process chips
  -> chip X calls kill action
```

### Data shapes
```ts
export type BackgroundProcessStatus =
  | 'starting'
  | 'running'
  | 'exited'
  | 'killed'
  | 'failed'

export interface BackgroundProcess {
  pid: number
  command: string
  cwd: string
  startedAt: number
  status: BackgroundProcessStatus
  chatId: string
  projectId: string
  exitCode?: number | null
  signal?: string | null
}
```

```ts
export interface BackgroundProcessStartedMessage {
  type: 'background_process.started'
  process: BackgroundProcess
  timestamp: string
  projectId: string
}

export interface BackgroundProcessOutputMessage {
  type: 'background_process.output'
  pid: number
  chatId: string
  projectId: string
  source: 'stdout' | 'stderr'
  line: string
  timestamp: string
}

export interface BackgroundProcessExitedMessage {
  type: 'background_process.exited'
  process: BackgroundProcess
  timestamp: string
  projectId: string
}
```

```ts
interface BackgroundProcessesContextValue {
  processes: BackgroundProcess[]
  kill: (pid: number) => Promise<void>
}
```

```ts
interface BackgroundProcessChipProps {
  process: BackgroundProcess
  accentVariant: 'accent-primary' | 'accent-info' | 'accent-highlight'
  onKill: (pid: number) => void
}
```

### State & lifecycle
Background process status follows:

```
starting -> running -> exited
starting -> failed
running -> killed
running -> failed
```

The registry owns the authoritative process state until close/error. When a project is removed or the app shuts down, `killTransientChildren(projectId)` also terminates active background processes for that project and broadcasts terminal state where the broadcast callback is still available. Client state is volatile: switching chat/project removes visibility by filtering on active scope, and app reload starts from empty state.

### Public API / surface
```ts
startBackgroundProcess(
  command: string,
  cwd: string,
  chatId: string,
  projectId: string,
  hooks?: {
    onStarted?: (process: BackgroundProcess) => void
    onOutput?: (event: BackgroundProcessOutputEvent) => void
    onExited?: (process: BackgroundProcess) => void
  },
): BackgroundProcess
```

```ts
killBackgroundProcess(pid: number): void
```

```ts
// MCP tool action, colocated with the project jobs facade unless a dedicated
// background-process tool is cleaner in the existing registry.
specrails_jobs({
  action: 'background_start',
  projectId?: string,
  command: string,
  cwd?: string,
  chatId: string,
})

specrails_jobs({
  action: 'background_kill',
  projectId?: string,
  pid: number,
  chatId: string,
})
```

The in-app agent must propose the background launch in natural language and wait for explicit user confirmation before invoking the start action. The server validates that the resolved cwd stays within the selected project repo.

## Trade-offs

| Option | Pros | Cons | Chosen? |
|---|---|---|---|
| Extend `transient-children.ts` with a named background registry | Reuses shutdown/project cleanup semantics and keeps process ownership centralized | Requires broadening a currently private helper | Yes |
| Add a separate process manager unrelated to transient children | Clear separation from existing helper | Easy to forget in shutdown/project-removal cleanup | No |
| Add actions to `specrails_jobs` | Reuses existing MCP project facade and permission-tier pattern | The jobs tool name is broader than process chips | Yes |
| Add a brand-new MCP tool | Cleaner naming | More registry and documentation churn for the same project-scoped lifecycle | No |

Extending the transient child registry is the safest path because cleanup on app/project close is a hard invariant and already belongs there.

## Risks
- Arbitrary shell execution can be dangerous; mitigate with explicit agent confirmation, `operate` tier classification, cwd validation inside the project, and no silent launch.
- PID-only kill can target the wrong process after PID reuse; mitigate by checking the pid exists in the registry and belongs to the requested project/chat before killing.
- High-volume stdout can flood the UI; mitigate by line-splitting and broadcasting bounded output suitable for status only, with no full log retention in the chip context.
- Chat scoping can drift if the wrong id is used; mitigate by requiring `chatId` in start/kill calls and filtering all client events by active conversation id and project id.
- Terminal events after shutdown can throw against disposed broadcast state; mitigate with best-effort guards and terminal-state cleanup.

## Open questions
- None.
