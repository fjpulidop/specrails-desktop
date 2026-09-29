import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import LoopsPage from '../LoopsPage'
import { toast } from 'sonner'
import { loopsApi, type LoopDefinition } from '../../lib/loops-api'

vi.mock('../../lib/loops-api', () => ({
  loopsApi: {
    list: vi.fn(),
    legacyGraph: vi.fn(),
    templates: vi.fn(),
    create: vi.fn(),
    fromTemplate: vi.fn(),
    publish: vi.fn(),
    unpublish: vi.fn(),
    duplicate: vi.fn(),
    remove: vi.fn(),
    restoreBuiltin: vi.fn(),
  },
  LoopPublishError: class LoopPublishError extends Error {
    errors: unknown[] = []
  },
}))

const api = loopsApi as unknown as Record<string, ReturnType<typeof vi.fn>>

function loop(over: Partial<LoopDefinition>): LoopDefinition {
  return {
    id: 'l1',
    name: 'My Loop',
    description: null,
    status: 'draft',
    graph: { nodes: [{ id: 's', type: 'start', position: { x: 0, y: 0 } }], edges: [], config: { maxIterations: 10, timeoutMinutes: 30 } },
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...over,
  }
}

function renderPage() {
  return render(
    <MemoryRouter>
      <LoopsPage />
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  try { localStorage.clear() } catch { /* jsdom */ }
  api.list.mockResolvedValue([])
  api.templates.mockResolvedValue([])
  api.create.mockResolvedValue(loop({ id: 'new' }))
  api.fromTemplate.mockResolvedValue(loop({ id: 'fromtmpl' }))
  api.publish.mockResolvedValue(loop({ status: 'published' }))
  api.unpublish.mockResolvedValue(loop({}))
  api.duplicate.mockResolvedValue(loop({ id: 'dup' }))
  api.remove.mockResolvedValue(undefined)
  api.restoreBuiltin.mockResolvedValue(loop({ id: 'factory:implement', builtinId: 'factory:implement', status: 'published' }))
})

describe('LoopsPage', () => {
  it('shows the empty state when there are no loops', async () => {
    renderPage()
    expect(await screen.findByText('No loops yet')).toBeInTheDocument()
  })

  it('renders Published and Drafts sections with status badges', async () => {
    api.list.mockResolvedValue([loop({ id: 'd', name: 'Draft Loop', status: 'draft' }), loop({ id: 'p', name: 'Pub Loop', status: 'published' })])
    renderPage()
    expect(await screen.findByText('Draft Loop')).toBeInTheDocument()
    expect(screen.getByText('Pub Loop')).toBeInTheDocument()
    // "Published" appears both as a section heading and a status badge — scope to the heading.
    expect(screen.getByRole('heading', { name: 'Published' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Drafts' })).toBeInTheDocument()
  })

  const tmplGraph = {
    nodes: [
      { id: 's', type: 'start' as const, position: { x: 0, y: 0 } },
      { id: 'ai', type: 'ai-step' as const, position: { x: 0, y: 1 }, data: { prompt: '{{cmd:implement}}' } },
      { id: 'd', type: 'decider' as const, position: { x: 0, y: 2 }, data: { goal: 'tests pass' } },
      { id: 'e', type: 'end' as const, position: { x: 1, y: 2 }, data: { outcome: 'success' } },
    ],
    edges: [],
    config: { maxIterations: 10, timeoutMinutes: 30 },
  }

  it('renders templates and uses one (instantiates from template)', async () => {
    api.templates.mockResolvedValue([{ id: 'ship-and-green', name: 'Ship & Green', description: 'desc', tags: ['CI'], graph: tmplGraph }])
    renderPage()
    expect(await screen.findByText('Ship & Green')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Use template'))
    await waitFor(() => expect(api.fromTemplate).toHaveBeenCalledWith('ship-and-green'))
  })

  it('previews a template in a modal (steps + decider goal), then uses it from there', async () => {
    api.templates.mockResolvedValue([{ id: 'ship-and-green', name: 'Ship & Green', description: 'desc', tags: ['CI'], graph: tmplGraph }])
    renderPage()
    await screen.findByText('Ship & Green')
    fireEvent.click(screen.getByText('Preview'))
    const dialog = await screen.findByRole('dialog')
    // The modal shows the authored prompt + decider goal from the graph.
    expect(within(dialog).getByText('{{cmd:implement}}')).toBeInTheDocument()
    expect(within(dialog).getByText('tests pass')).toBeInTheDocument()
    // Using from the modal clones the template.
    fireEvent.click(within(dialog).getByRole('button', { name: /Use template/i }))
    await waitFor(() => expect(api.fromTemplate).toHaveBeenCalledWith('ship-and-green'))
  })

  const catTemplates = [
    { id: 'flaky-test-triage', name: 'Flaky Test Triage', description: 'classify failures', category: 'Testing', tags: ['testing', 'flaky'], graph: tmplGraph },
    { id: 'merge-conflict-resolver', name: 'Merge Conflict Resolver', description: 'resolve conflicts', category: 'Git', tags: ['git'], graph: tmplGraph },
  ]

  const standaloneGraph = {
    nodes: [
      { id: 's', type: 'start' as const, position: { x: 0, y: 0 } },
      { id: 'ai', type: 'ai-step' as const, position: { x: 0, y: 1 }, data: { prompt: '{{cmd:test}}' } },
      { id: 'd', type: 'decider' as const, position: { x: 0, y: 2 }, data: { goal: 'green' } },
      { id: 'e', type: 'end' as const, position: { x: 1, y: 2 }, data: { outcome: 'success' } },
    ],
    edges: [],
    config: { maxIterations: 10, timeoutMinutes: 30 },
  }

  it('marks templates as spec-driven (Needs spec) or standalone', async () => {
    api.templates.mockResolvedValue([
      { id: 'ship-and-green', name: 'Ship & Green', description: 'd', category: 'CI', tags: [], graph: tmplGraph }, // {{cmd:implement}} → needs spec
      { id: 'ci-watch', name: 'CI Watch', description: 'd', category: 'CI', tags: [], graph: standaloneGraph }, // no spec/ticket cmd → standalone
    ])
    renderPage()
    const specCard = (await screen.findByText('Ship & Green')).closest('[data-testid="template-card"]')! as HTMLElement
    expect(within(specCard).getByText('Needs spec')).toBeInTheDocument()
    const standaloneCard = screen.getByText('CI Watch').closest('[data-testid="template-card"]')! as HTMLElement
    expect(within(standaloneCard).getByText('Standalone')).toBeInTheDocument()
  })

  it('renders a category badge on template cards', async () => {
    api.templates.mockResolvedValue(catTemplates)
    renderPage()
    const card = (await screen.findByText('Flaky Test Triage')).closest('[data-testid="template-card"]')!
    expect(within(card as HTMLElement).getByText('Testing')).toBeInTheDocument()
  })

  it('filters templates by the search box', async () => {
    api.templates.mockResolvedValue(catTemplates)
    renderPage()
    await screen.findByText('Flaky Test Triage')
    fireEvent.change(screen.getByTestId('template-search'), { target: { value: 'conflict' } })
    await waitFor(() => expect(screen.queryByText('Flaky Test Triage')).not.toBeInTheDocument())
    expect(screen.getByText('Merge Conflict Resolver')).toBeInTheDocument()
  })

  it('matches search against the localized (catalog) text, not just the server fields', async () => {
    // id `flaky-test-triage` has a catalog entry whose description contains
    // "intermittent"; the server description here does NOT. Searching the
    // localized word must still find it.
    api.templates.mockResolvedValue([
      { id: 'flaky-test-triage', name: 'srv-name-a', description: 'srv-desc-no-match', category: 'Testing', tags: [], graph: tmplGraph },
      { id: 'merge-conflict-resolver', name: 'srv-name-b', description: 'srv-desc-b', category: 'Git', tags: [], graph: tmplGraph },
    ])
    renderPage()
    // card shows the localized catalog name, not the server name
    await screen.findByText('Flaky Test Triage')
    fireEvent.change(screen.getByTestId('template-search'), { target: { value: 'intermittent' } })
    await waitFor(() => expect(screen.queryByText('Merge Conflict Resolver')).not.toBeInTheDocument())
    expect(screen.getByText('Flaky Test Triage')).toBeInTheDocument()
  })

  it('filters templates by clicking a category chip', async () => {
    api.templates.mockResolvedValue(catTemplates)
    renderPage()
    await screen.findByText('Flaky Test Triage')
    const chips = screen.getByTestId('category-chips')
    fireEvent.click(within(chips).getByRole('button', { name: /Git/i }))
    await waitFor(() => expect(screen.queryByText('Flaky Test Triage')).not.toBeInTheDocument())
    expect(screen.getByText('Merge Conflict Resolver')).toBeInTheDocument()
  })

  it('shows a no-results empty state and clears the filter', async () => {
    api.templates.mockResolvedValue(catTemplates)
    renderPage()
    await screen.findByText('Flaky Test Triage')
    fireEvent.change(screen.getByTestId('template-search'), { target: { value: 'zzzz-nomatch' } })
    expect(await screen.findByTestId('template-empty')).toBeInTheDocument()
    // clearing restores all templates
    fireEvent.click(within(screen.getByTestId('template-empty')).getByText('Clear filters'))
    await waitFor(() => expect(screen.getByText('Flaky Test Triage')).toBeInTheDocument())
  })

  it('creates a new draft when clicking New loop', async () => {
    renderPage()
    await screen.findByText('No loops yet')
    fireEvent.click(screen.getByText('New loop'))
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
  })

  it('publishes a draft loop', async () => {
    api.list.mockResolvedValue([loop({ id: 'd', status: 'draft' })])
    renderPage()
    await screen.findByText('My Loop')
    fireEvent.click(screen.getByLabelText('Publish'))
    await waitFor(() => expect(api.publish).toHaveBeenCalledWith('d'))
  })

  it('deletes only after confirming in the in-app modal', async () => {
    api.list.mockResolvedValue([loop({ id: 'd', status: 'draft' })])
    renderPage()
    await screen.findByText('My Loop')
    // Open the confirm modal via the card's trash button (aria-label "Delete").
    fireEvent.click(screen.getByLabelText('Delete'))
    // Cancel → nothing deleted.
    fireEvent.click(screen.getByText('Cancel'))
    expect(api.remove).not.toHaveBeenCalled()
    // Re-open and confirm via the dialog's Delete button.
    fireEvent.click(screen.getByLabelText('Delete'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('d'))
  })

  it('shows the node count on a card', async () => {
    api.list.mockResolvedValue([loop({ id: 'd', status: 'draft' })]) // 1 start node
    renderPage()
    expect(await screen.findByText('1 node')).toBeInTheDocument()
  })

  it('lists built-ins as editable loops in their own section (no Fork, no Delete)', async () => {
    api.list.mockResolvedValue([
      loop({ id: 'factory:implement', name: 'Implement', status: 'published', builtinId: 'factory:implement', builtinModified: false }),
      loop({ id: 'u1', name: 'Mine', status: 'published' }),
    ])
    renderPage()
    const card = await screen.findByTestId('builtin-loop-card')
    expect(within(card).getByText('Implement')).toBeInTheDocument()
    expect(within(card).getByTestId('builtin-badge')).toHaveTextContent('Built-in')
    expect(within(card).getByLabelText('Edit')).toBeInTheDocument()
    expect(within(card).getByLabelText('Duplicate')).toBeInTheDocument()
    expect(within(card).queryByLabelText('Delete')).not.toBeInTheDocument()
    expect(within(card).queryByLabelText('Unpublish')).not.toBeInTheDocument()
    // Unedited → nothing to restore.
    expect(within(card).queryByLabelText('Restore original')).not.toBeInTheDocument()
    expect(screen.queryByText(/Fork to edit/i)).not.toBeInTheDocument()
    // Never listed twice: the Published section holds only the user's loop.
    expect(screen.getAllByTestId('loop-card')).toHaveLength(1)
    fireEvent.click(within(card).getByLabelText('Duplicate'))
    await waitFor(() => expect(api.duplicate).toHaveBeenCalledWith('factory:implement'))
  })

  it('restores an edited built-in after confirmation', async () => {
    api.list.mockResolvedValue([
      loop({ id: 'factory:implement', name: 'Team Implement', status: 'draft', builtinId: 'factory:implement', builtinModified: true }),
    ])
    renderPage()
    const card = await screen.findByTestId('builtin-loop-card')
    expect(within(card).getByText('Team Implement')).toBeInTheDocument()
    expect(within(card).getByText(/Edited/)).toBeInTheDocument()
    // An edited Draft built-in can be published from the card.
    expect(within(card).getByLabelText('Publish')).toBeInTheDocument()
    fireEvent.click(within(card).getByLabelText('Restore original'))
    fireEvent.click(await screen.findByTestId('confirm-restore-builtin'))
    await waitFor(() => expect(api.restoreBuiltin).toHaveBeenCalledWith('factory:implement'))
  })
})

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('preserved original graph export', () => {
  it('downloads the retained original rather than the current edited graph', async () => {
    const current = loop({ hasLegacyGraph: true })
    const original = { ...current.graph, config: { ...current.graph.config, maxIterations: 77 } }
    api.list.mockResolvedValue([current])
    api.legacyGraph.mockResolvedValue({ graph: original, savedAt: '2026-09-27' })
    const blobs: Blob[] = []
    const NativeURL = URL
    vi.stubGlobal('URL', class extends NativeURL {
      static createObjectURL(blob: Blob) { blobs.push(blob); return 'blob:original' }
      static revokeObjectURL = vi.fn()
    })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Export original graph' }))
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1))
    expect(api.legacyGraph).toHaveBeenCalledWith(current.id)
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = reject
      reader.readAsText(blobs[0])
    })
    expect(JSON.parse(text).loops[0].graph).toEqual(original)
    expect(JSON.parse(text).loops[0].name).toBe('Original: My Loop')
    expect(current.graph.config.maxIterations).toBe(10)
    expect(api.publish).not.toHaveBeenCalled()
  })
  it('reports a missing backup and does not fall back to exporting the current graph', async () => {
    api.list.mockResolvedValue([loop({ hasLegacyGraph: true })])
    api.legacyGraph.mockRejectedValue(new Error('missing'))
    const error = vi.spyOn(toast, 'error')
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Export original graph' }))
    await waitFor(() => expect(error).toHaveBeenCalledWith('Could not export the original graph.'))
    expect(click).not.toHaveBeenCalled()
  })
})
