// ─── The ONE premium spec contract (premium-milestone-progress D6) ─────────
//
// Every AI author of detailed specs derives its spec-content instructions
// from here: the day-0 Project Builder (blueprint-operator-prompt.ts), M2+
// milestone generation (chat-manager.ts _buildMilestoneSystemPrompt) and the
// agent's super-spec mode (agent-operator-prompt.ts). The DEPTH bar is shared;
// only the grounding rule differs per author (`day0` = everything introduced
// is labelled *planned*, nothing existing may be claimed; `verified` = only
// paths/identifiers actually read may be named).
//
// BYTE-STABILITY: every export is a static string / object (no timestamps,
// no live data) so provider prompt caching keeps working across turns.

import type { BlueprintM1Spec } from './blueprint-types'

/** Deterministic floors the quality gate enforces (server + client mirror). */
export const SPEC_DEPTH_FLOORS = {
  problemMinChars: 200,
  solutionMinChars: 500,
  outOfScopeMinBullets: 3,
  technicalMinBullets: 5,
  criteriaMin: 6,
  criteriaMax: 10,
  criterionMinChars: 20,
} as const

export type SpecGroundingMode = 'day0' | 'verified'

const GROUNDING: Record<SpecGroundingMode, { intro: string; modules: string; technical: string }> = {
  day0: {
    intro: 'No repository exists yet. Ground every technical detail in the selected stack, the planned components, the intended contracts and data shapes, the known risks and the dependencies between specs.',
    modules: 'name the modules, components, routes, tables and files this spec will CREATE, each explicitly marked as planned (for example "src/features/pantry/PantryList.tsx (planned)") with one line of responsibility — never claim that any of them already exists',
    technical: 'anchor bullets on the planned artifacts above and on the selected stack; never invent or imply an existing repository path, module, function, migration or test file',
  },
  verified: {
    intro: 'Ground every technical detail in the real codebase you read during this conversation, never in plausible-sounding memory.',
    modules: 'name the REAL modules, components, routes, tables and files the change builds on or extends — only ones you actually opened — plus the new ones it will create, each marked as planned',
    technical: 'anchor bullets on EXACT file paths and identifiers you verified; if you did not read it, do not name it',
  },
}

/**
 * The full contract, as a markdown section body (no leading heading) — for
 * instruction files and prompt bodies.
 */
export function premiumSpecContract(mode: SpecGroundingMode): string {
  const g = GROUNDING[mode]
  const f = SPEC_DEPTH_FLOORS
  return `${g.intro} Write every spec as if a senior engineer who has never spoken to the user must implement it unattended and a non-technical reviewer must understand what they are approving: no section is a restated title, every section carries decisions.

Every detailed spec MUST satisfy all of these rules:

- \`kind\` is exactly \`scaffold\`, \`feature\`, or \`verification\`.
- \`title\` is concise, imperative, unique in the batch, and in English.
- \`shortSummary\` is one useful English sentence, no more than 240 characters.
- \`description\` is English markdown with exactly these five \`##\` headings, once each and in this order (sub-blocks use \`###\`, never \`##\`):
  1. \`## Problem Statement\` — 3–5 sentences (at least ${f.problemMinChars} characters): the persona, the moment the pain happens, what hurts today and why, why this belongs in THIS milestone, and what a good outcome looks like. A narrative, not a restated title.
  2. \`## Proposed Solution\` — at least ${f.solutionMinChars} characters. Open with a numbered user journey (what the user does and sees, step by step), then these \`###\` sub-blocks:
     - \`### User experience\` — the screens/commands involved and their states: empty, loading, error, success; copy tone; what is remembered between visits.
     - \`### Data model\` — the entities with their fields, types, constraints and relationships (as planned).
     - \`### Interfaces & contracts\` — routes/commands/events with request and response shapes, validation rules and error responses.
     - \`### Planned modules\` — ${g.modules}.
     - \`### Key decisions\` — 2–3 decisions with the alternative considered and why it was rejected.
  3. \`## Out of Scope\` — at least ${f.outOfScopeMinBullets} bullets; each names what is deferred, why, and where it lands (a later spec or milestone by title).
  4. \`## Technical Considerations\` — at least ${f.technicalMinBullets} labelled bullets chosen from: **Architecture**, **Data & contracts**, **Failure handling & edge cases**, **Security & privacy**, **Performance & limits**, **Observability**, **Testing strategy** (unit / integration / end-to-end with named scenarios), **Dependencies** (earlier specs by title), **Risks & mitigations**; ${g.technical}.
  5. \`## Estimated Complexity\` — Low, Medium, High, or Very High, then 1–2 sentences on what drives the estimate and the main uncertainty.
- Do NOT put an \`## Acceptance Criteria\` heading in \`description\`. Criteria live only in the separate \`acceptanceCriteria\` array; the app folds them into the ticket deterministically at commit time.
- \`acceptanceCriteria\` contains ${f.criteriaMin}–${f.criteriaMax} independent, testable outcomes (each at least ${f.criterionMinChars} characters), written as observable behaviour — "Given … when … then …" or "When X, the system Y" — never implementation steps. Across the set cover: the happy path, at least one failure or edge case (invalid input, empty state, permission denied, offline, timeout), at least one automated verification (the unit/integration/e2e test that proves it), and for user-facing specs an empty-state or accessibility outcome.
- \`priority\` is exactly \`low\`, \`medium\`, \`high\`, or \`critical\` and reflects delivery urgency/risk rather than implementation complexity.
- \`labels\` includes the milestone label plus at least one concise domain label such as \`frontend\`, \`api\`, \`data\`, \`auth\`, \`testing\`, or \`infra\`.`
}

/** One-paragraph form for \`--system-prompt\` channels (same rules, no markdown). */
export function premiumSpecContractCompact(mode: SpecGroundingMode): string {
  const g = GROUNDING[mode]
  const f = SPEC_DEPTH_FLOORS
  return `Spec depth bar (premium): ${g.intro} Each spec has kind (scaffold|feature|verification), a unique imperative English title, a one-sentence shortSummary <=240 characters, and a description with exactly these ## headings once and in order: ## Problem Statement (3-5 sentences, >=${f.problemMinChars} chars: persona, trigger, pain, why this milestone, what good looks like), ## Proposed Solution (>=${f.solutionMinChars} chars: a numbered user journey, then ### User experience with empty/loading/error/success states, ### Data model with fields and types, ### Interfaces & contracts with request/response shapes and errors, ### Planned modules — ${g.modules} — and ### Key decisions with the rejected alternative), ## Out of Scope (>=${f.outOfScopeMinBullets} bullets: what, why deferred, where it lands), ## Technical Considerations (>=${f.technicalMinBullets} labelled bullets from Architecture, Data & contracts, Failure handling & edge cases, Security & privacy, Performance & limits, Observability, Testing strategy with named scenarios, Dependencies by spec title, Risks & mitigations; ${g.technical}), ## Estimated Complexity (level plus 1-2 sentences and the main uncertainty). Never an ## Acceptance Criteria section in description. A separate acceptanceCriteria array of ${f.criteriaMin}-${f.criteriaMax} observable outcomes (>=${f.criterionMinChars} chars each, Given/When/Then style) covering the happy path, at least one failure/edge case, at least one automated verification and an empty-state/accessibility outcome for user-facing specs. priority low|medium|high|critical by urgency/risk; labels include the milestone label plus a domain label.`
}

/**
 * A complete premium example (the mandatory M1 scaffold) — rendered into the
 * Builder prompt so the model mirrors the DEPTH, not just the shape.
 */
export const PREMIUM_SCAFFOLD_EXAMPLE: BlueprintM1Spec = {
  kind: 'scaffold',
  title: 'Scaffold the runnable project foundation',
  shortSummary: 'Turn the README-only repository into an installable, runnable, testable application shell with CI, so every later slice lands on a verified foundation.',
  description: [
    '## Problem Statement',
    'A contributor who clones the repository today finds a README and nothing else: there is no dependency manifest, no command that starts the app, no test to prove anything works and no CI to catch a broken change. Every Milestone-1 slice would otherwise begin by improvising its own setup, producing three incompatible foundations by week one. The walking skeleton needs this first because each later spec is defined as "runs on top of the scaffold". A good outcome is a clean checkout that installs, starts, tests and passes CI with documented commands, with zero product behaviour beyond a visible placeholder.',
    '',
    '## Proposed Solution',
    '1. The contributor runs the documented install command and gets a reproducible dependency tree.',
    '2. They run the development command and see the placeholder home screen respond on the documented port.',
    '3. They run the test command and one smoke test passes.',
    '4. They open a pull request and CI runs the same install, lint, build and test steps.',
    '',
    '### User experience',
    'A single placeholder route/screen showing the product name and a short "foundation ready" message; no other UI. States: success (page renders), error (the process exits with a clear message when the port is taken or a dependency is missing). Nothing is remembered between visits.',
    '',
    '### Data model',
    'None yet. The persistence layer is initialised (connection/config only) so later specs add entities without re-scaffolding.',
    '',
    '### Interfaces & contracts',
    '`GET /health` → `{ "status": "ok", "version": "<package version>" }` (200). Development, build and test commands documented in the README with their exit-code semantics.',
    '',
    '### Planned modules',
    '- `package manifest + lockfile (planned)` — pinned runtime and dependency versions.',
    '- `src/app entry (planned)` — process bootstrap, port/config loading, the placeholder route.',
    '- `src/config (planned)` — typed environment loading with defaults.',
    '- `tests/smoke (planned)` — one end-to-end smoke test hitting `/health`.',
    '- `CI workflow (planned)` — install → lint → build → test on every push and pull request.',
    '',
    '### Key decisions',
    '- Keep the placeholder minimal instead of seeding a real feature: a feature here would blur the boundary later specs build on. Rejected: scaffolding the first product screen now.',
    '- Pin exact dependency versions from day one; floating ranges were rejected because the first CI break would be a dependency drift, not a product bug.',
    '',
    '## Out of Scope',
    '- Any product feature beyond the placeholder — every slice of the core flow lands in the later Milestone-1 specs.',
    '- Production deployment, hosting and environment provisioning — deferred to a later milestone once the skeleton runs end to end.',
    '- Authentication, authorization and user accounts — a dedicated Milestone-1 or Milestone-2 spec owns them.',
    '',
    '## Technical Considerations',
    '- **Architecture**: one process, one entry module, configuration read once at boot; later specs add modules under the planned layout rather than reshaping it.',
    '- **Data & contracts**: `/health` is the only contract; its response shape is frozen so CI and later monitoring can rely on it.',
    '- **Failure handling & edge cases**: a missing runtime or an occupied port fails fast with an actionable message; the smoke test fails when `/health` is not 200.',
    '- **Security & privacy**: no secrets committed; `.env.example` documents variables; the health endpoint exposes no internal detail beyond the version.',
    '- **Performance & limits**: cold start under a few seconds on a laptop; no performance work beyond that.',
    '- **Observability**: structured startup log line with port and version; CI logs are the audit trail.',
    '- **Testing strategy**: unit — config loading with and without overrides; e2e — the smoke test starts the app and asserts `/health`; CI runs both on every change.',
    '- **Dependencies**: none (first spec); every later Milestone-1 spec depends on this one.',
    '- **Risks & mitigations**: toolchain drift between contributors — mitigated by the pinned lockfile and CI running from a clean checkout.',
    '',
    '## Estimated Complexity',
    'Medium — the foundation must align local development, automated tests and CI without implementing product behaviour; the main uncertainty is CI runtime setup for the chosen stack.',
  ].join('\n'),
  acceptanceCriteria: [
    'Given a clean checkout, when the contributor runs the documented install command, then it completes without errors and produces the pinned dependency tree.',
    'When the development command runs, the placeholder screen renders and GET /health returns 200 with { status: "ok", version } within a few seconds.',
    'When the test command runs from a clean checkout, the smoke test passes and the process exits with code 0.',
    'When the configured port is already in use, the process exits non-zero with a message naming the port instead of hanging.',
    'When a pull request is opened, CI runs install, lint, build and test and reports a red status on any failure.',
    'The README documents the install, run and test commands and a contributor can follow them without asking anyone.',
  ],
  priority: 'high',
  labels: ['M1', 'foundation', 'infra'],
}
