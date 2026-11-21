import { describe, expect, it } from 'vitest'
import { allocateBudgetFairly, clipOnLineBoundary, splitDiffIntoFileSections, truncateDiffForPrompt } from './diff-prompt-budget'

function fileDiff(name: string, lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => `+line ${i} of ${name}`).join('\n')
  return `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -0,0 +1,${lines} @@\n${body}\n`
}

describe('allocateBudgetFairly', () => {
  it('gives small items what they need and redistributes the rest', () => {
    expect(allocateBudgetFairly([10, 1000, 20], 300)).toEqual([10, 270, 20])
  })

  it('splits evenly among items that all want more', () => {
    expect(allocateBudgetFairly([500, 500], 300)).toEqual([150, 150])
  })

  it('never exceeds the budget and handles tiny budgets', () => {
    const grants = allocateBudgetFairly([5, 5, 5], 2)
    expect(grants.reduce((a, b) => a + b, 0)).toBe(2)
    expect(allocateBudgetFairly([5, 5], 0)).toEqual([0, 0])
  })
})

describe('splitDiffIntoFileSections', () => {
  it('splits at diff --git headers and preserves the bytes', () => {
    const diff = fileDiff('a.ts', 2) + fileDiff('b.ts', 3)
    const sections = splitDiffIntoFileSections(diff)
    expect(sections).toHaveLength(2)
    expect(sections.join('')).toBe(diff)
    expect(sections[1].startsWith('diff --git a/b.ts')).toBe(true)
  })
})

describe('clipOnLineBoundary', () => {
  it('cuts at a newline and marks the omission', () => {
    const text = 'aaaa\nbbbb\ncccc\ndddd\n'.repeat(10)
    const out = clipOnLineBoundary(text, 120)
    expect(out.length).toBeLessThanOrEqual(120)
    expect(out).toMatch(/…\(diff truncated, \d+ characters omitted\)\n$/)
    const kept = out.slice(0, out.indexOf('\n…('))
    expect(text.startsWith(kept)).toBe(true)
    expect(text[kept.length]).toBe('\n')
  })

  it('returns short text unchanged', () => {
    expect(clipOnLineBoundary('abc', 10)).toBe('abc')
  })
})

describe('truncateDiffForPrompt', () => {
  it('returns a fitting diff unchanged', () => {
    const diff = fileDiff('a.ts', 3)
    expect(truncateDiffForPrompt(diff, 10_000)).toEqual({ text: diff, truncatedFiles: 0, omittedFiles: 0, totalFiles: 1 })
  })

  it('keeps small files whole when a lockfile is huge', () => {
    const diff = fileDiff('package-lock.json', 5000) + fileDiff('src/app.ts', 5) + fileDiff('src/util.ts', 4)
    const out = truncateDiffForPrompt(diff, 4000)
    expect(out.text.length).toBeLessThanOrEqual(4000)
    expect(out.text).toContain(fileDiff('src/app.ts', 5))
    expect(out.text).toContain(fileDiff('src/util.ts', 4))
    expect(out.text).toContain('diff --git a/package-lock.json')
    expect(out.truncatedFiles).toBe(1)
    expect(out.totalFiles).toBe(3)
    expect(out.text).toContain('1 of 3 files truncated')
  })

  it('reports omitted files when the budget cannot hold every header', () => {
    const diff = Array.from({ length: 40 }, (_, i) => fileDiff(`f${i}.ts`, 50)).join('')
    const out = truncateDiffForPrompt(diff, 500)
    expect(out.text.length).toBeLessThanOrEqual(500)
    expect(out.omittedFiles + out.truncatedFiles).toBe(40)
    expect(out.text).toMatch(/omitted\)\n$/)
  })

  it('clips a single-file diff on a line boundary', () => {
    const diff = fileDiff('a.ts', 1000)
    const out = truncateDiffForPrompt(diff, 1000)
    expect(out.text.length).toBeLessThanOrEqual(1000)
    expect(out.truncatedFiles).toBe(1)
    expect(out.text.startsWith('diff --git a/a.ts')).toBe(true)
  })
})
