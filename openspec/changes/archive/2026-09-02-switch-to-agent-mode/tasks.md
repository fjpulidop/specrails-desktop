## 1. UiMode foundation

- [x] 1.1 Add `FEATURE_AGENT_MODE` to `client/src/lib/feature-flags.ts` (`VITE_FEATURE_AGENT_MODE`, `"false"` = off), mirroring `FEATURE_AGENT_CHAT`
- [x] 1.2 Create `client/src/context/UiModeContext.tsx`: `uiMode:'kanban'|'agent'`, `setUiMode`, `toggleUiMode`, localStorage `specrails-desktop:uiMode`, NOOP fallback pinned `'kanban'`, hard-pin when flag off
- [x] 1.3 Mount `<UiModeProvider>` inside `DesktopProvider` above `TitleBar`/`AgentChatProvider` (`App.tsx:440-465`)

## 2. Hoist BottomPanel/StatusBar + gate chevron/SearchPill (no Kanban regression)

- [x] 2.1 Lift `StatusBar` + `connectionStatus` (`usePipeline()`), `viewportHeight` ResizeObserver, `STATUSBAR_HEIGHT_PX` from `ProjectLayout.tsx:66-95` to `DesktopApp` scope (`App.tsx ~:296`); ref on the flex column `App.tsx:242`
- [x] 2.2 Hoist `BottomPanel` (`ProjectLayout.tsx:124-134`) to the DesktopApp main column driven by `activeProjectId` + `useProjectTerminals(activeProjectId)`; REMOVE the ProjectLayout copy (single-adopter invariant)
- [x] 2.3 Gate `chevronSlot` on `uiMode==='kanban'`
- [x] 2.4 Hide `SearchPill` in `TitleBar.tsx` at both mounts (`:175`,`:215`) when `uiMode==='agent'`
- [x] 2.5 Verify terminal spans full width beneath surface + workspace sidebar; verify maximize height parity vs pre-hoist

## 3. Extract AgentConversationView (floating panel keeps working)

- [x] 3.1 Create `client/src/components/agent-chat/AgentConversationView.tsx` (`variant:'floating'|'inline'`): banners, sticky-scroll message list + empty placeholder, streaming + `useSmoothStream` + activity chip, full composer, and the local state (`input`, scroll refs, prompt-history, tier-cycle keydown rebind)
- [x] 3.2 Reduce `AgentChatPanel.tsx` to chrome wrapper (`useMovableResizableModal`, maximize, header, `ResizeGrips`) rendering `<AgentConversationView variant='floating'/>`
- [x] 3.3 Re-home `AgentProjectSelector` from panel header into the composer/empty-state
- [x] 3.4 Extend `newConversation(projectId?)` in `AgentChatContext.tsx:246-253` (arg-less stays backward-compatible)

## 4. AgentModeSurface + center branch

- [x] 4.1 Create `client/src/components/agent-chat/AgentModeSurface.tsx`: EMPTY (`active===null`, centered "Plan, Build" card) vs ACTIVE (`<AgentConversationView variant='inline'/>` + optional Files split); MUST NOT call `ensureActive` on mount
- [x] 4.2 Branch the center in `App.tsx:252-296`: setup → global route (`/loops`,`/docs`) → `uiMode==='agent'` → else `<Routes>` (shared `onGlobalRoute` predicate); keep `<Routes>` byte-identical

## 5. Sidebar buttons + conversation trees + refresh

- [x] 5.1 Expose `refreshConversations` on `AgentChatContext` (no `visibility='open'` side effect)
- [x] 5.2 Gate `AgentChatPanel`(`:293`)+`AgentBubble`(`:296`) off when `uiMode==='agent'`
- [x] 5.3 `ArcSidebar.tsx`: add `useAgentChat()`+`useUiMode()`; add [Switch mode] (both modes), [New agent] + [Search] (agent) above Loops
- [x] 5.4 Group `conversations` by `pinned_project_id` (`useMemo`, null sentinel); make `ProjectItem` expandable (chevron independent of row activate, only when >0 convs); render conversation children + synthetic Home group; "Untitled" fallback
- [x] 5.5 Expansion state `Set<string>` persisted to `specrails-desktop:agentTreeExpanded`, default-expand active project
- [x] 5.6 Branch `handleSelectProject` by mode: agent = `setActiveProjectId` + toggle expand, no navigation; kanban unchanged; row click sets active + toggles even with zero convs; conversation click `selectConversation` + ensure agent mode + highlight

## 6. AgentWorkspaceSidebar

- [x] 6.1 Create `client/src/components/agent-chat/AgentWorkspaceSidebar.tsx` (Browser/Terminal/Files, disabled+tooltip when `activeProjectId` null); mount at `App.tsx:302` agent branch (renders even with no project; suppress on global routes/setup)

## 7. Terminal tool

- [x] 7.1 Wire Terminal button to `togglePanel(activeProjectId)`; entering Agent Mode does not auto-hide an open panel

## 8. Files inline (embedded CodePage split)

- [x] 8.1 Refactor `CodePage.tsx` to controlled/`embedded`: props (`embedded?`, `selectedPath?`, `onSelectedPathChange?`, `jobFilter?`/`ticketFilter?`, `onFilterChange?`); replace `navigate('/code')` (`:133,140,147,159`) with callbacks; no-op URL→state effects (`:71-75`) when embedded; keep provenance toolbar controlled
- [x] 8.2 Create `AgentModeCodePane.tsx`: resizable split (thread | code) with `<Suspense>`, maximize toggle, honor `MIN_MAIN_WIDTH=520`+`MIN_TREE_WIDTH=240`; selection persisted per-conversation in Agent-Mode state (not URL)
- [x] 8.3 Wire Files button to open the split pane (requires active project)

## 9. Browser capture

- [x] 9.1 Wire Browser button → `BrowserCaptureModal` (active project + agent conversation), `onCaptured` → composer chips (no auto-send); reuse `browser-capture.ts` + `CapturedDomPanel`; gate on `isBrowserCaptureEnabled()`; resolve the agent-capture storage seam (agent-scoped capture target OR scope to pinned-project convos)

## 10. Server attachment routes + storage + migration

- [x] 10.1 `attachment-manager.ts`: `agentDir(conversationId)` + agent sidecar/meta privates + `uploadAgent`/`listAgent`/`getAgentMeta`/`getAgentFilePath`/`deleteAgent`/`deleteAllAgent` (traversal guards; root `~/.specrails/agent/<id>/attachments/`)
- [x] 10.2 `agent-chat-router.ts`: multer (single `file`, 25MB, MIME filter) + `POST/GET/GET:attId/DELETE /conversations/:id/attachments` (mirror `project-router-tickets.ts:1839-1979`); conversation-id validation + existence 404; feature-flag 404
- [x] 10.3 `desktop-db.ts` migration 18: `ALTER TABLE agent_messages ADD COLUMN attachment_ids TEXT`; `deleteAgentConversation` cleanup via `deleteAllAgent` (at route layer, `agent-chat-router.ts:138-142`)

## 11. Send-flow fold + native images + capabilities

- [x] 11.1 `agent-chat-router.ts` `POST /:id/send`: parse `attachments:{ids:string[]}` (mirror `project-router-chat.ts:276-286`); thread to manager
- [x] 11.2 `agent-chat-manager.ts` `sendMessage`: `AgentTurnOptions.attachmentIds`; resolve `getClaudeArgsAgent(conversationId, ids)` (async); fold `textBlocks` into prompt before pinned-project prefix; append attachment system note; try/catch → text-only degrade; persist `attachment_ids` on the user message
- [x] 11.3 `attachment-manager.ts` `getClaudeArgsAgent`: return `{textBlocks, imagePaths}` — image `@path` stays in textBlocks AND abs path collected in imagePaths
- [x] 11.4 `providers/types.ts`: add `SpawnOptions.imagePaths?` + `ProviderCapabilities.supportsImageInput?`
- [x] 11.5 `codex-adapter.ts`: `supportsImageInput:true`; emit `--image <abs>` per image in `chat-turn` + `chat-resume`. `claude-adapter.ts`: `supportsImageInput:true`. `gemini-adapter.ts`: `supportsImageInput:false`
- [x] 11.6 Thread `imagePaths` into `buildOpts` when `adapter.capabilities.supportsImageInput`

## 12. ai_invocations metering

- [ ] 12.1 Add `'agent'` to `Surface` + `ALLOWED_SURFACES` (`spawn-lifecycle.ts:4-15`)
- [ ] 12.2 Pass `ProjectRegistry` into `AgentChatManager` (`index.ts:582`); on turn settle for pinned convos, `finaliseInvocationResult` + `recordInvocation` (surface `'agent'`) into the pinned project's DB + broadcast `spending.invalidated`; skip Home turns; wrap in try/catch

## 13. Client composer attachment reuse

- [x] 13.1 `RichAttachmentEditor.tsx`: optional `uploadFn`/`onDeleteAttachment` props; `ticketKey` usable as pill namespace
- [x] 13.2 `lib/agent-api.ts`: `uploadAgentAttachment`/`deleteAgentAttachment`; extend `sendAgentMessage` with `attachments:{ids}`
- [x] 13.3 Swap the agent composer textarea → `RichAttachmentEditor` (in `AgentConversationView`), wired to agent transport; capture chips ride next send; gate image affordance on `supportsImageInput`; works with null active project

## 14. i18n

- [x] 14.1 Add `agent`-namespace keys (`switchToAgentMode`/`switchToKanbanMode`, `newAgent`, `search`, `workspace.terminal/.files/.browser`, disabled tooltip, EMPTY "Plan, Build" copy, Home label) to all 8 locales; pass `locale-parity.test.ts`

## 15. Motion / aesthetics

- [x] 15.1 Apply motion spec: mode-swap crossfade (hero curve `cubic-bezier(0.34,1.56,0.64,1)`) + right-sidebar baton-pass (200ms), sidebar tree expand/collapse, EMPTY→ACTIVE composer FLIP-to-dock, split-pane resize; reduced-motion degrades to opacity-only; semantic tokens + glass-card only

## 16. Tests to thresholds

- [x] 16.1 Client suites: `UiModeContext`, `AgentConversationView` (EMPTY/ACTIVE from `active===null`, tier rebind, submit), `AgentModeSurface` (no `ensureActive` on mount), `AgentWorkspaceSidebar` (disabled gating), `ArcSidebar` agent branch (grouping, Home, expand persist, click semantics, Search dispatch), `CodePage` embedded (navigate suppression, URL no-op), agent composer attachments (upload/delete/pre-upload-ids/image gating/null-project)
- [ ] 16.2 Server suites: agent attachment routes (25MB, MIME, traversal, cleanup, flag 404), `sendMessage` fold (+degrade), `getClaudeArgsAgent` image/text split, `buildCodexArgs` `--image`, metering (pinned records, Home skips), migration 18
- [ ] 16.3 Regression guardrails: single terminal instance, Kanban row-click navigation, `/code` route unchanged, floating panel present in Kanban, flag-off byte-identity
- [ ] 16.4 Run full gate: `npm run typecheck`, `npm test`, `npm run test:coverage` (server 80/70), `cd client && npm run test:coverage` (client 80/70); iterate until green
