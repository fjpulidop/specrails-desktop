# Design

## Context

See proposal.md for motivation. Observed current state:

- `server/attachment-manager.ts` holds one allow-list, `SUPPORTED_MIME_TYPES`. `normalizeUploadedMimeType(mimetype, originalname)` maps SQL and image extensions onto it, and `isSupportedUploadedFile` wraps both. `upload()` (tickets, including pending Explore specs) and `uploadAgent()` (agent chat) each re-check the allow-list. `extractText` reads csv/txt/json/sql as UTF-8.
- Both HTTP routes use multer with a 25 MB limit and a `fileFilter` built on `isSupportedUploadedFile`. The filter runs before the buffer is read and only records the rejected MIME, so a content check cannot live there. Both routes already map `LIMIT_FILE_SIZE` to `File too large (max 25 MB)`.
- Explore does NOT use `uploadAgent`. `ExploreSpecShell` renders `RichAttachmentEditor` with `ticketKey={pendingSpecId}`, and the editor calls `uploadAttachment` against `/tickets/:pendingUuid/attachments`. `ProposeSpecModal` uses the same editor and the same route, and must not change. The agent composer (`AgentComposer.uploadFiles` -> `uploadAgentAttachment`) has no client type filter and no `accept` attribute; only the server filter rejects there.
- Provider consumption is uniform. `getClaudeArgsAgent` (agent chat) and `getClaudeArgs` (Explore pending spec, `project-router-tickets.ts`) both return `<user-attachment>` text blocks, produced by `wrapUserAttachment` after `extractText`, and only images take an extra provider-specific path (codex `--image`). A text file is just a text block for claude, codex and gemini, so no per-provider branch is needed.
- Size: 25 MB multer limit on both routes. It is kept (out of scope). The extracted text is injected whole, as it is today for `.txt`/`.json`.

## Goals / Non-Goals

**Goals:**
- Accept any readable text or code file on agent and Explore conversation uploads, decided by content.
- Refuse non-text files with a file-named, reasoned 400.
- Keep ticket/spec attachment behaviour byte-for-byte unchanged.

**Non-Goals:**
- No change to the 25 MB limit, to `upload()` rules for real tickets or `ProposeSpecModal`, or to binary/office formats (zip, docx).
- No extension allow-list, no new dependency, no persisted-format or schema change, no new i18n keys.
- No magic-number sniffing of rich types and no change to image/PDF/Excel classification.

## Decisions

1. **Detector in `attachment-manager.ts`.** Add pure `isReadableText(buffer, maxPrefixBytes = 8192): boolean` and an internal `resolveReadableTextMime(file)`. Rules on the prefix: empty -> true; UTF-8 BOM stripped; UTF-16 LE/BE BOM -> true when the prefix decodes; otherwise any NUL -> false; the prefix must decode as UTF-8 with `TextDecoder('utf-8', { fatal: true })` (trimming up to 3 trailing bytes so a multibyte character cut by the prefix boundary is not a failure); control characters other than `\t \n \r \f` and ESC must be under 1% of the prefix. A single long line is irrelevant because only byte classes are inspected. Rejected: extension allow-list (the current problem); `file(1)`-style libraries (new dependency).
2. **Rich types keep precedence and today's mapping.** Rich = image/jpeg|png|gif|webp, `application/pdf`, the two Excel MIMEs. For those, the existing `normalizeUploadedMimeType` result is used unchanged (so a `application/pdf` file named `.png` stays PDF). Everything else, including csv/json/plain/SQL, goes through the detector. Accepted generic text is stored as `text/plain`. Rejected: running the detector on rich types.
3. **Single shared rule, two entry points.** Export `isConversationUploadAccepted`-style helper used by `uploadAgent` and by `upload()` when a new optional argument `allowReadableText: true` is passed. `upload()` without the argument keeps the current allow-list code path. A refusal throws an error with `status = 400` and the message `"<filename>" is not a text file and cannot be attached` (filename is the sanitized original name, not a path).
4. **Remove the multer `fileFilter` on the agent route** (it cannot see content); validation happens in `uploadAgent`, whose 400 the route already forwards via `e.status`. The `No file uploaded` branch stays for a missing field.
5. **Explore opt-in via query `?readableText=1`.** On the ticket route the `fileFilter` lets the file through when `req.query.readableText === '1'`; the handler passes `allowReadableText` to `upload()` only when `parsed.isPending` is true. For a numeric ticket id the flag is ignored and the file would already have passed or failed the old filter, but a file let through by the filter on a real ticket is still rejected by `upload()`'s allow-list check (it re-checks), so real tickets stay unchanged. Rejected: a new Explore-specific endpoint (duplicates storage, pending-key migration and cleanup); sniffing `Referer` (fragile).
6. **Client opt-in prop.** `RichAttachmentEditor` gets `acceptAnyFile?: boolean` (default false). When true: no `accept` attribute and no `isSupportedAttachmentFile` gate, and `uploadAttachment(ticketKey, file, signal, { readableText: true })` appends the query. `ExploreSpecShell` sets it. `isSupportedAttachmentFile` and `ATTACHMENT_ACCEPT_MIME` are left as they are for `ProposeSpecModal`; the ticket's "no longer filters" criterion is satisfied by the conversation callers no longer consulting them. Errors flow through the existing `onUploadError` toast whose `detail` is `err.message` (the server text).
7. **Multi-file isolation.** `uploadFiles` already runs `uploadFile` per file with its own try/catch, and `AgentComposer.uploadFiles` has a per-file try/catch, so a refusal cannot abort others. Tests lock this in.
8. **UTF-16 reading.** `extractText` for `text/plain` reads the buffer once: UTF-16LE/BE BOM -> decode accordingly (swap bytes for BE), UTF-8 BOM -> strip, else UTF-8. Without this a UTF-16 file would be accepted and then read as garbage.

## Local reference patterns

- Closest implementation: `normalizeUploadedMimeType` and `isSupportedUploadedFile` in `server/attachment-manager.ts` (SQL/image fallbacks), tested in `server/attachment-manager.test.ts`.
- Route pattern: `attachmentUpload` multer + `err instanceof multer.MulterError` handler in `server/modules/missions/runtime/agent-chat-router.ts` (~L128, ~L490) and `server/project-router-tickets.ts` (~L1990, ~L2014); `fileRejected` convention for filter rejections.
- Client: `RichAttachmentEditor.uploadFile`/`uploadFiles` (`Promise.all` of independent per-file try/catch), `uploadAttachment` in `client/src/features/chat/lib/attachments.ts`, `onUploadError` toast in `ExploreSpecShell.tsx`; tests in `client/src/features/chat/components/__tests__/RichAttachmentEditor.test.tsx` and `client/src/features/chat/lib/__tests__/attachments.test.ts`.
- Async/state: uploads are async per file and tracked in `uploads` state; the error propagates as a thrown `Error(body.error)` from `uploadAttachment` into `onUploadError`. Server tests use Vitest, Supertest and a temp home dir; no equivalent route test for the agent attachment upload exists yet (only `server/agent-chat-router-background-cleanup.test.ts`), so task 3 adds a focused Supertest test.
- Versions: Express 5, multer 2.x (memory storage), Vitest; confirmed in package.json.

## Risks / Trade-offs

- A text file in a legacy encoding (Latin-1, invalid UTF-8) is refused as "not a text file" rather than garbled -> message is explicit; broader encodings are a later decision.
- The detector samples only a prefix, so a file with binary content after 8 KB would pass -> acceptable, since it is read as UTF-8 text and is size-bounded by 25 MB.
- Large logs up to 25 MB are injected whole into the prompt, as `.txt` already is -> the size limit is out of scope; the same behaviour exists today for plain text.
- Opt-in query could be sent by any client -> only widens acceptance to readable text on pending Explore keys, still behind the same project routing and size cap.
- Filename appears in an error message and in the `name="..."` attribute of the block -> the error uses the sanitized name; attribute handling is unchanged existing behaviour.

## Assumptions

- Which route Explore uses (the ticket route, pending UUID)? Verified in code; the opt-in is scoped to it.
- Is the 25 MB limit adequate for code and logs? Assumed yes and kept, as the ticket states it is out of scope.
- Is detection by content, or by extension too? Content only; extensions are never consulted for text.
- Do claude, codex and gemini receive text the same way? Verified: all get the same `<user-attachment>` text block.
- How to scope the change away from tickets? Assumed an explicit opt-in on the shared route plus a separate code path in `upload()`.
- A file reported as an image/PDF MIME keeps the current classification; no sniffing of rich types.

## Blast radius

- `server/attachment-manager.ts`: `isReadableText`, shared acceptance helper, `uploadAgent` validation, optional `allowReadableText` in `upload()`, `extractText` BOM/UTF-16 decode.
- `server/modules/missions/runtime/agent-chat-router.ts`: drop the MIME `fileFilter` (content is checked in `uploadAgent`); keep size handling.
- `server/project-router-tickets.ts`: filter honours the opt-in; handler passes `allowReadableText` for pending keys only.
- `client/src/features/chat/lib/attachments.ts`: `uploadAttachment` optional options argument that appends `?readableText=1`.
- `client/src/features/chat/components/RichAttachmentEditor.tsx`: `acceptAnyFile` prop, `accept` and gate skipped when set.
- `client/src/features/specs/components/explore-spec/ExploreSpecShell.tsx`: pass `acceptAnyFile`.
- `server/attachment-manager.test.ts`, a new `server/modules/missions/runtime/agent-chat-router-attachments.test.ts`, `client/src/features/chat/lib/__tests__/attachments.test.ts`, `client/src/features/chat/components/__tests__/RichAttachmentEditor.test.tsx`: tests.
- `docs/internals/api-reference.md`: note the readable-text rule on the agent and ticket attachment rows.
- `npm run docs:source-map` output (`docs/internals/source-map.md`) only if the new test file changes it.
- No locale files: the refusal text is a server `error` string that the existing toast already shows.

## Non-Goals

This change does not touch ticket or `ProposeSpecModal` attachment rules, binary or office formats, the 25 MB limit, rich-type sniffing, or i18n copy.

## Out-of-scope findings

- The ticket and agent routes duplicate the multer config and error mapping; left as is.
- The `SUPPORTED_MIME_TYPES` check is repeated inside `upload()`; left as is.
