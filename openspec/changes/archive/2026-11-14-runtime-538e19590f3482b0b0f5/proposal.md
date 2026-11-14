# Proposal

## Why

Agent chat and Explore attachments are filtered by a closed MIME allow-list, so a developer cannot attach a `.md`, `.yaml`, `.ts` or `.log` file that Claude or Codex accept without friction, and a refusal does not say why. `.sql` only works because of a dedicated special case. Every new text type would need another code change.

## What Changes

- Agent conversation uploads (`attachmentManager.uploadAgent`, `POST /api/agent/conversations/:id/attachments`) accept a file iff it is a rich type (image, PDF, Excel) or its content is readable text. Readable text is detected from a bounded prefix, never from an extension list, and stored as `text/plain`.
- The agent route's multer MIME `fileFilter` is removed, because it runs before the buffer exists. Validation moves into `uploadAgent`, which returns HTTP 400 `"<filename>" is not a text file and cannot be attached` for binaries. The 25 MB multer limit and its existing size error are unchanged.
- Explore uploads go through the ticket attachment route with a pending-spec UUID, not through `uploadAgent`. That route gains an explicit opt-in (`?readableText=1`) that applies the same content rule only for pending-spec keys. `ProposeSpecModal` and real tickets do not send the opt-in, so their rules are unchanged.
- `RichAttachmentEditor` gains an opt-in prop that removes the `accept` attribute and the client MIME gate. Explore turns it on. `ProposeSpecModal` keeps today's behaviour. `uploadAttachment` forwards the opt-in.
- A refused file shows its server error through the existing `onUploadError` toast. Other files in the same multi-file drop still upload, because each file is uploaded independently.
- `extractText` decodes UTF-16 text that carries a BOM, and strips a UTF-8 BOM.
- Findings that differ from the ticket text: Explore does not use `uploadAgent`. The agent composer (`AgentComposer`) has no client-side type filter today, so its client side needs no change.

## Capabilities

### New Capabilities
- `readable-text-attachments`: content-based acceptance of text and code files on agent and Explore conversation attachments, the refusal contract for non-text files, and the guarantee that ticket and spec attachments keep their current rules.

### Modified Capabilities
- `agent-attachments`: the "Agent attachment endpoints and storage" requirement drops the MIME allow-list in favour of the rich-type-or-readable-text rule.

## Impact

- Server: `server/attachment-manager.ts`, `server/modules/missions/runtime/agent-chat-router.ts`, `server/project-router-tickets.ts`.
- Client: `client/src/features/chat/components/RichAttachmentEditor.tsx`, `client/src/features/chat/lib/attachments.ts`, `client/src/features/specs/components/explore-spec/ExploreSpecShell.tsx`.
- Tests: `server/attachment-manager.test.ts`, the agent-chat router and ticket router tests, `client/src/features/chat/lib/__tests__/attachments.test.ts`, and the editor tests.
- Docs: `docs/internals/api-reference.md` attachment notes.
- No schema, migration, dependency or persisted-format change. No new i18n keys, because the refusal text comes from the server `error` field.
