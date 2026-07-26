## 1. Desktop shell reopen

- [x] 1.1 Handle `RunEvent::Reopen` in `src-tauri/src/lib.rs`, calling `show_main_window` when no visible windows remain
- [x] 1.2 Document the Windows parity path (single-instance relaunch) next to the close-to-tray handler
- [x] 1.3 `cargo check` the Tauri crate

## 2. Mission project binding

- [x] 2.1 Read `activeProjectId` in `AgentChatContext` and add the change-only backward sync effect (draft pin when no conversation, patch when the conversation has no messages, no-op otherwise), gated on `uiMode === 'agent'`
- [x] 2.2 Skip the effect's first render so a Home-pinned mission is never converted on mount
- [x] 2.3 Client tests: draft pin follows a project switch, empty conversation is patched, a conversation with messages is untouched, mount does not bind, board mode is untouched

## 3. Warm-dependency links are release-safe

- [x] 3.1 In `server/worktree-node-modules.ts`, export a live authenticator that returns `OverlayCleanupEvidence` for worktree entries named `node_modules` (depth ≤ `MAX_DEPTH`) whose symlink target resolves to the base repo's identically-named directory
- [x] 3.2 Make `linkNodeModulesIntoWorktree` also authenticate pre-existing links (resume safety) and return their evidence alongside the created ones
- [x] 3.3 In `server/rail-isolated-launch.ts`, feed the authenticated paths into `overlayExcludes` and the evidence into the durable branch record's cleanup evidence, without letting overlay revalidation drop them
- [x] 3.4 In `server/rail-worktree-release.ts`, merge live-authenticated warm-link evidence into the release exclusion pathspec and the quarantine set
- [x] 3.5 Server tests: link-only worktree releases and is quarantined; a real directory / copy / foreign-target link still preserves the worktree; a legacy row with no persisted evidence heals; resume keeps the exclusion

## 4. Claude Opus 5

- [x] 4.1 Add the alias → model-id resolution in `server/providers/claude-adapter.ts` and apply it at every `--model` push
- [x] 4.2 Recognise `claude-opus-5` in `normaliseModel`
- [x] 4.3 Adapter tests: `opus` spawns `claude-opus-5`, other aliases and concrete ids pass through, `claude-opus-5` normalises to `opus`

## 5. Gates

- [x] 5.1 `npm run typecheck`
- [x] 5.2 `npm test`
- [x] 5.3 `npm run test:coverage` (server thresholds)
- [x] 5.4 `cd client && npm run test:coverage` (client thresholds)
- [x] 5.5 Update `CLAUDE.md` where the changed contracts are documented
