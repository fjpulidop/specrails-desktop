import { describe, expect, it } from 'vitest'
import { MARK_END, MARK_START, parseMarkedSnippet, windowMarked } from './search-snippet'

describe('windowMarked', () => {
  it('turns literal escapes and Markdown heading hashes into plain spacing', () => {
    const marked = `Intro text\\n## Estimated ${MARK_START}Complexity${MARK_END}\\n### Notes about it`
    const { text, ranges } = parseMarkedSnippet(windowMarked(marked))
    expect(text).not.toContain('\\n')
    expect(text).not.toContain('##')
    expect(text).toBe('Intro text Estimated Complexity Notes about it')
    expect(text.slice(ranges[0]![0], ranges[0]![1])).toBe('Complexity')
  })

  it('cleans the unmarked head too and keeps ticket references', () => {
    expect(windowMarked('# Title\\nSee #14 for details')).toBe('Title See #14 for details')
  })
})
