import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, within, fireEvent, act, waitFor } from '../../../../test-utils'
import { AgentRuntimeSettingsSection } from '../AgentRuntimeSettingsSection'
import { formatVerificationCommand, nextRuntimeProviderId, parseVerificationCommand, type AgentRuntimeConfig } from '../../lib/agent-runtime'
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
  it('loads efforts automatically and retains confirmed options when effort or turns change', async () => {
    const config = defaults()
    config.agents.architect.model = 'sonnet'
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/capabilities')) {
        const selected = JSON.parse(String(init?.body)) as AgentRuntimeConfig
        return response({ schemaVersion: 1, roles: Object.entries(selected.agents).map(([role, agent]) => ({ role, tier: 'base', provider: agent.provider, model: agent.model ?? null, transport: 'claude-cli', effortSupport: 'supported', supportedEfforts: ['low', 'medium', 'high'] })) })
      }
      return response(snapshot(config, true, true))
    })
    const user = userEvent.setup()
    render(<AgentRuntimeSettingsSection />)
    const architect = within(await screen.findByRole('group', { name: 'Architect' }))
    const effort = architect.getByLabelText('Reasoning effort')
    await waitFor(() => expect(within(effort).getByRole('option', { name: 'medium' })).toBeInTheDocument())
    await user.selectOptions(effort, 'medium')
    await user.type(architect.getByLabelText('Maximum turns (default 100)'), '120')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    expect(effort).toHaveValue('medium')
    expect(within(effort).getAllByRole('option')).toHaveLength(4)
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/capabilities'))).toHaveLength(1)
    await user.selectOptions(architect.getByLabelText('Model'), 'opus')
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/capabilities'))).toHaveLength(2))
    await waitFor(() => expect(within(effort).getByRole('option', { name: 'high' })).toBeInTheDocument())
  })


  it('ignores an older capability response after selecting a different model', async () => {
    const config = defaults(); config.agents.architect.model = 'sonnet'
    let resolveOld!: (value: Response) => void
    const capabilityResponse = (model: string, levels: string[]) => response({ schemaVersion: 1, roles: [{ role: 'architect', tier: 'base', provider: 'claude', model, transport: 'claude-cli', effortSupport: 'supported', supportedEfforts: levels }] })
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.endsWith('/capabilities')) return response(snapshot(config, true, true))
      const model = (JSON.parse(String(init?.body)) as AgentRuntimeConfig).agents.architect.model
      if (model === 'sonnet') return new Promise<Response>(resolve => { resolveOld = resolve })
      return capabilityResponse('opus', ['high'])
    })
    const user = userEvent.setup()
    render(<AgentRuntimeSettingsSection />)
    const architect = within(await screen.findByRole('group', { name: 'Architect' }))
    await waitFor(() => expect(resolveOld).toBeTypeOf('function'))
    await user.selectOptions(architect.getByLabelText('Model'), 'opus')
    const effort = architect.getByLabelText('Reasoning effort')
    await waitFor(() => expect(within(effort).getByRole('option', { name: 'high' })).toBeInTheDocument())
    await act(async () => { resolveOld(capabilityResponse('sonnet', ['low'])) })
    expect(within(effort).queryByRole('option', { name: 'low' })).not.toBeInTheDocument()
    expect(within(effort).getByRole('option', { name: 'high' })).toBeInTheDocument()
  })

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

  it('prefills an unconfigured project with its detected checks and shows every default in the form', async () => {
    render(<AgentRuntimeSettingsSection />)
    await screen.findByRole('group', { name: 'Architect' })
    expect(await screen.findByDisplayValue('npm test')).toBeInTheDocument()
    expect(screen.getByText(/Detected from package.json test script/)).toBeInTheDocument()
    expect(screen.getByText('Filled in from the checks this project already defines.')).toBeInTheDocument()
    const architect = within(screen.getByRole('group', { name: 'Architect' }))
    expect(architect.getByRole('radio', { name: 'Claude (claude)' })).toBeChecked()
    expect(architect.getByRole('option', { name: 'Default (Claude Sonnet)' })).toBeInTheDocument()
    expect(architect.getByRole('option', { name: 'Claude Opus 5.5' })).toBeInTheDocument()
    expect(architect.getByLabelText('Maximum turns (default 100)')).toHaveAttribute('placeholder', '100')
    expect(screen.getByLabelText('Maximum developer attempts (default 3)')).toHaveAttribute('placeholder', '3')
    expect(screen.getByLabelText('Timeout in minutes (default 15; local engines 45 per task group)')).toHaveAttribute('placeholder', '15')
    expect(screen.getByLabelText('Maximum tokens')).toHaveAttribute('placeholder', 'No limit')
    // Provider connections are advanced: hidden until asked for.
    expect(screen.queryByLabelText('Provider ID')).not.toBeInTheDocument()
    expect(fetch).toHaveBeenCalledWith('/api/projects/p1/agent-runtime/verification-suggestions', expect.anything())
  })

  it('mirrors the stepper grouping on the cards: core pipeline cards 1–5, loop-step cards 1–2 under their own heading', async () => {
    render(<AgentRuntimeSettingsSection />)
    await screen.findByRole('group', { name: 'Architect' })
    const core = within(screen.getByTestId('phase-cards-core'))
    const loop = within(screen.getByTestId('phase-cards-loop'))
    expect(core.getByTestId('phase-group-heading-core')).toHaveTextContent('Core pipeline')
    expect(loop.getByTestId('phase-group-heading-loop')).toHaveTextContent('Loop steps')
    expect(core.getAllByTestId(/^phase-card-/).map((card) => card.getAttribute('data-testid'))).toEqual(['phase-card-architect', 'phase-card-developer', 'phase-card-verification', 'phase-card-fixer', 'phase-card-reviewer'])
    expect(loop.getAllByTestId(/^phase-card-/).map((card) => card.getAttribute('data-testid'))).toEqual(['phase-card-verifier', 'phase-card-decider'])
    expect(core.getByRole('button', { name: 'Collapse: 5. Reviewer' })).toBeInTheDocument()
    expect(loop.getByRole('button', { name: 'Collapse: 1. Verifier' })).toBeInTheDocument()
    expect(loop.getByRole('button', { name: 'Collapse: 2. Decider' })).toBeInTheDocument()
  })

  it('enables the runtime with no verification and saves models, turns, minutes and detected commands', async () => {
    const user = userEvent.setup()
    mockServer({ suggestions: { repositories: [{ id: 'primary-p1', name: 'App' }], suggestions: [] } })
    render(<AgentRuntimeSettingsSection />)
    await screen.findByRole('group', { name: 'Architect' })
    expect(await screen.findByText(/No test, type-check or build command was found/)).toBeInTheDocument()
    const developer = within(screen.getByRole('group', { name: 'Developer' }))
    await user.click(developer.getByRole('radio', { name: 'Claude (claude)' }))
    await user.selectOptions(developer.getByLabelText('Model'), 'opus')
    await user.type(developer.getByLabelText('Maximum turns (default 100)'), '12')
    await user.type(screen.getByLabelText('Maximum developer attempts (default 3)'), '2')
    await user.type(screen.getByLabelText('Timeout in minutes (default 15; local engines 45 per task group)'), '20')
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

  it('shows all providers and resets only the selected role model on reassignment', async () => {
    const user = userEvent.setup()
    mockServer({ configured: true })
    render(<AgentRuntimeSettingsSection />)
    const architect = within(await screen.findByRole('group', { name: 'Architect' }))
    expect(architect.getAllByRole('radio')).toHaveLength(4)
    await user.selectOptions(architect.getByLabelText('Model'), 'haiku')
    await user.click(architect.getByRole('radio', { name: 'Kimi (kimi)' }))
    expect(architect.getByLabelText('Model')).toHaveValue('')
    expect(screen.queryByLabelText('Provider ID')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    await screen.findByText('Runtime settings saved')
    expect(putBodies().at(-1)?.agents.architect).toEqual({ provider: 'kimi' })
    expect(putBodies().at(-1)?.agents.developer.provider).toBe('codex')
    expect(nextRuntimeProviderId([{ id: 'local', kind: 'cli', cli: 'claude' }], 'local')).toBe('local-2')
  })

  it('reports server validation errors without losing the draft and offers load retry', async () => {
    const user = userEvent.setup()
    const save = vi.fn<() => Promise<Response>>()
    mockServer({ configured: true, save })
    const view = render(<AgentRuntimeSettingsSection />)
    await screen.findByRole('group', { name: 'Architect' })
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
    expect(await screen.findByText(/This Core installation does not include/)).toBeInTheDocument()
  })

  it('binds pending saves to their project and ignores a response after switching projects', async () => {
    const user = userEvent.setup()
    let finish!: (response: Response) => void
    mockServer({ configured: true, save: () => new Promise((resolve) => { finish = resolve }) })
    const { rerender } = render(<AgentRuntimeSettingsSection />)
    await screen.findByRole('group', { name: 'Architect' })
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    desktop.activeProjectId = 'p2'
    rerender(<AgentRuntimeSettingsSection />)
    await screen.findByRole('group', { name: 'Architect' })
    await act(async () => finish(response(snapshot({ ...defaults(), enabled: true }, true, true))))
    expect(screen.queryByText('Use the agent runtime for implementation')).not.toBeInTheDocument()
    expect(screen.queryByText('Runtime settings saved')).not.toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PUT').map(([url]) => url)).toEqual(['/api/projects/p1/agent-runtime/config'])
    desktop.activeProjectId = 'p1'
    rerender(<AgentRuntimeSettingsSection />)
    expect(screen.getByRole('group', { name: 'Architect' })).toBeInTheDocument()
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

  it('persists guardrail switches through the same Save as the rest of the config (false entries only)', async () => {
    const user = userEvent.setup()
    render(<AgentRuntimeSettingsSection />)
    const guardrails = within(await screen.findByRole('group', { name: 'Guardrails' }))
    await guardrails.findByText('2 of 2 active')
    await user.click(guardrails.getByRole('switch', { name: 'No empty overwrites' }))
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    await screen.findByText('Runtime settings saved')
    expect(putBodies().at(-1)!.guardrails).toEqual({ 'empty-write': false })
    expect(guardrails.getByText('1 of 2 active')).toBeInTheDocument()
    await user.click(guardrails.getByRole('switch', { name: 'No empty overwrites' }))
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    await screen.findByText('Runtime settings saved')
    expect(putBodies().at(-1)).not.toHaveProperty('guardrails')
  })

  it('fixer: Own engine seeds from the developer and saves config.fixer; Inherit developer deletes it', async () => {
    const config = defaults()
    config.agents.developer = { provider: 'codex', model: 'gpt-5.5', effort: 'low' }
    mockServer({ config, configured: true })
    const user = userEvent.setup()
    render(<AgentRuntimeSettingsSection />)
    const fixer = within(await screen.findByRole('group', { name: 'Fixer' }))
    expect(fixer.getByTestId('engine-chip')).toHaveTextContent('Inherits developer')
    expect(fixer.getByRole('radio', { name: 'Inherit developer' })).toBeChecked()
    expect(fixer.queryByLabelText('Model')).not.toBeInTheDocument()
    await user.click(fixer.getByRole('radio', { name: 'Own engine' }))
    // Seeded from the developer: provider + model only (effort/turns start clean).
    expect(fixer.getByRole('radio', { name: 'Codex (codex)' })).toBeChecked()
    expect(fixer.getByLabelText('Model')).toHaveValue('gpt-5.5')
    expect(fixer.getByTestId('engine-chip')).toHaveTextContent('Codex · gpt-5.5')
    await user.click(fixer.getByRole('radio', { name: 'Claude (claude)' }))
    await user.selectOptions(fixer.getByLabelText('Model'), 'opus')
    await user.type(fixer.getByLabelText('Maximum turns (default 100)'), '30')
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    await screen.findByText('Runtime settings saved')
    expect(putBodies().at(-1)?.fixer).toEqual({ provider: 'claude', model: 'opus', maxTurns: 30 })
    expect(putBodies().at(-1)?.agents.developer).toEqual(config.agents.developer)
    await user.click(fixer.getByRole('radio', { name: 'Inherit developer' }))
    expect(fixer.getByTestId('engine-chip')).toHaveTextContent('Inherits developer')
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    await waitFor(() => expect(putBodies()).toHaveLength(2))
    expect(putBodies().at(-1)).not.toHaveProperty('fixer')
  })

  it('renders a saved fixer as Own engine and includes it in the capability check payload', async () => {
    const config = defaults()
    config.fixer = { provider: 'gemini', model: 'gemini-2.5-pro', effort: 'high' }
    mockServer({ config, configured: true })
    render(<AgentRuntimeSettingsSection />)
    const fixer = within(await screen.findByRole('group', { name: 'Fixer' }))
    expect(fixer.getByRole('radio', { name: 'Own engine' })).toBeChecked()
    expect(fixer.getByRole('radio', { name: 'Gemini (gemini)' })).toBeChecked()
    expect(fixer.getByTestId('engine-chip')).toHaveTextContent('gemini-2.5-pro · high')
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/capabilities'))).toHaveLength(1))
    const payload = JSON.parse(String(vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/capabilities'))?.[1]?.body)) as AgentRuntimeConfig
    expect(payload.fixer).toEqual(config.fixer)
  })

  it('round-trips command lines with quoted arguments', () => {
    expect(formatVerificationCommand({ command: 'npm', args: ['run', 'test', '--', 'a b'] })).toBe('npm run test -- "a b"')
    expect(parseVerificationCommand('npm run test -- "a b"')).toEqual({ command: 'npm', args: ['run', 'test', '--', 'a b'] })
    expect(parseVerificationCommand('  ')).toBeNull()
    expect(parseVerificationCommand('node "unterminated')).toBeNull()
    expect(parseVerificationCommand('echo "quote \\" inside"')).toEqual({ command: 'echo', args: ['quote " inside'] })
  })

  it('labels local providers by display name and offers discovered models for the role model input', async () => {
    const user = userEvent.setup()
    const config = defaults()
    config.providers.push({ id: 'lan-box', kind: 'openai-compatible', baseUrl: 'http://10.0.0.5:8080/v1', label: 'LAN box', defaultModel: 'qwen3.5-9b:latest' })
    config.agents.developer = { provider: 'lan-box' }
    mockServer({ config, detected: { detected: ['claude', 'lan-box'], providers: { 'lan-box': { id: 'lan-box', kind: 'local', models: ['qwen3.5-9b:latest', 'llama3'], authState: 'authenticated', installed: true, executable: true, usable: true, displayName: 'lan-box' } } } })
    render(<AgentRuntimeSettingsSection />)
    const developer = await screen.findByRole('group', { name: 'Developer' })
    expect(within(developer).getByLabelText('LAN box (lan-box) · http://10.0.0.5:8080/v1')).toBeChecked()
    const input = within(developer).getByLabelText('Model') as HTMLInputElement
    expect(input.placeholder).toBe('Default (qwen3.5-9b:latest)')
    const options = Array.from(within(developer).getByTestId('runtime-developer-models').querySelectorAll('option')).map((o) => o.value)
    expect(options).toEqual(['qwen3.5-9b:latest', 'llama3'])
    await user.type(input, 'custom-alias')
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    await waitFor(() => expect(putBodies().at(-1)?.agents.developer.model).toBe('custom-alias'))
  })

  it('offers a per-role thinking switch on local engines only: Off by default (nothing saved), On persists, Off again deletes the field', async () => {
    const user = userEvent.setup()
    const config = defaults()
    config.providers.push({ id: 'lan-box', kind: 'openai-compatible', baseUrl: 'http://10.0.0.5:8080/v1', label: 'LAN box', defaultModel: 'qwen3.5-9b:latest' })
    config.agents.developer = { provider: 'lan-box' }
    mockServer({ config, detected: { detected: ['claude', 'lan-box'], providers: { 'lan-box': { id: 'lan-box', kind: 'local', models: ['qwen3.5-9b:latest'], authState: 'authenticated', installed: true, executable: true, usable: true, displayName: 'lan-box' } } } })
    render(<AgentRuntimeSettingsSection />)
    const developer = await screen.findByRole('group', { name: 'Developer' })
    const architect = screen.getByRole('group', { name: 'Architect' })
    // A CLI role has no switch; the local role defaults to Off.
    expect(within(architect).queryByRole('radiogroup', { name: 'Private thinking' })).toBeNull()
    const thinking = within(developer).getByRole('radiogroup', { name: 'Private thinking' })
    expect(within(thinking).getByLabelText('Off')).toBeChecked()
    await user.click(within(thinking).getByLabelText('On'))
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    await waitFor(() => expect(putBodies().at(-1)?.agents.developer.thinking).toBe('on'))
    await user.click(within(thinking).getByLabelText('Off'))
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    await waitFor(() => expect(putBodies().length).toBe(2))
    expect('thinking' in putBodies().at(-1)!.agents.developer).toBe(false)
  })
})

it('saves a custom role engine and prompt with explicit independent permissions', async () => {
  mockServer({ configured: true, openRolesAvailable: true })
  const user = userEvent.setup(); render(<AgentRuntimeSettingsSection />)
  await user.type(await screen.findByLabelText('Role ID'), 'security-reviewer')
  await user.click(screen.getByRole('button', { name: 'Add role' }))
  const role = within(screen.getByRole('group', { name: 'security-reviewer' }))
  await user.type(role.getByLabelText('Role instructions'), 'Inspect actual security evidence.')
  await user.selectOptions(role.getByLabelText('OpenSpec artifact access'), 'tasks-checkboxes')
  await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
  await waitFor(() => expect(putBodies().at(-1)?.roles).toMatchObject({ 'security-reviewer': { provider: 'claude', access: 'read', artifacts: 'tasks-checkboxes', prompt: 'Inspect actual security evidence.' } }))
  expect(putBodies().at(-1)?.agents).toEqual(defaults().agents)
})
