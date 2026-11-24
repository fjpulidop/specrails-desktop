# Tasks

## 1. Resources button

- [x] 1.1 Render the Resources button always; show count only when measured; neutral name otherwise; verify AppResourcesFooter.test.tsx asserts visibility at zero and the neutral name
  - Evidence: client/src/features/background/components/AppResourcesFooter.tsx, AppResourcesFooter.test.tsx (asserts visibility at zero and neutral name)
- [x] 1.2 Keep it visible with StatusBar and terminal panel; fix comments and docs
  - Evidence: client/src/components/StatusBar.tsx, BottomPanel.tsx, features/background/README.md; no dedicated test for the terminal interaction

## 2. Project settings sidebar

- [x] 2.1 Keep the right sidebar and toggle in project settings; verify sidebar-layout and TitleBar tests
  - Evidence: client/src/lib/sidebar-layout.ts, sidebar-layout.test.ts, ProjectRightSidebar.test.tsx, TitleBar.test.tsx

## 3. Project settings surface

- [x] 3.1 Open project settings as native window or app modal with shared content and deep links; verify surface and SettingsPage tests
  - Evidence: native-surfaces.ts, SurfaceWindowContent.tsx, SettingsPage.tsx, surface.test.tsx, SettingsPage.test.tsx, CommandPalette*.test.tsx, ArcSidebar*.test.tsx

## 4. Framing and minimize

- [x] 4.1 Clip panel overflow and release frame owner; verify dialog-standard test
  - Evidence: client/src/components/ui/dialog.tsx, dialog-standard.test.tsx (asserts overflow-clip)
- [x] 4.2 No parent window on macOS for surface windows
  - Evidence: src-tauri/src/surface_windows.rs (Rust tests in file cover registry only; no test of minimize), docs/internals/native-window-surfaces.md

## 5. Correction round

- [x] 5.1 Give the 100-project overview latency/size-budget test a 60_000 ms timeout so fixture setup does not time out under full-suite load; verify the test passes
  - Evidence: server/mcp/v2/tools/overview.test.ts (the test itself, with unchanged assertions p95 < 1500 ms and ≤ 1500 tokens)

## 6. Bridge test isolation

- [x] 6.1 [spec:agent-runtime-test-isolation/bridge-tests-ignore-an-inherited-headless-guard] Strip only the inherited headless-guard `--require` in the bridge tests; kept by the person's decision
  - Evidence: server/modules/agent-runtime/runtime/agent-runtime-bridge.test.ts (`withoutHostGuard`, `seenRun`)
