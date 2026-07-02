## Why

The in-app agent today lives in a floating bubble/panel — a secondary, easily-missed surface. We want to promote it to a **primary, first-class mode** (Cursor / Antigravity style): a persisted, full-screen "Agent Mode" that replaces the Kanban dashboard, gives every project a browsable history of its agent conversations, and exposes the app's own tools (Browser / Terminal / Code) beside the thread. This turns the agent from an accessory into a co-equal way of operating the whole app, while Kanban stays byte-identical for users who never switch.

## What Changes

- New app-global **`uiMode: 'kanban' | 'agent'`** (persisted to `localStorage`), toggled by a **Switch to Agent Mode / Switch to Kanban mode** button in the left sidebar (`ArcSidebar`), above Loops.
- In Agent Mode the center swaps the routed dashboard for a full-screen **`AgentModeSurface`** — an EMPTY centered composer ("Plan, Build") when no conversation is active, an ACTIVE thread otherwise. The floating agent bubble/panel are suppressed.
- The left sidebar restructures in Agent Mode: **New Agent** + **Search** buttons, and project rows become **expandable trees of agent conversations** grouped by `pinned_project_id`, plus a **Home** group for null-pinned conversations. Clicking a project row also sets it active; clicking a conversation opens it.
- The navbar **SearchPill is hidden** in Agent Mode and its Cmd+K function is reached from the sidebar **Search** button (the CommandPalette keydown listener is unchanged).
- A right **"On workspace"** sidebar (`AgentWorkspaceSidebar`) exposes **Browser** (Explore-style capture), **Terminal** (the existing bottom panel), and **Files** (inline `CodePage` split pane, Cursor-style). All three are disabled without an active project.
- **`BottomPanel` + `StatusBar` are hoisted** from `ProjectLayout` up to `DesktopApp` as a single instance shared by both modes (preserving the terminal single-adopter invariant); the footer chevron is gated to Kanban.
- `CodePage` is refactored into a **controlled/embeddable** component (navigate-to-`/code` calls replaced by callbacks) so Files can render it inline in Agent Mode.
- **Full attachment parity** with Explore: the agent composer adopts `RichAttachmentEditor` (file-pick / drag-drop / image-paste / @-pills) plus browser-capture chips, with **native images** where supported — codex `--image` (verified), claude `@path`, gemini `@path` (unverified, gated off until smoke-tested).
- New server surface: **agent attachment routes** (`/api/agent/conversations/:id/attachments`), a distinct storage root `~/.specrails/agent/<conversationId>/attachments/`, an `agent_messages.attachment_ids` migration, and **`ai_invocations` metering** for agent turns (`surface='agent'`, pinned conversations only).
- Loops/Docs global routes **stay rendered in Agent Mode** (center shows the route without leaving the mode).
- Gated behind **`FEATURE_AGENT_MODE`**; when off, `UiMode` pins `'kanban'` and Kanban is byte-identical (kill path = flag flip, no data migration to reverse).

## Capabilities

### New Capabilities
- `agent-mode-shell`: the persisted `uiMode` context, the Kanban↔Agent shell swap (center branch, right-sidebar swap, bubble/SearchPill suppression, motion), and the `AgentModeSurface` EMPTY/ACTIVE surface.
- `agent-conversation-history`: project→conversation trees grouped by `pinned_project_id`, the Home group, expand/persist state, New-Agent pin defaulting, and standalone `refreshConversations`.
- `agent-workspace-tools`: the right "On workspace" sidebar and its three tools — inline Terminal (hoisted `BottomPanel`), inline Files (embedded `CodePage` split), and Browser capture — with the active-project gating rule.
- `agent-attachments`: attachment parity for the agent composer, the agent-scoped storage root + server routes, `agent_messages.attachment_ids` persistence, native-image threading + `supportsImageInput` capability, and `surface='agent'` metering.

### Modified Capabilities
- `desktop-shell`: `BottomPanel`/`StatusBar` hoisted to `DesktopApp` (single instance, both modes); center content and right sidebar branch on `uiMode`; Loops/Docs stay-in-mode.
- `mac-titlebar-search`: the SearchPill is hidden when `uiMode==='agent'` (Cmd+K still works; a sidebar Search button dispatches it).
- `code-explorer`: `CodePage` gains a controlled/`embedded` mode (navigate-suppression, URL-effect no-op, controlled selection/filters) so it can render inline outside the `/code` route.
- `rich-attachment-editor`: an injectable upload/delete transport (`uploadFn`/`onDeleteAttachment`) so the editor targets the agent attachment endpoint instead of the project tickets endpoint.

## Impact

- **Client**: `App.tsx` (provider tree + center/right branch + terminal hoist), new `UiModeContext`, `ArcSidebar`, `TitleBar`, `AgentChatContext`, `AgentChatPanel` (→ shared `AgentConversationView`), new `AgentModeSurface`/`AgentWorkspaceSidebar`/`AgentModeCodePane`, `ProjectLayout` (remove hoisted panel), `CodePage` (embeddable), `RichAttachmentEditor` (injectable transport), `lib/agent-api.ts`, `lib/feature-flags.ts`, i18n `agent` namespace ×8 locales.
- **Server**: `agent-chat-router.ts` (attachment routes + send parse + delete cleanup), `agent-chat-manager.ts` (attachment fold + image threading + metering + `ProjectRegistry` injection), `attachment-manager.ts` (agent root + `getClaudeArgsAgent` split), `agent-store.ts` + `desktop-db.ts` migration 18, `providers/types.ts` + `codex-adapter.ts`/`claude-adapter.ts`/`gemini-adapter.ts` (`supportsImageInput` + `imagePaths`), `spawn-lifecycle.ts` (`surface='agent'`), `index.ts` wiring.
- **Data**: additive `agent_messages.attachment_ids` (nullable); new on-disk root `~/.specrails/agent/<conversationId>/attachments/`. No destructive migration.
- **Frozen contracts preserved**: mobile-ws wire compat, bundle id `sh.specrails.hub`, master token. Kanban mode byte-identical when the flag is off.
- **Reference**: full design + resolved decisions in `docs/internals/switch-to-agent-mode-design.md`.
