/**
 * SPECs SMASH — pure agent contract module.
 *
 * Decomposes a committed ticket (with Contract Layer) into 3–8 ordered
 * child tickets. This module contains only the byte-stable system prompt,
 * the output schema, and the parser/validator. The spawn lifecycle and
 * store mutation live in `server/modules/specs/runtime/smash-runner.ts`.
 *
 * See openspec/changes/add-specs-smash.
 */

import type { TicketPriority } from '../../specs/runtime/ticket-store'

export const SMASH_PROMPT_VERSION = 1

export const SMASH_MIN_CHILDREN = 3
export const SMASH_MAX_CHILDREN = 8

// ─── Kill switch ─────────────────────────────────────────────────────────────

/**
 * Returns `true` when the app-wide kill switch is active and SMASH spawns
 * MUST be skipped regardless of per-project state.
 *
 * The env var `SPECRAILS_SMASH` controls the feature:
 *   - unset / any other value      → feature ENABLED (kill switch inactive)
 *   - `0` / `false` / `off` (CI)   → feature DISABLED (kill switch active)
 */
export function isSpecsSmashKillSwitchActive(
  envValue: string | undefined = process.env.SPECRAILS_SMASH,
): boolean {
  if (envValue == null) return false
  const v = envValue.trim().toLowerCase()
  return v === '0' || v === 'false' || v === 'off'
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type SmashMode = 'simple' | 'full'

export interface SmashChild {
  title: string
  description: string
  priority: TicketPriority
  executionOrder: number
  rationale: string
  /** Optional acceptance criteria — populated only when mode='full'. */
  acceptanceCriteria?: string[]
  /** Optional ≤120-char plain-text summary for the dashboard postit view. */
  shortSummary?: string | null
}

export interface SmashOutput {
  smashVersion: 1
  children: SmashChild[]
}

export type SmashValidationReason =
  | 'not-found'
  | 'malformed'
  | 'missing-version'
  | 'wrong-version'
  | 'children-missing'
  | 'children-empty'
  | 'count-below-min'
  | 'count-above-max'
  | 'child-shape'
  | 'title-too-long'
  | 'title-empty'
  | 'description-empty'
  | 'invalid-priority'
  | 'invalid-execution-order'
  | 'execution-order-not-contiguous'
  | 'rationale-too-long'

export type SmashParseResult =
  | { ok: true; value: SmashOutput }
  | { ok: false; reason: SmashValidationReason; detail?: string }

const VALID_PRIORITIES = new Set<TicketPriority>(['critical', 'high', 'medium', 'low'])

const TITLE_MAX_LEN = 80
const RATIONALE_MAX_LEN = 200

// ─── System prompt ───────────────────────────────────────────────────────────

const EXAMPLE_BLOCK = `\`\`\`smash
{
  "smashVersion": 1,
  "children": [
    {
      "title": "WS infra + presence channel",
      "description": "Set up the websocket transport and a presence channel that tracks connected users per document. Includes server-side connection lifecycle and client-side reconnect handling.",
      "priority": "high",
      "executionOrder": 1,
      "rationale": "Other children depend on a working transport"
    },
    {
      "title": "CRDT document model",
      "description": "Define the CRDT operations and the in-memory document shape. No UI work yet.",
      "priority": "high",
      "executionOrder": 2,
      "rationale": "Required before any broadcast or merge work"
    },
    {
      "title": "Cursor broadcast UI",
      "description": "Render other users' cursors in the editor. Throttle position updates to 30Hz.",
      "priority": "medium",
      "executionOrder": 3,
      "rationale": "Visible win once transport + model exist"
    },
    {
      "title": "Conflict resolution UX",
      "description": "Show a non-blocking banner when concurrent edits diverge and allow accept/reject.",
      "priority": "medium",
      "executionOrder": 4,
      "rationale": "Closes the loop on multi-user editing"
    }
  ]
}
\`\`\``

/**
 * Build the byte-stable system prompt for a SMASH turn.
 *
 * MUST be byte-stable for a given mode across two consecutive calls — the
 * only inputs that vary the output are intentional version bumps
 * (SMASH_PROMPT_VERSION) and the `mode` argument.
 */
export function buildSmashSystemPrompt(mode: SmashMode = 'simple'): string {
  if (mode === 'full') return buildSmashFullSystemPrompt()
  return buildSmashSimpleSystemPrompt()
}

function buildSmashSimpleSystemPrompt(): string {
  return [
    '# SPECs SMASH — decomposition pass',
    '',
    'You are SPECs SMASH. The user has a committed ticket that is too big to',
    'execute as a single unit. Your sole job is to split it into between',
    `${SMASH_MIN_CHILDREN} and ${SMASH_MAX_CHILDREN} ordered child tickets, each independently`,
    'executable. Emit EXACTLY ONE fenced code block tagged `smash` containing a',
    'JSON object matching the schema below. No prose before or after the block.',
    '',
    '## Hard rules',
    '',
    '- DO NOT call any tool. Work only from the title and description provided.',
    '- DO NOT ask clarifying questions.',
    '- Each child MUST be independently executable. If the user already has',
    '  enough context to start that child on its own, you have done it right.',
    `- Produce between ${SMASH_MIN_CHILDREN} and ${SMASH_MAX_CHILDREN} children inclusive. Below ${SMASH_MIN_CHILDREN} means the spec`,
    `  did not need to be split; above ${SMASH_MAX_CHILDREN} means each child is too small.`,
    '- `executionOrder` MUST start at 1 and be contiguous (1, 2, 3, …). Lower',
    '  numbers run first; ties imply you should pick one. Encode technical',
    '  dependency: a child cannot rely on another with a higher number.',
    '- `title` MUST be ≤ 80 chars, non-empty, imperative form ("Add X", "Refactor Y").',
    '- `description` MUST be non-empty markdown. Include WHAT to build, not why.',
    '- `priority` MUST be one of: "critical", "high", "medium", "low". Inherit',
    '  conservatively from the parent ticket if unsure.',
    '- `rationale` MUST be ≤ 200 chars and explain why this child exists as a',
    '  separate ticket (e.g. dependency anchor, scope isolation, parallelisable).',
    '- DO NOT include a Contract Layer in any child description. The app will run',
    '  Contract Refine per child separately if the user requests it.',
    '- `shortSummary` is OPTIONAL: when included, a single plain-text sentence',
    '  ≤ 120 chars summarising the child for a dashboard postit. No markdown,',
    '  no bullets, no headings. Omit the field if you cannot say anything new.',
    '',
    '## Required JSON shape',
    '',
    '```',
    '{',
    '  "smashVersion": 1,',
    '  "children": [',
    '    {',
    '      "title":          string  (≤ 80 chars, non-empty),',
    '      "description":    string  (non-empty markdown),',
    '      "priority":       "critical" | "high" | "medium" | "low",',
    '      "executionOrder": integer (1-based, contiguous, unique),',
    '      "rationale":      string  (≤ 200 chars),',
    '      "shortSummary":   string  (≤ 120 chars, optional, plain text)',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    '## Example output',
    '',
    EXAMPLE_BLOCK,
    '',
    `## Prompt version: ${SMASH_PROMPT_VERSION}`,
    '',
  ].join('\n')
}

/**
 * FULL mode: deep decomposition with codebase access. The agent uses
 * read-only tools (Read, Grep, Glob) extensively to ground the partition in
 * the real project. Each Sub-Spec is a stand-alone "super-spec" with rich
 * description sections, exhaustive acceptance criteria, and concrete file
 * paths. Tokens are spent freely — quality over speed.
 */
function buildSmashFullSystemPrompt(): string {
  return [
    '# SPECs SMASH — Super-Spec decomposition (Full mode)',
    '',
    'You are SPECs SMASH in Full mode. The user has committed a spec that is',
    'too big to execute as a single unit. Your job is to partition it into',
    `${SMASH_MIN_CHILDREN}-${SMASH_MAX_CHILDREN} ordered Sub-Specs that are themselves super-specs:`,
    'each as detailed and prescriptive as the parent — sometimes more so.',
    '',
    '**Do not economise on tokens.** Read aggressively, write thoroughly.',
    'Sub-Specs that ship to engineers should leave zero room for guessing.',
    '',
    '## Process — follow it in order',
    '',
    '1. **Read the parent spec end-to-end.** Internalise the title, the body,',
    '   and (critically) the Contract Layer. Note every identifier, file path,',
    '   data shape, invariant, and state machine step.',
    '',
    '2. **Survey the codebase.** USE Read, Grep, and Glob freely. Open every',
    '   file the Contract Layer mentions. Trace each named function /',
    '   identifier to its definition. Read sibling files in the same dir to',
    '   learn existing patterns, error-handling conventions, test style,',
    '   imports, and naming. Read the project root README / CLAUDE.md if',
    '   present. Read package.json for dependency versions. The more you',
    '   read, the better — there is no quota.',
    '',
    `3. **Decide the partition.** Carve ${SMASH_MIN_CHILDREN}-${SMASH_MAX_CHILDREN} Sub-Specs whose union covers`,
    '   the parent scope completely with zero overlap. Each Sub-Spec must be:',
    '   - **End-to-end executable on its own**: every dependency it relies on',
    '     exists today OR comes from a lower-numbered sibling.',
    '   - **Anchored to real artefacts**: cite concrete file paths and',
    '     identifiers from your reads, not invented names.',
    '   - **Faithful to the parent Contract Layer**: same names, same types,',
    '     same file touch list. Do not rename, do not "improve".',
    '',
    '4. **Draft each Sub-Spec as a super-spec.** Each description MUST contain',
    '   the following markdown sections in this order:',
    '',
    '   ```markdown',
    '   ## Background',
    '   <2-5 sentences: why this Sub-Spec exists in the broader spec, what it',
    '   unblocks, why it stands alone.>',
    '',
    '   ## Implementation Plan',
    '   <Numbered, step-by-step plan. Every step cites the file path it',
    '   touches (and roughly the function/area). Include type signatures,',
    '   data shapes, schema migrations, env vars. Mention `import` paths',
    '   when relevant.>',
    '',
    '   ## Affected Files',
    '   <Bullet list of every file you expect to be created / extended /',
    '   deleted. Use `create` / `extend` / `delete` next to each path, plus',
    '   a one-line "why".>',
    '',
    '   ## Edge Cases & Risks',
    '   <Bullets: things that could go wrong, race conditions, backwards',
    '   compatibility, perf, security, error paths the engineer must handle.>',
    '',
    '   ## Out of Scope',
    '   <Bullets: explicit "not this Sub-Spec" items, especially when a',
    '   reader might assume they belong here.>',
    '',
    '   ## Testing Strategy',
    '   <How to test this Sub-Spec end-to-end: unit, integration, manual',
    '   smoke. Mention specific existing test files when relevant.>',
    '   ```',
    '',
    '5. **Write exhaustive acceptance criteria.** 4-10 entries per Sub-Spec.',
    '   Each MUST be:',
    '   - A complete sentence starting with a capital letter.',
    '   - A *verifiable* outcome (a tester could mark it pass/fail).',
    '   - Phrased in the *result* tense ("X happens when Y"), not the',
    '     *implementation* tense ("we add a function").',
    '   - Cover happy path AND at least one error / edge case.',
    '',
    '6. **Final output.** Emit EXACTLY ONE fenced code block tagged `smash`',
    '   with the JSON shape below. No prose before or after the block. No',
    '   second block.',
    '',
    '## Hard rules',
    '',
    '- You MAY call Read, Grep, Glob freely. DO NOT call Bash, Edit, Write.',
    '- DO NOT ask clarifying questions — work from the codebase you can read.',
    `- Produce ${SMASH_MIN_CHILDREN}-${SMASH_MAX_CHILDREN} children inclusive.`,
    '- `executionOrder` starts at 1 and is contiguous; lower numbers run',
    '  first; higher-numbered Sub-Specs MAY depend on lower-numbered ones.',
    '- `title` ≤ 80 chars, imperative ("Add WS infra", "Refactor X").',
    '- `description` is markdown using the six section template above. Spend',
    '  the tokens — a thin description is a failed Sub-Spec.',
    '- `priority` ∈ {"critical","high","medium","low"}.',
    '- `rationale` ≤ 200 chars: WHY this Sub-Spec exists separately (dependency',
    '  anchor, isolation, parallelisability, Contract Layer constraint).',
    '- `acceptanceCriteria` is 4-10 strings, capitalised, testable outcomes.',
    '- `shortSummary` is OPTIONAL: when included, a single plain-text sentence',
    '  ≤ 120 chars summarising this Sub-Spec for a dashboard postit. No markdown.',
    '- DO NOT include a Contract Layer in any child description.',
    '- Use the parent Contract Layer as the immutable source of truth for',
    '  names, types, and file paths.',
    '',
    '## Required JSON shape',
    '',
    '```',
    '{',
    '  "smashVersion": 1,',
    '  "children": [',
    '    {',
    '      "title":              string  (≤ 80 chars, non-empty, imperative),',
    '      "description":        string  (markdown — 6-section super-spec body),',
    '      "priority":           "critical" | "high" | "medium" | "low",',
    '      "executionOrder":     integer (1-based, contiguous, unique),',
    '      "rationale":          string  (≤ 200 chars — WHY this Sub-Spec),',
    '      "acceptanceCriteria": string[] (4-10 items, capitalised, testable),',
    '      "shortSummary":       string  (≤ 120 chars, optional, plain text)',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    '## Example output (illustrative shape — not example content)',
    '',
    EXAMPLE_BLOCK,
    '',
    `## Prompt version: ${SMASH_PROMPT_VERSION}`,
    '',
  ].join('\n')
}

// ─── Parser ──────────────────────────────────────────────────────────────────

const SMASH_FENCE_RE = /```smash\s*\n([\s\S]*?)\n```/

function fail(reason: SmashValidationReason, detail?: string): SmashParseResult {
  return detail ? { ok: false, reason, detail } : { ok: false, reason }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function validateChild(
  raw: unknown,
  index: number,
): { ok: true; value: SmashChild } | { ok: false; reason: SmashValidationReason; detail: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'child-shape', detail: `child[${index}] is not an object` }
  }
  const o = raw as Record<string, unknown>

  const title = asString(o.title)
  if (title === null) {
    return { ok: false, reason: 'child-shape', detail: `child[${index}].title is not a string` }
  }
  if (title.trim().length === 0) {
    return { ok: false, reason: 'title-empty', detail: `child[${index}].title is empty` }
  }
  if (title.length > TITLE_MAX_LEN) {
    return {
      ok: false,
      reason: 'title-too-long',
      detail: `child[${index}].title length ${title.length} > ${TITLE_MAX_LEN}`,
    }
  }

  const description = asString(o.description)
  if (description === null) {
    return { ok: false, reason: 'child-shape', detail: `child[${index}].description is not a string` }
  }
  if (description.trim().length === 0) {
    return { ok: false, reason: 'description-empty', detail: `child[${index}].description is empty` }
  }

  const priority = asString(o.priority)
  if (priority === null || !VALID_PRIORITIES.has(priority as TicketPriority)) {
    return { ok: false, reason: 'invalid-priority', detail: `child[${index}].priority=${String(o.priority)}` }
  }

  const eo = o.executionOrder
  if (typeof eo !== 'number' || !Number.isInteger(eo) || eo < 1) {
    return {
      ok: false,
      reason: 'invalid-execution-order',
      detail: `child[${index}].executionOrder=${String(eo)}`,
    }
  }

  const rationale = asString(o.rationale)
  if (rationale === null) {
    return { ok: false, reason: 'child-shape', detail: `child[${index}].rationale is not a string` }
  }
  if (rationale.length > RATIONALE_MAX_LEN) {
    return {
      ok: false,
      reason: 'rationale-too-long',
      detail: `child[${index}].rationale length ${rationale.length} > ${RATIONALE_MAX_LEN}`,
    }
  }

  // Optional acceptanceCriteria: string[] of non-empty strings (full mode).
  let acceptanceCriteria: string[] | undefined
  if (o.acceptanceCriteria !== undefined) {
    if (!Array.isArray(o.acceptanceCriteria)) {
      return { ok: false, reason: 'child-shape', detail: `child[${index}].acceptanceCriteria is not an array` }
    }
    const valid: string[] = []
    for (const ac of o.acceptanceCriteria as unknown[]) {
      if (typeof ac !== 'string' || ac.trim().length === 0) continue
      valid.push(ac.trim())
    }
    if (valid.length > 0) acceptanceCriteria = valid
  }

  // Optional shortSummary: tolerated when missing. Sanitized (trim, control-strip,
  // 240-char hard cap) by the ticket-store helper at persistence time; here we
  // only accept strings and pass them through.
  let shortSummary: string | null | undefined
  if (o.shortSummary !== undefined && o.shortSummary !== null) {
    if (typeof o.shortSummary !== 'string') {
      // Reject only when present-but-wrong-type, to surface model bugs early.
      return { ok: false, reason: 'child-shape', detail: `child[${index}].shortSummary is not a string` }
    }
    shortSummary = o.shortSummary
  }

  return {
    ok: true,
    value: {
      title,
      description,
      priority: priority as TicketPriority,
      executionOrder: eo,
      rationale,
      ...(acceptanceCriteria ? { acceptanceCriteria } : {}),
      ...(shortSummary !== undefined ? { shortSummary } : {}),
    },
  }
}

/**
 * Validate a parsed payload as a SmashOutput. Used by parseSmashOutput, and
 * directly testable.
 */
export function validateSmashOutput(payload: unknown): SmashParseResult {
  if (typeof payload !== 'object' || payload === null) {
    return fail('malformed', 'payload is not an object')
  }
  const obj = payload as Record<string, unknown>

  if (!('smashVersion' in obj)) return fail('missing-version')
  if (obj.smashVersion !== 1) return fail('wrong-version', `smashVersion=${String(obj.smashVersion)}`)

  if (!('children' in obj)) return fail('children-missing')
  const rawChildren = obj.children
  if (!Array.isArray(rawChildren)) return fail('children-missing', 'children is not an array')
  if (rawChildren.length === 0) return fail('children-empty')
  if (rawChildren.length < SMASH_MIN_CHILDREN) {
    return fail('count-below-min', `${rawChildren.length} < ${SMASH_MIN_CHILDREN}`)
  }
  if (rawChildren.length > SMASH_MAX_CHILDREN) {
    return fail('count-above-max', `${rawChildren.length} > ${SMASH_MAX_CHILDREN}`)
  }

  const validated: SmashChild[] = []
  for (let i = 0; i < rawChildren.length; i++) {
    const r = validateChild(rawChildren[i], i)
    if (!r.ok) return r
    validated.push(r.value)
  }

  // Sort by the agent-provided executionOrder (stable: preserves original
  // child index on ties), then re-number 1..N. This tolerates agents that
  // emit duplicates or non-contiguous numbers while still preserving the
  // ordering intent the agent signalled. We only reject malformed numbers
  // (non-int / < 1) at the per-child validation step above.
  const withIndex = validated.map((c, i) => ({ c, i }))
  withIndex.sort((a, b) => {
    if (a.c.executionOrder !== b.c.executionOrder) return a.c.executionOrder - b.c.executionOrder
    return a.i - b.i
  })
  const renumbered = withIndex.map(({ c }, idx) => ({ ...c, executionOrder: idx + 1 }))

  return { ok: true, value: { smashVersion: 1, children: renumbered } }
}

/**
 * Parse a SMASH-fenced block from raw assistant text, then validate it.
 *
 * - `{ ok: false, reason: 'not-found' }` when no fenced block is present.
 * - `{ ok: false, reason: 'malformed' }` when JSON parse fails.
 * - Other validation reasons from `validateSmashOutput`.
 */
export function parseSmashOutput(raw: string): SmashParseResult {
  const match = raw.match(SMASH_FENCE_RE)
  if (!match) {
    // Also try parsing the whole input as raw JSON in case the model omitted
    // fences (defensive — strict prompt asks for fences but agents drift).
    try {
      const payload = JSON.parse(raw)
      return validateSmashOutput(payload)
    } catch {
      return fail('not-found')
    }
  }
  let payload: unknown
  try {
    payload = JSON.parse(match[1])
  } catch {
    return fail('malformed', 'JSON.parse failed')
  }
  return validateSmashOutput(payload)
}
