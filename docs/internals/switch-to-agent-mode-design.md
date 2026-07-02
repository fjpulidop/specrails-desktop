# Switch to Agent Mode — Design Dossier

> **Status: pre-implementation design artifact (explore mode).** This document consolidates 8 structured investigation slices into a single implementation plan. No application code is written here. It defines the shell swap, the shared conversation-view extraction, the left-sidebar restructure, the three "On workspace" tools, the full attachment-parity plan, search wiring, and the cross-cutting concerns. Section 10 carries the consolidated RISKS and the numbered OPEN DECISIONS that a human must resolve before implementation begins.

---

## 1. Overview + decided constraints

**Goal.** Add an app-global **Agent Mode** UI that replaces the Kanban route-driven center with a Cursor-style agent workspace: a full-height conversation surface, a restructured left sidebar (project→conversation trees), a hidden navbar search (moved into the sidebar), and a right "On workspace" toolbar exposing three tools (Terminal, Files, Browser). The floating agent bubble/panel are suppressed while in Agent Mode — the same conversation UI is hoisted inline.

**Decided constraints (fixed inputs to this design):**

1. **`uiMode` is persisted.** A new app-global `uiMode: 'kanban' | 'agent'` lives in its own small context (`UiModeProvider`), localStorage-backed, no project dependency. It gates the shell swap, the sidebar buttons, the search pill, and the floating surfaces.
2. **Brave option A — inline CodePage.** The Files tool embeds the existing `CodePage` inline (decoupled from `ProjectLayout` and the `/code` route) rather than shipping a stripped-down viewer. This is a real refactor of `CodePage` into a controlled component.
3. **Brave option B — full attachment parity + wired Browser.** The Agent composer reaches **full parity** with the Explore Add-Spec composer: `RichAttachmentEditor` (file-pick / drag-drop / image-paste / @-pills) **plus** the live `BrowserCaptureModal` / `CapturedDomPanel` browser-capture flow, all uploaded through a new app-global agent attachment endpoint and folded into the provider prompt. The Browser "On workspace" tool reuses the same capture stack.
4. **All three "On workspace" tools require an active project.** They are disabled when `activeProjectId` is null.

**Two things that stay byte-identical:** Kanban mode must render exactly as today, and the CommandPalette (Cmd+K) keeps its own global keydown listener so the shortcut keeps working regardless of which mode is active.

---

## 2. Architecture diagram (shell swap + provider tree)

```
main.tsx  →  <BrowserRouter>            (single app-wide router; main.tsx:17-19)
             └─ SharedWebSocketProvider (App.tsx:433 — above routes; CodePage/FileTree/FileViewer depend on it)
                └─ App()
                   └─ DesktopProvider                          (App.tsx:440 — projects, activeProjectId, api base)
                      └─ ★ UiModeProvider ★   ◄── NEW, inserted here (wraps TitleBar onward, closes before </DesktopProvider> App.tsx:465)
                         ├─ TitleBar          (App.tsx:442) ── reads uiMode → HIDES SearchPill when 'agent' (TitleBar.tsx:175,215)
                         ├─ SpecGen / ContractRefine / Smash / SidebarPin / Terminals / RailMetrics / MinimizedChats providers
                         │   (TerminalsProviderWithDesktop App.tsx:447 — already app-level; terminal state is mode-agnostic)
                         └─ AgentChatProvider (App.tsx:450) ── reads uiMode → SUPPRESSES AgentChatPanel(:293)+AgentBubble(:296)
                            └─ TicketDetailModalProvider ...
                               └─ DesktopApp   (App.tsx:453 / body 230-330)
                                  │
                                  │  flex h-full row:
                                  ├─ ArcSidebar (App.tsx:233-239) ── reads uiMode → sidebar buttons + project/conversation trees
                                  │
                                  ├─ main-area column  <div flex flex-col flex-1>  (App.tsx:242-297)
                                  │   ├─ project-switching progress bar (:244-249)
                                  │   ├─ content box <div flex-1 overflow-hidden> (:252-296)
                                  │   │     {isInSetup ? SetupWizard
                                  │   │      : uiMode==='agent' ? ★ <AgentModeSurface/> ★   ◄── NEW center swap
                                  │   │      : <Suspense><Routes> … ProjectLayout … </Routes></Suspense>}   (existing, :261-294)
                                  │   │
                                  │   └─ ★ <BottomPanel/> + <StatusBar/> ★   ◄── HOISTED here from ProjectLayout (both modes, one instance)
                                  │         gated on activeProject; chevronSlot gated on uiMode==='kanban'
                                  │
                                  └─ right sidebar (App.tsx:302)
                                        {uiMode==='agent'
                                           ? activeProject && !isInSetup && ★ <AgentWorkspaceSidebar/> ★   ◄── NEW (Browser/Terminal/Files)
                                           : activeProject && !isInSetup && !/loops && <ProjectRightSidebar/>}   (existing)
```

Key structural moves shown above:

- **`UiModeProvider` mounts just inside `DesktopProvider`** (App.tsx:440) so `TitleBar`, `AgentChatProvider`, `ArcSidebar`, the center, and both right sidebars all read it.
- **`BottomPanel` + `StatusBar` are HOISTED** out of the route element `ProjectLayout` (currently ProjectLayout.tsx:124-134) into the `DesktopApp` main-area column (App.tsx ~:296), so the terminal survives when the center is no longer a route. `TerminalsProvider` is already app-level (App.tsx:447), so only the *visual* panel needs hoisting.

---

## 3. Component / module inventory

### NEW files to create

| File | Responsibility | Key anchors |
|---|---|---|
| `client/src/context/UiModeContext.tsx` | App-global `uiMode: 'kanban'\|'agent'` + `setUiMode`/`toggle`, localStorage-persisted; `useUiMode()` with NOOP fallback for tests. | Insert provider at App.tsx:440-441; consumed by TitleBar/ArcSidebar/AgentChatContext/DesktopApp. |
| `client/src/components/agent-chat/AgentConversationView.tsx` | Shared inner UI (banners + sticky-scroll message list + streaming + activity chip + composer) consumed by BOTH the floating panel and the inline surface; `variant: 'floating'\|'inline'`. | Extracted from AgentChatPanel.tsx:158-269. |
| `client/src/components/agent-chat/AgentModeSurface.tsx` | Inline center surface: EMPTY (`active===null` → centered composer card) vs ACTIVE (`<AgentConversationView variant='inline'/>` + optional Files/code split). Does NOT call `ensureActive` on mount. | Mounted at App.tsx center swap (:252-296). |
| `client/src/components/agent-chat/AgentWorkspaceSidebar.tsx` | Right "On workspace" toolbar in Agent Mode: Browser / Terminal / Files buttons, each disabled when `activeProjectId` is null. | Mounted at App.tsx:302 (agent branch). |
| `client/src/components/agent-chat/AgentModeCodePane.tsx` (optional wrapper) | Resizable split host that mounts `<CodePage embedded/>` as a secondary pane beside the thread; own `<Suspense>` boundary. | Wraps CodePage.tsx (lazy). |
| `server/agent-attachment-routes` (in `agent-chat-router.ts`) | App-global attachment endpoints: `POST/GET/DELETE /api/agent/conversations/:id/attachments` (multer single 'file', 25MB, mime filter). | Mirror project-router-tickets.ts:1839-1917. |
| `server/agent-store` migration | Persist attachment id list per agent turn (new nullable `attachments` JSON column on `agent_messages`, or sibling `agent_message_attachments` table). | agent-store.ts:24-30,111-128. |

### EXISTING files to modify

| File | Change | Key anchors |
|---|---|---|
| `client/src/App.tsx` | Insert `UiModeProvider`; branch center on `uiMode`; branch right sidebar; hoist `BottomPanel`+`StatusBar` into main-area column; source `viewportHeight`/`panelState`/`connectionStatus` at DesktopApp scope. | 230-330 (shell), 440-461 (providers). |
| `client/src/components/ProjectLayout.tsx` | REMOVE the `BottomPanel`/`StatusBar` render (hoisted); keep `<Outlet/>`, ChatContext; gate chevronSlot on `uiMode==='kanban'`; relocate the `viewportHeight` ResizeObserver + `panelState` up. | 66-95, 124-134. |
| `client/src/components/TitleBar.tsx` | Hide `SearchPill` when `uiMode==='agent'` at both mount sites. | 66-129 (pill), 175 & 215 (mounts). |
| `client/src/context/AgentChatContext.tsx` | Gate `AgentChatPanel`(:293) + `AgentBubble`(:296) off when `uiMode==='agent'`; expose a public `refreshConversations`; extend `newConversation(projectId?)`. | 39-70, 246-253, 290-298. |
| `client/src/components/agent-chat/AgentChatPanel.tsx` | Reduce to thin chrome wrapper rendering `<AgentConversationView variant='floating'/>`; keep `useMovableResizableModal`/maximize/header/`ResizeGrips`. | 30-119 (chrome), 121-284 (body). |
| `client/src/components/ArcSidebar.tsx` | Add `useAgentChat()` + `useUiMode()`; add [Switch mode]/[New agent]/[Search] buttons above Loops; make `ProjectItem` expandable; render conversation children + Home group; branch `handleSelectProject` by mode. | 1-9, 19-106, 135-166, 206-259. |
| `client/src/pages/CodePage.tsx` | Add controlled/`embedded` props; neutralize `navigate({pathname:'/code'})` calls; gate URL→state effects when embedded. | 51-96, 129-160. |
| `server/agent-chat-router.ts` | Parse `attachments:{ids}` on `POST /:id/send`; add attachment endpoints. | 144-163. |
| `server/agent-chat-manager.ts` | Resolve attachment textBlocks via `attachmentManager.getClaudeArgs`, fold into `prompt` before pinned-project prefix; append note for codex/gemini into prompt. | 72-235 (fold near :97-102, chokepoint :151). |
| `server/attachment-manager.ts` | Add app-global agent storage root (`~/.specrails/agent/<conversationId>/attachments/`) or overload; keep traversal guards. | 89-133, 287-348. |

---

## 4. `AgentConversationView` extraction plan (shared by floating panel + inline surface)

**Boundary.** `AgentChatPanel.tsx` currently fuses two separable concerns. Split them:

- **WINDOW-CHROME WRAPPER (stays in `AgentChatPanel.tsx`):** `useMovableResizableModal` (AgentChatPanel:30-37), `maximized` + `MAXIMIZED_STYLE` (:27,:41), the `motion.div` shell (:123-135), the header drag band with `Bot` icon + maximize/minimize buttons (:137-155), the `ResizeGrips` overlay (:277-281), and the persisted geometry `persistKey 'specrails-desktop:agent-panel-geom'`. **Chrome-only — must NOT leak into the inline variant.**
- **SHARED `<AgentConversationView>` (NEW):** the two banners (no-provider :158-166, MCP-degraded :169-177), the messages scroll region including empty placeholder (:180-199), `messages.map(<AgentMessage/>)` (:188-190), the streaming block with `useSmoothStream` + `<AgentActivityChip/>` (:191-198), and the entire composer (:202-269). The local state that powers these **moves with the view:** `input` (:26), `scrollRef`/`pinnedRef` sticky-scroll (:28,:49-58), `useSmoothStream(streamingText,isStreaming)` (:43), prompt-history `histIndex`/`history`/`recall`/`onComposerKeyDown` (:61-109). The Shift+Tab tier-cycle handler `onPanelKeyDown` (:113-119) must be **re-bound onto the shared view's root wrapper** (it only calls `cycleTier()` from context, so it is portable).

**Prop / context boundary.** The view is **almost entirely context-driven** via `useAgentChat()` (AgentChatContext:39-70): `active`, `messages`, `streamingText`, `isStreaming`, `liveTools`, `mcpEnabled`, `enablingMcp`, `enableMcpServer`, `providersReady`, `send`, `abort`, `cycleTier`, `setProvider`, `setModel`, `setPinnedProject`. The **only props** are presentational: `variant: 'floating'|'inline'` (switches padding, rounded corners, whether the composer docks bottom vs centers), and optionally a `newConversation` callback carrying the active project for the inline [New agent] flow.

**EMPTY vs ACTIVE (inline surface).** Derived purely from context: `active===null` → **EMPTY** (centered "Plan, Build" composer card); `active!==null` → **ACTIVE** (full thread + docked composer). Note the floating panel's in-scroll placeholder uses `messages.length===0 && !isStreaming` (:181) while a conversation may still be active — the inline surface must use `active===null` instead. Because `open()/ensureActive()` (:176-209) auto-creates/loads a conversation, `AgentModeSurface` must **not** call `ensureActive` on mount, or the EMPTY state can never appear.

**Re-homing the project selector.** `AgentProjectSelector` (AgentProjectSelector.tsx:13-91) currently sits in the panel **header (chrome)** (AgentChatPanel:143). Extracting only the inner subtree would drop it from Agent Mode — it must be **re-homed into the composer or the empty-state card**.

**Pin defaulting.** `newConversation()` (AgentChatContext:246-253) hardcodes `pinnedProjectId: active?.pinned_project_id ?? null` and takes no args. Extend to `newConversation(projectId?: string|null)` using `projectId!==undefined ? projectId : (active?.pinned_project_id ?? null)` so the floating panel's arg-less call (AgentChatPanel:145) stays backward-compatible while the inline [New agent] can pass `useDesktop().activeProjectId` (useDesktop:269).

---

## 5. Left sidebar restructure (`ArcSidebar.tsx`)

`ArcSidebar` is self-contained (consumes `useDesktop()` + `useSidebarPin()` at :122, imports at :1-9) and sits inside both `DesktopProvider` and `AgentChatProvider` (App.tsx:440-457), so it can safely add `useAgentChat()` (NOOP fallback at AgentChatContext:301-318 keeps it test-mountable) and `useUiMode()`.

**New buttons cluster (inserted ABOVE the Loops block, before ArcSidebar:206):**

- **[Switch to Agent/Kanban mode]** — always shown (both modes). `onClick=toggleUiMode`. JSX mirrors the Loops button (:209-225): `type=button`, icon (Bot/Sparkles for agent, LayoutGrid/Columns for kanban) + `{expanded && <span>…</span>}`. Label flips on current `uiMode`.
- **[New agent]** — agent mode only. `onClick=newConversation(activeProjectId?)` (see §4 pin defaulting). Icon `Plus`.
- **[Search]** — agent mode only (replaces the hidden navbar pill). `onClick` dispatches the synthetic Cmd+K keydown (see §8). Icon `Search`.

**Project→conversation trees (agent mode):**

- Group `useAgentChat().conversations` (agent-api.ts:10-20) by `pinned_project_id` via `useMemo`: `Map<string|null, AgentConversation[]>`. Use a **sentinel** for the `null` key.
- Each `ProjectItem` (:19-106) becomes expandable: add a leading chevron hit-area (ChevronRight/ChevronDown) that toggles tree expansion **independently** of row activation. Split the current whole-row `onClick=onSelect` (:67): chevron toggles expand, row body sets active project. Only render the chevron in agent mode when the project has >0 conversations.
- Render conversation children (indented) for `pinned_project_id === project.id`; each `onClick=selectConversation(id)` (async, loads thread) **and** ensures `uiMode==='agent'`; highlight when `conv.id === active?.id`. Fallback label for nullable `title` (agent-api.ts:12) — e.g. "Untitled".
- A synthetic **Home pseudo-group** (agent mode only) renders conversations with `pinned_project_id === null`, not nested under any project.

**Expand state.** Held locally in `ArcSidebar` as `useState<Set<string>>` (or `Record`), initialized from and persisted to a **new** localStorage key (e.g. `specrails-desktop:agentTreeExpanded`), default-expanding the active project. This is orthogonal to the existing sidebar-width `expanded` flag (:149, from `useSidebarPin`), which only controls label visibility.

**Click semantics reconciliation.** Branch `handleSelectProject` (:135-147) by `uiMode`. In **agent mode** skip the `navigate('/')`/route-memory path (the center is the agent surface, not routes) and just `setActiveProjectId(projectId)` (useDesktop:90-102) + toggle expand — `setActiveProjectId` has side effects (`writeSavedProjectId` + `setApiActiveProjectId` :91-92, 400ms switching flag) but must NOT trigger visible route navigation. In **kanban mode** keep today's behavior exactly.

**Refresh gap.** `AgentChatContextValue` exposes **no** standalone refresh — `conversations[]` is only refreshed inside `open()`/`toggle()` (AgentChatContext:193,204). Entering agent mode must expose/call a `refreshConversations` (preferred over calling `open()`, which would set `visibility='open'` and mount the now-suppressed floating panel).

---

## 6. The three "On workspace" tools

All three are gated on `!!activeProjectId` (disabled tooltip otherwise), matching the decided rule.

### 6a. Terminal — hoist `BottomPanel`

`TerminalsProvider` is **already app-level** (App.tsx:447) and keyed off the active project, so PTYs, xterm instances, WS sockets and per-project panel state already survive route/project switches (durable refs at TerminalsContext:209-229; server-sync effect keyed on `activeProjectId` :297-334; disposal only on explicit kill/unmount :428-466). The **single hidden `#specrails-terminal-host`** (:178-194) and the single-adopter `TerminalViewport` reparenting invariant (TerminalViewport:126-139) mean unmounting the visible panel does NOT dispose the terminal — the DOM node simply returns to the host.

- **Reuse:** `useTerminals()` (already in DesktopApp App.tsx:152), `useProjectTerminals(activeProjectId)` (ProjectLayout:68), `setVisibility(projectId,'restored')` (TerminalsContext:273), `togglePanel(projectId)` (:277, the Cmd+J action App.tsx:196), `<BottomPanel projectId provider providers state viewportHeight statusBarHeight/>` (BottomPanel:36, returns null when hidden), `projectProviders(project)`, `PanelChevronButton`.
- **New work:** hoist the `BottomPanel` render (ProjectLayout:124-133) to the DesktopApp main-area column (App.tsx ~:296), driven by `activeProjectId` + `useProjectTerminals(activeProjectId)`, so **one** instance serves both modes; move the `viewportHeight` ResizeObserver (ProjectLayout:69-83) + `STATUSBAR_HEIGHT_PX` up; gate `chevronSlot` on `uiMode==='kanban'` (ProjectLayout:90-95); wire the sidebar Terminal button to `setVisibility(activeProjectId,'restored')`. **Ensure only ONE `BottomPanel`/`TerminalViewport` is mounted at any time** (remove the ProjectLayout copy) to preserve the single-adopter invariant.

### 6b. Files — inline `CodePage`

`CodePage`'s data layer is bound to the **active project**, not route context: `FileTree`/`FileViewer`/provenance fetch via `getApiBase()` (api.ts:13-28, module singleton set by `DesktopProvider`) and read `activeProjectId` via `useDesktop()`. It consumes **zero** context that `ProjectLayout` provides (no `useTerminals`, no `useChat`, no `BottomPanel`); the only transitive app-level provider is `useSharedWebSocket` (App.tsx:433, above routes). The **only** true shell coupling is React Router: `useSearchParams`/`useNavigate` pinned to `pathname:'/code'` (CodePage:133,140,147,159).

- **Reuse:** `getApiBase()` (throws when no active project — enforces the "requires active project" rule), `useDesktop().activeProjectId`, controlled `FileTree` props (`onOpenFile`, `selectedPath`, `filterJobId`, `filterTicketId`), controlled `FileViewer` props (`relPath`, `onFilterJob`, …), `useSharedWebSocket()`.
- **New work:** refactor `CodePage` into a **controlled** component — add optional props (`selectedPath?`, `onSelectedPathChange?`, `jobFilter?`/`ticketFilter?`, `onFilterChange?`, `embedded?`); when provided, lift internal state and **replace the `navigate({pathname:'/code'})` calls (:133,140,147,159) with callbacks**; gate the URL→state sync effect (:71-75) + searchParams effects to no-op when embedded. Mount inside `AgentModeSurface` as a **split** secondary pane (thread | code) with its own `<Suspense>` boundary (CodePage is `React.lazy`, App.tsx:21). Store code selection in the Agent Mode context/state (NOT the URL). Mind the nested-split min-width math (`MIN_MAIN_WIDTH=520` + `MIN_TREE_WIDTH=240`).

### 6c. Browser — capture reuse

The Explore browser-capture stack is fully project-scoped and reusable verbatim.

- **Reuse:** `BrowserCaptureModal` (props `{open,onClose,projectId,pendingSpecId,onCaptured,confirmLabel}`), `CapturedDomPanel` (props `{dom,onRemove?}`), the `client/src/lib/browser-capture.ts` REST helpers (`createBrowserSession`, `navigateBrowser`, `captureBrowserRegion`, `captureBrowserBreakpoints`, `uploadCaptureImage`), `isBrowserCaptureEnabled()` (client flag `VITE_FEATURE_BROWSER_CAPTURE`), and server `requireBrowserCaptureEnabled`/`SPECRAILS_BROWSER_CAPTURE` (feature-flags.ts:9-13). Server session endpoints at project-router-terminals.ts:200-410.
- **New work:** wire the sidebar Browser button to open `BrowserCaptureModal` with the current `activeProjectId` and the agent conversation's pending id; route `onCaptured` into the composer capture chips (see §7). Requires an active project (browser sessions are project-scoped).

---

## 7. Full attachment-parity plan

Today the agent turn is **text-only**. `POST /api/agent/conversations/:id/send` accepts `{text, tierLevel?, model?}` (agent-chat-router:150-162) → `AgentChatManager.sendMessage` builds `prompt = optional '[Active project…]' prefix + userText` (agent-chat-manager:100-102) → `runAiCliInvocation` passes it as an argv positional (`buildOpts.prompt`, :151). There is **no** upload endpoint, **no** attachment path, and **no** per-turn `ai_invocations` accounting. The Explore side already has the complete mechanism; most of the work is wiring, not new storage.

### 7a. Enumerated Explore affordances to port (parity list)

From `RichAttachmentEditor` + `ExploreSpecShell`:

1. **File picker** — footer "Attach files" button (RichAttachmentEditor:562-570) → hidden `<input type=file multiple accept=ATTACHMENT_ACCEPT_MIME>` (:578-585) → `handleBrowseChange` (:490-498) → `uploadFiles`.
2. **Drag-drop** — root drop zone (:504-511) + "Drop to add context" overlay (:587-606) → `handleDrop` (:475-485) → `uploadFiles`.
3. **Image paste** — `handlePaste` (:390-422): clipboard image item → renamed `paste-<date>-<n>.png` → `uploadFile`; non-image paste forced to plain text (HTML stripped).
4. **Backspace/Delete on a pill** — removes attachment (`handleKeyDown` :342-388) + fires `onAttachmentRemoved` (Explore → DELETE on the attachments endpoint, ExploreSpecShell:966-971).
5. **@-mention pills** — inline pills in the contenteditable (`buildPill` :79-98, serialized `@[filename](id)` :104-126). Pills are created **only** by uploads (no free-text @-typeahead).
6. **Browser capture ("From a website")** — `footerExtra` Globe button (ExploreSpecShell:978-989) → `BrowserCaptureModal` (:1150-1159). User drives a live headless browser, selects a region/element, optionally annotates and/or captures at 3 breakpoints. `captureBrowserRegion`/`captureBrowserBreakpoints` write **TWO** attachments per capture (PNG screenshot + DOM JSON) into the same pending dir, returning `CaptureResult`. `handleCaptured` (:258-291) either auto-sends a feedback turn (`sendCaptureFeedback` :574-600) or queues a chip under the composer (:991-1033) that rides the next message.

### 7b. Attachment data model

- **Client:** an attachment is the `Attachment` type (`{id, filename, mimeType, storedName, …}`). The editor tracks `attached: Attachment[]` + DOM pills; `getAttachmentIds()` (RichAttachmentEditor:306-311) reads all `[data-attachment-id]`. Captures are tracked separately in `ExploreSpecShell.captures: BrowserCaptureEntry[]` (screenshotId, domAttachmentId, breakpoints[]) so both ids merge in.
- **Server:** each attachment = file + `<id>.meta.json` sidecar under `~/.specrails/projects/<slug>/attachments/<ticketKey>/` (attachment-manager:96-133). `ticketKey` is a `pendingSpecId` (UUID) during Explore, path-sanitized. On Create Spec, `migrateToTicket` (attachment-manager:248-273) renames the pending dir to the real ticket id.

### 7c. Server storage + upload endpoints (NEW for agent)

- **New app-global upload route:** `POST /api/agent/conversations/:id/attachments` (multer `single('file')`, `memoryStorage`, 25MB cap, `isSupportedUploadedFile` filter) → `attachmentManager.upload(...)` with an agent-scoped key; returns `201 {attachment}`. Add `GET` (list), `GET /:attachmentId` (download), `DELETE` for parity. Mirror project-router-tickets.ts:1839-1917.
- **New agent-scoped storage root:** `~/.specrails/agent/<conversationId>/attachments/` (the agent per-conversation dir already exists for mcp.json, agent-mcp-config.ts:135,162-169). Add an `agentAttachmentsRoot()`/overload on `AttachmentManager` (or a thin wrapper), **keeping the path-traversal guards** (attachment-manager:100-110). Do NOT reuse `projects/<slug>/attachments` with a synthetic slug — it risks colliding with a real project slug.
- **Cleanup:** `deleteAgentConversation` (agent-store:107) must remove the attachment dir (a `deleteAll` analog).

### 7d. Agent send-flow changes (payload / adapter contract / per-provider)

- **Payload:** extend `POST /:id/send` to parse `attachments: { ids: string[] }` (the `conversationId` is the storage key — no slug needed). Mirror the chat parse at project-router-chat.ts:276-286.
- **Fold point:** in `AgentChatManager.sendMessage`, resolve `attachmentManager.getClaudeArgs(agentKey, ids)` (attachment-manager:287, **async** — pdf/xlsx extraction) → `{imageFlags:[], textBlocks:string[]}` and fold `textBlocks` into `prompt` **before** the pinned-project prefix (between agent-chat-manager:97 and :100), exactly mirroring chat-manager:585-609 ("## Attached Resources" + `USER_ATTACHMENT_SYSTEM_NOTE`). `buildOpts.prompt` (:151) is the single chokepoint. Wrap in try/catch so extraction failure degrades to a text-only turn.
- **Adapter contract:** prompt transport is **argv, not stdin** for all three providers — claude `-p opts.prompt` (claude-adapter:97,110), codex positional to `exec` (codex-adapter:88, folds systemPrompt :101), gemini `-p opts.prompt` (gemini-adapter:76). `SpawnOptions.attachmentTextBlocks?` is **reserved but unused** (providers/types.ts:40-41) — either fold-into-prompt (fast, matches Explore, recommended) or wire `attachmentTextBlocks` through the 3 adapters' `buildArgs` (cleaner, more edits).
- **Per-provider image reality:** `getClaudeArgs` emits images as `@<abs-path>` refs. **Claude Code resolves these natively → images work.** codex/gemini receive the `@path` as **literal prompt text → the image is silently NOT loaded.** Extracted-text attachments (pdf/csv/xlsx/txt/json/sql) become inline `<user-attachment>` text and work for **all three**. LCD for v1 = text-extractable attachments for all providers; images are claude-only until per-adapter native image flags are added. This needs a UX decision (block images on non-claude vs attempt native flags) — see Open Decisions.
- **Persistence:** `agent_messages` has only `{id, conversation_id, role, content}` (agent-store:24-30). To re-render pills/thumbnails after refresh, add a nullable `attachments` JSON column (new migration) or a sibling `agent_message_attachments` table.
- **Metering (recommended, optional):** agent turns are currently **unmetered** — `AgentChatManager` is absent from the `ai_invocations` consumer set. Adding `finaliseInvocationResult` in the same change makes attachment-heavy turns visible on `/analytics`, matching Explore.

---

## 8. Search / Cmd+K plan

The "navbar search box" is the **`SearchPill` inside `TitleBar.tsx`** (:64-129), not `Navbar.tsx` (which has no search). It does no inline searching — `handleClick` (:70-74) dispatches a synthetic `Cmd+K` keydown that the already-mounted `CommandPalette` (App.tsx:321-325, cmdk-based) listens for via a **global window keydown listener** (CommandPalette:53-62). There is **no imperative open API** — the synthetic-keydown dispatch is the only sanctioned seam.

- **Hide** `SearchPill` when `uiMode==='agent'` (gate render at TitleBar:175 and :215). The palette's own listener keeps Cmd+K working with the pill hidden.
- **New sidebar [Search] button** (agent mode) copies `SearchPill.handleClick` verbatim: `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))`. Cross-platform: the palette listener accepts `metaKey||ctrlKey`, and the synthetic event sets `metaKey:true`, so it works on Windows/Linux too.
- **Optional:** extract a tiny shared `openCommandPalette()` helper so both call sites share one function.

Note the dispatch **toggles** — clicking [Search] while the palette is already open would close it (CommandPalette:57). v1 reuses the generic palette (projects/commands/jobs/nav); a scoped agent-conversation search would require refactoring `CommandPalette` to accept controlled open state.

---

## 9. Cross-cutting concerns

- **Feature flag.** Gate the whole feature behind a client flag (e.g. `VITE_FEATURE_AGENT_MODE`, default per policy) resolved through `client/src/lib/feature-flags.ts` (string `"false"` = off, everything else = on), mirroring `VITE_FEATURE_CODE_EXPLORER`/`VITE_FEATURE_TERMINAL_PANEL`. When off, `UiModeProvider` pins `'kanban'` and none of the new buttons render — Kanban stays byte-identical.
- **i18n (`agent` namespace).** The `agent` namespace already exists (×8 locales). Add keys for the new surfaces: `switchToAgentMode`/`switchToKanbanMode`, `newAgent`, `search` (reuse `titleBar.searchShortcut`/`searchPlaceholder` from `nav.json` for the button label), the "On workspace" tool labels (`workspace.terminal`/`.files`/`.browser`), disabled-tooltip ("requires an active project"), the EMPTY-state "Plan, Build" copy, and Home-group label. **All 8 locales must mirror English** (locale-parity test enforces key tree + placeholders).
- **WS events.** No new WS event types are strictly required for the shell swap (uiMode is client-local). Attachment parity may add attachment refs to the existing `agent_done`/message echo, or a new project-scoped-free (app-global, no `projectId`) event so non-initiating subscribers render user-turn attachments. Browser capture reuses the existing project-scoped browser WS. Terminal reuses the dedicated `/ws/terminal/:id`.
- **Coverage / tests (per CLAUDE.md — server 80% lines/functions/statements + 70% branches, client 80% lines/statements + 70% functions, 70% global).**
  - *Client:* `UiModeContext` (persistence, NOOP fallback), `AgentConversationView` (EMPTY vs ACTIVE from context, tier-cycle rebind, composer submit), `AgentModeSurface`, `AgentWorkspaceSidebar` (disabled gating), `ArcSidebar` agent-mode branch (grouping, expand state, click semantics, Home group), `CodePage` embedded/controlled mode (navigate suppression, URL-effect no-op), the [Search] dispatch. Attachment editor reuse is largely covered by existing Explore tests; add agent-composer wiring tests.
  - *Server:* new agent attachment endpoints (upload/list/delete, 25MB cap, mime filter, traversal guard on `conversationId`), `AgentChatManager.sendMessage` prompt-fold (text blocks in, extraction-failure degrades to text-only), agent-scoped storage root, conversation-delete cleanup, and (if added) `ai_invocations` recording.
  - Structurally-unreachable Tauri-only paths may be excluded with an inline documented reason (per policy), never to mask missing tests.

---

## 10. Consolidated RISKS + numbered OPEN DECISIONS

### RISKS (deduped across slices, most-load-bearing first)

1. **Double-mount of the terminal (single-adopter invariant).** If `BottomPanel` is hoisted to `DesktopApp` but `ProjectLayout` still renders its own copy (ProjectLayout:124-133) in Kanban, TWO `TerminalViewport`s fight over the same active container in `#specrails-terminal-host` — the second `appendChild` steals the node, the first's cleanup moves it back → flicker/blank terminal. The ProjectLayout copy **must** be removed.
2. **CodePage's hardcoded `navigate({pathname:'/code'})` (CodePage:133,140,147,159).** Embedded without neutralizing these, any file/filter click routes the whole app to `/code` and pops the user out of Agent Mode. Highest CodePage coupling. Paired risk: the searchParams source-of-truth effect (:71-75) would force-reset `relPath` on every non-`/code` search change unless gated by `embedded`.
3. **Hoisting `BottomPanel`/`StatusBar` risks Kanban layout regressions.** `StatusBar` needs `connectionStatus` from `usePipeline()` (ProjectLayout:25) — verify it works at DesktopApp scope. The `viewportHeight`/`STATUSBAR_HEIGHT_PX` maximize math depends on the panel's container height and whether a StatusBar exists; wrong values overshoot/undershoot maximize. Kanban must render exactly as today.
4. **Images silently no-op on codex/gemini.** `@<abs-path>` is literal text to them; users will believe the image was seen. Needs per-provider UX gating. Also `getClaudeArgs` `@path` refs only resolve if the agent CLI spawn has read access to the agent attachments dir — confirm cwd/permissions parity with the chat spawn.
5. **Agent attachment storage has no natural home / lifecycle.** Agent conversations are app-global (no slug); the `projects/<slug>/attachments/<ticketKey>` convention doesn't fit and a synthetic slug risks collision. An unpinned "Home" conversation has no project at all. Agent convos never become tickets, so there's no migration/permanence path, and `deleteAgentConversation` doesn't clean up files today.
6. **`AgentChatContext` has no public `refreshConversations`** (only `open()`/`toggle()` refresh, :193,204) — the sidebar project tree can show a stale/empty list on mode entry; and `selectConversation` only loads the thread (doesn't set visibility/uiMode), so sidebar clicks need new coordination.
7. **`AgentProjectSelector` lives in the panel header (chrome).** Naive extraction of only the inner subtree drops the project selector from Agent Mode — it must be re-homed into the composer/empty-state.
8. **Center-as-route assumption breaks in Agent Mode.** `useProjectRouteMemory` (App.tsx:166) and `/code`/`/jobs` routes don't mount; route memory must still restore correctly on switching back to Kanban.
9. **`ProjectItem` onClick split** (chevron-toggle vs row-activate) risks breaking keyboard handling (`handleSelectKeyDown` :57-61) and the remove-confirm `stopPropagation` flow (:88-101); nested interactives need a11y care.
10. **Prompt bloat / argv limits.** Folding large extracted PDF/xlsx text into one argv prompt can hit OS `E2BIG`; same exposure as ChatManager but worth noting.

### OPEN DECISIONS (the human must resolve these before implementation — this is the next phase)

1. **Do global routes `/loops` and `/docs` (App.tsx:263-269) still function in Agent Mode, or is the entire center replaced by `AgentModeSurface` regardless of URL?** Determines whether the `uiMode` branch wraps only the project-route block or the whole `<Routes>`.
2. **Is `BottomPanel`+`StatusBar` truly hoisted to `DesktopApp` (single instance, both modes) or duplicated into `AgentModeSurface`?** Hoisting is cleaner but edits `ProjectLayout`; confirm the acceptable refactor scope. (Recommendation across slices: single hoisted instance.)
3. **Is there any footer/StatusBar in Agent Mode at all?** If not, `statusBarHeight` passed to `BottomPanel` is 0 and the terminal chevron entry point lives solely in the right sidebar.
4. **Where does the terminal render vertically in Agent Mode** — under the agent center only, or spanning full width beneath both the agent surface and the `AgentWorkspaceSidebar`? (Today's BottomPanel spans only the routed main column.)
5. **Can Agent Mode be entered with no active project (Home group only), or does the toggle force an active project?** Affects `activeProject` gating on `AgentWorkspaceSidebar` and the hoisted `BottomPanel`.
6. **When switching Kanban→Agent while the panel is `restored`/`maximized`, does it stay open (same session) or auto-hide?** And is the sidebar Terminal button open-only (`setVisibility('restored')`) or a toggle (`togglePanel`)?
7. **Does entering Agent Mode call `open()` (mounts the now-suppressed floating panel) or a new lighter `refreshConversations`?** (Recommendation: expose a standalone refresh.)
8. **Does `[New agent]` pin to the currently-active project or always create a Home (null) conversation?** And does `newConversation` gain an explicit `projectId` param, or read `useDesktop` internally? (Recommendation: explicit arg keeps the context decoupled from routing.)
9. **Persistence key + shape for per-project tree expansion** (Set vs Record) and default (expand active only vs expand all vs remember last).
10. **In Agent Mode, does a project-row click with zero conversations still toggle (empty group) or only set active?**
11. **Does the inline EMPTY state reuse the exact ACTIVE composer (variant-driven layout) or a dedicated "Plan, Build" card variant?** (Recommendation: same composer, variant layout, to guarantee attachment parity.)
12. **Where do provider/model/tier controls + the project/Home indicator live in Agent Mode** — inside the composer row (as today) or a header strip?
13. **When entering Agent Mode with an existing active conversation, show ACTIVE immediately or reset to EMPTY?** (`active` persists across mode toggles.)
14. **Files: split vs full-replace when opened.** (Recommendation: SPLIT — thread + collapsible code pane — since the workflow is "chat while inspecting code"; confirm nested-split min-width math fits `MIN_MAIN_WIDTH=520`+`MIN_TREE_WIDTH=240`.)
15. **Where does code selection persist** — per-conversation (reopen where left off) or per session — and is it context-state only (design keeps Agent Mode off `/code`) or also reflected as a shareable query param?
16. **Does the embedded Files pane keep the provenance toolbar/filters (jobId/ticketId), or a stripped tree+viewer?** (Provenance filters are URL-driven today; keeping them needs the same controlled-state treatment.)
17. **Does `[Search]` open the same generic palette (projects/commands/jobs/nav) or a scoped agent-conversation search?** (Recommendation: reuse generic palette for v1.)
18. **Agent attachment storage key scheme:** distinct root `~/.specrails/agent/<conversationId>/attachments/` (recommended) vs reusing `AttachmentManager` with a synthetic slug/ticketKey.
19. **What backs attachment storage for unpinned "Home" conversations with no active/pinned project** — is an active project mandatory to attach, or do we introduce app-global attachment storage?
20. **Do agent turns persist their attachment id list** (new migration on `agent_messages` / new table) so historical turns re-render pills, or is display-on-send enough (folded into prompt only)?
21. **Do we meter agent turns in `ai_invocations` now** (none today) or keep agent unmetered and only fold attachments?
22. **Images on codex/gemini:** block/disable image attachments for non-claude providers, or attempt native image flags? What parity bar is acceptable for v1?
23. **Does the agent composer replicate the auto-send-capture-feedback behavior (`sendCaptureFeedback`)** or only queue captures as chips that ride the next manual message?
24. **Are the 25MB per-file cap and `ATTACHMENT_ACCEPT_MIME` allowlist acceptable unchanged for agent mode**, or does agent mode want different limits/types?
25. **Attachment transport at send:** pre-upload then pass ids (Explore model, recommended for streaming compat) vs multipart on the send call itself.

---

## 11. RESOLVED DECISIONS (human sign-off, 2026-07-01)

The 25 open decisions are resolved as follows. The 4 taste-forks were decided by the human; the rest take the recommended defaults.

**Human-decided forks:**
- **D1 → Loops/Docs STAY in Agent Mode.** The center branch is `isInSetup ? Wizard : (location==='/loops'||'/docs') ? <Routes> : uiMode==='agent' ? <AgentModeSurface/> : <Routes>`. Global routes render in the center without leaving Agent Mode; only project-route/dashboard content is replaced by the agent surface.
- **D14 → Files = SPLIT (Cursor-style).** Thread stays visible; `CodePage` opens in a resizable secondary pane beside it, with a maximize toggle to widen the code pane (Cursor behaviour). Honour `MIN_MAIN_WIDTH=520`+`MIN_TREE_WIDTH=240`.
- **D5 → Agent Mode CAN be entered with no active project.** Home-group (null-pinned) conversations are first-class. `AgentWorkspaceSidebar` Browser/Terminal/Files are disabled until a project is active; **file/paste/drag attachments still work** (they are conversation-keyed, project-independent). Only Browser-capture requires an active project (sessions are project-scoped).
- **D22 → Images: NATIVE FLAGS, verified against real binaries (2026-07-01).** Empirical `--help` check on the installed CLIs:
  - **codex-cli 0.141.0 → `-i, --image <FILE>...`** (present on both `codex` and `codex exec`). Wire this into `buildCodexArgs` (codex-adapter:75) — real native image support.
  - **claude 2.1.197 →** images via `@<abs-path>` in the prompt, resolved natively (unchanged).
  - **gemini 0.49.0 → NO dedicated image flag** (`-i` is `--prompt-interactive`). Relies on `@path` in-prompt injection (already emitted by `getClaudeArgs`); the Gemini model is multimodal so it *may* vision-load it under `-p`, but this is **UNVERIFIED** and must be smoke-tested live during implementation. Fallback: if it doesn't load, images degrade to claude+codex only and are disabled in the composer for gemini convos.
  - **Contract:** add `supportsImageInput` to `ProviderCapabilities` (types.ts:91-120) and gate the composer's image affordance on the flag (never on `provider === id`). Add a new image-paths field on `SpawnOptions` threaded through `buildCodexArgs` (emits `--image`); claude/gemini keep the `@path` route.

**Default-resolved:**
- **D2/D3 →** Single hoisted `BottomPanel`+`StatusBar` in `DesktopApp` (remove ProjectLayout copy). StatusBar exists in both modes (maximize math needs its height); footer chevron gated to `uiMode==='kanban'`.
- **D4 →** Terminal spans full width beneath surface + `AgentWorkspaceSidebar`.
- **D6 →** Entering Agent Mode does NOT auto-hide an open panel. Sidebar Terminal button = `togglePanel(activeProjectId)`.
- **D7 →** Expose a standalone `refreshConversations` (do NOT call `open()`).
- **D8 →** `newConversation(projectId?)` explicit arg; `[New agent]` defaults the pin to `activeProjectId` (null ⇒ Home).
- **D9 →** Expansion state = `Set<string>` in localStorage `specrails-desktop:agentTreeExpanded`, default-expand the active project.
- **D10 →** Project-row click always sets active + toggles expand (even with zero conversations).
- **D11 →** EMPTY reuses the ACTIVE composer via `variant` layout (guarantees attachment parity), styled as the centered "Plan, Build" card.
- **D12 →** provider/model/tier + project/Home indicator stay in the composer row.
- **D13 →** Entering Agent Mode with an existing `active` shows ACTIVE immediately.
- **D15/D16 →** Code selection persists per-conversation in Agent-Mode context state (NOT the URL); embedded Files pane keeps the provenance toolbar/filters (controlled-state, not URL-driven).
- **D17 →** `[Search]` reuses the generic CommandPalette (synthetic Cmd+K dispatch) for v1.
- **D18/D19 →** Distinct storage root `~/.specrails/agent/<conversationId>/attachments/`; attachments are conversation-keyed and work for Home convos with no project.
- **D20 →** Persist the attachment id list per turn (new nullable `attachments` JSON column on `agent_messages`) so history re-renders pills.
- **D21 →** METER agent turns in `ai_invocations` now (`surface='agent'` or similar), for Analytics coherence.
- **D23 →** Agent composer queues captures as chips that ride the next manual message (no auto-send-feedback in v1).
- **D24 →** Keep 25MB cap + `ATTACHMENT_ACCEPT_MIME` allowlist unchanged.
- **D25 →** Pre-upload then pass ids (streaming-compatible).
