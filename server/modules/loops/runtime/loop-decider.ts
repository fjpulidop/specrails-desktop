/**
 * Loop Decider — the pure prompt/parse core for the dedicated AI node that
 * decides, each iteration, whether a loop's goal is met (STOP) or another
 * iteration is needed (CONTINUE). The decision is made by an AI invocation, NOT
 * by app heuristics; this module only builds the (byte-stable) prompt and
 * parses the model's structured verdict. The engine bounds everything with
 * maxIterations + timeout, so an unparseable verdict safely defaults to CONTINUE.
 */

export const DECIDER_PROMPT_VERSION = 3

export interface DeciderDecision {
  /** true → run another iteration; false → stop the loop. When `blocked` is
   *  true this is false (a blocked loop does not continue). */
  continue: boolean
  /** true → the loop is stuck on a decision only a human can make; the engine
   *  halts with a `blocked` outcome (NOT `success`) and surfaces the question. */
  blocked: boolean
  reasoning: string
  /** false when the model output could not be parsed (engine treats as continue). */
  parsed: boolean
}

/** Byte-stable system prompt (no timestamps/aggregates) so prompt caching hits. */
export function buildDeciderSystemPrompt(): string {
  return [
    'You are the Loop Decider for an automation loop run by an external engine.',
    'You are given the loop GOAL, the SPEC being implemented (when provided), the history of prior iterations, and the latest output.',
    'Decide whether the goal is now met (STOP) or another iteration is needed (CONTINUE).',
    'Be strict: only STOP when the goal is genuinely satisfied by the evidence in the history.',
    'A step CLAIMING success (e.g. printing "VERIFICATION: PASS") is NOT proof on its own — weigh it against the SPEC. If the spec describes work the history does not yet evidence as done, CONTINUE even if a step reported success.',
    'BLOCKED is a THIRD option, distinct from continue/stop. Choose "blocked" when the loop is stuck on a decision only a HUMAN can make and further iterations cannot make progress — e.g. the latest step printed a line starting `LOOP_BLOCKED:`, OR a step repeatedly asks the human the same question / reports it will not proceed without a decision, OR the history shows several iterations with no new progress toward the goal. Do NOT pick "continue" in those cases — it just burns iterations. Put the blocking question in `reasoning`.',
    'Respond with ONLY a single-line JSON object — no prose, no markdown, no code fences:',
    '{"action":"continue"|"stop"|"blocked","reasoning":"<one short sentence>"}',
  ].join('\n')
}

export function buildDeciderUserPrompt(input: {
  goal: string
  history: string[]
  /** The spec the loop is implementing — so the Decider can judge completeness
   *  against the FULL scope instead of trusting a step's self-reported success. */
  spec?: { title?: string; description?: string; tickets?: Array<{ id: number; title?: string; description?: string }> }
}): string {
  const history = input.history.length > 0 ? input.history.join('\n') : '(no output yet)'
  const lines: string[] = [`LOOP GOAL: ${input.goal}`, '']
  const specTitle = input.spec?.title?.trim()
  const specDesc = input.spec?.description?.trim()
  if (input.spec?.tickets && input.spec.tickets.length > 1) {
    lines.push('SPECS BEING IMPLEMENTED — every listed spec must be complete before STOP:')
    for (const ticket of input.spec.tickets) {
      const description = ticket.description?.trim() || '(spec description unavailable; completeness is not established)'
      const bounded = description.length > 2000
        ? `${description.slice(0, 1000)}\n…\n${description.slice(-1000)}`
        : description
      lines.push(`Spec #${ticket.id}: ${ticket.title?.trim() || '(untitled)'}`, bounded, '')
    }
  } else if (specTitle || specDesc) {
    // Cap the description so a huge spec can't blow up the Decider prompt.
    const desc = specDesc ? (specDesc.length > 2000 ? specDesc.slice(0, 2000) + '…' : specDesc) : ''
    lines.push(
      'SPEC BEING IMPLEMENTED (judge completeness against THIS — do not stop just because a step claimed success):',
      ...(specTitle ? [`Title: ${specTitle}`] : []),
      ...(desc ? [desc] : []),
      '',
    )
  }
  lines.push('ITERATION HISTORY (most recent last):', history, '', 'Is the goal met? Reply with the JSON decision object only.')
  return lines.join('\n')
}

/**
 * Parse the Decider's output into a decision. Looks for the last flat JSON
 * object carrying an `"action"` key (tolerant of surrounding prose). On any
 * parse failure returns `{ continue: true, parsed: false }` — the engine's
 * maxIterations/timeout are the hard stop, so a confused Decider can never spin
 * forever.
 */
export function parseDeciderDecision(raw: string): DeciderDecision {
  const matches = raw.match(/\{[^{}]*"action"[^{}]*\}/g)
  if (matches) {
    for (let i = matches.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(matches[i]) as { action?: unknown; reasoning?: unknown }
        const action = typeof obj.action === 'string' ? obj.action.toLowerCase().trim() : ''
        if (action === 'stop' || action === 'continue' || action === 'blocked') {
          return {
            continue: action === 'continue',
            blocked: action === 'blocked',
            reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '',
            parsed: true,
          }
        }
      } catch {
        /* try the previous candidate */
      }
    }
  }
  return { continue: true, blocked: false, reasoning: '(could not parse decision; continuing)', parsed: false }
}
