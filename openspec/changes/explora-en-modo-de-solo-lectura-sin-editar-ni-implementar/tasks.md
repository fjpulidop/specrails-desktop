# Tasks

## 1. Resources button

- [x] 1.1 Render the Resources button always; show count only when measured; neutral name otherwise
  - Evidence: client/src/features/background/components/AppResourcesFooter.tsx, AppResourcesFooter.test.tsx (asserts visibility at zero and neutral name)
- [x] 1.2 Keep it visible with StatusBar and terminal panel; fix comments and docs
  - Evidence: client/src/components/StatusBar.tsx, BottomPanel.tsx, features/background/README.md; no dedicated test for the terminal interaction

## 2. Project settings sidebar

- [x] 2.1 Keep the right sidebar and toggle in project settings
  - Evidence: client/src/lib/sidebar-layout.ts, sidebar-layout.test.ts, ProjectRightSidebar.test.tsx, TitleBar.test.tsx

## 3. Project settings surface

- [x] 3.1 Open project settings as native window or app modal with shared content and deep links
  - Evidence: native-surfaces.ts, SurfaceWindowContent.tsx, SettingsPage.tsx, surface.test.tsx, SettingsPage.test.tsx, CommandPalette*.test.tsx, ArcSidebar*.test.tsx

## 4. Framing and minimize

- [x] 4.1 Clip panel overflow and release frame owner
  - Evidence: client/src/components/ui/dialog.tsx, dialog-standard.test.tsx (asserts overflow-clip)
- [x] 4.2 No parent window on macOS for surface windows
  - Evidence: src-tauri/src/surface_windows.rs (Rust tests in file cover registry only; no test of minimize), docs/internals/native-window-surfaces.md
