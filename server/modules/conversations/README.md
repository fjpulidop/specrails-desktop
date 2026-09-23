# Conversation stream and recovery core

The [public API](index.ts) exposes [draft stream filtering](domain/draft-stream.ts)
and [resume context construction](domain/recovery-context.ts). These functions
have no filesystem, process, database or provider-client dependencies. Recovery
keeps the current user turn intact, bounds historical context by UTF-8 bytes and
only recognizes the existing Claude missing-session diagnostic.

[ChatManager](runtime/chat-manager.ts) supplies persisted messages and owns
processes, provider selection, retry limits and broadcast effects. Its legacy
filter export remains for callers. Provider-specific diagnostic interpretation
is deterministic; it does not create a second provider transport abstraction.

Run `npx vitest run server/modules/conversations server/modules/conversations/runtime/chat-manager.test.ts`.
[Policy tests](__tests__/recovery-context.test.ts) cover Unicode boundaries,
non-retryable failures and every two-chunk draft-fence split. The manager suite
covers the actual one-time retry and persisted conversation lifecycle.

## Reviewed public entry points

- [runtime/chat-manager.ts](runtime/chat-manager.ts)
- [runtime/context-budget.ts](runtime/context-budget.ts)
- [runtime/context-scope.ts](runtime/context-scope.ts)
- [runtime/explore-contract-refine.ts](runtime/explore-contract-refine.ts)
- [runtime/explore-cwd-manager.ts](runtime/explore-cwd-manager.ts)
- [runtime/explore-draft-title.ts](runtime/explore-draft-title.ts)
- [runtime/explore-smash.ts](runtime/explore-smash.ts)
- [runtime/explore-stdin-session.ts](runtime/explore-stdin-session.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/conversations` and any affected consumers.
