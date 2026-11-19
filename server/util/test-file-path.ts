/**
 * Test-file classification shared by the review packet and the PR body, across
 * the ecosystems a delivery can touch. A JavaScript-only rule reported Java,
 * Go, Python, Rust, Swift and Dart deliveries as "no test files changed" (and
 * raised the matching watch-out) even when their tests were the bulk of the diff.
 *
 * A path is a test when its FILE has a test shape (`x.test.ts`, `x.spec.js`,
 * `test_x.py`, `x_test.go`, `x_spec.rb`, `MoneyTest.java`, `HabitTests.swift`,
 * `x.bats`…) or it lives under a conventional test directory (`__tests__/`,
 * `test/`, `tests/`, `spec/`, `Tests/`, `src/test/`, `integration_test/`…).
 * OpenSpec artifacts (`openspec/specs/<cap>/spec.md`) and Markdown are never
 * tests, whatever their directory is called.
 */
const TEST_FILE_SHAPE = /(?:^|\/)(?:test_[^/]+\.(?:py|sh)|[^/]+(?:\.(?:test|spec)\.[a-z0-9]+|_test\.(?:go|py|rs|rb|exs?|dart|ts|js|c|cc|cpp|sh)|_spec\.rb|Tests?\.(?:java|kt|kts|cs|swift|scala|php|m)|\.bats))$/i
const TEST_DIRECTORY = /(?:^|\/)(?:__tests__|tests?|specs?|Tests|androidTest|integration_test|test_?suite)\//

export function isTestFilePath(filePath: string): boolean {
  const p = filePath.replace(/\\/g, '/')
  if (/(?:^|\/)openspec\//.test(p) || /\.(?:md|mdx|markdown)$/i.test(p)) return false
  return TEST_FILE_SHAPE.test(p) || TEST_DIRECTORY.test(p)
}

/** Paths that document or plan the change rather than implement it: OpenSpec artifacts and Markdown. */
export function isDocumentationPath(filePath: string): boolean {
  const p = filePath.replace(/\\/g, '/')
  return /(?:^|\/)openspec\//.test(p) || /\.(?:md|mdx|markdown|txt|rst)$/i.test(p)
}
