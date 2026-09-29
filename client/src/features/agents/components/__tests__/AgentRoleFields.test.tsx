import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '../../../../test-utils'
import { AgentStudio } from '../AgentStudio'
import { AgentRoleFields } from '../AgentRoleFields'
import { readAgentRoleMetadata, setAgentRoleMetadata } from '../../lib/agent-role-metadata'

const body = '---\nname: custom-auditor\ndescription: Keep this\nmodel: inherit\ncolor: blue\n---\n\n# Review\n\nKeep the public API.\n'
describe('Agent Studio Core roles', () => {
  it('edits nested engine metadata while preserving native metadata and exact instructions', () => {
    let edited = setAgentRoleMetadata(body, 'engine.escalation.model', 'opus')
    edited = setAgentRoleMetadata(edited, 'engine.model', 'sonnet')
    edited = setAgentRoleMetadata(edited, 'access', 'write')
    const parsed = readAgentRoleMetadata(edited)
    expect(parsed.metadata).toMatchObject({ name: 'custom-auditor', description: 'Keep this', color: 'blue', access: 'write', engine: { model: 'sonnet', escalation: { model: 'opus' } } })
    expect(parsed.instructions).toBe(readAgentRoleMetadata(body).instructions)
    expect(readAgentRoleMetadata(setAgentRoleMetadata(edited, 'engine.escalation.model', '')).metadata.engine).toEqual({ model: 'sonnet' })
  })
  it('preserves CRLF and refuses malformed metadata instead of overwriting it', () => {
    const windows = body.replace(/\n/g, '\r\n')
    const edited = setAgentRoleMetadata(windows, 'engine.maxTurns', '128')
    expect(edited.replace(/\r\n/g, '')).not.toContain('\n')
    expect(readAgentRoleMetadata(edited).metadata.engine).toEqual({ maxTurns: 128 })
    expect(() => setAgentRoleMetadata('---\nengine: [\n---\nBody', 'access', 'write')).toThrow()
  })
  it('defaults to read/none with no implicit skill and writes explicit controls', () => {
    const change = vi.fn()
    render(<AgentRoleFields body={body} onChange={change} />)
    expect(screen.getByLabelText('Source access')).toHaveValue('read')
    expect(screen.getByLabelText('OpenSpec artifact access')).toHaveValue('none')
    expect(screen.getByLabelText('OpenSpec skill')).toHaveValue('')
    fireEvent.change(screen.getByLabelText('Source access'), { target: { value: 'write' } })
    expect(readAgentRoleMetadata(change.mock.lastCall![0]).metadata.access).toBe('write')
    fireEvent.change(screen.getByLabelText('Higher-tier model'), { target: { value: 'opus' } })
    expect(readAgentRoleMetadata(change.mock.lastCall![0]).metadata.engine).toEqual({ escalation: { model: 'opus' } })
  })
  it('synchronizes non-Kimi file identity and refuses shadowing built-in roles', () => {
    render(<AgentStudio provider="claude" initialBody={body} onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('custom-my-agent'), { target: { value: 'custom-reviewer' } })
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
    fireEvent.change(screen.getByPlaceholderText('custom-my-agent'), { target: { value: 'custom-api-reviewer' } })
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toContain('name: custom-api-reviewer')
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled()
  })
})
