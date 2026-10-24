import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import type { ChangesPayload, FileDiff } from '../../../lib/changes-model'

vi.mock('../../../../../hooks/useDesktop', () => ({ useDesktop: () => ({ activeProjectId: 'proj-1' }) }))
vi.mock('../../../../../lib/api', () => ({ getApiBase: () => '/api/projects/proj-1' }))
const mockOpenTicketDetail = vi.fn()
vi.mock('../../../../specs/context/TicketDetailModalContext', () => ({
  useTicketDetailModal: () => ({ openTicketDetail: mockOpenTicketDetail }),
}))
const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }))
const openExternalUrl = vi.fn(async () => {})
vi.mock('../../../../../lib/tauri-shell', () => ({ openExternalUrl: (url: string) => openExternalUrl(url) }))

import { ChangesTab } from '../ChangesTab'

const files = [
  { path: 'src/a.ts', oldPath: null, status: 'modified' as const, additions: 2, deletions: 1, binary: false, hash: 'a1' },
  { path: 'src/b.ts', oldPath: null, status: 'added' as const, additions: 1, deletions: 0, binary: false, hash: 'b1' },
  { path: 'logo.png', oldPath: null, status: 'modified' as const, additions: null, deletions: null, binary: true, hash: 'l1' },
]

function payload(over: Partial<Extract<ChangesPayload, { available: true }>> = {}): ChangesPayload {
  return {
    available: true, source: 'delivery', sources: [{ id: 'delivery', ticketId: null, branch: 'feat/x' }],
    base: 'main', head: 'feat/x', baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40), root: '/repo', rootKind: 'repository',
    files, truncated: false, totals: { files: 3, additions: 3, deletions: 1 },
    annotations: [
      { id: 'finding:1:0', source: 'reviewer-finding', text: 'Guard against null', severity: null, author: null, location: { path: 'src/a.ts', line: 2, endLine: null } },
      { id: 'finding:1:1', source: 'reviewer-finding', text: 'Old style finding', severity: null, author: null, location: null },
      { id: 'finding:1:2', source: 'reviewer-finding', text: 'On b', severity: null, author: null, location: { path: 'src/b.ts', line: 1, endLine: null } },
    ],
    ...over,
  }
}

function bigDiff(path: string, count: number): FileDiff {
  return {
    path, oldPath: null, status: 'modified', binary: false, truncated: false, totalLines: count,
    hunks: [{ header: `@@ -1,${count} +1,${count} @@`, oldStart: 1, oldLines: count, newStart: 1, newLines: count,
      lines: Array.from({ length: count }, (_, i) => ({ type: 'add' as const, oldNo: null, newNo: i + 1, text: `line ${i + 1}` })) }],
  }
}

const smallDiff = (path: string): FileDiff => ({
  path, oldPath: null, status: 'modified', binary: false, truncated: false, totalLines: 3,
  hunks: [{ header: '@@ -1,2 +1,3 @@', oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [
    { type: 'context', oldNo: 1, newNo: 1, text: 'one' },
    { type: 'add', oldNo: null, newNo: 2, text: 'two' },
    { type: 'add', oldNo: null, newNo: 3, text: 'three' },
  ] }],
})

let diffFor: (path: string) => FileDiff
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  localStorage.clear()
  toastSuccess.mockClear(); toastError.mockClear(); openExternalUrl.mockClear(); mockOpenTicketDetail.mockClear()
  diffFor = smallDiff
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return { ok: true, json: async () => ({ addendum: { id: 'ad-1' } }) }
    if (url.includes('/changes/file')) {
      const path = new URL(url, 'http://x').searchParams.get('path')!
      return { ok: true, json: async () => ({ diff: diffFor(path) }) }
    }
    return { ok: true, json: async () => ({ changes: payload() }) }
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

const tickets = [{ ticketId: 7, label: '#7 Add login' }]
const renderTab = (active = true) => render(<ChangesTab prDeliveryId="del-1" repositoryId={null} tickets={tickets} active={active} />)
const selectedRow = () => screen.getByRole('treeitem', { selected: true })

describe('ChangesTab', () => {
  it('does not touch the network until the tab is shown', () => {
    renderTab(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows the tree with counts, loads the first file lazily and lists unanchored findings on top', async () => {
    renderTab()
    expect(await screen.findByRole('tree')).toBeInTheDocument()
    expect(await screen.findByText('two')).toBeInTheDocument()
    // only the list and the one selected file were requested
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls.filter((u) => u.includes('/changes/file'))).toHaveLength(1)
    expect(within(selectedRow()).getByText('a.ts')).toBeInTheDocument()
    // unanchored fallback: the finding without a location is listed, not dropped
    const unanchored = screen.getByTestId('changes-unanchored')
    expect(within(unanchored).getByText('Old style finding')).toBeInTheDocument()
    // the located finding sits under its line in the diff
    expect(screen.getByText('Guard against null')).toBeInTheDocument()
    expect(screen.getByTestId('changes-viewed-count')).toHaveTextContent('0')
  })

  it('walks files with j/k and annotations with n/p, but never while typing', async () => {
    renderTab()
    await screen.findByText('two')
    fireEvent.keyDown(window, { key: 'j' })
    await waitFor(() => expect(within(selectedRow()).getByText('b.ts')).toBeInTheDocument())
    fireEvent.keyDown(window, { key: 'k' })
    await waitFor(() => expect(within(selectedRow()).getByText('a.ts')).toBeInTheDocument())

    // n jumps to the first located annotation (in a.ts), then on to the next file's
    fireEvent.keyDown(window, { key: 'n' })
    await waitFor(() => expect(screen.getByText('Guard against null').closest('[data-annotation-id]')).toHaveAttribute('data-active', 'true'))
    fireEvent.keyDown(window, { key: 'n' })
    await waitFor(() => expect(within(selectedRow()).getByText('b.ts')).toBeInTheDocument())
    fireEvent.keyDown(window, { key: 'p' })
    await waitFor(() => expect(within(selectedRow()).getByText('a.ts')).toBeInTheDocument())

    const input = document.createElement('textarea')
    document.body.appendChild(input)
    fireEvent.keyDown(input, { key: 'j' })
    expect(within(selectedRow()).getByText('a.ts')).toBeInTheDocument()
    input.remove()
  })

  it('does not react to the keys while the tab is hidden', async () => {
    const { rerender } = renderTab()
    await screen.findByText('two')
    rerender(<ChangesTab prDeliveryId="del-1" repositoryId={null} tickets={tickets} active={false} />)
    fireEvent.keyDown(window, { key: 'j' })
    expect(within(selectedRow()).getByText('a.ts')).toBeInTheDocument()
  })

  it('marks a file viewed (also with v), shows the count and keeps it across a reload', async () => {
    const first = renderTab()
    await screen.findByText('two')
    fireEvent.click(screen.getByTestId('changes-mark-viewed'))
    expect(screen.getByTestId('changes-viewed-count')).toHaveTextContent('1')
    fireEvent.keyDown(window, { key: 'j' })
    await screen.findByRole('treeitem', { selected: true, name: /b\.ts/ })
    fireEvent.keyDown(window, { key: 'v' })
    expect(screen.getByTestId('changes-viewed-count')).toHaveTextContent('2')
    first.unmount()
    renderTab()
    await screen.findByText('two')
    expect(screen.getByTestId('changes-viewed-count')).toHaveTextContent('2')
  })

  it('invalidates a viewed mark when the file content hash changes', async () => {
    localStorage.setItem('specrails-desktop:review-viewed:proj-1:del-1', JSON.stringify({ 'src/a.ts': 'OLD-HASH' }))
    renderTab()
    await screen.findByText('two')
    expect(screen.getByTestId('changes-viewed-count')).toHaveTextContent('0')
    expect(screen.getByTestId('changes-mark-viewed')).toHaveTextContent(/changed since/i)
  })

  it('selects lines, files an addendum with path:lines + snippet + note, and links the toast to the spec', async () => {
    renderTab()
    await screen.findByText('two')
    fireEvent.click(screen.getByRole('button', { name: /Select line 2/ }))
    fireEvent.click(screen.getByRole('button', { name: /Select line 3/ }), { shiftKey: true })
    expect(screen.getByTestId('changes-selection-bar')).toHaveTextContent('src/a.ts:2-3')
    fireEvent.click(screen.getByTestId('changes-ask-button'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Rename these' } })
    fireEvent.click(screen.getByTestId('changes-ask-submit'))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST')!
    expect(String(post[0])).toBe('/api/projects/proj-1/tickets/7/addenda')
    const body = JSON.parse((post[1] as RequestInit).body as string)
    expect(body.kind).toBe('review-feedback')
    expect(body.title).toBe('Review: src/a.ts:2-3')
    expect(body.body).toContain('two\nthree')
    expect(body.body).toContain('Rename these')
    const options = toastSuccess.mock.calls[0][1] as { action: { onClick: () => void } }
    options.action.onClick()
    expect(mockOpenTicketDetail).toHaveBeenCalledWith(7)
  })

  it('files an annotation as an addendum from its own button, prefilled with its text', async () => {
    renderTab()
    await screen.findByText('two')
    const card = screen.getByText('Guard against null').closest('[data-annotation-id]') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: /Ask agent to fix this/ }))
    expect(screen.getByRole('textbox')).toHaveValue('Guard against null')
    fireEvent.click(screen.getByTestId('changes-ask-submit'))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST')!
    expect(JSON.parse((post[1] as RequestInit).body as string).title).toBe('Review: src/a.ts:2')
  })

  it('reports a failed addendum without losing the note', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: false, json: async () => ({}) }
      if (url.includes('/changes/file')) return { ok: true, json: async () => ({ diff: smallDiff('src/a.ts') }) }
      return { ok: true, json: async () => ({ changes: payload() }) }
    })
    renderTab()
    await screen.findByText('two')
    fireEvent.click(screen.getByRole('button', { name: /Select line 2/ }))
    fireEvent.click(screen.getByTestId('changes-ask-button'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep me' } })
    fireEvent.click(screen.getByTestId('changes-ask-submit'))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(screen.getByRole('textbox')).toHaveValue('keep me')
  })

  it('opens the file in the chosen editor at the selected line', async () => {
    renderTab()
    await screen.findByText('two')
    fireEvent.click(screen.getByRole('button', { name: /Select line 3/ }))
    fireEvent.click(screen.getByTestId('changes-open-editor'))
    expect(openExternalUrl).toHaveBeenCalledWith('vscode://file/repo/src/a.ts:3')
  })

  it('virtualises a large diff: only a window of rows is mounted', async () => {
    diffFor = (path) => bigDiff(path, 20_000)
    renderTab()
    await screen.findByText('line 1')
    const mounted = document.querySelectorAll('[data-testid="changes-diff"] [data-index]').length
    expect(mounted).toBeGreaterThan(5)
    expect(mounted).toBeLessThan(200)
    expect(screen.queryByText('line 19999')).not.toBeInTheDocument()
  })

  it('offers the full diff of a capped file', async () => {
    diffFor = (path) => ({ ...smallDiff(path), truncated: true, totalLines: 9000 })
    renderTab()
    expect(await screen.findByTestId('changes-truncated')).toHaveTextContent('9000')
    fireEvent.click(screen.getByRole('button', { name: /Load full file diff/ }))
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('full=1'))).toBe(true))
  })

  it('shows binary files as such without requesting a diff', async () => {
    renderTab()
    await screen.findByText('two')
    fireEvent.click(screen.getByRole('treeitem', { name: /logo\.png/ }))
    expect(await screen.findByTestId('changes-binary')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('path=logo.png'))).toBe(false)
  })

  it('explains an unavailable comparison and still lists the findings', async () => {
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ changes: { available: false, reason: 'head_missing', sources: [], annotations: payload().annotations } }) }))
    renderTab()
    expect(await screen.findByTestId('changes-unavailable')).toHaveTextContent(/no longer exists/)
    expect(screen.getByText('Old style finding')).toBeInTheDocument()
  })

  it('persists the split/unified layout per viewer', async () => {
    renderTab()
    await screen.findByText('two')
    fireEvent.click(screen.getByRole('radio', { name: /Split/ }))
    expect(localStorage.getItem('specrails-desktop:review-diff-mode')).toBe('split')
    await act(async () => {})
  })

  it('gives the tree an accessible structure', async () => {
    renderTab()
    await screen.findByText('two')
    expect(screen.getByRole('tree', { name: 'Changed files' })).toBeInTheDocument()
    const items = screen.getAllByRole('treeitem')
    expect(items.every((item) => item.hasAttribute('aria-level'))).toBe(true)
    expect(screen.getByRole('treeitem', { name: /src/ })).toHaveAttribute('aria-expanded', 'true')
  })
})
