## 1. Rich blueprint contract

- [x] 1.1 Extend server and client blueprint types/coercers with `specsComplete` plus detailed-spec `kind`, `shortSummary`, structured `acceptanceCriteria`, and validated `priority`, preserving legacy defaults; add parser round-trip tests
- [x] 1.2 Add a pure shared server quality validator for completion, 5–10 M1 set size, canonical section order/content including ≥2 Out-of-Scope/Technical bullets, M1 scaffold, summary, 4–10 criteria, priority, unique titles, labels, and backward-only dependency indices; cover every rejection and a valid batch

## 2. Generation quality

- [x] 2.1 Rewrite the day-0 Builder instructions/system prompt around approval-before-generation, one-response/one-complete-snapshot M1 generation with no partial waves, and the canonical normal-spec contract, phase-appropriate grounding, 4–10 criteria, domain labels, priority, completion, and dependency rules; pin it with prompt-contract tests
- [x] 2.2 Strengthen the grounded M2+ milestone prompt with the same payload/quality and one-response complete-target-set contract plus verified code-path, edge-case, and testing requirements, and deliver it equivalently to Claude/Codex/Gemini; add prompt tests

## 3. Atomic persistence

- [x] 3.1 Gate day-0 project commit on the shared validator before mutation, fold criteria with the normal helper, and persist generated priority/short summary; update orchestrator/router tests
- [x] 3.2 Gate M2+ batch commit atomically on the same validator, persist criteria/priority/short summary parity, and cover invalid-batch no-write plus rich-ticket success

## 4. Review UI

- [x] 4.1 Render short summary, priority, criteria count, and the complete acceptance criteria in Builder cards/modal for M1 and M2+; add component tests
- [x] 4.2 Surface quality-validation detail from both commit flows so a stale or malformed generated draft is actionable rather than a generic failure

## 5. Documentation and gates

- [x] 5.1 Update Project Builder internal documentation and the parent change artifacts to make the canonical rich-spec contract authoritative
- [x] 5.2 Run focused server/client suites, typecheck, OpenSpec strict validation, and the full CI gate; fix regressions
