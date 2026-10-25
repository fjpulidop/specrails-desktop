import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor, act } from '../../../../test-utils'
import { useLocation } from 'react-router-dom'
import type { LocalTicket } from '../../../../types'
import type { SpecBulkHandlers } from '../../lib/bulk-actions'
import { getPaletteSurface, resetPaletteSurfaces } from '../../../../lib/palette-bridge'

const h = vi.hoisted(() => ({ activeId: 'proj-A' as string | null }))
vi.mock('../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    projects: [], activeProjectId: h.activeId, setActiveProjectId: () => {}, addProject: async () => null, removeProject: async () => {},
    isLoading: false, isSwitchingProject: false, setupProjectIds: new Set(), startSetupWizard: () => {}, completeSetupWizard: () => {},
  }),
}))
vi.mock('@dnd-kit/core', () => ({ useDroppable: () => ({ isOver: false, setNodeRef: vi.fn() }) }))
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  verticalListSortingStrategy: vi.fn(),
  useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), transform: null, transition: undefined, isDragging: false }),
}))
vi.mock('@dnd-kit/utilities', () => ({ CSS: { Transform: { toString: () => '' }, Translate: { toString: () => '' } } }))
vi.mock('../ProposeSpecModal', () => ({ ProposeSpecModal: () => null }))

import { SpecsBoard } from '../SpecsBoard'

function ticket(id: number, overrides: Partial<LocalTicket> = {}): LocalTicket {
  return {
    id, title: `Spec ${id}`, description: '', status: 'todo', priority: 'medium', labels: [], assignee: null, prerequisites: [], metadata: {},
    created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z', created_by: 'tester', source: 'manual', ...overrides,
  }
}

function handlers(overrides: Partial<SpecBulkHandlers> = {}): SpecBulkHandlers {
  return {
    jiraConnected: false,
    loadJiraStatuses: vi.fn(async () => ['To Do', 'Code Review']),
    allLabels: ['bug', 'ui'],
    onStatus: vi.fn(async () => {}),
    onLabel: vi.fn(async () => {}),
    onPriority: vi.fn(async () => {}),
    onMoveToRail: vi.fn(),
    onLaunch: vi.fn(),
    onDelete: vi.fn(async () => {}),
    ...overrides,
  }
}

const RAILS = [
  { id: 'rail-1', label: 'Rail 1', ticketIds: [], mode: 'implement' as const, status: 'idle' as const },
  { id: 'rail-2', label: 'Rail 2', ticketIds: [9], mode: 'implement' as const, status: 'running' as const },
]

function Probe() {
  const loc = useLocation()
  return <output data-testid="loc">{loc.search}</output>
}

const TODO = [ticket(1), ticket(2), ticket(3), ticket(4)]
const DONE = [ticket(20, { status: 'done' }), ticket(21, { status: 'done' })]

function renderBoard(opts: { bulk?: SpecBulkHandlers; tickets?: LocalTicket[]; doneTickets?: LocalTicket[]; route?: string; onTicketClick?: (t: LocalTicket) => void; viewTier?: 'row' | 'postit'; onSortChange?: () => void; onViewTierChange?: (t: 'row' | 'postit') => void } = {}) {
  const bulk = opts.bulk ?? handlers()
  const onTicketClick = opts.onTicketClick ?? vi.fn()
  const view = render(
    <>
      <SpecsBoard
        tickets={opts.tickets ?? TODO}
        doneTickets={opts.doneTickets ?? []}
        isLoading={false}
        onTicketClick={onTicketClick}
        viewTier={opts.viewTier ?? 'row'}
        onViewTierChange={opts.onViewTierChange}
        onSortChange={opts.onSortChange}
        rails={RAILS}
        bulk={bulk}
      />
      <Probe />
    </>,
    { route: opts.route },
  )
  return { ...view, bulk, onTicketClick }
}

const card = (id: number) => document.querySelector<HTMLElement>(`[data-ticket-id="${id}"]`)!
const bar = () => screen.queryByTestId('specs-bulk-bar')
const selectedIds = () => [...document.querySelectorAll<HTMLElement>('[data-ticket-id][aria-selected="true"]')].map((el) => Number(el.dataset.ticketId))

describe('SpecsBoard selection (CD4)', () => {
  beforeEach(() => {
    localStorage.clear()
    h.activeId = 'proj-A'
    resetPaletteSurfaces()
  })

  it('is a multi-select listbox and shows no bulk bar until something is selected', () => {
    renderBoard()
    const list = screen.getByTestId('specs-board-list')
    expect(list).toHaveAttribute('role', 'listbox')
    expect(list).toHaveAttribute('aria-multiselectable', 'true')
    expect(card(1)).toHaveAttribute('role', 'option')
    expect(card(1)).toHaveAttribute('aria-selected', 'false')
    expect(bar()).toBeNull()
  })

  it('stays a plain list without bulk handlers', () => {
    render(<SpecsBoard tickets={TODO} isLoading={false} onTicketClick={vi.fn()} viewTier="row" />)
    expect(screen.getByTestId('specs-board-list')).not.toHaveAttribute('role')
    expect(card(1)).toHaveAttribute('role', 'button')
  })

  it('x toggles the focused card and the toolbar announces the count', () => {
    renderBoard()
    fireEvent.keyDown(card(2), { key: 'x' })
    expect(selectedIds()).toEqual([2])
    const toolbar = screen.getByRole('toolbar', { name: 'Bulk actions, 1 spec selected' })
    expect(within(toolbar).getByTestId('specs-bulk-count')).toHaveTextContent('1 selected')
    fireEvent.keyDown(card(3), { key: 'x' })
    expect(screen.getByRole('toolbar', { name: 'Bulk actions, 2 specs selected' })).toBeInTheDocument()
    fireEvent.keyDown(card(2), { key: 'x' })
    expect(selectedIds()).toEqual([3])
    fireEvent.keyDown(card(3), { key: 'x' })
    expect(bar()).toBeNull()
  })

  it('x never selects while typing in the search field', () => {
    renderBoard()
    const search = screen.getByRole('searchbox')
    fireEvent.keyDown(search, { key: 'x' })
    fireEvent.keyDown(search, { key: 'a', ctrlKey: true })
    expect(selectedIds()).toEqual([])
    expect(bar()).toBeNull()
  })

  it('x with a modifier does nothing', () => {
    renderBoard()
    fireEvent.keyDown(card(1), { key: 'x', metaKey: true })
    fireEvent.keyDown(card(1), { key: 'x', ctrlKey: true })
    expect(selectedIds()).toEqual([])
  })

  it('⌘/Ctrl-click toggles without opening the spec; a plain click still opens it', () => {
    const { onTicketClick } = renderBoard()
    fireEvent.click(card(1), { metaKey: true })
    fireEvent.click(card(3), { ctrlKey: true })
    expect(selectedIds()).toEqual([1, 3])
    expect(onTicketClick).not.toHaveBeenCalled()
    fireEvent.click(card(3), { ctrlKey: true })
    expect(selectedIds()).toEqual([1])
    fireEvent.click(card(2))
    expect(onTicketClick).toHaveBeenCalledTimes(1)
  })

  it('Shift-click selects a range from the last toggled spec', () => {
    renderBoard()
    fireEvent.click(card(1), { metaKey: true })
    fireEvent.click(card(3), { shiftKey: true })
    expect(selectedIds()).toEqual([1, 2, 3])
  })

  it('the hover checkbox toggles a spec and is a real checkbox', () => {
    const { onTicketClick } = renderBoard()
    const box = screen.getByTestId('spec-select-2')
    expect(box).toHaveAttribute('role', 'checkbox')
    expect(box).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(box)
    expect(screen.getByTestId('spec-select-2')).toHaveAttribute('aria-checked', 'true')
    expect(onTicketClick).not.toHaveBeenCalled()
  })

  it('⌘A selects the whole focused column; the Done column is separate', () => {
    renderBoard({ doneTickets: DONE })
    // The All view shows both columns.
    fireEvent.click(screen.getByRole('radio', { name: /All/i }))
    fireEvent.keyDown(card(1), { key: 'a', metaKey: true })
    expect(selectedIds()).toEqual([1, 2, 3, 4])
    fireEvent.keyDown(card(1), { key: 'Escape' })
    expect(bar()).toBeNull()
    fireEvent.keyDown(card(20), { key: 'a', ctrlKey: true })
    expect(selectedIds()).toEqual([20, 21])
  })

  it('a Shift range never crosses columns', () => {
    renderBoard({ doneTickets: DONE })
    fireEvent.click(screen.getByRole('radio', { name: /All/i }))
    fireEvent.click(card(2), { metaKey: true })
    fireEvent.click(card(21), { shiftKey: true })
    expect(selectedIds()).toEqual([2, 21])
  })

  it('Escape clears the selection and is ignored when nothing is selected', () => {
    renderBoard()
    fireEvent.keyDown(card(1), { key: 'Escape' })
    expect(bar()).toBeNull()
    fireEvent.keyDown(card(1), { key: 'x' })
    expect(bar()).not.toBeNull()
    fireEvent.keyDown(card(1), { key: 'Escape' })
    expect(bar()).toBeNull()
    expect(selectedIds()).toEqual([])
  })

  it('drops specs a search hides from the selection', () => {
    renderBoard()
    fireEvent.click(card(1), { metaKey: true })
    fireEvent.click(card(2), { metaKey: true })
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Spec 2' } })
    expect(selectedIds()).toEqual([2])
    expect(screen.getByTestId('specs-bulk-count')).toHaveTextContent('1 selected')
  })

  it('clears the selection on a project switch', () => {
    const view = renderBoard()
    fireEvent.keyDown(card(1), { key: 'x' })
    expect(bar()).not.toBeNull()
    h.activeId = 'proj-B'
    view.rerender(<SpecsBoard tickets={TODO} doneTickets={[]} isLoading={false} onTicketClick={vi.fn()} viewTier="row" rails={RAILS} bulk={handlers()} />)
    expect(bar()).toBeNull()
  })

  it('works in the post-it grid too', () => {
    const onMoveToRail = vi.fn()
    render(<SpecsBoard tickets={TODO} isLoading={false} onTicketClick={vi.fn()} viewTier="postit" rails={RAILS} onMoveToRail={onMoveToRail} bulk={handlers()} />)
    expect(screen.getByTestId('specs-board-postit-grid')).toHaveAttribute('role', 'listbox')
    fireEvent.keyDown(card(4), { key: 'x' })
    expect(selectedIds()).toEqual([4])
  })
})

describe('SpecsBoard bulk bar (CD4)', () => {
  beforeEach(() => {
    localStorage.clear()
    h.activeId = 'proj-A'
    resetPaletteSurfaces()
  })

  function select(...ids: number[]) {
    for (const id of ids) fireEvent.click(card(id), { metaKey: true })
  }
  const openMenu = (testId: string) => fireEvent.click(screen.getByTestId(testId))

  it('has Move to, Label, Priority, Add to rail, Launch all, Delete and Clear', () => {
    renderBoard()
    select(1)
    const toolbar = screen.getByRole('toolbar')
    for (const id of ['move', 'label', 'priority', 'rail', 'launch', 'delete', 'clear']) {
      expect(within(toolbar).getByTestId(`specs-bulk-${id}`)).toBeInTheDocument()
    }
  })

  it('Move to runs the local status handler on every selected spec', () => {
    const { bulk } = renderBoard()
    select(1, 3)
    openMenu('specs-bulk-move')
    fireEvent.click(screen.getByTestId('specs-bulk-move-local-done'))
    expect(bulk.onStatus).toHaveBeenCalledWith([1, 3], { kind: 'local', status: 'done' })
  })

  it('splits a mixed selection: local statuses for local specs, Jira workflow statuses for Jira-backed ones', async () => {
    const jiraBulk = handlers({ jiraConnected: true })
    renderBoard({ bulk: jiraBulk, tickets: [ticket(1), ticket(2, { source: 'jira', jira_key: 'PROJ-2' }), ticket(3, { source: 'jira', jira_key: 'PROJ-3' })] })
    select(1, 2, 3)
    openMenu('specs-bulk-move')
    expect(await screen.findByTestId('specs-bulk-move-jira-Code Review')).toBeInTheDocument()
    expect(jiraBulk.loadJiraStatuses).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('specs-bulk-move-jira-Code Review'))
    expect(jiraBulk.onStatus).toHaveBeenCalledWith([2, 3], { kind: 'jira', status: 'Code Review' })
    openMenu('specs-bulk-move')
    fireEvent.click(screen.getByTestId('specs-bulk-move-local-todo'))
    expect(jiraBulk.onStatus).toHaveBeenLastCalledWith([1], { kind: 'local', status: 'todo' })
  })

  it('reports a Jira status load failure inside the menu', async () => {
    const failing = handlers({ jiraConnected: true, loadJiraStatuses: vi.fn(async () => { throw new Error('nope') }) })
    renderBoard({ bulk: failing, tickets: [ticket(2, { source: 'jira', jira_key: 'PROJ-2' })] })
    select(2)
    openMenu('specs-bulk-move')
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load the Jira statuses')
  })

  it('Label adds a label missing somewhere and removes one the specs carry', () => {
    const { bulk } = renderBoard({ tickets: [ticket(1, { labels: ['bug'] }), ticket(2, { labels: ['bug', 'ui'] })] })
    select(1, 2)
    openMenu('specs-bulk-label')
    // `bug` is on both specs, so it is only removable; `ui` is missing from #1, so it is addable.
    expect(screen.queryByTestId('specs-bulk-label-add-bug')).toBeNull()
    fireEvent.click(screen.getByTestId('specs-bulk-label-add-ui'))
    expect(bulk.onLabel).toHaveBeenCalledWith([1, 2], 'ui', 'add')
    openMenu('specs-bulk-label')
    fireEvent.click(screen.getByTestId('specs-bulk-label-remove-bug'))
    expect(bulk.onLabel).toHaveBeenLastCalledWith([1, 2], 'bug', 'remove')
  })

  it('Priority and Add to rail hand the ids to the host; a running rail is disabled', () => {
    const { bulk } = renderBoard()
    select(2, 4)
    openMenu('specs-bulk-priority')
    fireEvent.click(screen.getByTestId('specs-bulk-priority-high'))
    expect(bulk.onPriority).toHaveBeenCalledWith([2, 4], 'high')
    openMenu('specs-bulk-rail')
    expect(screen.getByTestId('specs-bulk-rail-rail-2')).toBeDisabled()
    fireEvent.click(screen.getByTestId('specs-bulk-rail-rail-1'))
    expect(bulk.onMoveToRail).toHaveBeenCalledWith([2, 4], 'rail-1')
  })

  it('Launch all and Delete hand the ids to the host', () => {
    const { bulk } = renderBoard()
    select(1, 2)
    fireEvent.click(screen.getByTestId('specs-bulk-launch'))
    expect(bulk.onLaunch).toHaveBeenCalledWith([1, 2])
    fireEvent.click(screen.getByTestId('specs-bulk-delete'))
    expect(bulk.onDelete).toHaveBeenCalledWith([1, 2])
  })

  it('Clear empties the selection', () => {
    renderBoard()
    select(1, 2)
    fireEvent.click(screen.getByTestId('specs-bulk-clear'))
    expect(bar()).toBeNull()
  })

  it('arrow keys move focus along the toolbar', () => {
    renderBoard()
    select(1)
    const move = screen.getByTestId('specs-bulk-move')
    move.focus()
    fireEvent.keyDown(move, { key: 'ArrowRight' })
    expect(screen.getByTestId('specs-bulk-label')).toHaveFocus()
    fireEvent.keyDown(screen.getByTestId('specs-bulk-label'), { key: 'ArrowLeft' })
    expect(move).toHaveFocus()
  })

  it('publishes the selection to the command palette', () => {
    renderBoard({ doneTickets: DONE })
    const surface = () => getPaletteSurface('selection')!
    expect(surface().count()).toBe(0)
    act(() => surface().selectAllInColumn())
    expect(surface().count()).toBe(4)
    act(() => surface().clear())
    expect(surface().count()).toBe(0)
  })

  it('palette bulk calls run the same handlers as the bar', async () => {
    const { bulk } = renderBoard()
    select(1, 2)
    const surface = getPaletteSurface('selection')!
    act(() => surface.setPriority('low'))
    expect(bulk.onPriority).toHaveBeenCalledWith([1, 2], 'low')
    act(() => surface.addToRail('rail-1'))
    expect(bulk.onMoveToRail).toHaveBeenCalledWith([1, 2], 'rail-1')
    act(() => surface.launch())
    expect(bulk.onLaunch).toHaveBeenCalledWith([1, 2])
    act(() => surface.remove())
    expect(bulk.onDelete).toHaveBeenCalledWith([1, 2])
    const options = await surface.statusOptions()
    expect(options.map((o) => o.id)).toEqual(['local:todo', 'local:in_progress', 'local:done', 'local:cancelled'])
    act(() => surface.moveStatus('local:done'))
    expect(bulk.onStatus).toHaveBeenCalledWith([1, 2], { kind: 'local', status: 'done' })
    expect(surface.labelOptions()).toEqual(['bug', 'ui'])
  })
})

describe('SpecsBoard saved views (CD4)', () => {
  beforeEach(() => {
    localStorage.clear()
    h.activeId = 'proj-A'
    resetPaletteSurfaces()
  })

  const storedViews = (project = 'proj-A') => JSON.parse(localStorage.getItem(`specrails-desktop:spec-views:${project}`) ?? '[]') as { id: string; name: string; status: string; sortMode: string; viewTier: string; labels: string[] }[]

  async function saveView(name: string) {
    fireEvent.click(screen.getByTestId('specs-views-trigger'))
    fireEvent.click(screen.getByTestId('specs-views-save'))
    fireEvent.change(screen.getByTestId('specs-views-name'), { target: { value: name } })
    fireEvent.click(screen.getByTestId('specs-views-save-confirm'))
    await waitFor(() => expect(screen.queryByTestId('specs-views-save-dialog')).toBeNull())
  }

  it('saves the current status, filters, sort and density per project', async () => {
    renderBoard({ tickets: [ticket(1, { labels: ['bug'] }), ticket(2)] })
    fireEvent.click(screen.getByRole('radio', { name: /All/i }))
    await saveView('Everything')
    const [view] = storedViews()
    expect(view).toMatchObject({ name: 'Everything', status: 'all', sortMode: 'default', viewTier: 'row' })
    expect(storedViews('proj-B')).toEqual([])
    // The board matches the view it was just saved from, so the trigger names it.
    expect(screen.getByTestId('specs-views-trigger')).toHaveAccessibleName('Views, current: Everything')
  })

  it('applies a saved view: status, sort and density return to what was saved', async () => {
    const onSortChange = vi.fn()
    const onViewTierChange = vi.fn()
    localStorage.setItem('specrails-desktop:spec-views:proj-A', JSON.stringify([
      { id: 'v1', name: 'Done by priority', status: 'done', labels: [], epic: null, sprint: null, jiraStatus: null, sortMode: 'priority', sortDir: 'asc', viewTier: 'postit' },
    ]))
    renderBoard({ doneTickets: DONE, onSortChange, onViewTierChange })
    expect(screen.queryByTestId('specs-board-done-bucket')).toBeNull()
    fireEvent.click(screen.getByTestId('specs-views-trigger'))
    fireEvent.click(screen.getByTestId('specs-view-v1'))
    expect(screen.getByTestId('specs-board-done-bucket')).toBeInTheDocument()
    expect(onSortChange).toHaveBeenCalledWith('priority', 'asc')
    expect(onViewTierChange).toHaveBeenCalledWith('postit')
    // The applied status is also the persisted one.
    expect(localStorage.getItem('specrails-desktop:spec-status-filter:proj-A')).toBe('done')
  })

  it('renames, updates from the board, and deletes a view', async () => {
    renderBoard()
    await saveView('Mine')
    fireEvent.click(screen.getByTestId('specs-views-trigger'))
    fireEvent.click(screen.getByTestId('specs-views-manage'))
    const id = storedViews()[0].id
    // up to date right after saving
    expect(screen.getByTestId(`specs-views-update-${id}`)).toBeDisabled()
    fireEvent.click(screen.getByTestId(`specs-views-rename-${id}`))
    const input = screen.getByTestId('specs-views-rename-input')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.blur(input)
    expect(storedViews()[0].name).toBe('Renamed')
    // change the board, then update the view from it
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    fireEvent.click(screen.getByRole('radio', { name: /All/i }))
    fireEvent.click(screen.getByTestId('specs-views-trigger'))
    fireEvent.click(screen.getByTestId('specs-views-manage'))
    fireEvent.click(screen.getByTestId(`specs-views-update-${id}`))
    expect(storedViews()[0].status).toBe('all')
    fireEvent.click(screen.getByTestId(`specs-views-delete-${id}`))
    expect(storedViews()).toEqual([])
  })

  it('refuses an empty name', async () => {
    renderBoard()
    fireEvent.click(screen.getByTestId('specs-views-trigger'))
    fireEvent.click(screen.getByTestId('specs-views-save'))
    fireEvent.change(screen.getByTestId('specs-views-name'), { target: { value: '   ' } })
    expect(screen.getByTestId('specs-views-save-confirm')).toBeDisabled()
    expect(storedViews()).toEqual([])
  })

  it('keeps each project’s views separate', async () => {
    const view = renderBoard()
    await saveView('Only in A')
    h.activeId = 'proj-B'
    view.rerender(<SpecsBoard tickets={TODO} doneTickets={[]} isLoading={false} onTicketClick={vi.fn()} viewTier="row" rails={RAILS} bulk={handlers()} />)
    fireEvent.click(screen.getByTestId('specs-views-trigger'))
    expect(screen.queryByText('Only in A')).toBeNull()
    expect(screen.getByText('No saved views yet')).toBeInTheDocument()
    expect(storedViews('proj-A')).toHaveLength(1)
  })

  it('copies a link that carries the project and the view id', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderBoard()
    await saveView('Shareable')
    const id = storedViews()[0].id
    fireEvent.click(screen.getByTestId('specs-views-trigger'))
    fireEvent.click(screen.getByTestId('specs-views-manage'))
    fireEvent.click(screen.getByTestId(`specs-views-link-${id}`))
    expect(writeText).toHaveBeenCalledTimes(1)
    const url = new URL(writeText.mock.calls[0][0] as string)
    expect(url.searchParams.get('view')).toBe(id)
    expect(url.searchParams.get('p')).toBe('proj-A')
  })

  it('?view=<id> applies the view and drops the param in place', () => {
    localStorage.setItem('specrails-desktop:spec-views:proj-A', JSON.stringify([
      { id: 'v9', name: 'Linked', status: 'done', labels: [], epic: null, sprint: null, jiraStatus: null, sortMode: 'default', sortDir: 'desc', viewTier: 'row' },
    ]))
    renderBoard({ doneTickets: DONE, route: '/?view=v9&p=proj-A' })
    expect(screen.getByTestId('specs-board-done-bucket')).toBeInTheDocument()
    const search = screen.getByTestId('loc').textContent ?? ''
    expect(search).not.toContain('view=')
    expect(search).toContain('status=done')
  })

  it('an unknown ?view= is dropped without changing the board', () => {
    renderBoard({ route: '/?view=ghost' })
    expect(screen.getByTestId('loc').textContent).not.toContain('view=')
    expect(screen.getByTestId('specs-board-list')).toBeInTheDocument()
  })

  it('a link for another project waits for that project', () => {
    localStorage.setItem('specrails-desktop:spec-views:proj-B', JSON.stringify([
      { id: 'vb', name: 'In B', status: 'done', labels: [], epic: null, sprint: null, jiraStatus: null, sortMode: 'default', sortDir: 'desc', viewTier: 'row' },
    ]))
    renderBoard({ doneTickets: DONE, route: '/?view=vb&p=proj-B' })
    expect(screen.getByTestId('loc').textContent).toContain('view=vb')
    expect(screen.queryByTestId('specs-board-done-bucket')).toBeNull()
  })

  it('the palette can open the save dialog and switch views', async () => {
    localStorage.setItem('specrails-desktop:spec-views:proj-A', JSON.stringify([
      { id: 'v1', name: 'Done only', status: 'done', labels: [], epic: null, sprint: null, jiraStatus: null, sortMode: 'default', sortDir: 'desc', viewTier: 'row' },
    ]))
    renderBoard({ doneTickets: DONE })
    const surface = getPaletteSurface('selection')!
    expect(surface.views()).toEqual([{ id: 'v1', name: 'Done only' }])
    act(() => surface.switchView('v1'))
    expect(screen.getByTestId('specs-board-done-bucket')).toBeInTheDocument()
    act(() => surface.saveCurrentView())
    expect(await screen.findByTestId('specs-views-save-dialog')).toBeInTheDocument()
  })
})
