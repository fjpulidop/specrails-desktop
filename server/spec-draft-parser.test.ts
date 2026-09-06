import { describe, it, expect } from 'vitest'
import { parseSpecDraftBlocks, mergeDraft, applyBlocks } from './spec-draft-parser'

describe('parseSpecDraftBlocks', () => {
  it('returns text unchanged when no fenced block present', () => {
    const result = parseSpecDraftBlocks('Just plain text with no fences.')
    expect(result.stripped).toBe('Just plain text with no fences.')
    expect(result.blocks).toEqual([])
  })

  it('handles empty input gracefully', () => {
    expect(parseSpecDraftBlocks('').blocks).toEqual([])
    expect(parseSpecDraftBlocks(undefined as unknown as string).blocks).toEqual([])
  })

  it('strips a valid block and returns the parsed payload', () => {
    const text = [
      'Settings page is fine.',
      '',
      '```spec-draft',
      '{"title":"Add dark mode","priority":"medium","ready":false}',
      '```',
      '',
      'What about persistence?',
    ].join('\n')
    const result = parseSpecDraftBlocks(text)
    expect(result.stripped).toContain('Settings page is fine.')
    expect(result.stripped).toContain('What about persistence?')
    expect(result.stripped).not.toContain('spec-draft')
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0].partial.title).toBe('Add dark mode')
    expect(result.blocks[0].partial.priority).toBe('medium')
    expect(result.blocks[0].ready).toBe(false)
  })

  it('drops malformed JSON without throwing', () => {
    const text = '```spec-draft\nnot json at all\n```'
    const result = parseSpecDraftBlocks(text)
    expect(result.stripped).not.toContain('spec-draft')
    expect(result.blocks).toEqual([])
  })

  it('drops unknown fields and invalid priority', () => {
    const text = '```spec-draft\n{"title":"X","foo":"bar","priority":"weird"}\n```'
    const result = parseSpecDraftBlocks(text)
    expect(result.blocks[0].partial.title).toBe('X')
    expect(result.blocks[0].partial).not.toHaveProperty('foo')
    expect(result.blocks[0].partial.priority).toBeUndefined()
  })

  it('coerces labels and acceptanceCriteria to string arrays', () => {
    const text = '```spec-draft\n{"labels":["ui",42,"theme",null],"acceptanceCriteria":["a","b"]}\n```'
    const result = parseSpecDraftBlocks(text)
    expect(result.blocks[0].partial.labels).toEqual(['ui', 'theme'])
    expect(result.blocks[0].partial.acceptanceCriteria).toEqual(['a', 'b'])
  })

  it('parses chips and ready flag', () => {
    const text = '```spec-draft\n{"chips":["yes","no"],"ready":true}\n```'
    const result = parseSpecDraftBlocks(text)
    expect(result.blocks[0].chips).toEqual(['yes', 'no'])
    expect(result.blocks[0].ready).toBe(true)
  })

  it('parses multiple blocks in order', () => {
    const text = [
      '```spec-draft', '{"title":"A"}', '```',
      'middle',
      '```spec-draft', '{"title":"B","ready":true}', '```',
    ].join('\n')
    const result = parseSpecDraftBlocks(text)
    expect(result.blocks).toHaveLength(2)
    expect(result.blocks[0].partial.title).toBe('A')
    expect(result.blocks[1].partial.title).toBe('B')
    expect(result.stripped).toContain('middle')
  })

  it('rejects non-object payloads (arrays, primitives)', () => {
    expect(parseSpecDraftBlocks('```spec-draft\n[1,2,3]\n```').blocks).toEqual([])
    expect(parseSpecDraftBlocks('```spec-draft\n"a string"\n```').blocks).toEqual([])
    expect(parseSpecDraftBlocks('```spec-draft\n42\n```').blocks).toEqual([])
  })
})

describe('mergeDraft', () => {
  it('keeps prior values when next is missing', () => {
    const merged = mergeDraft({ title: 'Old', priority: 'low' }, {})
    expect(merged.title).toBe('Old')
    expect(merged.priority).toBe('low')
  })

  it('treats empty strings as no-op', () => {
    const merged = mergeDraft({ title: 'Old' }, { title: '', description: 'New' })
    expect(merged.title).toBe('Old')
    expect(merged.description).toBe('New')
  })

  it('replaces arrays (does not append)', () => {
    const merged = mergeDraft({ labels: ['ui'] }, { labels: ['theme'] })
    expect(merged.labels).toEqual(['theme'])

    const cleared = mergeDraft({ labels: ['ui'] }, { labels: [] })
    expect(cleared.labels).toEqual([])
  })

  it('ignores invalid priority values', () => {
    const merged = mergeDraft({ priority: 'low' }, { priority: 'weird' as unknown as 'high' })
    expect(merged.priority).toBe('low')
  })
})

describe('applyBlocks', () => {
  it('returns prev unchanged when blocks is empty', () => {
    const prev = { draft: { title: 'X' }, ready: false, chips: [], lastChangedFields: [] }
    expect(applyBlocks(prev, [])).toBe(prev)
  })

  it('initialises state when prev is undefined', () => {
    const result = applyBlocks(undefined, [{ partial: { title: 'X' }, ready: false, chips: [] }])
    expect(result.draft.title).toBe('X')
    expect(result.lastChangedFields).toContain('title')
  })

  it('applies multiple blocks in order, last ready wins', () => {
    const result = applyBlocks(undefined, [
      { partial: { title: 'A' }, ready: false, chips: [] },
      { partial: { title: 'B' }, ready: true, chips: ['c1'] },
    ])
    expect(result.draft.title).toBe('B')
    expect(result.ready).toBe(true)
    expect(result.chips).toEqual(['c1'])
  })

  it('reports changed fields between prior and new merged state', () => {
    const prev = applyBlocks(undefined, [{ partial: { title: 'A', priority: 'low' }, ready: false, chips: [] }])
    const next = applyBlocks(prev, [{ partial: { priority: 'high' }, ready: false, chips: [] }])
    expect(next.lastChangedFields).toEqual(['priority'])
  })

  it('keeps existing chips when latest block has none', () => {
    const prev = applyBlocks(undefined, [{ partial: {}, ready: false, chips: ['a'] }])
    const next = applyBlocks(prev, [{ partial: { title: 'X' }, ready: false, chips: [] }])
    expect(next.chips).toEqual(['a'])
  })

  it('caps chips at 3', () => {
    const result = applyBlocks(undefined, [
      { partial: {}, ready: false, chips: ['a', 'b', 'c', 'd', 'e'] },
    ])
    expect(result.chips).toHaveLength(3)
  })
})


describe('repository scope in draft streams', () => {
  it('merges valid selections, reports the changed field and preserves it when omitted', () => {
    const parsed = parseSpecDraftBlocks('```spec-draft\n{"repositoryIds":["primary-p","api"]}\n```')
    const state = applyBlocks(undefined, parsed.blocks)
    expect(state.draft.repositoryIds).toEqual(['primary-p', 'api'])
    expect(state.lastChangedFields).toContain('repositoryIds')
    expect(mergeDraft(state.draft, { title: 'Cross-repository feature' }).repositoryIds).toEqual(['primary-p', 'api'])
  })

  it.each([[], ['x', 'x'], [''], ['x', 2], null].map((repositoryIds) => ({ repositoryIds })))('does not silently normalize invalid scope $repositoryIds', ({ repositoryIds }) => {
    const parsed = parseSpecDraftBlocks('```spec-draft\n' + JSON.stringify({ repositoryIds }) + '\n```')
    expect(parsed.blocks[0].partial.repositoryIds).toBeUndefined()
  })
})
