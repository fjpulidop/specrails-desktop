// Builder turns of the scripted engine: a full, gate-valid ```blueprint-draft
// snapshot (5 Milestone-1 specs) so the Project Builder can commit a project
// without a model. The spec text mirrors the server's premium fixtures
// (server/modules/builder/runtime/__fixtures__/blueprint-spec-fixtures.ts), which
// pass analyzeBuilderSpecBatch; keep the two in step.

/** Whether a prompt (or system prompt) is a Project Builder turn (pure). */
export const isBuilderTurn = text => /blueprint-draft/.test(String(text ?? ''))

function premiumDescription(opts = {}) {
  const subject = opts.subject ?? 'the core workflow'
  return [
    '## Problem Statement',
    `A developer who opens the product today has no way to complete ${subject} end to end: the flow stops at the first screen, nothing is persisted, and nobody can tell whether the slice works. It matters now because every later Milestone-1 spec is defined as building on this slice.${opts.readme ? ' The repository already contains a README and nothing else.' : ''} A good outcome is a thin, runnable, tested version of ${subject} that a contributor can run from a clean checkout and a reviewer can exercise without guidance.`,
    '',
    '## Proposed Solution',
    `1. The user opens the entry screen for ${subject} and sees the empty state.`,
    '2. They provide the minimal input and submit it.',
    '3. The system validates, persists and echoes the result on the next screen.',
    '4. Reloading shows the persisted state; invalid input shows an inline error.',
    '',
    '### User experience',
    'One screen with an empty state, a loading indicator while saving, an inline validation error and a success confirmation; the last successful input is remembered between visits.',
    '',
    '### Data model',
    '`Entry { id: uuid, createdAt: timestamp, payload: text (1–500 chars), status: "draft" | "saved" }` (planned).',
    '',
    '### Interfaces & contracts',
    '`POST /entries { payload } → 201 { id, status }`; `400 { error: "invalid_payload" }` on validation failure; `GET /entries/:id → 200 | 404` (planned).',
    '',
    '### Planned modules',
    '- `src/features/entries/EntryScreen (planned)` — the screen and its states.',
    '- `src/features/entries/entries-api (planned)` — request/response handling and validation.',
    '- `src/data/entries-repository (planned)` — persistence behind one interface.',
    '',
    '### Key decisions',
    '- Persist through a repository interface instead of calling the database from the screen, so later slices swap storage without touching UI; rejected: direct calls for speed.',
    '- Validate on both client and server; rejected: server-only validation because the empty-state UX needs immediate feedback.',
    '',
    '## Out of Scope',
    '- Social sharing and collaboration — deferred to the "Sharing" milestone because it needs accounts first.',
    '- Advanced personalization and recommendations — deferred to a later milestone once real usage data exists.',
    '- Offline editing — deferred; the walking skeleton assumes connectivity.',
    '',
    '## Technical Considerations',
    '- **Architecture**: screen → api module → repository; no cross-layer imports.',
    '- **Data & contracts**: the `Entry` shape and the `/entries` routes are frozen for later slices.',
    '- **Failure handling & edge cases**: empty payload, over-long payload and a missing id each produce a distinct, tested error.',
    '- **Security & privacy**: input is length-limited and escaped before rendering; no personal data beyond the payload.',
    '- **Testing strategy**: unit — validation rules; integration — repository round trip; e2e — submit, reload, error path.',
    '- **Dependencies**: builds on the scaffold spec; nothing else.',
    '- **Risks & mitigations**: persistence schema churn — mitigated by the repository interface.',
    '',
    '## Estimated Complexity',
    'Medium — the slice crosses UI, validation and persistence; the main uncertainty is the persistence setup on the chosen stack.',
  ].join('\n')
}

function premiumCriteria(seed = '') {
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

// The four slices of the todo CLI the blueprint describes (a coherent product reads as one to a real agent).
const SLICES = ['add a todo', 'list the todos', 'mark a todo done', 'delete a todo']

function premiumSpec(index, over = {}) {
  const scaffold = index === 0
  const slice = SLICES[index - 1] ?? `workflow slice ${index}`
  return {
    kind: scaffold ? 'scaffold' : 'feature',
    title: scaffold ? 'Scaffold the runnable project foundation' : `Let the user ${slice}`,
    shortSummary: scaffold
      ? 'Turn the README-only repository into an installable, runnable, testable application shell with CI.'
      : `Let the user ${slice} from the command line, independently testable on top of the scaffold.`,
    description: premiumDescription({ readme: scaffold, subject: scaffold ? 'the project foundation' : `the "${slice}" flow` }),
    acceptanceCriteria: premiumCriteria(scaffold ? 'foundation' : slice),
    priority: 'medium',
    labels: ['M1', scaffold ? 'foundation' : 'workflow'],
    ...(index > 0 ? { dependsOnIndex: index - 1 } : {}),
    ...over,
  }
}


/**
 * The Builder's reply: a short sentence and the snapshot. `marker` (an
 * `[eval-engine:<mode>]` the person's message carried) rides into the first
 * spec, so the milestone chain's first run behaves that way (pure).
 */
export function builderReply({ marker = null } = {}) {
  const specs = Array.from({ length: 5 }, (_, i) => premiumSpec(i))
  if (marker) specs[0] = { ...specs[0], description: `${specs[0].description}\n\n${marker}` }
  const blueprint = {
    blueprintVersion: 1,
    product: { name: 'Todo CLI', pitch: 'A minimal command-line todo list.', audience: 'Developers who live in the terminal' },
    coreFlow: 'Add a todo, list todos, mark one done, delete one.',
    platform: 'CLI (Node.js)',
    stack: { language: 'JavaScript', framework: 'Node.js', db: 'JSON file' },
    assumptions: ['Single user, local machine'],
    milestones: [
      { id: 'M1', title: 'Walking skeleton', goal: 'A runnable, tested CLI with the core flow.', status: 'planned', plannedSpecs: specs.map(s => s.title) },
      { id: 'M2', title: 'Polish', goal: 'Due dates and filters.', status: 'planned', plannedSpecs: ['Due dates', 'Filter by status'] },
    ],
    specsComplete: true,
    m1Specs: specs,
  }
  return `Here is the complete blueprint for Milestone 1.\n\n\`\`\`blueprint-draft\n${JSON.stringify(blueprint, null, 2)}\n\`\`\`\n`
}
