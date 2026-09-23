import { describe, expect, it } from 'vitest'
import { buildResumeRecoveryPrompt, isMissingClaudeSessionErrorResult, filterDraftBlocksLive } from '..'

describe('conversation recovery and stream policies', () => {
  it('retains the complete current turn and a valid Unicode transcript tail within the byte budget', () => {
    const current = 'Current turn: ' + 'Z'.repeat(60_000)
    const prompt = buildResumeRecoveryPrompt([{ role: 'assistant', content: '😀'.repeat(30_000) }], current)
    expect(prompt.endsWith(current)).toBe(true)
    const transcript = prompt.split('<prior-conversation>\n')[1].split('\n</prior-conversation>')[0]
    expect(Buffer.byteLength(transcript)).toBeLessThanOrEqual(48 * 1024)
    expect(transcript).toContain('[earlier content truncated]')
    expect(Buffer.from(transcript).toString()).toBe(transcript)
  })
  it('does not turn unrelated provider failures into resumable-session retries', () => {
    expect(isMissingClaudeSessionErrorResult({ is_error: true, error: 'quota exceeded' })).toBe(false)
    expect(isMissingClaudeSessionErrorResult({ is_error: false, text: 'No conversation found with session ID' })).toBe(false)
    expect(isMissingClaudeSessionErrorResult({ is_error: true, error: 'No conversation found with session ID: 1' })).toBe(true)
  })
  it('removes private draft content across every possible stream split', () => {
    const input = 'before```spec-draft\n{"secret":true}```after'
    for (let split = 0; split <= input.length; split++) {
      const state = { inBlock: false, pendingTail: '' }
      const output = filterDraftBlocksLive(state, input.slice(0, split)) + filterDraftBlocksLive(state, input.slice(split))
      expect(output).toBe('beforeafter')
      expect(state).toEqual({ inBlock: false, pendingTail: '' })
    }
  })
})
