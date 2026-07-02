## Context

The in-app agent (`AgentChatManager` + `AgentChatContext`) today renders as a floating, movable/resizable panel plus a draggable bubble, mounted as a sibling of the routed app (`AgentChatContext.tsx:290-297`, provider at `App.tsx:450`). Conversations are app-global in `desktop.sqlite` (`agent_conversations`, migration 17) with a nullable `pinned_project_id` selector, and the context already keeps a full `conversations[]` history list, `active`, streaming state, and actions (`newConversation`, `selectConversation`, `setPinnedProject`).

This change promotes that agent to a **primary full-screen mode**. The heavy lifting is UI/shell composition and one server-side attachment subsystem — the data model already supports per-project grouping (no conversation-schema migration needed). The authoritative, file:line-anchored reference is `docs/internals/switch-to-agent-mode-design.md` (sections 1–12 + the three implementation-grade slices and the motion spec). This document distills the architecture and the load-bearing decisions.

Key existing anchors: `App.tsx` DesktopApp (`:230-330`), providers (`:440-465`); `ProjectLayout.tsx` (BottomPanel/StatusBar `:124-134`, chevronSlot `:90-95`, viewportHeight `:70-83`, usePipeline `:25`); `TerminalsContext` (single host `#specrails-terminal-host` `:178-194`, `togglePanel`/`setVisibility` `:273-282`); `TitleBar.tsx` SearchPill (`:66-129`, mounts `:175`,`:215`); `ArcSidebar.tsx` (Loops `:206-229`, projects `:233`); `CodePage.tsx` (navigate `:133,140,147,159`, URL sync `:71-75`); `attachment-manager.ts` (`getClaudeArgs` `:287-310`, guards `:100-129`); `agent-chat-manager.ts` (`sendMessage`, prompt build `:97-151`); `agent-chat-router.ts` (`:144-163`); `providers/types.ts` (`SpawnOptions`/`ProviderCapabilities`); `codex-adapter.ts` (`buildCodexArgs` `:75`).

## Goals / Non-Goals

**Goals:**
- A persisted `uiMode` shell swap where Agent Mode replaces the dashboard, restructures the left sidebar into project→conversation trees, hides the floating surfaces + navbar search, and adds a right "On workspace" toolbar (Browser/Terminal/Files).
- Kanban Mode byte-identical when the feature flag is off, and safe (single-instance terminal, no route breakage) when on.
- One shared `AgentConversationView` consumed by both the floating panel (Kanban quick-access) and the inline surface — no forked chat UI.
- Full Explore attachment parity in the agent composer + native images where the CLI supports them (codex `--image` verified; claude `@path`; gemini gated off pending live verification).
- Reuse the app's existing motion DNA (hero curve `cubic-bezier(0.34,1.56,0.64,1)`, glass-card, `useSmoothStream`, semantic tokens) so Agent Mode looks native, not bolted-on.

**Non-Goals:**
- No conversation-schema migration for grouping (reuse `pinned_project_id`).
- No metering of Home (unpinned) turns (`ai_invocations.project_id` is NOT NULL, per-project DB).
- No auto-send of browser captures (chips only in v1).
- No scoped agent-conversation search (v1 reuses the generic CommandPalette).
- No provider-id branching — capabilities gate features (`supportsImageInput`), never `provider === 'x'`.

## Decisions

The 25 open questions from the design dossier are resolved in its §11; the load-bearing ones:

- **`uiMode` = own persisted context (`UiModeContext`), mounted inside `DesktopProvider` above `TitleBar`/`AgentChatProvider`.** Alternative (bolt onto `DesktopProvider`) rejected — a tiny dedicated context with a NOOP fallback keeps every shell surface test-mountable and the concern isolated. Flag-off pins `'kanban'`.
- **Hoist `BottomPanel` + `StatusBar` to `DesktopApp` as a single instance (remove the `ProjectLayout` copy).** This is the riskiest structural move: the terminal relies on a single hidden host `#specrails-terminal-host` and a single-adopter `TerminalViewport`. Two mounted panels would fight over the container. `TerminalsProvider` is already app-level, so only the visual panel moves; `usePipeline().connectionStatus` is project-independent (sourced from the app-level WS provider) and works at `DesktopApp` scope. The maximize math (`viewportHeight − statusBarHeight`) requires the ResizeObserver ref on the flex column that also contains the StatusBar (`App.tsx:242`). Alternative (duplicate a second panel into `AgentModeSurface`) rejected — it violates the single-adopter invariant.
- **Center branch order: setup → global route (`/loops`,`/docs`) → agent → Routes.** Loops/Docs stay rendered in Agent Mode (a shared `onGlobalRoute` predicate); the Kanban `<Routes>` block stays byte-identical (the swap is a sibling ternary arm).
- **Extract `AgentConversationView` (banners + message list + streaming + composer + local state), leaving window chrome in `AgentChatPanel`.** `variant: 'floating' | 'inline'` drives layout only. The project selector must be re-homed out of the panel header into the composer/empty-state so it survives in Agent Mode. `newConversation(projectId?)` gains an explicit arg (arg-less call stays backward-compatible).
- **Files = inline `CodePage` split pane (Cursor-style), decoupled from `ProjectLayout`/route.** `CodePage` becomes controlled: `embedded` gates navigate-suppression + URL-effect no-op; selection/filters become props; selection persists per-conversation in Agent-Mode state (not URL). Alternative (jump to Kanban `/code`) rejected by the "brave" decision — inline keeps the mode pure at the cost of a real `CodePage` refactor.
- **Agent attachments: distinct storage root `~/.specrails/agent/<conversationId>/attachments/`, conversation-keyed.** Reusing `projects/<slug>/attachments` with a synthetic slug risks collisions and doesn't fit Home (no project). Conversation-keyed storage lets Home conversations attach files. Server routes mirror the ticket endpoints; guards reuse the opaque-token rule already enforced for `~/.specrails/agent/<id>/`.
- **Attachment ids persisted per turn (`agent_messages.attachment_ids`, migration 18) + pre-upload-then-ids transport.** Pills rehydrate on reload; streaming stays compatible (ids known before send).
- **Native images via capability + `SpawnOptions.imagePaths`.** `getClaudeArgsAgent` returns `{textBlocks, imagePaths}`: the image `@path` stays in `textBlocks` (claude resolves it, gemini gets a best-effort shot) AND absolute image paths are collected for codex `--image` (additive; the `@path` is inert to codex). `supportsImageInput`: codex/claude true, gemini false until a live `-p @path` vision smoke-test passes.
- **Meter agent turns in `ai_invocations` (`surface='agent'`), pinned conversations only.** `AgentChatManager` takes the `ProjectRegistry` to resolve the pinned project's DB; Home turns are skipped. `spending.invalidated` broadcast per metered turn.
- **`RichAttachmentEditor` gains an injectable `uploadFn`/`onDeleteAttachment`** so the agent composer targets the agent endpoint without a new editor.

## Risks / Trade-offs

- **Double-mounted terminal (single-adopter)** → remove the `ProjectLayout` `BottomPanel`/`StatusBar` in the same commit as the hoist; test asserts exactly one panel in the DOM and a clean Kanban→Agent→Kanban round-trip.
- **`CodePage` hardcoded `navigate('/code')` (`:133,140,147,159`) + URL-sync effect (`:71-75`)** → embedded mode replaces those with callbacks and no-ops the effect; regression test asserts zero `navigate` calls when embedded and unchanged route behavior otherwise.
- **StatusBar hoist Kanban regression (usePipeline scope, maximize math)** → ref on the correct column node; snapshot maximize height parity Kanban vs Agent; verify `connectionStatus` non-undefined at DesktopApp scope.
- **Images silently no-op on gemini** → `supportsImageInput:false` disables the image affordance for gemini convos so users aren't misled; codex `--image` verified; text-extractable attachments work everywhere.
- **Browser-capture storage mismatch** → capture routes write to the project attachment dir; the agent send fold reads the agent dir. v1 either scopes captures to pinned-project convos via an agent-scoped capture target, or ships the Browser tool behind that seam; do not wire the Globe to project storage (ids won't resolve).
- **Home turns unmetered** → intended v1 behavior (no `project_id`); documented, not a bug.
- **`ProjectItem` onClick split (chevron vs row)** → preserve keyboard handling and the remove-confirm `stopPropagation`; nested-interactive a11y care.
- **argv E2BIG on large extracted text** → same exposure as ChatManager; add a size guard if attachments are large.

## Migration Plan

- **Schema:** additive migration 18 — `ALTER TABLE agent_messages ADD COLUMN attachment_ids TEXT` (nullable). No destructive change; existing rows read as text-only.
- **Storage:** new on-disk root `~/.specrails/agent/<conversationId>/attachments/`, created on first upload, removed on conversation delete.
- **Flag / rollout:** `FEATURE_AGENT_MODE` (client, `VITE_FEATURE_AGENT_MODE`, `"false"` = off). Ship dark-capable; server attachment/metering code is inert unless a turn actually sends ids and the existing `SPECRAILS_AGENT_CHAT` gate is on.
- **Kill path:** set `VITE_FEATURE_AGENT_MODE=false` → `UiMode` pins `'kanban'`, no new surfaces render, the terminal hoist (mode-agnostic, validated in Kanban) stays, app is byte-identical to pre-feature. If server misbehaves, `SPECRAILS_AGENT_CHAT=false` 404s the attachment/send routes. Neither requires reversing a migration (the nullable column is harmless).
- **Dependency order (implementation):** P1 UiMode+flag → P2 hoist BottomPanel/StatusBar (+gate chevron/SearchPill) → P3 extract AgentConversationView → P4 AgentModeSurface+center branch → P5 sidebar trees+refresh → P6 workspace sidebar → P7 terminal → P8 files inline → P9 browser → P10 server attachment routes+storage+migration → P11 send-fold+native images+capabilities → P12 metering → P13 composer reuse → P14 i18n ×8 → P15 motion polish → P16 tests to thresholds. Full per-task acceptance checks + test matrix live in `tasks.md` and the dossier's slice C.

## Open Questions

- **Gemini image support** — does `gemini -p` vision-load a `@path` image? Requires a live smoke-test against gemini 0.49; until then `supportsImageInput:false`.
- **Browser-capture agent target** — build a small agent-scoped capture route, or scope captures to pinned-project conversations for v1? (Affects whether the Browser tool ships fully wired.)
- **`FEATURE_AGENT_MODE` default** — dossier planner recommends OFF for v1 (invariant-touching); product intent is a primary feature (ON, killable). Resolve at rollout.
