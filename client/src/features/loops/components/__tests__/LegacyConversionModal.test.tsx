import { afterEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LegacyConversionModal } from '../LegacyConversionModal'
import { LoopPublishError, loopsApi, type LoopDefinition } from '../../lib/loops-api'
afterEach(() => vi.restoreAllMocks())
const loop: LoopDefinition = { id: 'legacy', name: 'Legacy', description: null, status: 'published', createdAt: '', updatedAt: '', graph: {
  nodes: [{ id: 'shell', type: 'shell', position: { x: 0, y: 0 }, data: { command: 'npm test' } }], edges: [], config: { maxIterations: 1, timeoutMinutes: 0 },
} }
const projects = [{ id: 'project', name: 'Project', repositories: [{ id: 'repo', name: 'Original repository' }] }]
it('requires an explicit shell repository and opens the returned draft after conversion', async () => {
  const draft = { ...loop, status: 'draft' as const }, onConverted = vi.fn()
  const convert = vi.spyOn(loopsApi, 'convert').mockResolvedValue({ loop: draft, nodeIds: {} })
  render(<LegacyConversionModal loop={loop} projects={projects} onClose={vi.fn()} onConverted={onConverted} />)
  const submit = screen.getByRole('button', { name: 'Convert and review' })
  expect(submit).toBeDisabled()
  fireEvent.change(screen.getByRole('combobox'), { target: { value: JSON.stringify(['project', 'repo']) } })
  fireEvent.click(submit)
  await waitFor(() => expect(onConverted).toHaveBeenCalledWith(draft))
  expect(convert).toHaveBeenCalledWith('legacy', 'repo')
})
it('keeps conversion errors actionable without closing or replacing the original graph', async () => {
  const onConverted = vi.fn(), onClose = vi.fn()
  vi.spyOn(loopsApi, 'convert').mockRejectedValue(new LoopPublishError([{ code: 'INVALID_CONFIG', nodeId: 'shell', message: 'Select a supported transition bound' }]))
  render(<LegacyConversionModal loop={{ ...loop, graph: { ...loop.graph, nodes: [] } }} projects={projects} onClose={onClose} onConverted={onConverted} />)
  fireEvent.click(screen.getByRole('button', { name: 'Convert and review' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('shell: Select a supported transition bound')
  expect(onConverted).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled()
})
