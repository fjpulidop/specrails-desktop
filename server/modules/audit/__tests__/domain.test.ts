import { describe, expect, it } from 'vitest'
import {
  classifyToolCall,
  classifyToolName,
  createStreamAuditState,
  extractStreamActions,
  normaliseTarget,
  parseAgentAuditFormat,
  patchPaths,
  redactCommand,
  redactUrl,
  retentionCutoff,
  toAgentActionRow,
  toCsv,
  toJsonl,
  type AgentActionRecord,
} from '../domain'

const strip = (drafts: ReturnType<typeof extractStreamActions>) => drafts.map(({ kind, target, role, source }) => ({ kind, target, role, source }))

describe('tool name classification', () => {
  it.each([
    ['Read', 'read'], ['Grep', 'read'], ['Glob', 'read'], ['read_file', 'read'],
    ['Edit', 'write'], ['Write', 'write'], ['MultiEdit', 'write'], ['apply_patch', 'write'], ['NotebookEdit', 'write'],
    ['Bash', 'exec'], ['shell', 'exec'], ['exec_command', 'exec'], ['run_shell_command', 'exec'],
    ['WebFetch', 'network'], ['WebSearch', 'network'], ['google_web_search', 'network'],
    ['mcp__specrails__specrails_jobs', 'mcp'],
  ])('%s → %s', (name, kind) => {
    expect(classifyToolName(name)).toBe(kind)
  })

  it('ignores tools that are not reads, writes, commands, MCP or network', () => {
    for (const name of ['TodoWrite', 'Task', 'Agent', 'ExitPlanMode', 'update_plan', '']) expect(classifyToolName(name)).toBeNull()
  })
})

describe('Claude stream-json', () => {
  it('records each tool_use block of an assistant frame with its target', () => {
    const state = createStreamAuditState()
    const event = {
      type: 'assistant',
      message: { content: [
        { type: 'text', text: 'Looking around' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/a.ts' } },
        { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test -- --token abc123' } },
        { type: 'tool_use', id: 't3', name: 'Write', input: { file_path: 'src/b.ts', content: 'SECRET FILE BODY' } },
        { type: 'tool_use', id: 't4', name: 'TodoWrite', input: { todos: [] } },
      ] },
    }
    const drafts = extractStreamActions(event, state, 'orchestrator')
    expect(strip(drafts)).toEqual([
      { kind: 'read', target: 'src/a.ts', role: 'orchestrator', source: 'claude-stream' },
      { kind: 'exec', target: 'npm test -- --token ***', role: 'orchestrator', source: 'claude-stream' },
      { kind: 'write', target: 'src/b.ts', role: 'orchestrator', source: 'claude-stream' },
    ])
    // The content is only offered for hashing; it never becomes a target.
    expect(drafts[2]!.hashSource).toBe('SECRET FILE BODY')
    expect(JSON.stringify(strip(drafts))).not.toContain('SECRET FILE BODY')
  })

  it('attributes sub-agent actions to the Task subagent_type through parent_tool_use_id', () => {
    const state = createStreamAuditState()
    extractStreamActions({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'task-1', name: 'Task', input: { subagent_type: 'sr-architect' } }] } }, state)
    const drafts = extractStreamActions({ type: 'assistant', parent_tool_use_id: 'task-1', message: { content: [{ type: 'tool_use', id: 'x', name: 'Grep', input: { pattern: 'TODO', path: 'server' } }] } }, state)
    expect(strip(drafts)).toEqual([{ kind: 'read', target: 'server', role: 'architect', source: 'claude-stream' }])
  })
})

describe('Codex exec --json', () => {
  it('records a command once across item.started and item.completed', () => {
    const state = createStreamAuditState()
    const started = { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'bash -lc "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 gh pr list"' } }
    expect(strip(extractStreamActions(started, state))).toEqual([
      { kind: 'exec', target: 'bash -lc "GITHUB_TOKEN=*** gh pr list"', role: 'agent', source: 'codex-stream' },
    ])
    expect(extractStreamActions({ ...started, type: 'item.completed' }, state)).toEqual([])
  })

  it('records file changes on completion, MCP calls and web searches', () => {
    const state = createStreamAuditState()
    expect(extractStreamActions({ type: 'item.started', item: { id: 'f', type: 'file_change', changes: [] } }, state)).toEqual([])
    expect(strip(extractStreamActions({ type: 'item.completed', item: { id: 'f', type: 'file_change', changes: [{ path: 'a.ts', kind: 'update' }, { path: 'b.ts', kind: 'add' }] } }, state)).map(d => d.target)).toEqual(['a.ts', 'b.ts'])
    expect(strip(extractStreamActions({ type: 'item.completed', item: { id: 'm', type: 'mcp_tool_call', server: 'github', tool: 'create_issue', arguments: { body: 'x' } } }, state))).toEqual([
      { kind: 'mcp', target: 'mcp__github__create_issue', role: 'agent', source: 'codex-stream' },
    ])
    expect(strip(extractStreamActions({ type: 'item.completed', item: { id: 'w', type: 'web_search', query: 'vitest fake timers' } }, state))[0]).toMatchObject({ kind: 'network', target: 'search: vitest fake timers' })
  })

  it('unwraps ["bash","-lc",script] shell calls and reads apply_patch file names only', () => {
    expect(classifyToolCall('shell', { command: ['bash', '-lc', 'ls -la'] }, 'codex-stream')[0]!.target).toBe('ls -la')
    const patch = '*** Begin Patch\n*** Update File: src/x.ts\n@@\n-secret\n+value\n*** Add File: src/y.ts\n+body\n*** End Patch'
    expect(classifyToolCall('apply_patch', { input: patch }, 'codex-stream').map(d => d.target)).toEqual(['src/x.ts', 'src/y.ts'])
    expect(patchPaths('--- a/one.ts\n+++ b/one.ts\n')).toEqual(['one.ts'])
  })
})

describe('Gemini stream-json', () => {
  it('classifies tool_use frames by tool_name and parameters', () => {
    expect(strip(extractStreamActions({ type: 'tool_use', tool_name: 'read_file', parameters: { absolute_path: '/repo/a.md' } }, createStreamAuditState()))).toEqual([
      { kind: 'read', target: '/repo/a.md', role: 'agent', source: 'gemini-stream' },
    ])
  })
})

describe('Core agent-event lines', () => {
  it('uses the event role, target paths and redacted command details', () => {
    const state = createStreamAuditState()
    expect(strip(extractStreamActions({ type: 'agent-event', role: 'developer', event: { kind: 'tool-start', tool: 'Edit', detail: 'src/a.ts', targetPaths: ['src/a.ts'] } }, state))).toEqual([
      { kind: 'write', target: 'src/a.ts', role: 'developer', source: 'core-agent-event' },
    ])
    expect(strip(extractStreamActions({ type: 'agent-event', role: 'reviewer', event: { kind: 'tool-start', tool: 'Bash', detail: 'curl -H "Authorization: Bearer abc.def" https://x' } }, state))[0]!.target)
      .toBe('curl -H "Authorization: ***" https://x')
    expect(strip(extractStreamActions({ type: 'agent-event', role: 'developer', event: { kind: 'tool-start', tool: 'npm', detail: 'ci (repo)' } }, state))).toEqual([
      { kind: 'exec', target: 'npm ci (repo)', role: 'developer', source: 'core-agent-event' },
    ])
    expect(extractStreamActions({ type: 'agent-event', role: 'developer', event: { kind: 'text', text: 'hi' } }, state)).toEqual([])
    expect(extractStreamActions({ type: 'agent-event', role: 'developer', event: { kind: 'tool-start', tool: 'TodoWrite' } }, state)).toEqual([])
  })

  it('never throws on malformed input', () => {
    for (const value of [null, undefined, 42, 'text', [], { type: 'assistant', message: { content: 'nope' } }, { type: 'item.completed', item: null }]) {
      expect(extractStreamActions(value, createStreamAuditState())).toEqual([])
    }
  })
})

describe('redaction and normalisation', () => {
  it('removes obvious secrets from commands', () => {
    expect(redactCommand('API_KEY=xyz OTHER=1 npm run deploy')).toBe('API_KEY=*** OTHER=*** npm run deploy')
    expect(redactCommand('export NPM_TOKEN=abc && npm publish')).toBe('export NPM_TOKEN=*** && npm publish')
    expect(redactCommand('gh auth login --with-token --token=abc --password "p w"')).toBe('gh auth login --with-token --token=*** --password ***')
    expect(redactCommand('git clone https://user:pw@github.com/o/r.git')).toBe('git clone https://***@github.com/o/r.git')
    expect(redactCommand('echo sk-ant-api03-abcdefghijklmnopqrstuvwxyz')).toBe('echo ***')
    expect(redactCommand('npm test -- --passWithNoTests')).toBe('npm test -- --passWithNoTests')
  })

  it('drops URL queries and credentials', () => {
    expect(redactUrl('https://user:pw@api.example.com/v1/x?key=secret#frag')).toBe('https://api.example.com/v1/x')
    expect(classifyToolCall('WebFetch', { url: 'https://example.com/a?token=1', prompt: 'summarise' }, 'claude-stream')[0]!.target).toBe('https://example.com/a')
  })

  it('bounds targets to one line', () => {
    expect(normaliseTarget('a\n\tb')).toBe('a b')
    expect(normaliseTarget('x'.repeat(600)).length).toBe(512)
  })

  it('builds rows only from valid inputs', () => {
    const now = '2026-10-21T10:00:00.000Z'
    expect(toAgentActionRow({ runId: 'r', kind: 'read', target: 'a', source: 's' }, null, now)).toEqual({ runId: 'r', jobId: null, role: 'agent', kind: 'read', target: 'a', hash: null, ts: now, source: 's' })
    expect(toAgentActionRow({ runId: '', kind: 'read', target: 'a', source: 's' }, null, now)).toBeNull()
    expect(toAgentActionRow({ runId: 'r', kind: 'delete' as never, target: 'a', source: 's' }, null, now)).toBeNull()
    expect(toAgentActionRow({ runId: 'r', kind: 'exec', target: '   ', source: 's' }, null, now)).toBeNull()
  })
})

describe('export formats and retention', () => {
  const record: AgentActionRecord = { id: 1, runId: 'run-1', jobId: 'run-1', role: 'developer', kind: 'exec', target: '=HYPERLINK("x"), y', hash: null, ts: '2026-10-21T10:00:00.000Z', source: 'claude-stream' }

  it('serialises JSONL one object per line and CSV with escaping and formula guard', () => {
    expect(toJsonl([record, { ...record, id: 2 }]).trim().split('\n').map(line => JSON.parse(line).id)).toEqual([1, 2])
    expect(toJsonl([])).toBe('')
    const csv = toCsv([record]).trim().split('\n')
    expect(csv[0]).toBe('id,ts,run_id,job_id,role,kind,target,hash,source')
    expect(csv[1]).toBe('1,2026-10-21T10:00:00.000Z,run-1,run-1,developer,exec,"\'=HYPERLINK(""x""), y",,claude-stream')
  })

  it('parses formats and computes the cutoff within bounds', () => {
    expect(parseAgentAuditFormat(undefined)).toBe('jsonl')
    expect(parseAgentAuditFormat('csv')).toBe('csv')
    expect(parseAgentAuditFormat('xml')).toBeNull()
    const now = Date.parse('2026-10-31T00:00:00.000Z')
    expect(retentionCutoff(now, 30)).toBe('2026-10-01T00:00:00.000Z')
    expect(retentionCutoff(now, 0)).toBe('2026-10-30T00:00:00.000Z')
  })
})
