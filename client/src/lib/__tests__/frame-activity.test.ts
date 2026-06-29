import { describe, it, expect } from 'vitest'
import { deriveFrameActivity, countActivitySteps, mapTool } from '../frame-activity'
import type { EventRow } from '../../types'

const ev = (event_type: string, payload: unknown): EventRow =>
  ({ event_type, payload: typeof payload === 'string' ? payload : JSON.stringify(payload) }) as EventRow

describe('deriveFrameActivity', () => {
  it('assistant frame with N parallel tool_use blocks = N steps, label from last', () => {
    const a = deriveFrameActivity(ev('assistant', { message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/a/b.ts' } }, { type: 'tool_use', name: 'Read', input: { file_path: '/c/d.ts' } }] } }))
    expect(a).toMatchObject({ step: true, stepCount: 2, actionKey: 'reading', actionArg: 'd.ts' })
  })
  it('assistant text-only frame = 1 thinking step', () => {
    expect(deriveFrameActivity(ev('assistant', { message: { content: [{ type: 'text', text: 'hi' }] } }))).toMatchObject({ step: true, actionKey: 'thinking' })
  })
  it('bare tool_use = 1 step', () => {
    expect(deriveFrameActivity(ev('tool_use', { name: 'Bash', input: { command: 'npm test' } }))).toMatchObject({ step: true, actionKey: 'running', actionArg: 'npm' })
  })
  it('codex item.completed function_call = 1 running step', () => {
    expect(deriveFrameActivity(ev('item.completed', { item: { type: 'function_call', arguments: '{"command":"ls -la"}' } }))).toMatchObject({ step: true, actionKey: 'running', actionArg: 'ls' })
  })
  it('loop_step / log / result are NOT activity steps', () => {
    expect(deriveFrameActivity(ev('loop_step', { index: 3 })).step).toBe(false)
    expect(deriveFrameActivity(ev('log', { line: 'x' })).step).toBe(false)
    expect(deriveFrameActivity(ev('result', {})).step).toBe(false)
  })
  it('unparseable payload still counts the frame', () => {
    expect(deriveFrameActivity(ev('assistant', 'not json')).step).toBe(true)
  })
})

describe('countActivitySteps', () => {
  it('sums stepCount across frames, ignoring non-activity events', () => {
    const events = [
      ev('assistant', { message: { content: [{ type: 'tool_use' }, { type: 'tool_use' }] } }), // 2
      ev('tool_use', { name: 'Read' }), // 1
      ev('loop_step', { index: 1 }), // 0
      ev('log', { line: 'a' }), // 0
      ev('item.completed', { item: { type: 'agent_message' } }), // 1
    ]
    expect(countActivitySteps(events)).toBe(4)
  })
})

describe('mapTool', () => {
  it('maps known tools to action keys', () => {
    expect(mapTool('Write', { file_path: '/x/y.ts' })).toMatchObject({ actionKey: 'writing', actionArg: 'y.ts' })
    expect(mapTool('Grep', { pattern: 'foo' })).toMatchObject({ actionKey: 'searching', actionArg: 'foo' })
    expect(mapTool('Unknown', {})).toMatchObject({ actionKey: 'working' })
  })
})
