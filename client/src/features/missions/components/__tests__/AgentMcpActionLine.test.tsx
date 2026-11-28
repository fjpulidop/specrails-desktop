import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AgentMcpActionLine, mcpCallName, parseMcpActionRow } from '../AgentMcpActionLine'

const row = (over: Record<string, unknown> = {}) => JSON.stringify({ kind: 'mcp-action', client: 'claude-code', tool: 'specrails_runs', action: 'launch', tier: 'ai-spawn', ok: true, summary: 'Launched Rail 1', ...over })

describe('mcp-action rows', () => {
  it('parses an MCP client change and ignores anything else', () => {
    expect(parseMcpActionRow(row())).toMatchObject({ client: 'claude-code', tool: 'specrails_runs', action: 'launch', ok: true, summary: 'Launched Rail 1', error: null })
    expect(parseMcpActionRow(row({ ok: false, error: { code: 'conflict', message: 'Rail busy' } }))).toMatchObject({ ok: false, error: { code: 'conflict', message: 'Rail busy' } })
    expect(parseMcpActionRow(JSON.stringify({ kind: 'flow-boundary' }))).toBeNull()
    expect(parseMcpActionRow(row({ tool: '' }))).toBeNull()
    expect(parseMcpActionRow('not json')).toBeNull()
  })

  it('names the call as runs.launch', () => {
    expect(mcpCallName({ tool: 'specrails_runs', action: 'launch' })).toBe('runs.launch')
  })

  it('renders the client, the call and its outcome', () => {
    const { rerender } = render(<AgentMcpActionLine row={parseMcpActionRow(row())!} />)
    const line = screen.getByTestId('agent-mcp-action')
    expect(line).toHaveTextContent('claude-code · runs.launch')
    expect(line).toHaveTextContent('Launched Rail 1')
    expect(line).toHaveAttribute('data-ok', 'true')
    rerender(<AgentMcpActionLine row={parseMcpActionRow(row({ ok: false, summary: undefined, error: { code: 'conflict', message: 'Rail busy' } }))!} />)
    expect(screen.getByTestId('agent-mcp-action')).toHaveTextContent('claude-code · runs.launch failed')
    expect(screen.getByTestId('agent-mcp-action')).toHaveTextContent('Rail busy')
  })
})
