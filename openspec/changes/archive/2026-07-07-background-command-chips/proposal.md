# Chips de comandos en background lanzados por el agente

## Why
Users can ask the in-app agent to start long-running commands such as dev servers or watchers, but the current flow either blocks the conversation or leaves the process outside the visible chat workflow. This makes it easy to lose track of live development processes and hard to stop them without switching to an external terminal.

## What changes
- Add an observable background-process registry for shell commands launched from agent chat, including pid, command, cwd, timestamps, status, chat scope, and project scope.
- Expose MCP/REST lifecycle actions so the agent can launch a confirmed command in the background and kill it immediately on request.
- Broadcast `background_process.started`, `background_process.output`, and `background_process.exited` websocket events to the active project/chat surface.
- Add a chat-scoped `BackgroundProcessesContext` and render append-only background process chips above the agent composer input.
- Show hover kill controls and elapsed-time tooltips while rotating chip accents through existing theme variables.

## Impact
- Affected specs: agent-mode-background-processes
- Affected code: Server process lifecycle code in `server/transient-children.ts`, project/MCP routing around jobs, websocket message typing, and frontend agent chat state/UI in `client/src/context` and `client/src/components/agent-chat`.
- Out of scope: Global or persistent background chips, a full interactive terminal in each chip, stdin/log history inside chips, confirmation before killing a chip process, persistence across app restarts, and launching outside a valid project repo context.
