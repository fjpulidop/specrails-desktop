import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PacketDerivation } from './PacketDerivation'

const full = { status: 'available' as const, change: 'kanban-board', files: 5, explained: 5, unexplainedFiles: [], unexplainedOmitted: 0, confidence: 'high' as const, requirementsAdded: 2, requirementsModified: 1, tasks: 3, transcriptTurnsUsed: 4 }

describe('PacketDerivation', () => {
  it('shows full coverage without an unexplained list', () => {
    render(<PacketDerivation derivation={full} />)
    expect(screen.getByTestId('packet-derivation-coverage').textContent).toContain('5')
    expect(screen.queryByTestId('packet-derivation-unexplained')).toBeNull()
    expect(screen.getByText('kanban-board')).toBeTruthy()
  })

  it('lists unexplained files and the remainder', () => {
    const files = Array.from({ length: 14 }, (_, i) => `src/f${i}.ts`)
    render(<PacketDerivation derivation={{ ...full, explained: 1, unexplainedFiles: files, unexplainedOmitted: 3 }} />)
    expect(screen.getByTestId('packet-derivation-unexplained').querySelectorAll('li')).toHaveLength(12)
    expect(screen.getByText('src/f0.ts')).toBeTruthy()
    expect(screen.queryByText('src/f13.ts')).toBeNull()
  })

  it('says when the report is missing and when the spec rewrite failed', () => {
    render(<PacketDerivation derivation={{ status: 'unavailable' }} settlement={{ specRewrite: 'failed', jiraCreate: 'done', jiraReview: 'done' }} />)
    expect(screen.getByTestId('packet-derivation')).toBeTruthy()
    expect(screen.getByTestId('packet-derivation-rewrite-failed')).toBeTruthy()
  })
})
