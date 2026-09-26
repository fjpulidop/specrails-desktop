import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CoreWorkflowInspector } from '../CoreWorkflowInspector'
import type { LoopGraph } from '../../lib/loops-api'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const graph: LoopGraph = {
  nodes: [{ id: 'audit', type: 'core', position: { x: 0, y: 0 }, data: { kind: 'role-turn', params: { roleId: 'auditor' } } }],
  edges: [], config: { maxIterations: 2, timeoutMinutes: 0 },
}

describe('workflow review evidence selection', () => {
  it('selects the node identity and clears back to automatic without changing execution settings', () => {
    const onChange = vi.fn()
    const props = { graph, canvas: null, schema: {}, onChange, onOpenCanvas: vi.fn() }
    const { rerender } = render(<CoreWorkflowInspector {...props} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'audit' } })
    expect(onChange).toHaveBeenLastCalledWith({ ...graph, config: { ...graph.config, reviewerStepId: 'audit' } })
    rerender(<CoreWorkflowInspector {...props} graph={onChange.mock.calls[0][0]} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith({ ...graph, config: { ...graph.config, reviewerStepId: undefined } })
  })

  it('keeps a removed selection visible for validation and hides the global choice in component canvases', () => {
    const props = { graph: { ...graph, config: { ...graph.config, reviewerStepId: 'removed/audit' } }, canvas: null, schema: {}, onChange: vi.fn(), onOpenCanvas: vi.fn() }
    const { rerender } = render(<CoreWorkflowInspector {...props} />)
    expect(screen.getByRole('combobox')).toHaveValue('removed/audit')
    rerender(<CoreWorkflowInspector {...props} canvas="nested" />)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })
})
