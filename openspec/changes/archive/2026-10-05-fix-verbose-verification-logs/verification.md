# Verification

The reported successful run contained a very large Jest log. The supplied partial transcript includes 4,623 verification lines (671,586 bytes); projecting those same lines with the built code produces 32 display lines (5,741 bytes), with both original test/suite totals and the omission notice present. The private transcript is not checked into the repository. This measurement covers the supplied fragment, not the reported 77,018-line complete run.

## Regressions and validation

- Bridge: 54/54 tests pass. New regressions reproduced failure before implementation, including a real child CLI emitting 77,018 lines, generic output with late errors, repeated and interleaved commands, legacy scope, repeated assertion input and long prefixes. All raw callbacks remain present; readable output is bounded below 16 KiB for the large synthetic case.
- Frontend focused buffer/Page/Modal suites: 93/93 pass. Tests cover 22k-event replay/live floods, preserved lifecycle structure, copyable omission notice and delayed attempt attribution.
- Expanded client jobs and loops: 619/619 tests pass across 46 files.
- Expanded server agent-runtime, loops and architecture: 951 tests pass; 62 optional paired tests skipped without their environment. The first sandboxed run could not open local HTTP test sockets (91 failures across four files); rerunning those four suites with local socket access passes all 149 tests. No source fix was required for the sandbox restriction.
- Actual Core pairing: two selected factory tests pass, covering failed compiler handoff and unchanged-correction termination. The other 23 cases were deliberately filtered in this focused run.
- Typecheck, architecture audit, production build and installed-package smoke check pass.
- Core contract 5.1 compatibility passes against the bundled Core 6.2.1. The initial unconfigured command skipped when no global package was selected; the explicit bundled check performed the actual validation.
- OpenSpec strict validation and diff checks pass. Source map and reviewed dependency manifest include the two private helpers.

## Preserved semantics and limits

Command execution, candidate validity, correction policy, original runtime events and database retention are unchanged. Original attempt IDs reach persisted and live readable logs. Legacy output without IDs keeps its existing fallback. The UI caps ordinary display events while retaining lifecycle markers and gives an always-visible and copyable notice when output has been omitted.

Detailed output remains accessible through existing verification evidence, subject to Core's existing per-stream size and retention limits. This patch does not rewrite already persisted historical logs or promise unlimited evidence storage.
