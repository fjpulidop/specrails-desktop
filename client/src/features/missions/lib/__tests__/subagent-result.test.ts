import { describe, expect, it } from 'vitest'

import { resultPreview } from '../subagent-result'

describe('resultPreview', () => {
  it('reduces markdown to readable text for a collapsed row', () => {
    const markdown = [
      '**Dark Era has no backend yet.** It is a fresh scaffold.',
      '',
      '## Repo state',
      '- One commit, `234ea0a Initial commit`.',
      '- Real content: [README](./README.md) and *empty* `openspec/specs/`.',
      '> note',
      '```',
      'ls -la',
      '```',
    ].join('\n')
    expect(resultPreview(markdown)).toBe('Dark Era has no backend yet. It is a fresh scaffold. Repo state One commit, 234ea0a Initial commit. Real content: README and empty openspec/specs/. note ls -la')
  })

  it('keeps plain text and identifiers untouched', () => {
    expect(resultPreview('snake_case_name and 2 * 3 = 6')).toBe('snake_case_name and 2 * 3 = 6')
  })
})
