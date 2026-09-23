/**
 * Explore Spec — Contract Refine
 *
 * Post-commit refinement turn that appends a structured "Contract Layer"
 * section to a committed Explore Spec ticket. The refine spawn is a single
 * structural Claude turn with a byte-stable system prompt (cache-friendly),
 * read-only (no tools), that emits one ```contract-layer fenced JSON block.
 *
 * This module contains the pure pieces (prompt builder, parser, renderer,
 * kill switch). The actual spawn lifecycle lives in ChatManager.
 *
 * See openspec/changes/explore-spec-contract-refine.
 */

export const CONTRACT_PROMPT_VERSION = 1

export const CONTRACT_MARKER_USER_MESSAGE = [
  'CONTRACT REFINE — structural pass.',
  '',
  'The user has already committed the spec. Do NOT continue exploring, do NOT',
  'ask questions, do NOT call tools. Emit EXACTLY ONE fenced code block tagged',
  '`contract-layer` containing the JSON shape described in your system prompt.',
  'No prose before or after the block.',
].join('\n')

// ─── Kill switch ─────────────────────────────────────────────────────────────

/**
 * Returns `true` when the app-wide kill switch is active and Contract Refine
 * spawns MUST be skipped regardless of per-project toggles.
 *
 * The env var `SPECRAILS_EXPLORE_CONTRACT_REFINE` controls the feature:
 *   - unset / any other value      → feature ENABLED (kill switch inactive)
 *   - `0` / `false` / `off` (CI)   → feature DISABLED (kill switch active)
 */
export function isExploreContractRefineKillSwitchActive(
  envValue: string | undefined = process.env.SPECRAILS_EXPLORE_CONTRACT_REFINE,
): boolean {
  if (envValue == null) return false
  const v = envValue.trim().toLowerCase()
  return v === '0' || v === 'false' || v === 'off'
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NamingContractEnum {
  name: string
  values: string[]
  file: string
}

export interface NamingContractField {
  name: string
  type: string
  where: string
}

export interface NamingContractFunction {
  signature: string
  file: string
}

export interface NamingContractFile {
  path: string
  purpose: string
}

export interface NamingContract {
  enums: NamingContractEnum[]
  fields: NamingContractField[]
  functions: NamingContractFunction[]
  files: NamingContractFile[]
}

export interface DataShape {
  name: string
  ts: string
}

export type FileTouchAction = 'create' | 'extend' | 'delete'

export interface FileTouchEntry {
  path: string
  action: FileTouchAction
  reason: string
}

export interface ContractLayer {
  contractVersion: 1
  namingContract: NamingContract
  dataShapes: DataShape[]
  stateMachine: string | null
  invariants: string[]
  fileTouchList: FileTouchEntry[]
}

export type ParseResult =
  | { ok: true; value: ContractLayer }
  | { ok: false; reason: 'malformed' | 'missing-version' | 'parser-error' | 'not-found' }

// ─── System prompt ───────────────────────────────────────────────────────────

const EXAMPLE_BLOCK = `\`\`\`contract-layer
{
  "contractVersion": 1,
  "namingContract": {
    "enums": [
      { "name": "RoundState", "values": ["INTRO","FIGHTING","KO_FREEZE","ROUND_END","MATCH_END"], "file": "engine/game_loop.py" }
    ],
    "fields": [
      { "name": "p1_rounds_won", "type": "int", "where": "Match" }
    ],
    "functions": [
      { "signature": "Match.advance_round_state(input_state) -> RoundState", "file": "engine/game_loop.py" }
    ],
    "files": [
      { "path": "engine/game_loop.py", "purpose": "extend update() with RoundState machine" }
    ]
  },
  "dataShapes": [
    { "name": "Match", "ts": "{ p1RoundsWon: number; p2RoundsWon: number; roundTimerFrames: number; state: RoundState }" }
  ],
  "stateMachine": "INTRO -> FIGHTING -> (KO_FREEZE | TIMEOUT) -> ROUND_END -> (INTRO | MATCH_END)",
  "invariants": [
    "p1_rounds_won + p2_rounds_won + double_kos <= 3",
    "round_timer_frames only decrements while state == FIGHTING"
  ],
  "fileTouchList": [
    { "path": "engine/game_loop.py", "action": "extend", "reason": "round state machine + transitions" },
    { "path": "engine/hud.py", "action": "extend", "reason": "round counter + KO banner" }
  ]
}
\`\`\``

/**
 * Build the structural-only system prompt for a Contract Refine turn.
 *
 * MUST be byte-stable across two consecutive calls — the only inputs that
 * vary the output are intentional version bumps (CONTRACT_PROMPT_VERSION).
 */
export function buildContractRefineSystemPrompt(): string {
  return [
    '# Contract Refine — structural pass',
    '',
    'You are running a STRUCTURAL post-commit refinement on a spec that has already',
    'been committed by the user. Your sole job is to emit a single fenced code block',
    'tagged `contract-layer` containing a JSON object that anchors the spec with',
    'prescriptive, anti-reinvention details (exact names, types, file paths,',
    'invariants). Downstream agents (Architect, Developer, Reviewer) will read these',
    'anchors to avoid inventing divergent identifiers.',
    '',
    '## Hard rules',
    '',
    '- DO NOT modify, restate, paraphrase, or critique the user-authored title,',
    '  description, labels, priority, or acceptance criteria of the committed spec.',
    '- DO NOT call any tool. Do not Read, Grep, Glob, or Bash anything. Work only',
    '  from the conversation transcript and the committed spec body already in',
    '  context.',
    '- DO NOT ask clarifying questions. If a section has no concrete content,',
    '  emit an empty array (or `null` for `stateMachine`).',
    '- Output EXACTLY one fenced code block tagged `contract-layer`. No prose',
    '  before or after the block. No second block.',
    '',
    '## Required JSON shape',
    '',
    '```',
    '{',
    '  "contractVersion": 1,',
    '  "namingContract": {',
    '    "enums":     [{ "name": string, "values": string[], "file": string }],',
    '    "fields":    [{ "name": string, "type": string, "where": string }],',
    '    "functions": [{ "signature": string, "file": string }],',
    '    "files":     [{ "path": string, "purpose": string }]',
    '  },',
    '  "dataShapes":    [{ "name": string, "ts": string }],',
    '  "stateMachine":  string | null,',
    '  "invariants":    string[],',
    '  "fileTouchList": [{ "path": string, "action": "create" | "extend" | "delete", "reason": string }]',
    '}',
    '```',
    '',
    '## Example output',
    '',
    EXAMPLE_BLOCK,
    '',
    `## Prompt version: ${CONTRACT_PROMPT_VERSION}`,
    '',
  ].join('\n')
}

// ─── Parser ──────────────────────────────────────────────────────────────────

const CONTRACT_FENCE_RE = /```contract-layer\s*\n([\s\S]*?)\n```/

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((s): s is string => typeof s === 'string')
}

function normaliseNamingContract(raw: unknown): NamingContract {
  const r = (raw ?? {}) as Record<string, unknown>
  const enums = Array.isArray(r.enums) ? r.enums : []
  const fields = Array.isArray(r.fields) ? r.fields : []
  const functions = Array.isArray(r.functions) ? r.functions : []
  const files = Array.isArray(r.files) ? r.files : []
  return {
    enums: enums
      .map((e) => {
        const o = (e ?? {}) as Record<string, unknown>
        const name = asString(o.name)
        const file = asString(o.file)
        if (!name || !file) return null
        return { name, values: asStringArray(o.values), file }
      })
      .filter((x): x is NamingContractEnum => x !== null),
    fields: fields
      .map((e) => {
        const o = (e ?? {}) as Record<string, unknown>
        const name = asString(o.name)
        const type = asString(o.type)
        const where = asString(o.where)
        if (!name || !type || !where) return null
        return { name, type, where }
      })
      .filter((x): x is NamingContractField => x !== null),
    functions: functions
      .map((e) => {
        const o = (e ?? {}) as Record<string, unknown>
        const signature = asString(o.signature)
        const file = asString(o.file)
        if (!signature || !file) return null
        return { signature, file }
      })
      .filter((x): x is NamingContractFunction => x !== null),
    files: files
      .map((e) => {
        const o = (e ?? {}) as Record<string, unknown>
        const path = asString(o.path)
        const purpose = asString(o.purpose)
        if (!path || !purpose) return null
        return { path, purpose }
      })
      .filter((x): x is NamingContractFile => x !== null),
  }
}

function normaliseDataShapes(raw: unknown): DataShape[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((e) => {
      const o = (e ?? {}) as Record<string, unknown>
      const name = asString(o.name)
      const ts = asString(o.ts)
      if (!name || !ts) return null
      return { name, ts }
    })
    .filter((x): x is DataShape => x !== null)
}

function normaliseFileTouch(raw: unknown): FileTouchEntry[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((e) => {
      const o = (e ?? {}) as Record<string, unknown>
      const path = asString(o.path)
      const action = asString(o.action)
      const reason = asString(o.reason)
      if (!path || !reason) return null
      if (action !== 'create' && action !== 'extend' && action !== 'delete') return null
      return { path, action, reason }
    })
    .filter((x): x is FileTouchEntry => x !== null)
}

/**
 * Parse a `contract-layer` fenced block from a raw assistant text.
 *
 * - Returns `{ ok: false, reason: 'not-found' }` when no block is present.
 * - Returns `{ ok: false, reason: 'malformed' }` when JSON parse fails.
 * - Returns `{ ok: false, reason: 'missing-version' }` when `contractVersion`
 *   is missing or not equal to 1.
 * - Unknown top-level keys are dropped silently.
 * - Missing optional arrays default to `[]`.
 * - `stateMachine` defaults to `null` if missing or non-string.
 */
export function parseContractLayerBlock(raw: string): ParseResult {
  try {
    const match = raw.match(CONTRACT_FENCE_RE)
    if (!match) return { ok: false, reason: 'not-found' }
    let payload: unknown
    try {
      payload = JSON.parse(match[1])
    } catch {
      return { ok: false, reason: 'malformed' }
    }
    const obj = (payload ?? {}) as Record<string, unknown>
    if (obj.contractVersion !== 1) {
      return { ok: false, reason: 'missing-version' }
    }
    const stateMachineRaw = obj.stateMachine
    const value: ContractLayer = {
      contractVersion: 1,
      namingContract: normaliseNamingContract(obj.namingContract),
      dataShapes: normaliseDataShapes(obj.dataShapes),
      stateMachine: typeof stateMachineRaw === 'string' ? stateMachineRaw : null,
      invariants: asStringArray(obj.invariants),
      fileTouchList: normaliseFileTouch(obj.fileTouchList),
    }
    return { ok: true, value }
  } catch {
    return { ok: false, reason: 'parser-error' }
  }
}

/**
 * Strip the `contract-layer` fenced block from raw text (for chat content
 * broadcast to the client). Returns the input unchanged when no block is
 * present.
 */
export function stripContractLayerBlock(raw: string): string {
  return raw.replace(CONTRACT_FENCE_RE, '').replace(/\n{3,}/g, '\n\n').trim()
}

// ─── Renderer ────────────────────────────────────────────────────────────────

const NA_LINE = '_N/A — model did not produce items for this subsection._'

export const CONTRACT_LAYER_SEPARATOR = '\n\n---\n\n## Contract Layer\n\n'

function renderNamingContract(nc: NamingContract): string {
  const lines: string[] = []
  const hasAny =
    nc.enums.length || nc.fields.length || nc.functions.length || nc.files.length
  if (!hasAny) return NA_LINE
  if (nc.enums.length) {
    lines.push('**Enums**')
    for (const e of nc.enums) {
      lines.push(`- \`${e.name}\` in \`${e.file}\` — values: ${e.values.map((v) => `\`${v}\``).join(', ') || '_(none)_'}`)
    }
    lines.push('')
  }
  if (nc.fields.length) {
    lines.push('**Fields**')
    for (const f of nc.fields) {
      lines.push(`- \`${f.name}: ${f.type}\` on \`${f.where}\``)
    }
    lines.push('')
  }
  if (nc.functions.length) {
    lines.push('**Functions**')
    for (const f of nc.functions) {
      lines.push(`- \`${f.signature}\` — \`${f.file}\``)
    }
    lines.push('')
  }
  if (nc.files.length) {
    lines.push('**Files**')
    for (const f of nc.files) {
      lines.push(`- \`${f.path}\` — ${f.purpose}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

function renderDataShapes(shapes: DataShape[]): string {
  if (!shapes.length) return NA_LINE
  const lines: string[] = []
  for (const s of shapes) {
    lines.push(`**${s.name}**`)
    lines.push('```ts')
    lines.push(s.ts)
    lines.push('```')
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

function renderStateMachine(sm: string | null): string {
  if (!sm) return NA_LINE
  return ['```', sm, '```'].join('\n')
}

function renderInvariants(items: string[]): string {
  if (!items.length) return NA_LINE
  return items.map((i) => `- ${i}`).join('\n')
}

function renderFileTouchList(entries: FileTouchEntry[]): string {
  if (!entries.length) return NA_LINE
  const rows = ['| Path | Action | Reason |', '|------|--------|--------|']
  for (const e of entries) {
    const safeReason = e.reason.replace(/\|/g, '\\|')
    rows.push(`| \`${e.path}\` | ${e.action} | ${safeReason} |`)
  }
  return rows.join('\n')
}

/**
 * Render a parsed Contract Layer to a deterministic markdown subsection.
 * The output begins after the `## Contract Layer` heading and contains the
 * five labelled subsections in fixed order.
 */
export function renderContractLayerMarkdown(layer: ContractLayer): string {
  return [
    '### Naming Contract',
    '',
    renderNamingContract(layer.namingContract),
    '',
    '### Data Shapes',
    '',
    renderDataShapes(layer.dataShapes),
    '',
    '### State Machine',
    '',
    renderStateMachine(layer.stateMachine),
    '',
    '### Invariants',
    '',
    renderInvariants(layer.invariants),
    '',
    '### File Touch List',
    '',
    renderFileTouchList(layer.fileTouchList),
    '',
  ].join('\n')
}

/**
 * Append the Contract Layer to a ticket description, producing the canonical
 * `userBody\n\n---\n\n## Contract Layer\n\n<section>` shape.
 */
export function appendContractLayerToDescription(
  userBody: string,
  layer: ContractLayer,
): string {
  // B59: a Contract Refine retry must REPLACE an existing Contract Layer, not
  // append a second one. If the body already carries a layer, strip it down to
  // the user-authored part first so re-running is idempotent.
  const base = hasContractLayer(userBody)
    ? splitDescriptionAtContractLayer(userBody).user
    : userBody
  const trimmed = base.replace(/\s+$/, '')
  return `${trimmed}${CONTRACT_LAYER_SEPARATOR}${renderContractLayerMarkdown(layer)}`
}

/**
 * Detects whether a ticket description already contains a Contract Layer.
 */
export function hasContractLayer(description: string | null | undefined): boolean {
  if (!description) return false
  return description.includes(CONTRACT_LAYER_SEPARATOR.trim())
}

/**
 * Splits a ticket description into the user-authored body and the contract
 * layer markdown (when present). When no Contract Layer is detected, returns
 * `{ user: description, contract: null }`.
 */
export function splitDescriptionAtContractLayer(
  description: string,
): { user: string; contract: string | null } {
  const idx = description.indexOf(CONTRACT_LAYER_SEPARATOR)
  if (idx < 0) {
    // also check the trimmed variant in case of stray whitespace
    const altSep = '\n---\n\n## Contract Layer\n'
    const altIdx = description.indexOf(altSep)
    if (altIdx < 0) return { user: description, contract: null }
    return {
      user: description.slice(0, altIdx),
      contract: description.slice(altIdx + altSep.length),
    }
  }
  return {
    user: description.slice(0, idx),
    contract: description.slice(idx + CONTRACT_LAYER_SEPARATOR.length),
  }
}
