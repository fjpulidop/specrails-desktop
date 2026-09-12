import { describe, it, expect } from 'vitest'
import { deriveFrameActivity, countActivitySteps, mapTool } from '../frame-activity'
import type { EventRow } from '../../types'
import kimiAssistantToolCalls from './fixtures/kimi-assistant-tool-calls.json'

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
  it('Kimi assistant frame counts function calls and labels the last action', () => {
    expect(deriveFrameActivity(ev('assistant', kimiAssistantToolCalls))).toMatchObject({
      step: true,
      stepCount: 2,
      actionKey: 'reading',
      actionArg: 'package.json',
    })
  })
  it('Kimi assistant text-only frame = 1 thinking step', () => {
    expect(deriveFrameActivity(ev('assistant', { role: 'assistant', content: 'Done.' })))
      .toMatchObject({ step: true, actionKey: 'thinking' })
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
    expect(mapTool('WriteFile', { path: '/x/kimi.ts' })).toMatchObject({ actionKey: 'writing', actionArg: 'kimi.ts' })
    expect(mapTool('ReadMediaFile', { path: '/x/mock.png' })).toMatchObject({ actionKey: 'reading', actionArg: 'mock.png' })
    expect(mapTool('Grep', { pattern: 'foo' })).toMatchObject({ actionKey: 'searching', actionArg: 'foo' })
    expect(mapTool('Unknown', {})).toMatchObject({ actionKey: 'working' })
  })
})

describe('deriveFrameActivity — Specrails Core agent runtime events', () => {
  it('maps runtime tool-start events onto the shared activity vocabulary', () => {
    expect(deriveFrameActivity(ev('agent-event', { role: 'developer', event: { kind: 'tool-start', tool: 'Read', detail: 'src/app.ts' } })))
      .toMatchObject({ step: true, actionKey: 'reading', actionArg: 'app.ts' })
    expect(deriveFrameActivity(ev('agent-event', { role: 'developer', event: { kind: 'tool-start', tool: 'Bash', detail: 'npm test' } })))
      .toMatchObject({ step: true, actionKey: 'running', actionArg: 'npm' })
    expect(deriveFrameActivity(ev('agent-event', { role: 'architect', event: { kind: 'tool-start', tool: 'grep_search', detail: 'multiply' } })))
      .toMatchObject({ step: true, actionKey: 'searching', actionArg: 'multiply' })
    expect(deriveFrameActivity(ev('agent-event', { role: 'developer', event: { kind: 'tool-start', tool: 'write_file', detail: 'math.js' } })))
      .toMatchObject({ step: true, actionKey: 'writing', actionArg: 'math.js' })
    expect(deriveFrameActivity(ev('agent-event', { role: 'developer', event: { kind: 'tool-start', tool: 'shell', detail: 'cargo test' } })))
      .toMatchObject({ step: true, actionKey: 'running', actionArg: 'cargo' })
  })
  it('counts runtime prose as thinking and ignores usage frames', () => {
    expect(deriveFrameActivity(ev('agent-event', { role: 'reviewer', event: { kind: 'text', text: 'Inspecting.' } }))).toMatchObject({ step: true, actionKey: 'thinking' })
    expect(deriveFrameActivity(ev('agent-event', { role: 'reviewer', event: { kind: 'usage', usage: {} } })).step).toBe(false)
    expect(deriveFrameActivity(ev('workflow-event', { event: { type: 'step_started', stepId: 'architect' } })).step).toBe(false)
  })
})
