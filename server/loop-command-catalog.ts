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
