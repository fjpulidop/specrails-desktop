# Design

## Context

See proposal.md for motivation. This document derives the existing diff against d815e23cbbbdd4aaa33fb8e605f64aa066bb3a17. Mission views already have conversation-keyed draft storage, stable-key split panes, scroll persistence, normal send admission and bounded provider-history reconstruction. This change connects those seams and adds independent history/file snapshots. No new module, dependency or provider strategy is introduced.

## Goals / Non-Goals

**Goals:** Keep selection ownership bound to its source; make the history cut explicit; keep copied history separate from executable ownership; retain transaction ownership in the missions route.

## Non-Goals

- Automatically submitting either new mission's selected text.
- Copying unsent composer uploads, later messages, queued inputs, provider session IDs, Core turn IDs or live execution ownership.
- Supporting selections across panes or including live/queued text.
- Replacing existing split-layout rules or adding a new window-management scheme.
- Changing dev-server ports or runtime metadata; no such source changes are in the frozen diff.

## Decisions

1. **Capture the selected range and its source action.** `readMissionSelection` accepts one noncollapsed range within the wrapped transcript, intersects committed message wrappers and compares selected text with those segments ignoring whitespace. The final segment with nonblank text determines the cut, including backwards selections via document-order Range semantics. A zero-offset endpoint at the next message is excluded. The menu captures source ID, text, boundary, a stable queue ID and the source `send` closure before focus changes. Its busy ref prevents concurrent double-click admission; unsuccessful sends keep the snapshot for retry. This uses the existing queue path and never calls composer-submit draft clearing.
2. **Keep new prompts as drafts.** `branchAgentConversation` reads source settings and validates boundary presence before using the existing creation API for empty mode. Fork mode uses the new endpoint with no empty fallback. Only a successful result writes the selected text and an empty attachment list into the new draft and calls split `open` with composer focus. The root split provider now also surrounds floating UI. Split IDs append without replacing existing pane keys; existing scroll persistence stays in place. The menu changes to Agent mode and the mission route when needed.
3. **Snapshot synchronously under the route-owned transaction.** The branch route validates a nontrashed source, mode and source-owned boundary, decorates persisted messages with delivery state, then slices the inclusive cut. It creates a fresh conversation carrying provider/model/project/tier/effort, copies referenced files, and copies message rows inside one SQLite transaction. Only success announces conversation creation. Empty mode is also accepted by this endpoint, although the client deliberately uses the established creation API.
4. **Preserve records without replayable ownership.** `copyAgentHistory` generates new message IDs, keeps original timestamps, content, roles, attachment/context references, intents and delivery status, and records the immediate source message ID. Conversation provenance stores the source ID, message ID and title without a source foreign key. No input admissions, provider session or Core turn ID are copied. This lets the fork survive source deletion and avoids replaying pending work.
5. **Own attachment copies independently.** File copying validates every reference before writing, deduplicates IDs, rejects existing destinations and source-as-target, then copies file bytes and sidecars exclusively. A copy failure removes partial attachments. A later database failure rolls back rows and invokes destination cleanup. Historical attachment IDs seed the fork's first session only while it has no session ID; interrupted/cancelled inherited rows are excluded, IDs are deduplicated with current uploads, and inherited IDs do not become attachments of the new user message.
6. **Make inherited work inactive.** Inherited non-user rows render in disabled fieldsets. Inherited messages are filtered out before deriving active proposals/deliveries, and inherited final assistant options cannot activate reply shortcuts. The source title is displayed with an untitled fallback. Eight locale files supply menu, status, error and provenance labels.

## Rejected alternatives

- Falling back to an empty mission when the fork endpoint is unavailable is explicitly rejected by code and tests: the version error preserves the menu and draft instead.
- Requiring the new snapshot endpoint for From scratch is avoided explicitly in the API client comments and tests; the existing creation API is used for compatibility with older running servers.
- The recorded decisions choose independent attachment copies, an inclusive cut through the last selected message and an appended pane. No other alternatives were recorded.

## Blast radius

- `client/src/features/missions/components/__tests__/MissionSelectionMenu.test.tsx`: Adds selection boundaries, captured-source send/retry, draft preparation, keyboard, archive and failure coverage.
- `client/src/features/missions/components/__tests__/streaming-store-regressions.test.tsx`: Asserts inherited cards and option shortcuts cannot act.
- `client/src/features/missions/components/AgentConversationView.tsx`: Wraps committed rows for selection, shows provenance, disables inherited cards, filters active work and focuses the new composer.
- `client/src/features/missions/components/MissionSelectionMenu.tsx`: Implements range capture, contextual actions, keyboard interaction and async action lifecycle.
- `client/src/features/missions/context/AgentChatContext.tsx`: Shares root split context with the floating panel and bubble.
- `client/src/features/missions/context/MissionSplitViewsContext.tsx`: Adds a composer-focus request to split opening and clears it on close/source changes.
- `client/src/features/missions/lib/__tests__/agent-api.test.ts`: Covers source settings, missing boundaries and fork endpoint compatibility.
- `client/src/features/missions/lib/agent-api.ts`: Adds provenance types and branch client behavior and encodes conversation IDs on reads.
- `client/src/features/missions/README.md`: Documents selection actions and inherited-history safeguards.
- `client/src/locales/de/agent.json`: Adds German selection labels and feedback.
- `client/src/locales/en/agent.json`: Adds English selection labels and feedback.
- `client/src/locales/es/agent.json`: Adds Spanish selection labels and feedback.
- `client/src/locales/fr/agent.json`: Adds French selection labels and feedback.
- `client/src/locales/it/agent.json`: Adds Italian selection labels and feedback.
- `client/src/locales/ja/agent.json`: Adds Japanese selection labels and feedback.
- `client/src/locales/pt/agent.json`: Adds Portuguese selection labels and feedback.
- `client/src/locales/zh/agent.json`: Adds Chinese selection labels and feedback.
- `docs/guide/en/integrations/6-agent-chat.md`: Explains reuse, fork scope and keyboard interaction in English.
- `docs/guide/es/integrations/6-agent-chat.md`: Explains the same user flows in Spanish.
- `docs/internals/api-reference.md`: Documents branch payload, result and failures.
- `docs/internals/source-map.md`: Indexes the new component and test and updates the generated source count.
- `server/attachment-manager.test.ts`: Tests independent copies, deduplication, missing files, partial cleanup and unsafe/existing destinations.
- `server/attachment-manager.ts`: Adds synchronous attachment snapshot copying with validation and cleanup.
- `server/desktop-db.test.ts`: Updates migration-sequence and upgrade expectations to version 39.
- `server/desktop-db.ts`: Appends migration 39 for fork provenance and inherited row delivery status.
- `server/modules/agents/README.md`: Documents copy ownership and retained record fields.
- `server/modules/agents/runtime/agent-store.ts`: Persists/maps conversation provenance and copies message records with fresh IDs.
- `server/modules/missions/README.md`: Documents attachment snapshots, branch route, rollback and first-session seeding.
- `server/modules/missions/runtime/agent-chat-branch.test.ts`: Exercises inclusive snapshots, settings, files, provenance, no replay, invalid requests and rollback.
- `server/modules/missions/runtime/agent-chat-manager.test.ts`: Asserts first-session historical attachment seeding and later resume without repeated extraction.
- `server/modules/missions/runtime/agent-chat-manager.ts`: Resolves eligible inherited attachment IDs into a fresh fork session.
- `server/modules/missions/runtime/agent-chat-router.ts`: Adds source validation, snapshot transaction, cleanup, announcement and response handling.
- `server/modules/missions/runtime/agent-input-store.test.ts`: Updates legacy upgrade assertions to migration 39 while preserving input recovery checks.

## Risks / Trade-offs

- Synchronous attachment copying holds the database transaction during file I/O → it keeps the snapshot cut and row ownership together, with prevalidation and partial-copy cleanup; no performance benchmark is present.
- Filesystem writes do not participate in SQLite rollback → the route invokes destination cleanup after database failure and tests cover missing files and insert failure. Cleanup failure is logged; crash-atomic cross-resource recovery is not added.
- Older running servers may lack fork support → explicit endpoint-version errors preserve user work; From scratch remains compatible with the existing API.
- Source reading-position retention relies on stable existing pane identities and scroll persistence → selection tests assert draft/pane requests, but the added tests do not directly measure scroll position or end-to-end multi-pane focus.

## Migration Plan

Desktop initialization appends guarded migration 39, adding nullable `fork_source`, `source_message_id` and `source_delivery_status` columns without rewriting earlier migrations. Existing rows retain normal behavior with absent provenance. Deploy the matching frontend/server for fork support. No down migration or automated runtime rollback procedure is supplied by this diff.

## Assumptions

- No non-obvious product intention was needed to explain the diff. The three open questions are resolved by code: included attachment references are independently copied; panes append; multi-message selections end at the last message with selected text.
- The summary's preview ports and isolated sample-data setup are conversation history, not changes evidenced by this frozen diff; they are intentionally not requirements or completed implementation tasks here.
- The summary describes a new agent session: the API actually creates a conversation with a null provider session and starts that session only when the user later sends. No automatic turn is inferred.
- Checked tasks below report implemented source and test assertions, not checks executed by this deriver. Core owns verification; no user-validation outcome is claimed.
