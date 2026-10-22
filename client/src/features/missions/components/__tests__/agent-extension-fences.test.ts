import { describe, expect, it } from 'vitest'
import { extractExtensionFences } from '../agent-extension-fences'

const OFFER = '{"idea":"Try it","recommended":"flow"}'

describe('extractExtensionFences', () => {
  it('strips registered blocks in order and parses their JSON', () => {
    const text = `Two paths.\n\n\`\`\`flow-offer\n${OFFER}\n\`\`\`\n\nThen:\n\`\`\`flow-offer\n{oops\n\`\`\``
    const parsed = extractExtensionFences(text, ['flow-offer'])
    expect(parsed.body).toBe('Two paths.\n\nThen:')
    expect(parsed.blocks).toEqual([
      { tag: 'flow-offer', index: 0, payload: { idea: 'Try it', recommended: 'flow' } },
      { tag: 'flow-offer', index: 1, payload: null },
    ])
    expect(parsed.pending).toEqual([])
  })

  it('leaves unregistered tags and plain text untouched', () => {
    const text = 'x\n```json\n{"a":1}\n```'
    expect(extractExtensionFences(text, ['flow-offer'])).toEqual({ body: text, blocks: [], pending: [] })
    expect(extractExtensionFences(text, [])).toEqual({ body: text, blocks: [], pending: [] })
  })

  it('cuts an unclosed block while streaming and accepts a valid settled tail', () => {
    const streaming = extractExtensionFences(`Hi\n\`\`\`flow-offer\n{"idea":"Tr`, ['flow-offer'], true)
    expect(streaming).toEqual({ body: 'Hi', blocks: [], pending: ['flow-offer'] })
    const settled = extractExtensionFences(`Hi\n\`\`\`flow-offer\n${OFFER}`, ['flow-offer'], false)
    expect(settled.body).toBe('Hi')
    expect(settled.blocks[0].payload).toEqual({ idea: 'Try it', recommended: 'flow' })
  })

  it('does not treat a longer tag as the registered one', () => {
    const text = '```flow-offer-v2\n{}\n```'
    expect(extractExtensionFences(text, ['flow-offer']).blocks).toEqual([])
  })
})
