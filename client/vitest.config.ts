import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: {
    __WS_URL__: JSON.stringify('ws://localhost:4200'),
  },
  test: {
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        'src/main.tsx',
        'src/test-setup.ts',
        'src/test-utils.tsx',
        'src/types.ts',
        // Tauri-only component: returns null in non-Tauri (test) environments.
        // Internal sub-components are structurally unreachable in jsdom tests.
        'src/components/TitleBar.tsx',
        // desktop-demo-only build: loaded by demo-entry.tsx into dist-demo/, never
        // compiled into the production client bundle.
        'src/demo-mode/**',
        // Agents section (profiles + Studio + pickers). Heavy Dialog/editor
        // UI backed by real fetch flows; the logic is covered server-side in
        // profile-manager.test.ts / profiles-router.test.ts / rails-store.test.ts.
        // UI component tests are tracked as follow-up (add-agents-profiles
        // tasks 17.7–17.9).
        'src/components/agents/**',
        'src/pages/AgentsPage.tsx',
        // Premium terminal panel additions — feature delivered in
        // add-premium-terminal-panel. The shell-quote pure function and the
        // marks store have direct unit tests; the rest are Tauri-only paths
        // (drag-drop, opener, notifications, save-scrollback, image addon
        // wiring) or structurally unreachable in jsdom (xterm decorations,
        // canvas resizer, DragDropEvent wiring). Tracked as a follow-up to
        // backfill behavioural tests once a Tauri test harness lands.
        'src/lib/tauri-shell.ts',
        'src/lib/tauri-drag-drop.ts',
        'src/lib/save-scrollback.ts',
        'src/lib/terminal-notifications.ts',
        'src/components/terminal/PromptGutter.tsx',
        'src/components/terminal/CommandTimingBadge.tsx',
        'src/components/terminal/TerminalContextMenu.tsx',
        'src/components/terminal/TerminalSearchOverlay.tsx',
        'src/components/terminal/ShortcutContextMenu.tsx',
        'src/components/settings/TerminalSettingsSection.tsx',
        // monaco-editor loaded dynamically; not testable in jsdom
        'src/lib/monaco-setup.ts',
        'src/components/code-explorer/CodeViewerMonaco.tsx',
        // Browser-capture ("Add Spec from browser"): the screencast canvas + WS
        // hook and the large overlay rely on WebSocket binary frames,
        // createImageBitmap, canvas 2d drawing and pointer-drag — none of which
        // run under jsdom. The pure geometry/REST/flag logic lives in
        // lib/browser-capture.ts and CapturedDomPanel, both unit-tested.
        'src/components/browser-capture/useBrowserCaptureSession.ts',
        'src/components/browser-capture/BrowserCaptureModal.tsx',
        // Read-only embedded-browser modal for opening spec-description links —
        // same canvas/WS/pointer machinery as BrowserCaptureModal (not jsdom-able).
        'src/components/browser-capture/WebViewModal.tsx',
        // Annotation markup editor: canvas flatten + pointer-drag drawing; the
        // model/geometry/undo-reducer live in lib/annotations.ts and are tested.
        'src/components/browser-capture/AnnotationEditor.tsx',
        // Loop builder canvas (the Loops feature): renders @xyflow/react (React
        // Flow) which needs getBoundingClientRect / ResizeObserver / pointer +
        // viewport transforms unavailable under jsdom. The pure graph⇄react-flow
        // conversion lives in lib/loop-graph-rf.ts and is unit-tested; the engine
        // logic is tested server-side (loop-run-manager.test.ts).
        'src/pages/LoopBuilderPage.tsx',
      ],
      thresholds: {
        lines: 80,
        // Attachment/AI-edit components add contenteditable and imperative-handle
        // callbacks (DnD, ResizeObserver, xterm) that are structurally unreachable
        // in jsdom unit tests. Threshold set to 70 to reflect this constraint.
        functions: 70,
        statements: 80,
      },
    },
  },
})
