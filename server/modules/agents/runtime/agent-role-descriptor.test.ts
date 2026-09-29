import { describe, expect, it } from 'vitest'
import { projectCustomAgentRole, projectCustomAgentRoles } from './agent-role-descriptor'

const fallback = { provider: 'claude', model: 'sonnet' }
const document = (front = '', id = 'custom-auditor') => ({ id, content: `---\nname: ${id}\n${front}\n---\nCheck the frozen acceptance requirements.` })
describe('Agent Studio role projection', () => {
  it('defaults to read-only source access and no artifact writes', () => {
    expect(projectCustomAgentRole(document(), fallback)).toEqual({ id: 'auditor', role: { provider: 'claude', model: 'sonnet', access: 'read', artifacts: 'none', prompt: 'Check the frozen acceptance requirements.' } })
  })
  it('maps engine and explicit permissions without enabling an implicit OpenSpec skill', () => {
    const { role } = projectCustomAgentRole(document('access: write\nartifacts: tasks-checkboxes\nengine:\n  provider: codex\n  model: gpt-example\n  effort: high\n  maxTurns: 128'), fallback)
    expect(role).toMatchObject({ provider: 'codex', model: 'gpt-example', effort: 'high', maxTurns: 128, access: 'write', artifacts: 'tasks-checkboxes' })
    expect(role.openspecSkill).toBeUndefined()
    expect(projectCustomAgentRole(document('openspecSkill: openspec-verify-change'), fallback).role.openspecSkill).toBe('openspec-verify-change')
  })
  it('preserves explicit project overrides and legacy model inherit semantics', () => {
    const roles = projectCustomAgentRoles([document('model: inherit')], fallback, { auditor: { provider: 'codex', model: 'custom-model', access: 'read', artifacts: 'none', prompt: 'Project instructions' } })
    expect(roles.auditor).toMatchObject({ provider: 'codex', model: 'custom-model', prompt: 'Project instructions' })
    expect(projectCustomAgentRole(document('model: inherit'), fallback).role.model).toBe('sonnet')
  })
  it('supports a distinct escalation without changing source permissions', () => {
    const role = projectCustomAgentRole(document('engine:\n  escalation:\n    model: opus\n    effort: high'), fallback).role
    expect(role).toMatchObject({ model: 'sonnet', escalation: { model: 'opus', effort: 'high' }, access: 'read', artifacts: 'none' })
    expect(projectCustomAgentRole({ id: 'custom-auditor', content: 'Review this project.' }, fallback).role.prompt).toBe('Review this project.')
  })
  it.each(['null', '[]', '{model: sonnet}', '{model: "--invalid"}', '{model: opus, effort: 1}', '{model: opus, provider: codex}'])('rejects malformed or redundant escalation %s', escalation => {
    expect(() => projectCustomAgentRole(document(`engine:\n  escalation: ${escalation}`), fallback)).toThrow('escalation')
  })
  it.each(['custom-architect', 'custom-developer', 'custom-reviewer', 'custom-fixer', 'custom-1bad', 'custom-UPPER'])('rejects builtin shadowing and invalid role id %s', id => {
    expect(() => projectCustomAgentRole(document('', id), fallback)).toThrow('non-built-in role')
  })
  it.each(['access: admin', 'artifacts: arbitrary', 'openspecSkill: remote-code', 'engine: shell', 'engine: {provider: "--bad"}', 'engine: {model: "--bad"}', 'engine: {maxTurns: 0}', 'engine: {surprise: true}'])('rejects invalid descriptor metadata %s', front => {
    expect(() => projectCustomAgentRole(document(front), fallback)).toThrow()
  })
  it('rejects duplicate roles, identity changes and empty instructions', () => {
    expect(() => projectCustomAgentRoles([document(), document()], fallback)).toThrow('Duplicate')
    expect(() => projectCustomAgentRole({ id: 'custom-auditor', content: '---\nname: custom-other\n---\nBody' }, fallback)).toThrow('differs')
    expect(() => projectCustomAgentRole({ id: 'custom-auditor', content: '---\nname: custom-auditor\n---\n' }, fallback)).toThrow('instructions')
  })
})
