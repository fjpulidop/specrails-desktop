import { describe, expect, it } from 'vitest'
import { createStreamAuditTap, recordPolicyDenial, type AgentActionInput } from '../index'
import { extractDisplayText } from '../../../util/stream-display'

const REASON = 'PreToolUse:Bash hook error: Blocked by Specrails policy: Force-pushing rewrites shared history. Do not retry it another way; continue without it or explain what you need. [specrails-policy:git-force-push]'

function recorder() {
  const rows: AgentActionInput[] = []
  return { rows, record: (input: AgentActionInput | readonly AgentActionInput[]) => { rows.push(...(Array.isArray(input) ? input : [input as AgentActionInput])) } }
}

const toolUse = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git push --force origin x' } }] } }
const denied = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: REASON }] }, tool_result_meta: [{ id: 't1', permission_decision: { source: 'hook' } }] }

describe('policy denials in the agent actions audit', () => {
  it('the stream tap records the attempt and the denial with the blocked target', () => {
    const r = recorder()
    const tap = createStreamAuditTap(r, { runId: 'job-1', role: 'developer' })
    tap(toolUse)
    tap(denied)
    expect(r.rows).toEqual([
      expect.objectContaining({ runId: 'job-1', kind: 'exec', source: 'claude-stream', target: 'git push --force origin x' }),
      expect.objectContaining({ runId: 'job-1', kind: 'exec', source: 'policy-hook', role: 'developer', target: 'denied by policy (git-force-push): git push --force origin x' }),
    ])
  })

  it('records a denial reported with the call (missions) or without it', () => {
    const r = recorder()
    recordPolicyDenial(r, { runId: 'conv', role: 'mission' }, { rule: 'secret-access', reason: 'no' }, { name: 'Read', input: { file_path: '/Users/u/.ssh/id_rsa' } })
    recordPolicyDenial(r, { runId: 'conv', role: 'mission' }, { rule: 'secret-access', reason: 'Credentials are off limits' }, null)
    expect(r.rows.map((row) => [row.kind, row.target, row.source])).toEqual([
      ['read', 'denied by policy (secret-access): /Users/u/.ssh/id_rsa', 'policy-hook'],
      ['exec', 'denied by policy (secret-access): Credentials are off limits', 'policy-hook'],
    ])
  })

  it('job logs get one explicit policy line; other tool results stay out', () => {
    expect(extractDisplayText(denied)).toBe('[specrails-policy:git-force-push] Force-pushing rewrites shared history.')
    expect(extractDisplayText({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } })).toBeNull()
  })
})
