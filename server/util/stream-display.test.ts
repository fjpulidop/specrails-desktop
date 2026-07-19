import { describe, it, expect } from 'vitest'
import { extractDisplayText } from './stream-display'

describe('extractDisplayText', () => {
  describe('Claude stream-json frames', () => {
    it('joins assistant text content blocks', () => {
      const frame = {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] },
      }
      expect(extractDisplayText(frame)).toBe('hello world')
    })

    it('returns null for an assistant frame with no text blocks', () => {
      const frame = { type: 'assistant', message: { content: [{ type: 'tool_use' }] } }
      expect(extractDisplayText(frame)).toBeNull()
    })

    it('renders a top-level tool_use using name/input', () => {
      const frame = { type: 'tool_use', name: 'Read', input: { file_path: '/x.ts' } }
      expect(extractDisplayText(frame)).toBe('[tool: Read] {"file_path":"/x.ts"}')
    })

    it('returns null for tool_result / system / user / result frames', () => {
      for (const type of ['tool_result', 'system_prompt', 'user', 'system', 'result']) {
        expect(extractDisplayText({ type })).toBeNull()
      }
    })
  })

  describe('Codex exec --json frames', () => {
    it('surfaces agent_message text on item.completed', () => {
      const frame = { type: 'item.completed', item: { type: 'agent_message', text: 'done' } }
      expect(extractDisplayText(frame)).toBe('done')
    })

    it('renders command_execution only on item.completed with exit code', () => {
      const completed = {
        type: 'item.completed',
        item: { type: 'command_execution', command: 'ls -la', exit_code: 0 },
      }
      expect(extractDisplayText(completed)).toBe('[exec] → exit 0 ls -la')

      const started = {
        type: 'item.started',
        item: { type: 'command_execution', command: 'ls -la' },
      }
      expect(extractDisplayText(started)).toBeNull()
    })

    it('prefixes agent_reasoning', () => {
      const frame = { type: 'item.completed', item: { type: 'agent_reasoning', text: 'thinking' } }
      expect(extractDisplayText(frame)).toBe('[reasoning] thinking')
    })

    it('returns null for thread/turn lifecycle frames', () => {
      for (const type of ['thread.started', 'turn.started', 'turn.completed']) {
        expect(extractDisplayText({ type })).toBeNull()
      }
    })

    it('surfaces turn.failed with the nested error message (codex 0.139)', () => {
      const frame = { type: 'turn.failed', error: { message: "You've hit your usage limit." } }
      expect(extractDisplayText(frame)).toBe("[turn failed] You've hit your usage limit.")
    })

    it('surfaces a standalone error frame', () => {
      expect(extractDisplayText({ type: 'error', message: 'model not available' })).toBe(
        '[error] model not available',
      )
    })

    it('renders bare turn.failed / error frames without a trailing space', () => {
      expect(extractDisplayText({ type: 'turn.failed' })).toBe('[turn failed]')
      expect(extractDisplayText({ type: 'error' })).toBe('[error]')
    })
  })

  describe('Gemini stream-json frames', () => {
    it('renders tool_use via tool_name/parameters (regression: no more [tool: undefined])', () => {
      const frame = {
        type: 'tool_use',
        tool_name: 'read_file',
        tool_id: 't0',
        parameters: { file_path: '.specrails/local-tickets.json' },
      }
      expect(extractDisplayText(frame)).toBe('[tool: read_file] {"file_path":".specrails/local-tickets.json"}')
    })

    it('falls back to <unnamed> when neither name nor tool_name present', () => {
      expect(extractDisplayText({ type: 'tool_use', parameters: {} })).toBe('[tool: <unnamed>] {}')
    })

    it('surfaces assistant message delta content', () => {
      const frame = { type: 'message', role: 'assistant', content: 'The content is hello world', delta: true }
      expect(extractDisplayText(frame)).toBe('The content is hello world')
    })

    it('ignores the role:user echo frame', () => {
      const frame = { type: 'message', role: 'user', content: 'read note.txt' }
      expect(extractDisplayText(frame)).toBeNull()
    })

    it('returns null for an empty assistant message', () => {
      expect(extractDisplayText({ type: 'message', role: 'assistant', content: '' })).toBeNull()
    })

    it('returns null for init and tool_result frames', () => {
      expect(extractDisplayText({ type: 'init', session_id: 'abc', model: 'gemini-3.5-flash' })).toBeNull()
      expect(extractDisplayText({ type: 'tool_result', tool_id: 't0', status: 'success', output: '' })).toBeNull()
    })
  })

  describe('Kimi stream-json frames', () => {
    it('renders role-discriminated assistant text without a type field', () => {
      expect(extractDisplayText({ role: 'assistant', content: 'Kimi says hello' })).toBe('Kimi says hello')
    })

    it('joins array content and renders all function calls from the same frame', () => {
      const frame = {
        role: 'assistant',
        content: [{ type: 'text', text: 'Checking files' }],
        tool_calls: [
          { function: { name: 'ReadFile', arguments: '{"path":"README.md"}' } },
          { function: { name: 'Search', arguments: { query: 'provider' } } },
        ],
      }
      expect(extractDisplayText(frame)).toBe(
        'Checking files\n[tool: ReadFile] {"path":"README.md"}\n[tool: Search] {"query":"provider"}',
      )
    })

    it('returns null for non-assistant Kimi metadata', () => {
      expect(extractDisplayText({
        role: 'meta',
        type: 'session.resume_hint',
        session_id: 's1',
      })).toBeNull()
    })
  })

  it('returns null for an unknown frame type', () => {
    expect(extractDisplayText({ type: 'totally-unknown' })).toBeNull()
  })
})
