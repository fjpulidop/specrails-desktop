import { describe, it, expect } from 'vitest'
import { promoteAgentProtocolFences, detectProtocolShape } from '../agent-fence-promotion'
import { extractAgentOptions } from '../agent-options'
import { extractAgentProblemFrame } from '../agent-problem-frame'

const FRAME = JSON.stringify({ restated: { reading: 'A', touches: [] }, alternative: { reading: 'B', touches: [] }, discriminator: 'which?', assumptions: [], unknowns: [] })

describe('promoteAgentProtocolFences', () => {
  it('re-tags a ```json options array so chips render', () => {
    const text = 'Pick one:\n```json\n["implement-now", "review-first"]\n```'
    const out = promoteAgentProtocolFences(text)
    expect(out).toContain('```options\n')
    expect(extractAgentOptions(out).options).toEqual(['implement-now', 'review-first'])
  })
  it('re-tags a bare/json fence carrying a problem frame', () => {
    const out = promoteAgentProtocolFences('Framing:\n```\n' + FRAME + '\n```')
    expect(out).toContain('```problem-frame\n')
    expect(extractAgentProblemFrame(out).frame).not.toBeNull()
  })
  it('re-tags a spec-draft-shaped object', () => {
    const body = JSON.stringify({ title: 'T', description: 'D', labels: ['x'], priority: 'high', acceptanceCriteria: ['a'] })
    expect(promoteAgentProtocolFences('```json\n' + body + '\n```')).toContain('```spec-draft\n')
  })
  it('leaves ambiguous json, invalid json, protocol-tagged and quoted fences alone', () => {
    const plain = '```json\n{"foo": 1}\n```'
    expect(promoteAgentProtocolFences(plain)).toBe(plain)
    const bad = '```json\n{oops\n```'
    expect(promoteAgentProtocolFences(bad)).toBe(bad)
    const tagged = '```options\n["a","b"]\n```'
    expect(promoteAgentProtocolFences(tagged)).toBe(tagged)
    const quoted = '````json\n["a","b"]\n```'
    expect(promoteAgentProtocolFences(quoted)).toBe(quoted)
    expect(promoteAgentProtocolFences('')).toBe('')
  })
  it('detectProtocolShape rejects oversized or non-string option arrays', () => {
    expect(detectProtocolShape(['a'])).toBeNull()
    expect(detectProtocolShape(['a', 2])).toBeNull()
    expect(detectProtocolShape(['a', 'x'.repeat(81)])).toBeNull()
    expect(detectProtocolShape({ title: 'T', description: 'D' })).toBeNull()
    expect(detectProtocolShape(null)).toBeNull()
  })
})
