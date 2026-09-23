# Conversation stream and recovery core

The [public API](index.ts) exposes [draft stream filtering](domain/draft-stream.ts)
and [resume context construction](domain/recovery-context.ts). These functions
have no filesystem, process, database or provider-client dependencies. Recovery
keeps the current user turn intact, bounds historical context by UTF-8 bytes and
only recognizes the existing Claude missing-session diagnostic.

[ChatManager](../../chat-manager.ts) supplies persisted messages and owns
processes, provider selection, retry limits and broadcast effects. Its legacy
filter export remains for callers. Provider-specific diagnostic interpretation
is deterministic; it does not create a second provider transport abstraction.

Run `npx vitest run server/modules/conversations server/chat-manager.test.ts`.
[Policy tests](__tests__/recovery-context.test.ts) cover Unicode boundaries,
non-retryable failures and every two-chunk draft-fence split. The manager suite
covers the actual one-time retry and persisted conversation lifecycle.
