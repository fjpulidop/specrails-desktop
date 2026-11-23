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

// The slices of the todo CLI the blueprint describes (a coherent product reads as one to a real agent). The person's
// messages pick them: a Builder that honours "also let me edit" or "filter in Milestone 1" revises, as a real one would.
export const FEATURES = Object.freeze([
  { slice: 'add a todo', words: /\b(add|adds|adding|create|new (todo|task))\b/i },
  { slice: 'list the todos', words: /\b(list|lists|listing|show|view)\b/i },
  { slice: 'mark a todo done', words: /\b(done|complete|completes|completed|completing|finish|mark|toggle|check off)\b/i },
  { slice: 'edit a todo', words: /\b(edit|edits|editing|rename|update a (todo|task))\b/i },
  { slice: 'delete a todo', words: /\b(delete|deletes|deleting|remove|removes)\b/i },
  { slice: 'filter the todos by status', words: /\b(filter|filters|filtering)\b/i },
  { slice: 'set a due date', words: /\bdue[- ]dates?\b/i },
  { slice: 'set a priority', words: /\bpriorit(y|ies|ize)\b/i },
  { slice: 'search the todos', words: /\bsearch\b/i },
])
const DEFAULT_SLICES = ['add a todo', 'list the todos', 'mark a todo done', 'delete a todo']
const LATER = [{ slice: 'set a due date', title: 'Due dates' }, { slice: 'filter the todos by status', title: 'Filter by status' }]

/**
 * The Milestone-1 slices for a Builder turn (pure): what this message asks for, added to what the conversation
 * already had (`previous`, in the feature order), padded with the core flow to the gate's minimum of four.
 */
export function slicesFor(message, previous = []) {
  const named = FEATURES.filter(f => f.words.test(String(message ?? ''))).map(f => f.slice)
  const wanted = new Set([...previous, ...named])
  // The Builder's gate wants 5–10 Milestone-1 specs (the scaffold plus 4–9 slices): pad with the core flow.
  for (const slice of DEFAULT_SLICES) if (wanted.size < 4) wanted.add(slice)
  return FEATURES.map(f => f.slice).filter(s => wanted.has(s))
}

let SLICES = DEFAULT_SLICES

/** The platforms the scripted Builder can plan; the person's words pick one (the last one named wins). */
export const PLATFORMS = Object.freeze({
  cli: { words: /\b(cli|command[- ]line|terminal|node(\.js)? (cli|script))\b/i, product: { name: 'Todo CLI', pitch: 'A minimal command-line todo list.', audience: 'Developers who live in the terminal' },
    platform: 'CLI (Node.js)', stack: { language: 'JavaScript', framework: 'Node.js', db: 'JSON file' }, where: 'from the command line', what: 'CLI' },
  web: { words: /\b(web ?app|browser|single[- ]page|spa|html|localstorage|website|web page|react|vue|svelte)\b/i, product: { name: 'Todo Web', pitch: 'A minimal todo list in the browser.', audience: 'Anyone who wants a quick list in a browser tab' },
    platform: 'Web (static HTML, CSS and JavaScript)', stack: { language: 'JavaScript', framework: 'none (vanilla)', db: 'browser localStorage' }, where: 'in the browser', what: 'web app' },
})

/** The platform for a Builder turn (pure): the one this message names, else the conversation's, else the CLI. */
export function platformFor(message, previous = null) {
  const text = String(message ?? '')
  let best = null
  let at = -1
  for (const [id, p] of Object.entries(PLATFORMS)) {
    for (const m of text.matchAll(new RegExp(p.words.source, 'gi'))) if (m.index > at) { at = m.index; best = id }
  }
  // "not a CLI" / "no Node" names the CLI only to rule it out.
  if (best === 'cli' && /\b(not|no|never|instead of)\b[^.]{0,20}\b(cli|command[- ]line|node)/i.test(text) && PLATFORMS.web.words.test(text)) best = 'web'
  return best ?? previous ?? 'cli'
}

let PLATFORM = PLATFORMS.cli

function premiumSpec(index, over = {}) {
  const scaffold = index === 0
  const slice = SLICES[index - 1] ?? `workflow slice ${index}`
  return {
    kind: scaffold ? 'scaffold' : 'feature',
    title: scaffold ? 'Scaffold the runnable project foundation' : `Let the user ${slice}`,
    shortSummary: scaffold
      ? 'Turn the README-only repository into an installable, runnable, testable application shell with CI.'
      : `Let the user ${slice} ${PLATFORM.where}, independently testable on top of the scaffold.`,
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
export function builderReply({ marker = null, slices = DEFAULT_SLICES, platform = 'cli' } = {}) {
  SLICES = slices
  PLATFORM = PLATFORMS[platform] ?? PLATFORMS.cli
  const specs = Array.from({ length: slices.length + 1 }, (_, i) => premiumSpec(i))
  if (marker) specs[0] = { ...specs[0], description: `${specs[0].description}\n\n${marker}` }
  const blueprint = {
    blueprintVersion: 1,
    product: PLATFORM.product,
    coreFlow: `${slices.map(s => s.replace(/^./, c => c.toUpperCase())).join(', ')}.`,
    platform: PLATFORM.platform,
    stack: PLATFORM.stack,
    assumptions: ['Single user, local machine'],
    milestones: [
      { id: 'M1', title: 'Walking skeleton', goal: `A runnable, tested ${PLATFORM.what} with the core flow.`, status: 'planned', plannedSpecs: specs.map(s => s.title) },
      { id: 'M2', title: 'Polish', goal: 'What comes after the core flow.', status: 'planned', plannedSpecs: LATER.filter(l => !slices.includes(l.slice)).map(l => l.title).concat(['Export the list']).slice(0, 2) },
    ],
    specsComplete: true,
    m1Specs: specs,
  }
  return `Here is the complete blueprint for Milestone 1.\n\n\`\`\`blueprint-draft\n${JSON.stringify(blueprint, null, 2)}\n\`\`\`\n`
}
