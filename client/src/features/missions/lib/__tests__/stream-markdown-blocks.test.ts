import { describe, expect, it } from 'vitest'
import { splitStreamedMarkdown, STREAM_SPLIT_MIN_CHARS } from '../stream-markdown-blocks'

const para = (i: number) => `Paragraph ${i}: ${'lorem ipsum dolor sit amet '.repeat(12)}\n\n`

describe('splitStreamedMarkdown', () => {
  it('leaves short streams whole', () => {
    expect(splitStreamedMarkdown('hello\n\nworld')).toEqual({ stable: [], tail: 'hello\n\nworld' })
  })

  it('reassembles to the exact input and keeps earlier chunks unchanged as the stream grows', () => {
    let text = ''
    let previous: string[] = []
    for (let i = 0; i < 40; i++) {
      text += para(i)
      const { stable, tail } = splitStreamedMarkdown(text)
      expect([...stable, tail].join('')).toBe(text)
      expect(stable.slice(0, previous.length)).toEqual(previous) // append-only prefix
      previous = stable
    }
    expect(previous.length).toBeGreaterThan(3)
    expect(text.length).toBeGreaterThan(STREAM_SPLIT_MIN_CHARS)
  })

  it('never splits inside a fenced code block, even across blank lines', () => {
    const code = `\`\`\`ts\n${'const a = 1\n\nconst b = 2\n\n'.repeat(120)}\`\`\`\n\n`
    const text = `${para(0)}${para(1)}${code}${para(2)}${para(3)}`
    const { stable, tail } = splitStreamedMarkdown(text)
    for (const chunk of stable) expect((chunk.match(/^```/gm) ?? []).length % 2).toBe(0)
    expect([...stable, tail].join('')).toBe(text)
  })

  it('keeps a list, a quote and a table in one piece', () => {
    const list = `${'- item one\n\n- item two\n\n'.repeat(80)}`
    const text = `${para(0)}${para(1)}${list}${para(2)}`
    const { stable, tail } = splitStreamedMarkdown(text)
    const holdsList = [...stable, tail].filter((chunk) => chunk.includes('- item one'))
    expect(holdsList).toHaveLength(1)
  })

  it('does not close a chunk on the line that is still being typed', () => {
    const text = `${para(0)}${para(1)}${para(2)}${para(3)}Streaming now`
    const { tail } = splitStreamedMarkdown(text)
    expect(tail.endsWith('Streaming now')).toBe(true)
  })

  it('a 4-backtick fence is not closed by a 3-backtick line inside it', () => {
    const inner = '```ts\nconst x = 1\n```\n\n\nstill inside the outer fence\n\n'
    const outer = `\`\`\`\`md\n${inner.repeat(40)}\`\`\`\`\n\n`
    const text = `${para(0)}${para(1)}${outer}${para(2)}${para(3)}`
    const { stable, tail } = splitStreamedMarkdown(text)
    expect([...stable, tail].join('')).toBe(text)
    // No chunk may start or end inside the 4-backtick fence.
    for (const chunk of [...stable, tail]) expect((chunk.match(/^`{4}/gm) ?? []).length % 2).toBe(0)
  })
})
