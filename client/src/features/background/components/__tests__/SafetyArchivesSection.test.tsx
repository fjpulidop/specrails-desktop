import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SafetyArchivesSection } from '../SafetyArchivesSection'

const A = '/h/.specrails/projects/one/worktrees/r1/ticket-1.specrails-overlay-quarantine-AAAAAA'
const B = '/h/.specrails/projects/two/worktrees/r2/ticket-2.specrails-overlay-quarantine-BBBBBB'
let remaining: string[] = []
let removed: unknown = null

function item(projectId: string, projectName: string, path: string) {
  return { projectId, projectName, path, worktreeName: path.includes('ticket-1') ? 'ticket-1' : 'ticket-2', createdAt: Date.now() - 3 * 86_400_000, fileCount: 1, bytes: 2048, files: [{ path: 'CLAUDE.md', kind: 'file', bytes: 2048 }], truncated: false }
}

beforeEach(() => {
  remaining = [A, B]
  removed = null
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/worktrees/quarantines/remove')) {
      removed = JSON.parse(String(init?.body))
      remaining = []
      return new Response(JSON.stringify({ results: [{ projectId: 'one', path: A, status: 'deleted' }, { projectId: 'two', path: B, status: 'deleted' }] }), { status: 200 })
    }
    return new Response(JSON.stringify({
      generatedAt: new Date().toISOString(),
      projects: [{ projectId: 'one', projectName: 'One' }, { projectId: 'two', projectName: 'Two' }],
      items: [item('one', 'One', A), item('two', 'Two', B)].filter((entry) => remaining.includes(entry.path)),
    }), { status: 200 })
  }) as unknown as typeof fetch
})

describe('SafetyArchivesSection', () => {
  it('lists archives across projects with age and size, and bulk-deletes after confirmation', async () => {
    render(<SafetyArchivesSection active />)
    const rows = await screen.findAllByTestId('safety-archive-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('ticket-1 · 1 file')
    expect(rows[0]).toHaveTextContent('Kept 3 days ago · 2.0 KB')
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    fireEvent.click(screen.getByTestId('safety-archives-delete-selected'))
    const dialog = await screen.findByTestId('safety-archive-confirm')
    expect(dialog).toHaveTextContent('2 folders')
    fireEvent.click(screen.getByTestId('safety-archive-confirm-button'))
    await waitFor(() => expect(screen.getByTestId('safety-archives-result')).toHaveTextContent('2 deleted, 0 not deleted.'))
    expect(removed).toEqual({ items: [{ projectId: 'one', path: A }, { projectId: 'two', path: B }] })
    await waitFor(() => expect(screen.queryAllByTestId('safety-archive-row')).toHaveLength(0))
  })
})
