import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import LoopsPage from '../LoopsPage'
import { loopsApi, type LoopDefinition } from '../../lib/loops-api'

vi.mock('../../lib/loops-api', () => ({
  loopsApi: {
    list: vi.fn(),
    templates: vi.fn(),
    create: vi.fn(),
    fromTemplate: vi.fn(),
    publish: vi.fn(),
    unpublish: vi.fn(),
    duplicate: vi.fn(),
    remove: vi.fn(),
    factoryLoops: vi.fn(),
    forkFactory: vi.fn(),
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
  api.list.mockResolvedValue([])
  api.templates.mockResolvedValue([])
  api.create.mockResolvedValue(loop({ id: 'new' }))
  api.fromTemplate.mockResolvedValue(loop({ id: 'fromtmpl' }))
  api.publish.mockResolvedValue(loop({ status: 'published' }))
  api.unpublish.mockResolvedValue(loop({}))
  api.duplicate.mockResolvedValue(loop({ id: 'dup' }))
  api.remove.mockResolvedValue(undefined)
  api.factoryLoops.mockResolvedValue([])
  api.forkFactory.mockResolvedValue(loop({ id: 'forked' }))
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

  it('lists built-in factory loops and forks one into an editable draft', async () => {
    api.factoryLoops.mockResolvedValue([
      { id: 'factory:implement', name: 'Implement', description: 'Run the pipeline', mode: 'implement', claudeOnly: false, graph: tmplGraph },
    ])
    renderPage()
    expect(await screen.findByText('Implement')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Fork to edit'))
    await waitFor(() => expect(api.forkFactory).toHaveBeenCalledWith('factory:implement'))
  })

  it('previews a built-in factory loop, then forks it from the modal (not fromTemplate)', async () => {
    api.factoryLoops.mockResolvedValue([
      { id: 'factory:implement', name: 'Implement', description: 'Run the pipeline', mode: 'implement', claudeOnly: false, graph: tmplGraph },
    ])
    renderPage()
    await screen.findByText('Implement')
    // Open the preview for the built-in (the card has both Preview + Fork to edit).
    fireEvent.click(screen.getByText('Preview'))
    const dialog = await screen.findByRole('dialog')
    // The modal CTA for a built-in is "Fork to edit", NOT "Use template".
    expect(within(dialog).queryByRole('button', { name: /Use template/i })).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: /Fork to edit/i }))
    await waitFor(() => expect(api.forkFactory).toHaveBeenCalledWith('factory:implement'))
    expect(api.fromTemplate).not.toHaveBeenCalled()
  })
})
