# Design

## Context

See proposal.md. Native surfaces are Tauri windows opened via `surface_windows.rs` and `native-surfaces.ts`; web falls back to Radix modals through `<Surface>`.

## Blast radius

- `client/src/App.tsx`: shell wiring for the project-settings surface and right sidebar.
- `client/src/components/__tests__/ArcSidebar.test.tsx`: updated for settings/sidebar behaviour.
- `client/src/components/__tests__/ArcSidebarAgentConversations.test.tsx`: updated for settings/sidebar behaviour.
- `client/src/components/__tests__/CommandPaletteActions.test.tsx`: updated for settings opening as a surface.
- `client/src/components/__tests__/CommandPaletteScopes.test.tsx`: updated for settings opening as a surface.
- `client/src/components/__tests__/ProjectRightSidebar.test.tsx`: right sidebar kept in settings.
- `client/src/components/__tests__/TitleBar.test.tsx`: right sidebar toggle in settings.
- `client/src/components/ArcSidebar.tsx`: opens project settings via the surface.
- `client/src/components/CommandPalette.tsx`: opens project settings via the surface.
- `client/src/components/ProjectRightSidebar.tsx`: sidebar available in settings.
- `client/src/components/StatusBar.tsx`: integrates the always-visible Resources button.
- `client/src/components/ui/__tests__/dialog-standard.test.tsx`: asserts `overflow-clip` panels.
- `client/src/components/ui/__tests__/surface.test.tsx`: surface behaviour for project settings and frame owner.
- `client/src/components/ui/dialog.tsx`: `overflow-clip` on panel and surface window panel classes.
- `client/src/features/background/components/__tests__/AppResourcesFooter.test.tsx`: replaces the hide-at-zero test; covers visibility and neutral name.
- `client/src/features/background/components/AppResourcesFooter.tsx`: button always rendered; count only when measured.
- `client/src/features/background/README.md`: documents persistent button.
- `client/src/features/README.md`: feature guide update.
- `client/src/features/settings/components/project-settings-sections.tsx`: shared section content for surface and modal.
- `client/src/features/settings/components/ProjectSettingsSections.tsx`: shared section content for surface and modal.
- `client/src/features/settings/lib/setting-anchor.ts`: deep links preserved through the surface.
- `client/src/features/settings/pages/__tests__/SettingsPage.test.tsx`: tests for dialog/surface presentation.
- `client/src/features/settings/pages/SettingsPage.tsx`: rendered as Dialog/surface with heading format.
- `client/src/features/settings/README.md`: documents the presentation.
- `client/src/features/terminals/components/terminal/BottomPanel.tsx`: terminal panel adjusted so the Resources button stays visible.
- `client/src/lib/__tests__/sidebar-layout.test.ts`: settings keeps right sidebar.
- `client/src/lib/app-settings-events.ts`: events for opening project settings.
- `client/src/lib/native-surfaces.ts`: `project-settings` surface id, opener/owner semantics.
- `client/src/lib/sidebar-layout.ts`: project settings no longer drops the right sidebar.
- `client/src/SurfaceWindowContent.tsx`: renders project-settings in native window.
- `DESIGN.md`: documents the visual/status conventions.
- `docs/internals/modal-standard.md`: modal standard update.
- `docs/internals/native-window-surfaces.md`: documents project-settings and macOS no-parent minimize.
- `src-tauri/src/surface_windows.rs`: `project-settings` spec; no parent on macOS.

## Rejected alternatives

None recorded. The browser as native modal was raised and left as an unimplemented idea.

## Non-Goals

- Browser as a native Tauri modal (idea only, not implemented).

## Assumptions

- The explore-only constraint of the original intent ("no editar ni implementar") was superseded by the 2026-11-23 21:46 UTC request ("El usuario acaba de aprobar implementar el cambio mínimo").
- The diff could not be read through git in this run (no shell); per-file reasons were inferred from the file contents, tests, docs and the session summary.
- Root cause of the gap/title defect is recorded as `overflow-clip` plus releasing the native frame owner, per the 22:37 UTC decision.
