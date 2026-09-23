import { describe, it, expect } from 'vitest'
import { previewLoop, SAMPLE_SPEC } from './loop-preview'
import type { LoopGraph } from './loop-graph'

function graph(): LoopGraph {
  return {
    nodes: [
      { id: 's', type: 'start', position: { x: 0, y: 0 } },
      { id: 'impl', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: '{{cmd:implement}}', label: 'Build it' } },
      { id: 'note', type: 'ai-step', position: { x: 0, y: 2 }, data: { prompt: 'Spec: {{spec.title}} — finish with {{const:VERIFICATION_PASS}}' } },
      { id: 'sh', type: 'shell', position: { x: 0, y: 3 }, data: { command: 'echo {{const:PKG_MANAGER}}' } },
      { id: 'd', type: 'decider', position: { x: 0, y: 4 }, data: { goal: 'reached {{const:VERIFICATION_PASS}}' } },
      { id: 'e', type: 'end', position: { x: 0, y: 5 } },
    ],
    edges: [
      { id: 'e1', source: 's', target: 'impl' },
      { id: 'e2', source: 'impl', target: 'note' },
      { id: 'e3', source: 'note', target: 'sh' },
      { id: 'e4', source: 'sh', target: 'd' },
      { id: 'e5', source: 'd', target: 'e', branch: 'stop' },
    ],
    config: { maxIterations: 5, timeoutMinutes: 20 },
  }
}

const constants = { VERIFICATION_PASS: 'VERIFICATION: PASS', PKG_MANAGER: 'npm' }

describe('previewLoop', () => {
  it('resolves {{cmd}}, {{spec.*}} (sample) and {{const}} per step, skipping start/end', () => {
    const { steps } = previewLoop(graph(), { provider: 'claude', constants })
    expect(steps.map((s) => s.kind)).toEqual(['ai-step', 'ai-step', 'shell', 'decider']) // no start/end
    expect(steps[0]).toMatchObject({ nodeId: 'impl', label: 'Build it' })
    expect(steps[0].text).toContain('/specrails:implement') // {{cmd:implement}} → native (claude)
    expect(steps[1].text).toBe(`Spec: ${SAMPLE_SPEC.title} — finish with VERIFICATION: PASS`)
    expect(steps[2].text).toBe('echo npm') // shell + const
    expect(steps[3].text).toBe('reached VERIFICATION: PASS') // decider goal + const
  })

  it('expands {{cmd:implement}} per provider', () => {
    const codex = previewLoop(graph(), { provider: 'codex', constants })
    expect(codex.steps[0].text).toContain('$implement') // codex skill form
  })

  it('preview order follows the flow from Start', () => {
    const { steps } = previewLoop(graph(), { provider: 'claude', constants })
    expect(steps.map((s) => s.nodeId)).toEqual(['impl', 'note', 'sh', 'd'])
  })
})
