import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FileTree } from '../FileTree'
import { purgeProjectCache } from '../../../hooks/useProjectCache'
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
  localStorage.clear()
  purgeProjectCache('p1')
  HTMLElement.prototype.scrollTo = vi.fn()
  openTicketDetail.mockClear()
  fakeWs.registerHandler.mockClear()
  fakeWs.unregisterHandler.mockClear()
})

describe('FileTree', () => {
  it('renders empty-state CTA when no entries on touched-by-ai filter', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ entries: [] }) }) as never
    render(wrap(<FileTree onOpenFile={() => {}} selectedPath={null} />))
    fireEvent.click(screen.getByText('Touched by AI'))
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

describe('FileTree exploration reliability', () => {
  it('defaults to all files for a project with no AI history', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ entries: [{ path: 'README.md', kind: 'file' }] }) })
    render(wrap(<FileTree onOpenFile={() => {}} selectedPath={null} />))
    expect(await screen.findByText('README.md')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'All files' })).toHaveAttribute('aria-pressed', 'true')
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('filter=all')
  })

  it('shows a failed page as an error and retries instead of reporting an empty repository', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValue({ ok: true, json: async () => ({ entries: [{ path: 'recovered.ts', kind: 'file' }] }) })
    render(wrap(<FileTree onOpenFile={() => {}} selectedPath={null} />))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the file tree')
    expect(screen.queryByText('No files.')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('recovered.ts')).toBeInTheDocument()
  })

  it('reports a truncated scan and repeated cursors without looping or hiding the limit', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ entries: [{ path: 'partial.ts', kind: 'file' }], nextCursor: 'repeat', truncated: true }) })
    render(wrap(<FileTree onOpenFile={() => {}} selectedPath={null} />))
    expect(await screen.findByText('partial.ts')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Partial file tree')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('navigates the virtual tree with arrows and opens the focused file', async () => {
    const onOpen = vi.fn()
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ entries: [
      { path: 'src', kind: 'dir' }, { path: 'src/a.ts', kind: 'file' }, { path: 'src/b.ts', kind: 'file' },
    ] }) })
    render(wrap(<FileTree onOpenFile={onOpen} selectedPath={null} />))
    const tree = await screen.findByRole('tree')
    fireEvent.keyDown(tree, { key: 'ArrowDown' })
    fireEvent.keyDown(tree, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith('src/a.ts')
    fireEvent.keyDown(tree, { key: 'End' })
    fireEvent.keyDown(tree, { key: 'Enter' })
    expect(onOpen).toHaveBeenLastCalledWith('src/b.ts')
    fireEvent.keyDown(tree, { key: 'ArrowLeft' })
    expect(screen.getByTestId('file-tree-row-src')).toHaveAttribute('id', tree.getAttribute('aria-activedescendant'))
  })

  it('cancels a paged request when the tree unmounts', async () => {
    let finish!: (value: unknown) => void
    global.fetch = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const view = render(wrap(<FileTree onOpenFile={() => {}} selectedPath={null} />))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal
    view.unmount()
    expect(signal?.aborted).toBe(true)
    finish({ ok: true, json: async () => ({ entries: [], nextCursor: 'page-2' }) })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
