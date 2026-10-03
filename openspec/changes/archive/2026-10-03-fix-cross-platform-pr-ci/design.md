## Context

Core diagnostics tests spawn real Node processes. Immediate process.exit can truncate asynchronous pipe writes on Linux; a source dump embedded in node -e exceeds Windows argument limits. Desktop CI pins Core c170a1bd, while new factory tests require later fixes. MCP launches and addendum lifecycle tests also fail and need focused reproduction.

## Goals / Non-Goals

Goals: deterministic cross-platform evidence fixtures, correct admitted launch behavior, and real paired execution against the exact Core PR commit. Non-goals: changing coverage thresholds, bypassing verification, or altering user projects and jobs.

## Decisions

- Emit large synthetic logs through synchronous writes or let Node flush with process.exitCode. Store large fixtures in files so argument size stays bounded; retain negative outcomes and full evidence assertions.
- Inspect the actual MCP error response and current scope contract before changing tests or production. Tests must provide authentic repository and delivery context.
- Pin the paired CI to the corrected Core commit rather than an unversioned branch. Execute the same real bridge/CLI suites locally before pushing.
- Fix any further deterministic failures exposed by the full CI; document platform-only limitations until remote checks confirm success.

## Risks / Trade-offs

[Tests may be outdated or expose a real admission bug] → Verify response details and current scope semantics, then retain negative tests.

[Local macOS cannot confirm Windows behavior] → Keep portable fixtures and wait for the new GitHub Windows checks.

[The pairing references an unmerged commit] → Commit and push Core first so the immutable revision exists before Desktop CI starts.
