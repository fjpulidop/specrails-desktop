import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { parsePolicyDeniedRow, parsePolicyLogLine } from '../policy-denial'
import { PolicyDeniedNotice } from '../PolicyDeniedNotice'
import { parseEvent } from '../../../features/jobs/lib/log-lines'

describe('policy denial rows', () => {
  it('parses the job log line and the mission system row', () => {
    expect(parsePolicyLogLine('[specrails-policy:git-force-push] Force-pushing rewrites shared history.')).toEqual({ rule: 'git-force-push', reason: 'Force-pushing rewrites shared history.' })
    expect(parsePolicyLogLine('[specrails-policy:unknown] x')).toBeNull()
    expect(parsePolicyLogLine('plain line')).toBeNull()
    expect(parsePolicyDeniedRow(JSON.stringify({ kind: 'policy-denied', rule: 'secret-access', reason: 'No.', tool: 'Read' }))).toEqual({ rule: 'secret-access', reason: 'No.', tool: 'Read' })
    expect(parsePolicyDeniedRow(JSON.stringify({ kind: 'run-failure' }))).toBeNull()
    expect(parsePolicyDeniedRow('not json')).toBeNull()
  })

  it('job/loop log parsing turns the line into a policy row', () => {
    const line = parseEvent({ id: 1, job_id: 'j', seq: 1, event_type: 'log', source: 'stdout', payload: JSON.stringify({ line: '[specrails-policy:rm-outside-run] Recursive deletion outside the run directory is not allowed (..).' }), timestamp: '2026-11-18T10:00:00Z' } as never, 0)
    expect(line).toMatchObject({ type: 'policy', denial: { rule: 'rm-outside-run' } })
  })

  it('renders what was blocked and why', () => {
    render(<PolicyDeniedNotice denial={{ rule: 'git-push-protected', reason: 'Pushing to the integration branch "main" is not allowed.', tool: 'Bash' }} />)
    expect(screen.getByRole('note', { name: 'Blocked by Specrails policy' })).toBeInTheDocument()
    expect(screen.getByText(/Push to the integration branch/)).toBeInTheDocument()
    expect(screen.getByText(/"main" is not allowed/)).toBeInTheDocument()
  })
})
