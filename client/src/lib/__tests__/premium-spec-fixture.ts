// Client mirror of server/blueprint-spec-fixtures.ts: gate-valid premium specs
// for the Builder test suites (raised floors — see SPEC_DEPTH_FLOORS).
import type { BlueprintM1Spec } from '../blueprint-draft'

export function premiumDescription(opts: { readme?: boolean; subject?: string } = {}): string {
  const subject = opts.subject ?? 'the core workflow'
  return [
    '## Problem Statement',
    `A home cook who opens the product today has no way to complete ${subject} end to end: the flow stops at the first screen, nothing is persisted, and nobody can tell whether the slice works. It matters now because every later Milestone-1 spec is defined as building on this slice.${opts.readme ? ' The repository already contains a README and nothing else.' : ''} A good outcome is a thin, runnable, tested version of ${subject} that a contributor can run from a clean checkout.`,
    '',
    '## Proposed Solution',
    `1. The user opens the entry screen for ${subject} and sees the empty state.`,
    '2. They provide the minimal input and submit it.',
    '3. The system validates, persists and echoes the result on the next screen.',
    '4. Reloading shows the persisted state; invalid input shows an inline error.',
    '',
    '### User experience',
    'One screen with an empty state, a loading indicator while saving, an inline validation error and a success confirmation.',
    '',
    '### Data model',
    '`Entry { id: uuid, createdAt: timestamp, payload: text (1–500 chars), status: "draft" | "saved" }` (planned).',
    '',
    '### Interfaces & contracts',
    '`POST /entries { payload } → 201 { id, status }`; `400 { error: "invalid_payload" }` on validation failure (planned).',
    '',
    '### Planned modules',
    '- `src/features/entries/EntryScreen (planned)` — the screen and its states.',
    '- `src/data/entries-repository (planned)` — persistence behind one interface.',
    '',
    '### Key decisions',
    '- Persist through a repository interface so later slices swap storage without touching UI; rejected: direct calls for speed.',
    '',
    '## Out of Scope',
    '- Social sharing and collaboration — deferred to the "Sharing" milestone because it needs accounts first.',
    '- Advanced personalization — deferred to a later milestone once real usage data exists.',
    '- Offline editing — deferred; the walking skeleton assumes connectivity.',
    '',
    '## Technical Considerations',
    '- **Architecture**: screen → api module → repository; no cross-layer imports.',
    '- **Data & contracts**: the `Entry` shape and the `/entries` routes are frozen for later slices.',
    '- **Failure handling & edge cases**: empty payload, over-long payload and a missing id each produce a distinct error.',
    '- **Testing strategy**: unit — validation rules; integration — repository round trip; e2e — submit, reload, error path.',
    '- **Risks & mitigations**: persistence schema churn — mitigated by the repository interface.',
    '',
    '## Estimated Complexity',
    'Medium — the slice crosses UI, validation and persistence; the main uncertainty is the persistence setup on the chosen stack.',
  ].join('\n')
}

export function premiumCriteria(seed = ''): string[] {
  const s = seed ? ` (${seed})` : ''
  return [
    `Given a clean checkout, when the user completes the primary happy path${s}, then the result is persisted and shown on the next screen.`,
    `When the user submits an empty or over-long payload${s}, then an inline validation error names the rule and nothing is persisted.`,
    `When the user opens the screen with no data${s}, then a deliberate empty state explains what to do first.`,
    `When the page reloads after a successful save${s}, then the persisted state is shown again without re-entry.`,
    `When the persistence layer is unavailable${s}, then the user sees an actionable error and the input is kept for retry.`,
    `Automated unit, integration and end-to-end tests cover the happy path, the validation error and the persistence failure${s}, and pass in CI.`,
  ]
}

export function premiumSpec(index: number, over: Partial<BlueprintM1Spec> = {}): BlueprintM1Spec {
  const scaffold = index === 0
  return {
    kind: scaffold ? 'scaffold' : 'feature',
    title: scaffold ? 'Scaffold the runnable project foundation' : `Deliver workflow slice ${index}`,
    shortSummary: scaffold
      ? 'Turn the README-only repository into an installable, runnable, testable application shell with CI.'
      : `Deliver an independently testable workflow slice ${index} on top of the scaffold.`,
    description: premiumDescription({ readme: scaffold, subject: scaffold ? 'the project foundation' : `workflow slice ${index}` }),
    acceptanceCriteria: premiumCriteria(scaffold ? 'foundation' : `slice ${index}`),
    priority: 'medium',
    labels: ['M1', scaffold ? 'foundation' : 'workflow'],
    ...(index > 0 ? { dependsOnIndex: index - 1 } : {}),
    ...over,
  }
}
