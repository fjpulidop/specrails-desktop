## Why

Desktop currently wraps the whole implementation pipeline in one provider invocation, preventing explicit control and durable recovery by role. Users need to configure present and future providers, including local AI, while keeping Claude, Codex, Gemini and Kimi and macOS/Windows support.

## What Changes

- Add project runtime configuration and provider/role settings UI with validated endpoints and environment credential references.
- Route configured Core implementation invocations through the shared LangGraph runtime, preserving existing providers, worktrees, scope, completion validation and delivery ownership.
- Expose runtime status, continuation and phase progress through project APIs and existing logs.
- Keep legacy execution available for existing projects and preserve existing settings edits.
- Add offline integration tests and end-user setup documentation for local AI and existing CLIs.

## Capabilities

### New Capabilities
- `programmatic-agent-runtime`: shared runtime integration, configuration and lifecycle in Desktop.

### Modified Capabilities

None. Legacy loops and providers continue using their existing contracts until explicitly configured.

## Impact

Project API/settings, runtime bridge, Core packaging and execution integration, tests and documentation. Uses the same Core engine rather than a second workflow scheduler.
