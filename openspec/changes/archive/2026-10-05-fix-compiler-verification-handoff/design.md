## Context

The generic Implement recipe already passes Core's bounded command diagnostics into the fixer prompt. Core's summary and excerpt selectors currently miss compiler messages beginning with file locations and can prefer a warning-only lint report instead. Candidate mutation and nonzero exits still correctly reject verification.

## Goals / Non-Goals

**Goals:** Prove the real Desktop-to-Core-to-fixer handoff retains meaningful compiler errors under long output and terminates an unchanged correction once.

**Non-Goals:** Change verification validity, exclude generated tracked files from fingerprints, install dependencies, or infer project dependency versions from model prose.

## Decisions

- Correct classification and excerpt selection in Core, the existing owner of subprocess evidence. Desktop consumes the same fields with no schema or production behavior changes.
- Extend the real paired factory harness with a portable Node subprocess emitting generic file-located compiler errors surrounded by lint noise. Assert the structured `failureSummary` in the fixer's actual prompt, the exit code and evidence ID, and terminal failure after a single unchanged correction.
- Keep all candidate and acceptance gates in place. An accurate diagnostic does not make a failing application valid.

## Risks / Trade-offs

- The paired regression requires the companion Core implementation. Validate against its built source, pin the existing paired CI job to that exact companion Core commit and document the companion PR; do not skip the new case. The packaged Core version remains 6.2.1 until a newer version is published and explicitly adopted.
- Summary budgets can omit additional failures. Full evidence remains available through the existing evidence ID; tests enforce bounded output and preservation of representative errors.
