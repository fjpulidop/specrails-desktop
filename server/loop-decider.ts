/**
 * Loop Decider — the pure prompt/parse core for the dedicated AI node that
 * decides, each iteration, whether a loop's goal is met (STOP) or another
 * iteration is needed (CONTINUE). The decision is made by an AI invocation, NOT
 * by app heuristics; this module only builds the (byte-stable) prompt and
 * parses the model's structured verdict. The engine bounds everything with
 * maxIterations + timeout, so an unparseable verdict safely defaults to CONTINUE.
 */

export const DECIDER_PROMPT_VERSION = 1

export interface DeciderDecision {
  /** true → run another iteration; false → stop the loop. */
  continue: boolean
  reasoning: string
  /** false when the model output could not be parsed (engine treats as continue). */
  parsed: boolean
}

/** Byte-stable system prompt (no timestamps/aggregates) so prompt caching hits. */
export function buildDeciderSystemPrompt(): string {
  return [
    'You are the Loop Decider for an automation loop run by an external engine.',
    'You are given the loop GOAL, the history of prior iterations, and the latest output.',
    'Decide whether the goal is now met (STOP) or another iteration is needed (CONTINUE).',
    'Be strict: only STOP when the goal is genuinely satisfied by the evidence in the history.',
    'Respond with ONLY a single-line JSON object — no prose, no markdown, no code fences:',
    '{"action":"continue"|"stop","reasoning":"<one short sentence>"}',
  ].join('\n')
}

export function buildDeciderUserPrompt(input: { goal: string; history: string[] }): string {
  const history = input.history.length > 0 ? input.history.join('\n') : '(no output yet)'
  return [
    `LOOP GOAL: ${input.goal}`,
    '',
    'ITERATION HISTORY (most recent last):',
    history,
    '',
    'Is the goal met? Reply with the JSON decision object only.',
  ].join('\n')
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
        if (action === 'stop' || action === 'continue') {
          return {
            continue: action === 'continue',
            reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '',
            parsed: true,
          }
        }
      } catch {
        /* try the previous candidate */
      }
    }
  }
  return { continue: true, reasoning: '(could not parse decision; continuing)', parsed: false }
}
