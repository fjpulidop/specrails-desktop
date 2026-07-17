# Tasks — reskin-project-builder-into-agent-panel

## 1. Session extraction + mode state

- [x] 1.1 Extract the builder session logic from `ProjectBuilderShell` into `client/src/hooks/useBuilderSession.ts` (conversation bootstrap, `blueprint.*` WS handling, phases `chat|commit|progress|done`, snapshot state, send/commit/launchM1/openProject actions); hook unit tests (mock fetch + WS handler injection)
- [x] 1.2 Add the `builderMode` slice to `AgentChatContext`: `{ active, enterBuilderMode, exitBuilderMode }`; entering opens the floating panel and suppresses (hides, never unmounts) normal agent chrome; exiting restores it and aborts an in-flight builder turn; context tests (agent queue/pinned state preserved across enter/exit)

## 2. Halo + surface transformation

- [x] 2.1 Create `client/src/components/project-builder/BuilderHalo.tsx`: entry-only CSS-keyframe rotating conic-gradient ring (theme accent tokens), `motion` enter/exit, `prefers-reduced-motion` ⇒ static glow; mount on the fresh composer, `AgentBubble`, and panel header while the chat is empty; remove it on first work; render tests incl. reduced-motion branch
- [x] 2.2 Agent Mode: `AgentWorkspaceSidebar` animated swap (`AnimatePresence`) to `BlueprintPanel` + phase CTA while `builderMode.active`; restore tool rail on exit; tests
- [x] 2.3 Board mode: attached blueprint side pane on `AgentChatPanel` (same `BlueprintPanel` + CTA, panel min-width grows in builder mode); tests

## 3. In-panel phases + entry/exit

- [x] 3.1 Builder conversation rendering inside the panel: chat phase (messages + streaming buffer with `cutUnterminatedBlock`, surprise-me chip on first turn, composer bound to `/api/blueprint/.../send` with provider/model/effort selectors, `resize-y` textarea, `SendHorizontal`, and inline first-send layout morph), commit phase (`BlueprintCommitForm` in the conversation slot), progress step list, done screen (Launch M1 / Open project → both exit builder mode)
- [x] 3.2 Entry: `AddProjectDialog` *New* card → `enterBuilderMode()` (replaces `onOpenBuilder` overlay wiring); delete `ProjectBuilderShell.tsx` + its `App.tsx` mount; migrate its tests to the panel-hosted rendering
- [x] 3.3 Exit protection: dirty-blueprint confirm on panel close / Esc from chat phase; Esc from commit form returns to chat; tests

## 4. Polish + gates

- [x] 4.1 i18n: builder-mode chrome keys (`builder:mode.*` — entering, exit confirm, halo aria) ×8 locales; parity test green
- [x] 4.2 Update CLAUDE.md (Project Builder section: panel-hosted, halo, sidebar transform) + `docs/internals/project-builder.md` as-built
- [x] 4.3 Full gates: `npm run typecheck`, `npm test`, server + client coverage thresholds; iterate until green
