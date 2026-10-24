import { describe, it, expect } from 'vitest'
import { humaniseCommand, humaniseJobCrumb } from '../humanise-command'

describe('humaniseCommand', () => {
  const titles = { 15: 'Add achievements' }
  it('names the loop, ticket and title', () => {
    expect(humaniseCommand('/specrails:implement #15', titles)).toBe('Implement · #15 Add achievements')
  })
  it('names only the loop when the ticket header already shows the title', () => {
    expect(humaniseCommand('/specrails:implement #15', titles, { omitTitle: true })).toBe('Implement')
  })
})

describe('humaniseJobCrumb', () => {
  it('builds "Implement · #15" without a title', () => {
    expect(humaniseJobCrumb('/specrails:implement #15')).toBe('Implement · #15')
  })
  it('returns null for an unrecognised command', () => {
    expect(humaniseJobCrumb('echo hi')).toBeNull()
  })
})
