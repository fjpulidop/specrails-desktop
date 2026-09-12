import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, within, fireEvent, act } from '../../../test-utils'
import { AgentRuntimeSettingsSection } from '../AgentRuntimeSettingsSection'
import { formatVerificationCommand, nextRuntimeProviderId, parseVerificationCommand, type AgentRuntimeConfig } from '../../../lib/agent-runtime'
import type { DesktopProject } from '../../../hooks/useDesktop'

const desktop = vi.hoisted(() => ({ activeProjectId: 'p1' as string | null, projects: [] as DesktopProject[] }))
vi.mock('../../../hooks/useDesktop', () => ({ useDesktop: () => desktop }))
const defaults = (): AgentRuntimeConfig => ({
  schemaVersion: 1, enabled: false,
  providers: ['claude', 'codex', 'gemini', 'kimi'].map((id) => ({ id, kind: 'cli', cli: id })) as AgentRuntimeConfig['providers'],
  agents: { architect: { provider: 'claude' }, developer: { provider: 'codex' }, reviewer: { provider: 'gemini' } },
  verification: [],
})
const snapshot = (config = defaults(), runtimeAvailable = true, configured = false) => ({ config, configured, runtimeAvailable })
const response = (data: unknown, ok = true) => ({ ok, json: async () => data }) as Response
const suggestions = { repositories: [{ id: 'primary-p1', name: 'App' }], suggestions: [{ repositoryId: 'primary-p1', command: 'npm', args: ['test'], reason: 'package.json test script "test"' }] }
function mockServer(options: { configured?: boolean; config?: AgentRuntimeConfig; suggestions?: unknown; runtimeAvailable?: boolean } = {}) {
  global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/verification-suggestions')) return response(options.suggestions ?? suggestions)
    if (String(url).endsWith('/agent-runtime/runs')) return response({ runs: [] })
    if (init?.method === 'PUT') return response(snapshot(JSON.parse(String(init.body)) as AgentRuntimeConfig, options.runtimeAvailable ?? true, true))
    return response(snapshot(options.config ?? defaults(), options.runtimeAvailable ?? true, options.configured ?? false))
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
  it('prefills an unconfigured project with its detected checks and shows every default in the form', async () => {
    render(<AgentRuntimeSettingsSection />)
    await screen.findByLabelText('Use the agent runtime for implementation')
    expect(await screen.findByDisplayValue('npm test')).toBeInTheDocument()
    expect(screen.getByText(/Detected from package.json test script/)).toBeInTheDocument()
    expect(screen.getByText('Filled in from the checks this project already defines.')).toBeInTheDocument()
    const architect = within(screen.getByRole('group', { name: 'Architect' }))
    expect(architect.getByLabelText('Provider')).toHaveValue('claude')
    expect(architect.getByRole('option', { name: 'Default (Claude Sonnet)' })).toBeInTheDocument()
    expect(architect.getByRole('option', { name: 'Claude Opus' })).toBeInTheDocument()
    expect(architect.getByLabelText('Maximum turns (default 24)')).toHaveAttribute('placeholder', '24')
    expect(screen.getByLabelText('Maximum developer attempts (default 3)')).toHaveAttribute('placeholder', '3')
    expect(screen.getByLabelText('Timeout in minutes (default 15)')).toHaveAttribute('placeholder', '15')
    expect(screen.getByLabelText('Maximum tokens')).toHaveAttribute('placeholder', 'No limit')
    // Provider connections are advanced: hidden until asked for.
    expect(screen.queryByLabelText('Provider ID')).not.toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/agent-runtime/verification-suggestions', expect.anything())
  })

  it('enables the runtime with no verification and saves models, turns, minutes and detected commands', async () => {
    const user = userEvent.setup()
    mockServer({ suggestions: { repositories: [{ id: 'primary-p1', name: 'App' }], suggestions: [] } })
    render(<AgentRuntimeSettingsSection />)
    await screen.findByLabelText('Use the agent runtime for implementation')
    expect(await screen.findByText(/No test, type-check or build command was found/)).toBeInTheDocument()
    await user.click(screen.getByLabelText('Use the agent runtime for implementation'))
    const developer = within(screen.getByRole('group', { name: 'Developer' }))
    await user.selectOptions(developer.getByLabelText('Provider'), 'claude')
    await user.selectOptions(developer.getByLabelText('Model'), 'opus')
    await user.type(developer.getByLabelText('Maximum turns (default 24)'), '12')
    await user.type(screen.getByLabelText('Maximum developer attempts (default 3)'), '2')
    await user.type(screen.getByLabelText('Timeout in minutes (default 15)'), '20')
    await user.click(screen.getByLabelText('Pause for approval before completing the workflow'))
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    await screen.findByText('Runtime settings saved')
    expect(putBodies().at(-1)).toMatchObject({ enabled: true, approvalBeforeArchive: true, verification: [], agents: { developer: { provider: 'claude', model: 'opus', maxTurns: 12 } }, limits: { maxAttempts: 2, timeoutMs: 1_200_000 } })
    expect(putBodies().at(-1)?.limits).not.toHaveProperty('maxTokens')
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

  it('keeps role references when renaming providers, resets models on reassignment and protects referenced providers from deletion', async () => {
    const user = userEvent.setup()
    mockServer({ configured: true })
    render(<AgentRuntimeSettingsSection />)
    const architect = within(await screen.findByRole('group', { name: 'Architect' }))
    await user.click(screen.getByRole('button', { name: 'Show provider connections' }))
    const first = within(screen.getByRole('group', { name: 'Provider 1' }))
    expect(first.getByRole('button', { name: 'Remove provider' })).toBeDisabled()
    fireEvent.change(first.getByLabelText('Provider ID'), { target: { value: 'design-cli' } })
    expect(architect.getByLabelText('Provider')).toHaveValue('design-cli')
    expect(architect.getByRole('option', { name: 'Claude (design-cli)' })).toBeInTheDocument()
    await user.selectOptions(architect.getByLabelText('Model'), 'haiku')
    await user.selectOptions(architect.getByLabelText('Provider'), 'kimi')
    expect(architect.getByLabelText('Model')).toHaveValue('')
    expect(architect.getByRole('option', { name: 'Default (Kimi K3)' })).toBeInTheDocument()
    await user.click(first.getByRole('button', { name: 'Remove provider' }))
    expect(screen.getAllByLabelText('Provider ID')).toHaveLength(3)
    await user.click(screen.getByRole('button', { name: 'Add local / API provider' }))
    const added = within(screen.getByRole('group', { name: 'Provider 4' }))
    expect(added.getByLabelText('API base URL')).toHaveValue('http://127.0.0.1:11434/v1')
    await user.clear(added.getByLabelText('Provider ID'))
    await user.type(added.getByLabelText('Provider ID'), 'ollama')
    await user.type(added.getByLabelText('API key environment variable (optional)'), 'LOCAL_AI_KEY')
    const developer = within(screen.getByRole('group', { name: 'Developer' }))
    await user.selectOptions(developer.getByLabelText('Provider'), 'ollama')
    // API endpoints have no catalog: the model is typed and required.
    await user.type(developer.getByLabelText('Model'), 'qwen-local:latest')
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    await screen.findByText('Runtime settings saved')
    const saved = putBodies().at(-1)!
    expect(saved.providers.at(-1)).toEqual({ id: 'ollama', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', apiKeyEnv: 'LOCAL_AI_KEY' })
    expect(saved.agents.developer).toEqual({ provider: 'ollama', model: 'qwen-local:latest' })
    expect(nextRuntimeProviderId([{ id: 'local', kind: 'cli', cli: 'claude' }, { id: 'local-2', kind: 'cli', cli: 'claude' }], 'local')).toBe('local-3')
  })

  it('reports server validation errors without losing the draft and offers load retry', async () => {
    const user = userEvent.setup()
    mockServer({ configured: true })
    const view = render(<AgentRuntimeSettingsSection />)
    await screen.findByLabelText('Use the agent runtime for implementation')
    vi.mocked(fetch).mockResolvedValueOnce(response({ message: 'Role developer requires a model' }, false))
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Role developer requires a model')
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: 'invalid_runtime_config' }, false))
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid_runtime_config')
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Network offline'))
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Network offline')

    view.unmount()
    vi.mocked(fetch).mockReset().mockResolvedValueOnce(response({}, false))
    render(<AgentRuntimeSettingsSection />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load runtime settings')
    mockServer({ runtimeAvailable: false, configured: true })
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText(/This Core installation does not include/)).toBeInTheDocument()
  })

  it('binds pending saves to their project and ignores a response after switching projects', async () => {
    const user = userEvent.setup()
    mockServer({ configured: true })
    const { rerender } = render(<AgentRuntimeSettingsSection />)
    await screen.findByLabelText('Use the agent runtime for implementation')
    let finish!: (response: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await user.click(screen.getByLabelText('Use the agent runtime for implementation'))
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    desktop.activeProjectId = 'p2'
    rerender(<AgentRuntimeSettingsSection />)
    await screen.findByLabelText('Use the agent runtime for implementation')
    await act(async () => finish(response(snapshot({ ...defaults(), enabled: true }, true, true))))
    expect(screen.getByLabelText('Use the agent runtime for implementation')).not.toBeChecked()
    expect(screen.queryByText('Runtime settings saved')).not.toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PUT').map(([url]) => url)).toEqual(['/api/projects/p1/agent-runtime/config'])
    desktop.activeProjectId = 'p1'
    rerender(<AgentRuntimeSettingsSection />)
    expect(screen.getByLabelText('Use the agent runtime for implementation')).toBeChecked()
  })

  it('saves tightened review thresholds and the architect policy, omitting empty fields so Core defaults apply', async () => {
    const user = userEvent.setup()
    mockServer({ configured: true, config: { ...defaults(), review: { minScore: 80, aspects: { security: 90 } }, architect: { onLowConfidence: 'proceed' } } })
    render(<AgentRuntimeSettingsSection />)
    const minScore = await screen.findByLabelText('Minimum overall score (default 70)')
    expect(minScore).toHaveValue(80)
    expect(minScore).toHaveAttribute('min', '70')
    expect(minScore).toHaveAttribute('placeholder', '70')
    expect(screen.getByLabelText('Security (default 75)')).toHaveValue(90)
    expect(screen.getByLabelText('Test coverage (default 60)')).toHaveAttribute('placeholder', '60')
    expect(screen.getByText(/security at least 75, other aspects at least 60/)).toBeInTheDocument()
    expect(screen.getByLabelText('On low confidence')).toHaveValue('proceed')
    await user.clear(screen.getByLabelText('Security (default 75)'))
    await user.type(screen.getByLabelText('Type correctness (default 60)'), '65')
    await user.selectOptions(screen.getByLabelText('On low confidence'), '')
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    await screen.findByText('Runtime settings saved')
    let saved = putBodies().at(-1)!
    expect(saved.review).toEqual({ minScore: 80, aspects: { type_correctness: 65 } })
    expect(saved).not.toHaveProperty('architect')
    await user.clear(minScore)
    await user.clear(screen.getByLabelText('Type correctness (default 60)'))
    await user.selectOptions(screen.getByLabelText('On low confidence'), 'ask')
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    await screen.findByText('Runtime settings saved')
    saved = putBodies().at(-1)!
    expect(saved).not.toHaveProperty('review')
    expect(saved.architect).toEqual({ onLowConfidence: 'ask' })
    // A server-side floor violation is reported without losing the draft.
    await user.type(minScore, '65')
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: 'invalid_runtime_config', message: "Review threshold review.minScore must be at least 70 (Core's own review gate)" }, false))
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('must be at least 70')
    expect(minScore).toHaveValue(65)
  })

  it('round-trips command lines with quoted arguments', () => {
    expect(formatVerificationCommand({ command: 'npm', args: ['run', 'test', '--', 'a b'] })).toBe('npm run test -- "a b"')
    expect(parseVerificationCommand('npm run test -- "a b"')).toEqual({ command: 'npm', args: ['run', 'test', '--', 'a b'] })
    expect(parseVerificationCommand('  ')).toBeNull()
    expect(parseVerificationCommand('node "unterminated')).toBeNull()
    expect(parseVerificationCommand('echo "quote \\" inside"')).toEqual({ command: 'echo', args: ['quote " inside'] })
  })
})
