/**
 * Loop "magic command" catalog — provider-aware command snippets the loop builder
 * offers as draggable chips (e.g. `{{cmd:implement}}`).
 *
 * Command kinds:
 *  - `coreCommand`: a NATIVE specrails-core slash command, resolved per provider —
 *    claude `/specrails:<name>`, codex `$<name>` (skill), gemini `/specrails:<name>`.
 *    Mirrors QueueManager's rail invocation (`/specrails:implement #1 #2 --yes`).
 *  - `template`: a provider-invariant curated prompt (no core coupling).
 *  - `native`: a raw autonomous command (ultracode) — claude-only, NOT a slash
 *    command; it expands to a self-contained autonomous prompt.
 *
 * Each command declares its TICKET SCOPE:
 *  - `all`        → one run over ALL the rail's tickets (`#1 #2 #3`). implement, batch.
 *  - `per-ticket` → one run per ticket. ultracode (and the default).
 *
 * Expansion order in the engine: `expandCommands()` FIRST (injects the ticket ids),
 * then `interpolateSpec()` resolves any remaining `{{spec.*}}` data tokens.
 */

export type TicketScope = 'all' | 'per-ticket'

export interface LoopCommand {
  /** Token name: referenced as `{{cmd:<name>}}`. */
  name: string
  /** Short human label for the builder chip. */
  label: string
  /** One-line description of what the command does (builder chip tooltip). */
  description: string
  /** How the command consumes the rail's tickets. Defaults to `per-ticket`. */
  ticketScope?: TicketScope
  /** Native specrails-core slash command name (provider-aware invocation). */
  coreCommand?: string
  /** Provider-invariant curated prompt (used when no coreCommand/native). */
  template?: string
  /** Raw autonomous command (ultracode): expands to a self-contained prompt. */
  native?: boolean
  /** Per-provider native invocation prefix, keyed by ProviderId. When present it
   *  wins over `template` for the providers it lists (e.g. `{{cmd:loop}}` →
   *  claude `/loop`, codex `$goal`); providers NOT listed fall back to `template`.
   *  Used for agent-native loop entry points that aren't specrails-core slash
   *  commands. */
  providerNative?: Record<string, string>
  /** Restrict to the claude provider (e.g. ultracode). */
  claudeOnly?: boolean
}

/** The autonomous prompt a `native` command (ultracode) expands to for the
 *  LoopRunManager path. Factory ultracode loops route to QueueManager's real
 *  `_buildUltracodePrompt` instead (phase A); this is the custom-loop fallback. */
const ULTRACODE_PROMPT = [
  'Implement the following spec completely and autonomously. Explore the codebase first, then write the code and tests and make the full test suite pass. Work end-to-end without stopping for confirmation; do not open a pipeline — just do it.',
  '',
  'Title: {{spec.title}}',
  '',
  '{{spec.description}}',
].join('\n')

/** The portable fallback `{{cmd:loop}}` expands to on providers without a native
 *  loop entry point (e.g. gemini). The author writes the goal text after the
 *  token; this preamble turns the AI Step into a self-paced autonomous loop. */
const LOOP_FALLBACK_PROMPT =
  'Work autonomously toward the goal stated next. After every change, re-check the goal and keep iterating until it holds; stop as soon as it is met, or when you hit a hard blocker you cannot resolve (report it).'

/** Distilled, tooling-agnostic verification/fix step shared by the gate commands.
 *  `verb` is the one job; `gate` is what "done" means. Mutating gates drag the
 *  guardrails contract so a loop using them can't quietly cheat its exit. */
function gateTemplate(verb: string, gate: string): string {
  return [
    `Detect THIS project's tooling from its config (package.json scripts, Makefile, pyproject, cargo, go.mod, etc.) and ${verb}. Do NOT assume a specific stack — inspect first.`,
    `Fix everything needed so that ${gate} (smallest change, no unrelated edits). Re-run until it is clean.`,
    '',
    '{{const:GUARDRAILS}}',
    '',
    'Finish with exactly `VERIFICATION: PASS` when it is clean, or `VERIFICATION: FAIL — <short reason>` otherwise.',
  ].join('\n')
}

/** Open, append-only registry. Add an entry to expose a new chip. */
export const LOOP_COMMANDS: LoopCommand[] = [
  {
    name: 'implement',
    label: 'implement',
    description: "Run the specrails implement pipeline (architect → developer → reviewer) over the rail's tickets, via the native /specrails:implement command.",
    coreCommand: 'implement',
    ticketScope: 'all',
  },
  {
    name: 'batch',
    label: 'batch',
    description: "Run the batch-implement pipeline over ALL the rail's tickets in one pass (parallel internally).",
    coreCommand: 'batch-implement',
    ticketScope: 'all',
  },
  {
    name: 'ultracode',
    label: 'ultracode',
    description: 'Autonomous per-ticket implementation — Claude works the spec end-to-end with no pipeline. Claude only.',
    native: true,
    claudeOnly: true,
    ticketScope: 'per-ticket',
  },
  {
    name: 'fix',
    label: 'fix',
    description: 'Refinement step: the verification reported failures — fix ONLY what is needed to make them pass (smallest change, no re-implementing, no unrelated edits). Verification re-runs after.',
    ticketScope: 'per-ticket',
    template: [
      'The verification step above reported failures (see VERIFICATION: FAIL and the output before it).',
      '',
      'Fix ONLY what is needed to make the failing tests / type-check / lint / build pass:',
      '- Make the smallest change that resolves the reported failures.',
      '- Do NOT re-implement the feature from scratch and do NOT touch unrelated code.',
      '- If a test is wrong, fix the test; if the code is wrong, fix the code.',
      '',
      'The verification will run again after this step.',
    ].join('\n'),
  },
  {
    name: 'verify',
    label: 'verify',
    description: "Detect the project's tooling and run the full verification (tests + type-check/lint/build), fixing until green; ends with VERIFICATION: PASS|FAIL.",
    ticketScope: 'per-ticket',
    // Provider-invariant + zero-coupling: the AGENT detects the project's tooling
    // and runs the right command (no hardcoded `npm test`). Ends with a machine-
    // readable verdict the Loop Decider can read from the step's report.
    template: [
      'Verify the current change is complete and correct. Detect THIS project\'s tooling from its config (package.json scripts, Makefile, pyproject, etc.) and run the full verification — at minimum the test suite, plus type-check, lint and build when the project has them.',
      '',
      'Pick the commands that match the stack (e.g. `npx vitest run`, `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `pytest`, `cargo test`, `go test ./...`). Do NOT assume `npm test` exists — inspect first.',
      '',
      'If anything fails, fix it and re-run until green (do not change unrelated code). Finish with a clear final line — exactly `VERIFICATION: PASS` when everything is green, or `VERIFICATION: FAIL — <short reason>` otherwise.',
    ].join('\n'),
  },

  // ── Provider-native autonomous loop ─────────────────────────────────────────
  {
    name: 'loop',
    label: 'loop',
    description: "The agent's own autonomous loop runner — Claude /loop, Codex $goal, or a self-paced prompt fallback elsewhere. Write the goal after the token.",
    ticketScope: 'per-ticket',
    providerNative: { claude: '/loop', codex: '$goal' },
    template: LOOP_FALLBACK_PROMPT,
  },

  // ── Distilled gate commands (tooling-agnostic; mutating ⇒ carry guardrails) ──
  { name: 'test', label: 'test', description: "Detect and run the project's test suite, fixing failures until green.", ticketScope: 'per-ticket', template: gateTemplate('run the full test suite', 'every test passes') },
  { name: 'lint', label: 'lint', description: "Detect and run the project's linter, fixing every issue (no behaviour change).", ticketScope: 'per-ticket', template: gateTemplate('run the linter/formatter check', 'the linter reports zero errors and warnings') },
  { name: 'typecheck', label: 'typecheck', description: "Detect and run the project's type checker, resolving every error (no any / ignore / non-null).", ticketScope: 'per-ticket', template: gateTemplate('run the type checker', 'the type checker passes with zero errors and no new suppressions') },
  { name: 'build', label: 'build', description: "Detect and run the project's production build, fixing compile/bundle errors.", ticketScope: 'per-ticket', template: gateTemplate('run the production build', 'the build completes with no errors and no disabled checks') },
  { name: 'coverage', label: 'coverage', description: "Run the project's coverage tooling and add focused tests until the thresholds pass.", ticketScope: 'per-ticket', template: gateTemplate('run the test suite with coverage and add focused tests for the change (cover edge cases and error paths; assert real behaviour)', 'the coverage thresholds pass') },
  { name: 'format', label: 'format', description: "Detect and run the project's formatter and apply it (formatting only).", ticketScope: 'per-ticket', template: gateTemplate('run the code formatter', 'all files are formatted with no diff remaining') },
  {
    name: 'commit', label: 'commit', ticketScope: 'per-ticket',
    description: 'Stage the work and create one clear commit (conventional message, no secrets, no unrelated files).',
    template: 'Review the working diff, then stage the changes for this work and create a single commit with a concise conventional message describing what changed and why. Never commit secrets, credentials, or unrelated files.',
  },
  {
    name: 'push', label: 'push', ticketScope: 'per-ticket',
    description: 'Push the current branch to its remote (sets upstream if needed; never force-pushes a shared branch).',
    template: 'Push the current branch to its remote, setting the upstream if it has none. Do not force-push a shared branch. Report the result.',
  },
  {
    name: 'pr', label: 'pr', ticketScope: 'all',
    description: "Open or update a pull request for the rail's work via the repo's tooling, summarising the change.",
    template: "Open a pull request for the current branch using the repository's tooling (e.g. `gh pr create`), or update the existing one. Write a clear title and a body summarising what changed and how it was verified. Report the PR URL.",
  },
  {
    name: 'ci-status', label: 'ci-status', ticketScope: 'per-ticket',
    description: "Poll CI on the current branch / open PR via the repo's tooling and report green / running / failing.",
    template: "Check the CI status of the current branch and its open PR using the repository's tooling (e.g. `gh pr checks`, `gh run list --branch <current>`). Report whether every check has passed, is still running, or has failed — name any failing checks.",
  },
  {
    name: 'audit', label: 'audit', ticketScope: 'per-ticket',
    description: 'Run the dependency/security audit and fix high/critical findings one at a time with re-verification.',
    template: [
      "Detect this project's dependency/security audit tooling and run it (e.g. `npm audit`, `pip-audit`, `cargo audit`, `govulncheck`). Fix the high and critical findings ONE AT A TIME, re-running the audit and the test suite after each fix to confirm nothing regressed. Do not blanket-force upgrades.",
      '',
      '{{const:GUARDRAILS}}',
    ].join('\n'),
  },
  {
    name: 'docs-sync', label: 'docs-sync', ticketScope: 'per-ticket',
    description: 'Find docs affected by the change (README/API refs/inline) and update them to match.',
    template: [
      'Find the documentation affected by the current change — README, API references, usage examples, and inline comments — and update it to match the new behaviour. Do not document features that do not exist.',
      '',
      '{{const:GUARDRAILS}}',
    ].join('\n'),
  },
  {
    name: 'review', label: 'review', ticketScope: 'per-ticket',
    description: 'Self-review the working diff for correctness and quality, then fix what you find.',
    template: [
      'Review the current working diff as a critical reviewer: look for correctness bugs, missing edge cases, security issues, and quality problems. Fix what you find with minimal, well-scoped changes; leave a short note on anything you deliberately did not change.',
      '',
      '{{const:GUARDRAILS}}',
    ].join('\n'),
  },
]

const COMMANDS_BY_NAME = new Map(LOOP_COMMANDS.map((c) => [c.name, c]))

export function getLoopCommand(name: string): LoopCommand | undefined {
  return COMMANDS_BY_NAME.get(name)
}

const CMD_TOKEN_RE = /\{\{\s*cmd:([\w-]+)\s*\}\}/g

export interface ExpandCommandOpts {
  /** The provider the loop run will spawn (rail-governed). */
  provider: string
  /** Ticket ids this run targets (all rail tickets for `all` scope; the single
   *  ticket for `per-ticket`). Native core commands embed them as `#a #b`. */
  ticketIds?: number[]
  /** Back-compat single id; used when `ticketIds` is absent. */
  specId?: number | null
}

/** Build the native, provider-correct invocation of a core slash command —
 *  identical in shape to the rail's `/specrails:implement #1 #2 --yes`. Codex has
 *  no `/namespace:cmd` parser, so it invokes the equivalent `$<name>` skill. */
function nativeInvocation(coreCommand: string, provider: string, ids: number[]): string {
  const head = provider === 'codex' ? `$${coreCommand}` : `/specrails:${coreCommand}`
  const tickets = ids.length ? ' ' + ids.map((id) => `#${id}`).join(' ') : ''
  return `${head}${tickets} --yes`
}

/** Replace every `{{cmd:<name>}}` token. Core → native per-provider invocation
 *  (with all ticket ids); native → autonomous prompt; template → its prompt.
 *  Unknown commands collapse to "". */
export function expandCommands(text: string, opts: ExpandCommandOpts): string {
  const ids = opts.ticketIds ?? (opts.specId != null ? [opts.specId] : [])
  return text.replace(CMD_TOKEN_RE, (_match, name: string) => {
    const cmd = COMMANDS_BY_NAME.get(name)
    if (!cmd) return ''
    if (cmd.coreCommand) return nativeInvocation(cmd.coreCommand, opts.provider, ids)
    if (cmd.native) return ULTRACODE_PROMPT
    // Provider-native prefix (e.g. {{cmd:loop}} → /loop | $goal) wins for the
    // providers it lists; everyone else falls back to the generic template.
    if (cmd.providerNative) {
      const native = cmd.providerNative[opts.provider]
      if (native != null) return native
    }
    return cmd.template ?? ''
  })
}

/** The dominant ticket scope of a prompt's `{{cmd:*}}` tokens: `all` if any
 *  all-scope command is present, else `per-ticket`. Drives how many runs a rail
 *  launches and which ticket token is injected. */
export function dominantTicketScope(text: string): TicketScope {
  let sawPerTicket = false
  for (const m of text.matchAll(CMD_TOKEN_RE)) {
    const cmd = COMMANDS_BY_NAME.get(m[1])
    if (!cmd) continue
    if ((cmd.ticketScope ?? 'per-ticket') === 'all') return 'all'
    sawPerTicket = true
  }
  return sawPerTicket ? 'per-ticket' : 'per-ticket'
}

/** True if a prompt references any claude-only command (e.g. ultracode). */
export function referencesClaudeOnlyCommand(text: string): boolean {
  for (const m of text.matchAll(CMD_TOKEN_RE)) {
    if (COMMANDS_BY_NAME.get(m[1])?.claudeOnly) return true
  }
  return false
}
