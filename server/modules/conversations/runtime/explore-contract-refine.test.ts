import { describe, it, expect } from 'vitest'
import {
  CONTRACT_PROMPT_VERSION,
  CONTRACT_MARKER_USER_MESSAGE,
  CONTRACT_LAYER_SEPARATOR,
  isExploreContractRefineKillSwitchActive,
  buildContractRefineSystemPrompt,
  parseContractLayerBlock,
  stripContractLayerBlock,
  renderContractLayerMarkdown,
  appendContractLayerToDescription,
  hasContractLayer,
  splitDescriptionAtContractLayer,
  type ContractLayer,
} from './explore-contract-refine'

const sampleLayer: ContractLayer = {
  contractVersion: 1,
  namingContract: {
    enums: [{ name: 'RoundState', values: ['INTRO', 'FIGHTING'], file: 'engine/game_loop.py' }],
    fields: [{ name: 'p1_rounds_won', type: 'int', where: 'Match' }],
    functions: [{ signature: 'Match.advance() -> RoundState', file: 'engine/game_loop.py' }],
    files: [{ path: 'engine/game_loop.py', purpose: 'extend update()' }],
  },
  dataShapes: [{ name: 'Match', ts: '{ rounds: number }' }],
  stateMachine: 'INTRO -> FIGHTING',
  invariants: ['rounds <= 3'],
  fileTouchList: [{ path: 'engine/game_loop.py', action: 'extend', reason: 'state machine' }],
}

describe('isExploreContractRefineKillSwitchActive', () => {
  it('is inactive when env is unset', () => {
    expect(isExploreContractRefineKillSwitchActive(undefined)).toBe(false)
  })

  it('is active for "0"', () => {
    expect(isExploreContractRefineKillSwitchActive('0')).toBe(true)
  })

  it('is active for case-insensitive "false" and "off"', () => {
    expect(isExploreContractRefineKillSwitchActive('false')).toBe(true)
    expect(isExploreContractRefineKillSwitchActive('False')).toBe(true)
    expect(isExploreContractRefineKillSwitchActive('OFF')).toBe(true)
    expect(isExploreContractRefineKillSwitchActive(' off ')).toBe(true)
  })

  it('is inactive for "1", "true", or other strings', () => {
    expect(isExploreContractRefineKillSwitchActive('1')).toBe(false)
    expect(isExploreContractRefineKillSwitchActive('true')).toBe(false)
    expect(isExploreContractRefineKillSwitchActive('on')).toBe(false)
    expect(isExploreContractRefineKillSwitchActive('')).toBe(false)
  })
})

describe('buildContractRefineSystemPrompt', () => {
  it('is byte-stable across two consecutive calls', () => {
    const a = buildContractRefineSystemPrompt()
    const b = buildContractRefineSystemPrompt()
    expect(a).toBe(b)
  })

  it('exposes the prompt version', () => {
    expect(CONTRACT_PROMPT_VERSION).toBe(1)
    const prompt = buildContractRefineSystemPrompt()
    expect(prompt).toContain('Prompt version: 1')
  })

  it('forbids user-content edits and tool calls', () => {
    const prompt = buildContractRefineSystemPrompt()
    expect(prompt).toMatch(/DO NOT modify/i)
    expect(prompt).toMatch(/DO NOT call any tool/i)
  })

  it('exposes the marker constant', () => {
    expect(CONTRACT_MARKER_USER_MESSAGE).toMatch(/^CONTRACT REFINE/)
  })
})

describe('parseContractLayerBlock', () => {
  it('parses a well-formed block', () => {
    const raw = '```contract-layer\n' + JSON.stringify({
      contractVersion: 1,
      namingContract: { enums: [], fields: [], functions: [], files: [] },
      dataShapes: [],
      stateMachine: null,
      invariants: ['x must be y'],
      fileTouchList: [{ path: 'a.ts', action: 'create', reason: 'r' }],
    }) + '\n```'
    const r = parseContractLayerBlock(raw)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.contractVersion).toBe(1)
      expect(r.value.invariants).toEqual(['x must be y'])
      expect(r.value.fileTouchList).toHaveLength(1)
    }
  })

  it('defaults missing arrays to empty', () => {
    const raw = '```contract-layer\n' + JSON.stringify({ contractVersion: 1 }) + '\n```'
    const r = parseContractLayerBlock(raw)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.namingContract.enums).toEqual([])
      expect(r.value.dataShapes).toEqual([])
      expect(r.value.invariants).toEqual([])
      expect(r.value.fileTouchList).toEqual([])
      expect(r.value.stateMachine).toBeNull()
    }
  })

  it('drops unknown top-level keys', () => {
    const raw = '```contract-layer\n' + JSON.stringify({
      contractVersion: 1,
      specFlavour: 'weird',
      invariants: ['ok'],
    }) + '\n```'
    const r = parseContractLayerBlock(raw)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect((r.value as unknown as Record<string, unknown>).specFlavour).toBeUndefined()
      expect(r.value.invariants).toEqual(['ok'])
    }
  })

  it('rejects missing contractVersion', () => {
    const raw = '```contract-layer\n' + JSON.stringify({ invariants: [] }) + '\n```'
    expect(parseContractLayerBlock(raw).ok).toBe(false)
    const result = parseContractLayerBlock(raw)
    if (!result.ok) expect(result.reason).toBe('missing-version')
  })

  it('rejects non-integer contractVersion', () => {
    const raw = '```contract-layer\n' + JSON.stringify({ contractVersion: '1' }) + '\n```'
    const r = parseContractLayerBlock(raw)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('missing-version')
  })

  it('rejects malformed JSON', () => {
    const raw = '```contract-layer\nnot { json\n```'
    const r = parseContractLayerBlock(raw)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('malformed')
  })

  it('returns not-found when there is no block', () => {
    const r = parseContractLayerBlock('plain prose with no fence')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not-found')
  })

  it('drops malformed enum entries silently', () => {
    const raw = '```contract-layer\n' + JSON.stringify({
      contractVersion: 1,
      namingContract: {
        enums: [
          { name: 'OK', values: ['A'], file: 'x.ts' },
          { name: 'missing-file' },
          'string-not-object',
        ],
      },
    }) + '\n```'
    const r = parseContractLayerBlock(raw)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.namingContract.enums).toHaveLength(1)
  })

  it('rejects file touch entries with unknown action', () => {
    const raw = '```contract-layer\n' + JSON.stringify({
      contractVersion: 1,
      fileTouchList: [
        { path: 'a', action: 'extend', reason: 'r' },
        { path: 'b', action: 'mutate', reason: 'r' },
      ],
    }) + '\n```'
    const r = parseContractLayerBlock(raw)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.fileTouchList).toHaveLength(1)
  })
})

describe('stripContractLayerBlock', () => {
  it('removes the fenced block from raw text', () => {
    const text = 'before\n```contract-layer\n{"contractVersion":1}\n```\nafter'
    const stripped = stripContractLayerBlock(text)
    expect(stripped).not.toContain('contract-layer')
    expect(stripped).toContain('before')
    expect(stripped).toContain('after')
  })

  it('returns input unchanged when no block is present', () => {
    expect(stripContractLayerBlock('just prose')).toBe('just prose')
  })
})

describe('renderContractLayerMarkdown', () => {
  it('renders all five subsections in fixed order', () => {
    const md = renderContractLayerMarkdown(sampleLayer)
    const idxNaming = md.indexOf('### Naming Contract')
    const idxShapes = md.indexOf('### Data Shapes')
    const idxStateMachine = md.indexOf('### State Machine')
    const idxInvariants = md.indexOf('### Invariants')
    const idxFiles = md.indexOf('### File Touch List')
    expect(idxNaming).toBeGreaterThanOrEqual(0)
    expect(idxShapes).toBeGreaterThan(idxNaming)
    expect(idxStateMachine).toBeGreaterThan(idxShapes)
    expect(idxInvariants).toBeGreaterThan(idxStateMachine)
    expect(idxFiles).toBeGreaterThan(idxInvariants)
  })

  it('renders N/A placeholder for empty subsections', () => {
    const empty: ContractLayer = {
      contractVersion: 1,
      namingContract: { enums: [], fields: [], functions: [], files: [] },
      dataShapes: [],
      stateMachine: null,
      invariants: [],
      fileTouchList: [],
    }
    const md = renderContractLayerMarkdown(empty)
    const naCount = md.split('N/A — model did not produce items').length - 1
    expect(naCount).toBe(5)
  })

  it('embeds the file touch list as a markdown table', () => {
    const md = renderContractLayerMarkdown(sampleLayer)
    expect(md).toContain('| Path | Action | Reason |')
    expect(md).toContain('| `engine/game_loop.py` | extend | state machine |')
  })

  it('escapes pipe characters in reason fields', () => {
    const layer: ContractLayer = {
      ...sampleLayer,
      fileTouchList: [{ path: 'x', action: 'create', reason: 'a | b' }],
    }
    const md = renderContractLayerMarkdown(layer)
    expect(md).toContain('a \\| b')
  })
})

describe('appendContractLayerToDescription', () => {
  it('appends the contract layer after the canonical separator', () => {
    const out = appendContractLayerToDescription('user body', sampleLayer)
    expect(out.startsWith('user body')).toBe(true)
    expect(out).toContain(CONTRACT_LAYER_SEPARATOR)
    expect(out).toContain('### Naming Contract')
  })

  it('trims trailing whitespace from the user body before appending', () => {
    const out = appendContractLayerToDescription('user body\n\n\n', sampleLayer)
    expect(out.startsWith('user body\n\n---\n\n## Contract Layer')).toBe(true)
  })

  it('B59: re-appending REPLACES an existing Contract Layer instead of duplicating', () => {
    const once = appendContractLayerToDescription('user body', sampleLayer)
    const twice = appendContractLayerToDescription(once, sampleLayer)
    // Exactly one Contract Layer separator, and the user body is preserved once.
    const occurrences = twice.split(CONTRACT_LAYER_SEPARATOR).length - 1
    expect(occurrences).toBe(1)
    expect(twice.startsWith('user body')).toBe(true)
  })
})

describe('hasContractLayer / splitDescriptionAtContractLayer', () => {
  it('detects the contract layer after append', () => {
    const out = appendContractLayerToDescription('hello', sampleLayer)
    expect(hasContractLayer(out)).toBe(true)
  })

  it('returns false for empty or undefined input', () => {
    expect(hasContractLayer(null)).toBe(false)
    expect(hasContractLayer(undefined)).toBe(false)
    expect(hasContractLayer('')).toBe(false)
    expect(hasContractLayer('plain body')).toBe(false)
  })

  it('splits cleanly at the separator', () => {
    const out = appendContractLayerToDescription('hello', sampleLayer)
    const { user, contract } = splitDescriptionAtContractLayer(out)
    expect(user).toBe('hello')
    expect(contract).not.toBeNull()
    expect(contract!).toContain('### Naming Contract')
  })

  it('returns contract: null when there is no separator', () => {
    const { user, contract } = splitDescriptionAtContractLayer('plain body')
    expect(user).toBe('plain body')
    expect(contract).toBeNull()
  })
})
