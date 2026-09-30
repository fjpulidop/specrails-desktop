import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, fireEvent, act } from '../../../../test-utils'
import { AgentRuntimeSettingsSection } from '../AgentRuntimeSettingsSection'
import { formatVerificationCommand, parseVerificationCommand, type AgentRuntimeConfig } from '../../lib/agent-runtime'
import type { DesktopProject } from '../../../../hooks/useDesktop'

const desktop = vi.hoisted(() => ({ activeProjectId: 'p1' as string | null, projects: [] as DesktopProject[] }))
vi.mock('../../../../hooks/useDesktop', () => ({ useDesktop: () => desktop }))
const defaults = (): AgentRuntimeConfig => ({
  schemaVersion: 1, enabled: true,
  providers: ['claude', 'codex', 'gemini', 'kimi'].map((id) => ({ id, kind: 'cli', cli: id })) as AgentRuntimeConfig['providers'],
  agents: { architect: { provider: 'claude' }, developer: { provider: 'codex' }, reviewer: { provider: 'gemini' } },
  verification: [],
})
const snapshot = (config = defaults(), runtimeAvailable = true, configured = false) => ({ config, configured, runtimeAvailable })
const response = (data: unknown, ok = true) => ({ ok, json: async () => data }) as Response
const suggestions = { repositories: [{ id: 'primary-p1', name: 'App' }], suggestions: [{ repositoryId: 'primary-p1', command: 'npm', args: ['test'], reason: 'package.json test script "test"' }] }
function mockServer(options: { detected?: unknown; configured?: boolean; config?: AgentRuntimeConfig; suggestions?: unknown; runtimeAvailable?: boolean; openRolesAvailable?: boolean; guardrails?: unknown; save?: (init: RequestInit) => Promise<Response> } = {}) {
  global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/capabilities')) return response({ schemaVersion: 1, roles: [] })
    if (String(url).endsWith('/verification-suggestions')) return response(options.suggestions ?? suggestions)
    if (String(url).endsWith('/agent-runtime/runs')) return response({ runs: [] })
    if (String(url).endsWith('/agent-runtime/guardrails')) return response(options.guardrails ?? { supported: true, catalog: [{ id: 'plan-validation', phase: 'architect' }, { id: 'empty-write', phase: 'developer' }] })
    if (String(url).includes('/providers/detected')) return response(options.detected ?? { detected: [], providers: {} })
    if (init?.method === 'PUT' && options.save) return options.save(init)
    if (init?.method === 'PUT') return response({ ...snapshot(JSON.parse(String(init.body)) as AgentRuntimeConfig, options.runtimeAvailable ?? true, true), openRolesAvailable: options.openRolesAvailable })
    return response({ ...snapshot(options.config ?? defaults(), options.runtimeAvailable ?? true, options.configured ?? false), openRolesAvailable: options.openRolesAvailable })
  })
}
const putBodies = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PUT').map(([, init]) => JSON.parse(String(init?.body)) as AgentRuntimeConfig)
beforeEach(() => {
  vi.clearAllMocks()
  desktop.activeProjectId = 'p1'
  desktop.projects = [{ id: 'p1', name: 'App', path: '/app', added_at: '' }] as DesktopProject[]
  mockServer()
})

describe('AgentRuntimeSettingsSection', () => {
  it('preserves distinct identical checks and their metadata when relabeling and reordering', async () => {
    const config = defaults()
    config.verification = [
      { repositoryId: 'primary-p1', key: 'first', label: 'First', command: 'npm', args: ['test'], cwd: 'src', env: { CI: 'true' }, timeoutMs: 1234, policy: { reuse: 'never' } },
      { repositoryId: 'primary-p1', key: 'second', label: 'Second', command: 'npm', args: ['test'], cwd: 'other', timeoutMs: 4321 },
    ]
    config.agents.developer = { provider: 'codex', model: 'base', effort: 'medium', escalation: { model: 'higher', effort: 'high' } }
    mockServer({ config, configured: true })
    const user = userEvent.setup()
    render(<AgentRuntimeSettingsSection />)
    const label = (await screen.findAllByLabelText('Check label (optional)'))[0]
    await user.clear(label); await user.type(label, 'Renamed')
    await user.click(screen.getByRole('button', { name: 'Move down 1' }))
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    const saved = putBodies().at(-1)!
    expect(saved.verification).toEqual([config.verification[1], { ...config.verification[0], label: 'Renamed' }])
    expect(saved.agents).toEqual(config.agents)
  })

  it('edits verification rows as command lines, detects more on request and rejects unterminated quotes', async () => {
    const user = userEvent.setup()
    render(<AgentRuntimeSettingsSection />)
    const line = await screen.findByDisplayValue('npm test')
    fireEvent.change(line, { target: { value: 'npm run "type check' } })
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('unterminated quote')
    expect(putBodies()).toHaveLength(0)
    fireEvent.change(line, { target: { value: 'npm run typecheck -- --strict' } })
    await user.click(screen.getByRole('button', { name: 'Add command' }))
    const lines = screen.getAllByLabelText('Command')
    fireEvent.change(lines[1], { target: { value: 'node --test "spec dir/a.test.js"' } })
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    await screen.findByText('Runtime settings saved')
    expect(putBodies().at(-1)?.verification).toEqual([
      { repositoryId: 'primary-p1', command: 'npm', args: ['run', 'typecheck', '--', '--strict'] },
      { repositoryId: 'primary-p1', command: 'node', args: ['--test', 'spec dir/a.test.js'] },
    ])
    await user.click(screen.getByRole('button', { name: 'Detect project checks' }))
    expect(await screen.findByDisplayValue('npm test')).toBeInTheDocument()
    expect(screen.getAllByLabelText('Command')).toHaveLength(3)
    await user.click(screen.getAllByRole('button', { name: 'Remove' })[0])
    expect(screen.getAllByLabelText('Command')).toHaveLength(2)
  })

  it('reports server validation errors without losing the draft and offers load retry', async () => {
    const user = userEvent.setup()
    const save = vi.fn<() => Promise<Response>>()
    mockServer({ configured: true, save })
    const view = render(<AgentRuntimeSettingsSection />)
    await screen.findByRole('button', { name: 'Save runtime settings' })
    save.mockResolvedValueOnce(response({ message: 'Role developer requires a model' }, false))
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Role developer requires a model')
    save.mockResolvedValueOnce(response({ error: 'invalid_runtime_config' }, false))
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid_runtime_config')
    save.mockRejectedValueOnce(new Error('Network offline'))
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Network offline')

    view.unmount()
    // The section also mounts useProviderDetection (one /api/providers/detected call) — answer it neutrally.
    vi.mocked(fetch).mockReset().mockImplementation(async (url: string) => String(url).includes('/providers/detected') ? response({ detected: [], providers: {} }) : response({}, false))
    render(<AgentRuntimeSettingsSection />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load runtime settings')
    mockServer({ runtimeAvailable: false, configured: true })
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('button', { name: 'Save runtime settings' })).toBeInTheDocument()
  })

  it('binds pending saves to their project and ignores a response after switching projects', async () => {
    const user = userEvent.setup()
    let finish!: (response: Response) => void
    mockServer({ configured: true, save: () => new Promise((resolve) => { finish = resolve }) })
    const { rerender } = render(<AgentRuntimeSettingsSection />)
    await screen.findByRole('button', { name: 'Save runtime settings' })
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    desktop.activeProjectId = 'p2'
    rerender(<AgentRuntimeSettingsSection />)
    await screen.findByRole('button', { name: 'Save runtime settings' })
    await act(async () => finish(response(snapshot({ ...defaults(), enabled: true }, true, true))))
    expect(screen.queryByText('Use the agent runtime for implementation')).not.toBeInTheDocument()
    expect(screen.queryByText('Runtime settings saved')).not.toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PUT').map(([url]) => url)).toEqual(['/api/projects/p1/agent-runtime/config'])
    desktop.activeProjectId = 'p1'
    rerender(<AgentRuntimeSettingsSection />)
    expect(screen.getByRole('button', { name: 'Save runtime settings' })).toBeInTheDocument()
  })

  it('round-trips command lines with quoted arguments', () => {
    expect(formatVerificationCommand({ command: 'npm', args: ['run', 'test', '--', 'a b'] })).toBe('npm run test -- "a b"')
    expect(parseVerificationCommand('npm run test -- "a b"')).toEqual({ command: 'npm', args: ['run', 'test', '--', 'a b'] })
    expect(parseVerificationCommand('  ')).toBeNull()
    expect(parseVerificationCommand('node "unterminated')).toBeNull()
    expect(parseVerificationCommand('echo "quote \\" inside"')).toEqual({ command: 'echo', args: ['quote " inside'] })
  })

  it('keeps verification in project settings and moves all agent editing to loops', async () => {
    render(<AgentRuntimeSettingsSection />)
    expect(await screen.findByDisplayValue('npm test')).toBeInTheDocument()
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Provider')).not.toBeInTheDocument()
    expect(screen.getByText(/Agent definitions, models and workflow policy are configured in the loop editor/)).toBeInTheDocument()
  })
})
