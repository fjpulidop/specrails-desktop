import { describe, it, expect } from 'vitest'
import { loopNeedsTicket, railRunnableCustomLoops } from '../loop-ticket-need'
import type { LoopDefinition, LoopGraph } from '../loops-api'

function graph(prompts: { prompt?: string; command?: string; goal?: string }[]): LoopGraph {
  return {
    nodes: prompts.map((data, i) => ({ id: `n${i}`, type: 'ai-step', position: { x: 0, y: i }, data })),
    edges: [],
    config: { maxIterations: 10, timeoutMinutes: 30 },
  }
}

describe('loopNeedsTicket', () => {
  it('needs a ticket when it references a {{spec.*}} token', () => {
    expect(loopNeedsTicket(graph([{ prompt: 'Implement {{spec.title}}' }]))).toBe(true)
    expect(loopNeedsTicket(graph([{ prompt: 'Ticket {{spec.id}}' }]))).toBe(true)
  })

  it('needs a ticket when it uses a ticket-consuming command', () => {
    expect(loopNeedsTicket(graph([{ prompt: '{{cmd:implement}}' }]))).toBe(true)
    expect(loopNeedsTicket(graph([{ prompt: '{{cmd:batch}}' }]))).toBe(true)
    expect(loopNeedsTicket(graph([{ prompt: '{{cmd:freestyle}}' }]))).toBe(true)
  })

  it('is ticket-LESS for repo-level loops (no spec token / ticket command)', () => {
    expect(loopNeedsTicket(graph([{ command: 'gh pr checks' }, { goal: 'CI is green' }]))).toBe(false)
    expect(loopNeedsTicket(graph([{ prompt: '{{cmd:verify}}' }]))).toBe(false) // verify doesn't consume a ticket
  })

  it('handles an undefined graph', () => {
    expect(loopNeedsTicket(undefined)).toBe(false)
  })
})

describe('railRunnableCustomLoops', () => {
  const graph = { nodes: [{ id: 'n', type: 'ai', position: { x: 0, y: 0 }, data: { prompt: '{{cmd:freestyle}}' } }], edges: [] }
  const loop = (over: Record<string, unknown>) => ({ id: 'x', name: 'X', status: 'published', graph, ...over }) as unknown as LoopDefinition

  it('drops seeded built-in rows so pickers never list a built-in twice', () => {
    const out = railRunnableCustomLoops([
      loop({ id: 'factory:freestyle', name: 'Freestyle', builtinId: 'factory:freestyle' }),
      loop({ id: 'mine', name: 'My loop' }),
      loop({ id: 'draft', name: 'Draft', status: 'draft' }),
    ])
    expect(out.map((l) => l.id)).toEqual(['mine'])
  })
})
