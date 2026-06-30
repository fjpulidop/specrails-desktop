import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'cli/**/*.test.ts', 'mcp-bridge/**/*.test.ts'],
    environment: 'node',
    // Safety net: pin SPECRAILS_REGISTRY_HOME to a throwaway tmp dir so no test
    // can write the relocation registry into the real ~/.specrails.
    setupFiles: ['server/vitest-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['server/**/*.ts', 'cli/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        'server/vitest-setup.ts',
        'server/dist/**',
        'server/index.ts',
        // Real Playwright/CDP implementation of the browser-capture abstractions.
        // Every branch requires a live Chromium (screencast frames, CDP input,
        // DOM eval) which is not exercisable in the node test env; the manager
        // that consumes it (browser-capture-manager.ts) is fully tested through a
        // fake ContextLauncher. See server/browser-playwright.ts header.
        'server/browser-playwright.ts',
        // Process-spawning glue for the Loops engine: wires runAiStep/runShell/
        // runDecider to real AI-CLI + shell spawns. Not exercisable in the node
        // test env (spawns claude/codex/shell); the engine's traversal/decision
        // logic is fully tested against fake executors in loop-run-manager.test.ts.
        'server/loop-executors.ts',
      ],
      // Global: 70% lines/functions (SPEA-380 target); branches excluded from global
      // because CLI has complex runtime code (HTTP/WebSocket/spawn) requiring integration tests
      // Server: 80% per engineering-standards.md §3.2
      thresholds: {
        lines: 70,
        functions: 70,
        statements: 70,
        'server/**': {
          lines: 80,
          functions: 80,
          statements: 80,
          branches: 70,
        },
      },
    },
  },
})
