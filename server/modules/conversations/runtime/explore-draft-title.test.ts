import { describe, it, expect } from 'vitest'
import { generateAutoTitle } from './explore-draft-title'

describe('generateAutoTitle', () => {
  it('returns Untitled draft for empty input', () => {
    expect(generateAutoTitle([])).toBe('Untitled draft')
  })

  it('returns Untitled draft when there is no user turn', () => {
    expect(generateAutoTitle([{ role: 'assistant', content: 'Hi!' }])).toBe('Untitled draft')
  })

  it('returns Untitled draft when first user message is whitespace only', () => {
    expect(generateAutoTitle([{ role: 'user', content: '   \n  ' }])).toBe('Untitled draft')
  })

  it('returns the first user message when short', () => {
    expect(
      generateAutoTitle([{ role: 'user', content: 'Add dark mode toggle' }]),
    ).toBe('Add dark mode toggle')
  })

  it('extracts the first sentence when present', () => {
    expect(
      generateAutoTitle([
        { role: 'user', content: 'Add dark mode toggle. It should persist between sessions and respect OS preferences.' },
      ]),
    ).toBe('Add dark mode toggle')
  })

  it('produces a single line (no newlines)', () => {
    const out = generateAutoTitle([
      { role: 'user', content: 'Line one\nline two\nline three' },
    ])
    expect(out).not.toContain('\n')
  })

  it('strips code fences', () => {
    const out = generateAutoTitle([
      { role: 'user', content: 'I want to ```fetch(api/x)``` from the client' },
    ])
    expect(out).not.toContain('`')
  })

  it('truncates very long messages with an ellipsis', () => {
    const long = 'word '.repeat(50).trim()
    const out = generateAutoTitle([{ role: 'user', content: long }])
    expect(out.length).toBeLessThanOrEqual(82) // 80 + ellipsis
    expect(out.endsWith('…')).toBe(true)
  })

  it('skips the assistant turn and uses the first user message', () => {
    const out = generateAutoTitle([
      { role: 'assistant', content: 'How can I help?' },
      { role: 'user', content: 'Build a settings page' },
    ])
    expect(out).toBe('Build a settings page')
  })

  it('always returns a non-empty string', () => {
    const inputs = [
      [],
      [{ role: 'assistant' as const, content: '' }],
      [{ role: 'user' as const, content: '' }],
      [{ role: 'user' as const, content: '```only code```' }],
    ]
    for (const msgs of inputs) {
      expect(generateAutoTitle(msgs).length).toBeGreaterThan(0)
    }
  })
})
