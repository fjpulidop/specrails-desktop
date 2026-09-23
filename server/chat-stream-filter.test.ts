import { describe, it, expect } from 'vitest'
import { filterDraftBlocksLive } from './modules/conversations/runtime/chat-manager'

function feed(state: { inBlock: boolean; pendingTail: string }, chunks: string[]): string {
  return chunks.map((c) => filterDraftBlocksLive(state, c)).join('')
}

describe('filterDraftBlocksLive', () => {
  it('emits text without modification when no fence is present (modulo a small tail held back)', () => {
    // The filter always holds back up to FENCE_OPEN.length - 1 trailing chars
    // in case they are the prefix of an open marker; chat_done flushes the
    // residue, so a slow stream eventually catches up. Here we feed a long
    // enough text to guarantee the prefix gets emitted.
    const state = { inBlock: false, pendingTail: '' }
    const out = feed(state, ['Hello world. This is plenty of text to clear the tail buffer.'])
    expect(out).toContain('Hello world.')
    expect(state.inBlock).toBe(false)
  })

  it('strips a complete fenced block delivered in one chunk', () => {
    const state = { inBlock: false, pendingTail: '' }
    // Trailing tail must exceed the open-marker length so the filter can
    // safely emit past the closing fence.
    const text = 'Before.\n```spec-draft\n{"title":"X"}\n```\nAfter — more text follows.'
    const out = feed(state, [text])
    expect(out).toContain('Before.')
    expect(out).toContain('After')
    expect(out).not.toContain('spec-draft')
    expect(state.inBlock).toBe(false)
  })

  it('strips a fence split across many small chunks', () => {
    const state = { inBlock: false, pendingTail: '' }
    // Add a long trailing tail so the filter can safely emit past the close
    // fence (anything within the last open-marker-length chars is held back
    // as a possible partial start of the *next* fence).
    const full = 'A\n```spec-draft\n{"a":1}\n```\nB after the fence with plenty of trailing text.'
    const chunks: string[] = []
    for (let i = 0; i < full.length; i++) chunks.push(full[i])
    const out = feed(state, chunks)
    expect(out).toContain('A\n')
    expect(out).toContain('B after the fence')
    expect(out).not.toContain('spec-draft')
    expect(state.inBlock).toBe(false)
  })

  it('does not leak the prefix of an open marker on chunk boundary', () => {
    const state = { inBlock: false, pendingTail: '' }
    // First chunk ends with the partial open marker; we must NOT emit any
    // suffix of `\`\`\`spec-` in the broadcast.
    const out1 = filterDraftBlocksLive(state, 'hello there, plenty of text\n```spec-')
    expect(out1).toContain('hello there')
    expect(out1).not.toContain('```')
    const out2 = filterDraftBlocksLive(state, 'draft\n{"x":1}\n```\nbye and a long tail follows now.')
    expect(out2).toContain('bye')
    expect(out2).not.toContain('spec-draft')
  })

  it('does not leak partial close fence', () => {
    const state = { inBlock: false, pendingTail: '' }
    filterDraftBlocksLive(state, 'pre ```spec-draft\n{"k":')
    expect(state.inBlock).toBe(true)
    // Mid-block, with a partial close at end (only `` instead of ```)
    const mid = filterDraftBlocksLive(state, '"v"}\n``')
    expect(mid).toBe('')
    expect(state.inBlock).toBe(true)
    // Resolve the close by feeding the final backtick + a long tail. The
    // tail must be longer than the open-marker length so the filter can
    // safely emit it (anything shorter is held back as a possible partial
    // open of the *next* fence — chat_done will deliver it on close).
    const tail = filterDraftBlocksLive(state, '`\nafter the close fence we have plenty of text.')
    expect(state.inBlock).toBe(false)
    expect(tail).toContain('after the close fence')
  })

  it('handles two consecutive fenced blocks in one stream', () => {
    const state = { inBlock: false, pendingTail: '' }
    const text = 'A ```spec-draft\n{"a":1}\n``` middle ```spec-draft\n{"b":2}\n``` Z plus trailing tail.'
    const out = feed(state, [text])
    expect(out).toContain('A ')
    expect(out).toContain('middle')
    expect(out).toContain('Z')
    expect(out).not.toContain('spec-draft')
    expect(state.inBlock).toBe(false)
  })

  it('passes ordinary triple-backtick code blocks through unchanged', () => {
    // Only fences tagged `spec-draft` get stripped; plain ``` code fences
    // (e.g. example bash / typescript blocks Claude might emit) remain
    // visible (modulo the standard tail hold-back).
    const state = { inBlock: false, pendingTail: '' }
    const text = 'See:\n```bash\necho hi\n```\nDone with extra padding here.'
    const out = feed(state, [text])
    expect(out).toContain('```bash')
    expect(out).toContain('echo hi')
    expect(out).toContain('Done')
  })

  it('preserves a literal mention of "spec-draft" without leaking when no fence follows', () => {
    const state = { inBlock: false, pendingTail: '' }
    const out = feed(state, ['the word spec-draft on its own is fine, even more text after it here.'])
    expect(out).toContain('the word spec-draft on its own is fine')
  })

  it('drops an unterminated block until close arrives', () => {
    const state = { inBlock: false, pendingTail: '' }
    const out1 = filterDraftBlocksLive(state, 'pre ```spec-draft\n{"a":')
    expect(out1).toBe('pre ')
    expect(state.inBlock).toBe(true)
    // Stream ends mid-block — caller is responsible for finalising; the filter
    // returns empty (waiting for close).
    const out2 = filterDraftBlocksLive(state, '1}')
    expect(out2).toBe('')
    expect(state.inBlock).toBe(true)
  })
})
