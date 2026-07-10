import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FileTree } from '../FileTree'
import { SharedWebSocketContext } from '../../../hooks/useSharedWebSocket'

const openTicketDetail = vi.fn()

vi.mock('../../../context/TicketDetailModalContext', () => ({
  useTicketDetailModal: () => ({ openTicketDetail }),
}))

vi.mock('../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ activeProjectId: 'p1' }),
}))

const fakeWs = {
  registerHandler: vi.fn(),
  unregisterHandler: vi.fn(),
  connectionStatus: 'connected' as const,
}

function wrap(ui: React.ReactNode) {
  return (
    <SharedWebSocketContext.Provider value={fakeWs}>{ui}</SharedWebSocketContext.Provider>
  )
}

beforeEach(() => {
  openTicketDetail.mockClear()
  fakeWs.registerHandler.mockClear()
  fakeWs.unregisterHandler.mockClear()
})

describe('FileTree', () => {
  it('renders empty-state CTA when no entries on touched-by-ai filter', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ entries: [] }) }) as never
    render(wrap(<FileTree onOpenFile={() => {}} selectedPath={null} />))
    await waitFor(() => {
      expect(screen.getByText(/No AI-touched files/)).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('Show all files'))
    await waitFor(() => {
      expect((screen.getByText('All files') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true')
    })
  })

  it('renders virtualised rows and provenance chip opens ticket modal', async () => {
    const entries = [
      {
        path: 'src/foo.ts',
        kind: 'file',
        provenance: {
          createdByTicketId: 42,
          modifiedByTicketIds: [7],
          latest: { path: 'src/foo.ts', ticketId: 7, jobId: 'job-1234567890', kind: 'modified', at: 1000 },
        },
      },
      { path: 'src/bar.ts', kind: 'file', provenance: { modifiedByTicketIds: [] } },
    ]
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ entries }) }) as never
    render(wrap(<FileTree onOpenFile={() => {}} selectedPath={null} />))
    await waitFor(() => {
      expect(screen.getByTestId('file-tree-scroller')).toBeInTheDocument()
    })
    const chip = await screen.findByTestId('provenance-chip-created-42')
    fireEvent.click(chip)
    expect(openTicketDetail).toHaveBeenCalledWith(42)
    expect(screen.getByText('changed')).toBeInTheDocument()
    expect(screen.getByText('job-123456')).toBeInTheDocument()
  })

  it('opens files with Enter and toggles folders with Space', async () => {
    const onOpenFile = vi.fn()
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ entries: [
        { path: 'src', kind: 'dir', provenance: { modifiedByTicketIds: [] } },
        { path: 'src/foo.ts', kind: 'file', provenance: { modifiedByTicketIds: [] } },
      ] }),
    }) as never
    render(wrap(<FileTree onOpenFile={onOpenFile} selectedPath={null} />))

    const fileRow = await screen.findByTestId('file-tree-row-src/foo.ts')
    fireEvent.keyDown(fileRow, { key: 'Enter' })
    expect(onOpenFile).toHaveBeenCalledWith('src/foo.ts')

    const folderRow = screen.getByTestId('file-tree-row-src')
    expect(folderRow).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(folderRow, { key: ' ' })
    await waitFor(() => expect(folderRow).toHaveAttribute('aria-expanded', 'false'))
  })

  it('follows server cursor pagination so no entries past the first page are lost', async () => {
    const page1 = { entries: [{ path: 'src/a.ts', kind: 'file', provenance: { modifiedByTicketIds: [] } }], nextCursor: 'cur1' }
    const page2 = { entries: [{ path: 'src/b.ts', kind: 'file', provenance: { modifiedByTicketIds: [] } }], nextCursor: null }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => page1 })
      .mockResolvedValueOnce({ ok: true, json: async () => page2 })
    global.fetch = fetchMock as never
    render(wrap(<FileTree onOpenFile={() => {}} selectedPath={null} />))
    await waitFor(() => {
      expect(screen.getByText('a.ts')).toBeInTheDocument()
      expect(screen.getByText('b.ts')).toBeInTheDocument()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0] as string).toContain('cursor=cur1')
  })

  it('switches filter without crashing', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ entries: [] }) }) as never
    render(wrap(<FileTree onOpenFile={() => {}} selectedPath={null} />))
    fireEvent.click(screen.getByText('All files'))
    await waitFor(() => {
      expect((screen.getByText('All files') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true')
    })
  })
})
