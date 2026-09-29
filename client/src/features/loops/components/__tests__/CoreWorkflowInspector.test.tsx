import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CoreNodeInspector, CoreWorkflowInspector } from '../CoreWorkflowInspector'
import type { LoopGraph, WorkflowPieceDescriptor } from '../../lib/loops-api'

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

it('edits typed variable values and counter deltas through localized controls without mutating the catalog', () => {
  const piece: WorkflowPieceDescriptor = { kind: 'assign', effect: 'read', requiresAI: false, outcomes: ['next', 'failed'], paramsSchema: {
    type: 'object', additionalProperties: false, properties: {
      set: { type: 'object', additionalProperties: true },
      increment: { type: 'object', additionalProperties: { type: 'integer', default: 1 } },
    },
  } }
  const original = structuredClone(piece)
  function Editor() {
    const [params, setParams] = useState<Record<string, unknown>>({ set: { failed: false }, increment: { iteration: 1 } })
    return <><CoreNodeInspector nodeId="variables" data={{ kind: 'core', coreKind: 'assign', params }} piece={piece} choices={{}} schema={{}}
      onChange={patch => { if (patch.params) setParams(patch.params) }} onDelete={() => {}} onOpenCanvas={() => {}} />
      <output data-testid="variables">{JSON.stringify(params)}</output></>
  }
  render(<Editor />)
  expect(screen.getByText('builder.core.assignment.increment')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('iteration'), { target: { value: '2' } })
  fireEvent.click(within(screen.getByRole('group', { name: 'builder.core.assignment.set' })).getByRole('checkbox'))
  expect(JSON.parse(screen.getByTestId('variables').textContent!)).toEqual({ set: { failed: true }, increment: { iteration: 2 } })
  expect(piece).toEqual(original)
})

it('offers the localized continuation guard only when the selected catalog supports it', () => {
  const piece: WorkflowPieceDescriptor = { kind: 'decider', effect: 'read', requiresAI: true, outcomes: ['continue', 'stop', 'failed'], paramsSchema: {
    type: 'object', properties: { continueWhen: { type: 'string' } },
  } }
  const onChange = vi.fn()
  const props = { nodeId: 'decide', data: { kind: 'core' as const, coreKind: 'decider' as const, params: { continueWhen: '$vars.failed == true' } }, piece, choices: {}, schema: {},
    onChange, onDelete: vi.fn(), onOpenCanvas: vi.fn() }
  const { rerender } = render(<CoreNodeInspector {...props} />)
  fireEvent.change(screen.getByLabelText('builder.core.requiredContinue'), { target: { value: '$vars.pending > 0' } })
  expect(onChange).toHaveBeenLastCalledWith({ params: { continueWhen: '$vars.pending > 0' } })
  rerender(<CoreNodeInspector {...props} data={{ ...props.data, params: {} }} piece={{ ...piece, paramsSchema: { type: 'object', properties: {} } }} />)
  expect(screen.queryByLabelText('builder.core.requiredContinue')).not.toBeInTheDocument()
})
