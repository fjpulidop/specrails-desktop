import { describe, it, expect } from 'vitest'

import {
  SMASH_PROMPT_VERSION,
  SMASH_MIN_CHILDREN,
  SMASH_MAX_CHILDREN,
  buildSmashSystemPrompt,
  isSpecsSmashKillSwitchActive,
  parseSmashOutput,
  validateSmashOutput,
  type SmashChild,
  type SmashOutput,
} from './explore-smash'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeChild(overrides: Partial<SmashChild> = {}): SmashChild {
  return {
    title: 'Add WS infra',
    description: 'Set up the websocket transport for the editor.',
    priority: 'high',
    executionOrder: 1,
    rationale: 'Other children depend on it',
    ...overrides,
  }
}

function makeValidOutput(count = 4): SmashOutput {
  return {
    smashVersion: 1,
    children: Array.from({ length: count }, (_, i) =>
      makeChild({ title: `Child ${i + 1}`, executionOrder: i + 1 }),
    ),
  }
}

function fence(payload: unknown): string {
  return '```smash\n' + JSON.stringify(payload, null, 2) + '\n```'
}

// ─── Constants and prompt ────────────────────────────────────────────────────

describe('constants', () => {
  it('exposes the expected prompt version and child range', () => {
    expect(SMASH_PROMPT_VERSION).toBe(1)
    expect(SMASH_MIN_CHILDREN).toBe(3)
    expect(SMASH_MAX_CHILDREN).toBe(8)
  })
})

describe('buildSmashSystemPrompt', () => {
  it('is byte-stable across calls', () => {
    expect(buildSmashSystemPrompt()).toBe(buildSmashSystemPrompt())
  })

  it('includes the version line and child range', () => {
    const p = buildSmashSystemPrompt()
    expect(p).toContain(`Prompt version: ${SMASH_PROMPT_VERSION}`)
    expect(p).toContain(`between ${SMASH_MIN_CHILDREN} and ${SMASH_MAX_CHILDREN}`)
  })

  it('contains a smash fenced example block', () => {
    const p = buildSmashSystemPrompt()
    expect(p).toMatch(/```smash[\s\S]+```/)
  })
})

// ─── Kill switch ─────────────────────────────────────────────────────────────

describe('isSpecsSmashKillSwitchActive', () => {
  it('inactive when env unset', () => {
    expect(isSpecsSmashKillSwitchActive(undefined)).toBe(false)
  })
  it('inactive for arbitrary truthy values', () => {
    expect(isSpecsSmashKillSwitchActive('1')).toBe(false)
    expect(isSpecsSmashKillSwitchActive('on')).toBe(false)
    expect(isSpecsSmashKillSwitchActive('')).toBe(false)
  })
  it('active for canonical disable values regardless of case', () => {
    expect(isSpecsSmashKillSwitchActive('0')).toBe(true)
    expect(isSpecsSmashKillSwitchActive('false')).toBe(true)
    expect(isSpecsSmashKillSwitchActive('off')).toBe(true)
    expect(isSpecsSmashKillSwitchActive('OFF')).toBe(true)
    expect(isSpecsSmashKillSwitchActive('  False ')).toBe(true)
  })
})

// ─── validateSmashOutput ─────────────────────────────────────────────────────

describe('validateSmashOutput', () => {
  it('accepts a valid 4-child output', () => {
    const r = validateSmashOutput(makeValidOutput(4))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.children).toHaveLength(4)
  })

  it('accepts boundary counts (3 and 8)', () => {
    expect(validateSmashOutput(makeValidOutput(3)).ok).toBe(true)
    expect(validateSmashOutput(makeValidOutput(8)).ok).toBe(true)
  })

  it('rejects non-object payload', () => {
    const r = validateSmashOutput(null)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('malformed')
  })

  it('rejects wrong smashVersion', () => {
    const r = validateSmashOutput({ ...makeValidOutput(), smashVersion: 2 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('wrong-version')
  })

  it('rejects missing smashVersion', () => {
    const r = validateSmashOutput({ children: makeValidOutput().children })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('missing-version')
  })

  it('rejects missing children array', () => {
    const r = validateSmashOutput({ smashVersion: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('children-missing')
  })

  it('rejects below minimum count', () => {
    const r = validateSmashOutput(makeValidOutput(2))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('count-below-min')
  })

  it('rejects above maximum count', () => {
    const r = validateSmashOutput(makeValidOutput(9))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('count-above-max')
  })

  it('rejects empty title', () => {
    const out = makeValidOutput()
    out.children[0].title = '   '
    const r = validateSmashOutput(out)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('title-empty')
  })

  it('rejects too-long title', () => {
    const out = makeValidOutput()
    out.children[0].title = 'a'.repeat(81)
    const r = validateSmashOutput(out)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('title-too-long')
  })

  it('rejects empty description', () => {
    const out = makeValidOutput()
    out.children[0].description = ''
    const r = validateSmashOutput(out)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('description-empty')
  })

  it('rejects invalid priority', () => {
    const out = makeValidOutput()
    // @ts-expect-error testing invalid input
    out.children[0].priority = 'urgent'
    const r = validateSmashOutput(out)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('invalid-priority')
  })

  it('rejects non-integer executionOrder', () => {
    const out = makeValidOutput()
    out.children[0].executionOrder = 1.5
    const r = validateSmashOutput(out)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('invalid-execution-order')
  })

  it('rejects executionOrder < 1', () => {
    const out = makeValidOutput()
    out.children[0].executionOrder = 0
    const r = validateSmashOutput(out)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('invalid-execution-order')
  })

  it('renumbers duplicate executionOrder values 1..N preserving ordering intent', () => {
    const out = makeValidOutput(4)
    out.children[1].executionOrder = 1
    const r = validateSmashOutput(out)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.children.map((c) => c.executionOrder)).toEqual([1, 2, 3, 4])
    }
  })

  it('renumbers non-contiguous executionOrder (gaps) into 1..N', () => {
    const out = makeValidOutput(4)
    out.children[1].executionOrder = 5
    const r = validateSmashOutput(out)
    expect(r.ok).toBe(true)
    if (r.ok) {
      // Stable sort then renumber: original order was [1, 5, 3, 4] → sorted
      // by value with stable tiebreak yields [1, 3, 4, 5] → renumbered 1..4
      expect(r.value.children.map((c) => c.executionOrder)).toEqual([1, 2, 3, 4])
    }
  })

  it('rejects too-long rationale', () => {
    const out = makeValidOutput()
    out.children[0].rationale = 'x'.repeat(201)
    const r = validateSmashOutput(out)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('rationale-too-long')
  })

  it('rejects missing child fields', () => {
    const r = validateSmashOutput({
      smashVersion: 1,
      children: [
        { title: 'a', description: 'b', priority: 'high', executionOrder: 1 },
        makeChild({ executionOrder: 2 }),
        makeChild({ executionOrder: 3 }),
      ],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('child-shape')
  })

  it('accepts an optional shortSummary on a child', () => {
    const r = validateSmashOutput({
      smashVersion: 1,
      children: [
        makeChild({ executionOrder: 1, shortSummary: 'A crisp one-liner.' }),
        makeChild({ executionOrder: 2 }),
        makeChild({ executionOrder: 3, shortSummary: '' }),
      ],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.children[0].shortSummary).toBe('A crisp one-liner.')
      // Missing field stays undefined; empty string also tolerated as undefined.
      expect(r.value.children[1].shortSummary).toBeUndefined()
      // We pass empty strings through to the persistence layer where
      // clampShortSummary collapses them to null.
      expect(r.value.children[2].shortSummary === undefined || r.value.children[2].shortSummary === '').toBe(true)
    }
  })

  it('rejects a child whose shortSummary is not a string when present', () => {
    const r = validateSmashOutput({
      smashVersion: 1,
      children: [
        makeChild({ executionOrder: 1 }),
        makeChild({ executionOrder: 2 }),
        // @ts-expect-error — intentional bad type for test
        makeChild({ executionOrder: 3, shortSummary: 42 }),
      ],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('child-shape')
  })

  it('sorts validated children by executionOrder', () => {
    const out = {
      smashVersion: 1 as const,
      children: [
        makeChild({ title: 'C', executionOrder: 3 }),
        makeChild({ title: 'A', executionOrder: 1 }),
        makeChild({ title: 'B', executionOrder: 2 }),
      ],
    }
    const r = validateSmashOutput(out)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.children.map((c) => c.title)).toEqual(['A', 'B', 'C'])
    }
  })
})

// ─── parseSmashOutput ────────────────────────────────────────────────────────

describe('parseSmashOutput', () => {
  it('parses a fenced valid payload', () => {
    const r = parseSmashOutput(fence(makeValidOutput(3)))
    expect(r.ok).toBe(true)
  })

  it('tolerates preamble + trailing prose around the fence', () => {
    const text = `Some chatter\n${fence(makeValidOutput(3))}\nMore after.`
    const r = parseSmashOutput(text)
    expect(r.ok).toBe(true)
  })

  it('returns not-found when no fence and no raw JSON', () => {
    const r = parseSmashOutput('definitely not json or fence')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not-found')
  })

  it('falls back to raw-JSON parsing when fence is missing', () => {
    const r = parseSmashOutput(JSON.stringify(makeValidOutput(3)))
    expect(r.ok).toBe(true)
  })

  it('returns malformed when fence contains invalid JSON', () => {
    const r = parseSmashOutput('```smash\n{not json,,\n```')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('malformed')
  })

  it('surfaces validation errors from inside a fence', () => {
    const r = parseSmashOutput(fence(makeValidOutput(2)))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('count-below-min')
  })
})
