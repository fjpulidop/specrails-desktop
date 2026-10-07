import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../../../../test-utils'

vi.mock('../../../../lib/api', () => ({ getApiBase: () => '/api/projects/p1' }))
vi.mock('../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ projects: [], activeProjectId: 'p1', setActiveProjectId: vi.fn() }),
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('../../../providers/hooks/useProviderDetection', () => ({
  useProviderDetection: () => ({ detected: ['claude', 'codex', 'gemini'], providers: {}, loading: false }),
}))

import { GlobalSubagentsSection, ProjectSubagentsSection } from '../SubagentsSettingsSection'

function respond(get: unknown, ok = true) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    if (!init?.method) return { ok: true, json: async () => get } as Response
    return { ok, status: ok ? 200 : 500, json: async () => ({}) } as Response
  }) as typeof fetch
  return calls
}

beforeEach(() => vi.clearAllMocks())

describe('ProjectSubagentsSection', () => {
  it('shows the stored value, explains cost and scope, and saves a change', async () => {
    const calls = respond({ allowSubagents: false })
    render(<ProjectSubagentsSection />)
    const toggle = await screen.findByRole('switch', { name: 'Allow sub-agents in this project' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText(/uses its own tokens/)).toBeInTheDocument()
    expect(screen.getByText(/Implement pipelines are not affected/)).toBeInTheDocument()
    fireEvent.click(toggle)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Sub-agents allowed'))
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    const patch = calls.find((call) => call.init?.method === 'PATCH')!
    expect(patch.url).toBe('/api/projects/p1/settings')
    expect(JSON.parse(String(patch.init!.body))).toEqual({ allowSubagents: true })
  })

  it('reverts the switch when saving fails', async () => {
    respond({ allowSubagents: true }, false)
    render(<ProjectSubagentsSection />)
    const toggle = await screen.findByRole('switch', { name: 'Allow sub-agents in this project' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not save the sub-agent setting', expect.anything()))
    expect(toggle).toHaveAttribute('aria-checked', 'true')
  })
})

describe('GlobalSubagentsSection', () => {
  it('reads and writes the app-wide setting', async () => {
    const calls = respond({ allowSubagents: true })
    render(<GlobalSubagentsSection />)
    const toggle = await screen.findByRole('switch', { name: 'Allow sub-agents in missions without a project' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Sub-agents turned off'))
    const put = calls.find((call) => call.init?.method === 'PUT')!
    expect(put.url).toMatch(/\/api\/settings$/)
    expect(JSON.parse(String(put.init!.body))).toEqual({ allowSubagents: false })
  })
})

describe('Run sub-agents with', () => {
  function lastBody(calls: Array<{ init?: RequestInit }>) {
    return JSON.parse(String(calls.filter((call) => call.init?.method).at(-1)!.init!.body))
  }

  it('is hidden while sub-agents are off', async () => {
    respond({ allowSubagents: false, subagentRuntime: null })
    render(<ProjectSubagentsSection />)
    await screen.findByRole('switch', { name: 'Allow sub-agents in this project' })
    expect(screen.queryByTestId('subagent-runtime')).not.toBeInTheDocument()
  })

  it('offers only providers Core can launch and confirms before leaving the mission agent', async () => {
    const calls = respond({ allowSubagents: true, subagentRuntime: null })
    render(<ProjectSubagentsSection />)
    const provider = await screen.findByTestId('subagent-runtime-provider')
    expect(provider).toHaveTextContent('Same as the mission agent')
    fireEvent.keyDown(provider, { key: 'ArrowDown' })
    expect(await screen.findByRole('option', { name: 'Codex' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Gemini' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: 'Claude' }))

    // The warning explains what is lost (native launch, cache, speed) and gained (control).
    const dialog = await screen.findByTestId('subagent-runtime-confirm')
    expect(dialog).toHaveTextContent('sub-agents stop being native')
    expect(dialog).toHaveTextContent('without the prompt cache')
    expect(dialog).toHaveTextContent('More control and flexibility')
    expect(calls.some((call) => call.init?.method)).toBe(false)

    fireEvent.click(screen.getByTestId('subagent-runtime-confirm-accept'))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Sub-agents now run with Claude'))
    expect(lastBody(calls)).toEqual({ subagentRuntime: { provider: 'claude', model: 'sonnet', effort: 'medium' } })
    expect(screen.getByText(/Claude's own sub-agents ignore effort/)).toBeInTheDocument()
  })

  it('saves nothing when the warning is dismissed', async () => {
    const calls = respond({ allowSubagents: true, subagentRuntime: null })
    render(<ProjectSubagentsSection />)
    fireEvent.keyDown(await screen.findByTestId('subagent-runtime-provider'), { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'Codex' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Keep same as mission' }))
    await waitFor(() => expect(screen.queryByTestId('subagent-runtime-confirm')).not.toBeInTheDocument())
    expect(calls.some((call) => call.init?.method)).toBe(false)
    expect(screen.getByTestId('subagent-runtime-provider')).toHaveTextContent('Same as the mission agent')
  })

  it('changes model and effort of a chosen provider and keeps an effort the new model accepts', async () => {
    const calls = respond({ allowSubagents: true, subagentRuntime: { provider: 'codex', model: 'gpt-6.1-sol', effort: 'ultra' } })
    render(<GlobalSubagentsSection />)
    expect(await screen.findByTestId('subagent-runtime-effort')).toHaveTextContent('Ultra')
    fireEvent.keyDown(screen.getByTestId('subagent-runtime-model'), { key: 'ArrowDown' })
    // Luna has no "ultra": the effort falls back to the model default.
    fireEvent.click(await screen.findByRole('option', { name: 'GPT-5.6 Luna' }))
    await waitFor(() => expect(lastBody(calls)).toEqual({ subagentRuntime: { provider: 'codex', model: 'gpt-5.6-luna', effort: 'medium' } }))
    fireEvent.keyDown(screen.getByTestId('subagent-runtime-provider'), { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'Same as the mission agent' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Sub-agents follow the mission agent again'))
    expect(lastBody(calls)).toEqual({ subagentRuntime: null })
    expect(screen.queryByTestId('subagent-runtime-confirm')).not.toBeInTheDocument()
  })

  it('restores the previous choice when saving fails', async () => {
    respond({ allowSubagents: true, subagentRuntime: { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' } }, false)
    render(<ProjectSubagentsSection />)
    fireEvent.keyDown(await screen.findByTestId('subagent-runtime-provider'), { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'Same as the mission agent' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(screen.getByTestId('subagent-runtime-provider')).toHaveTextContent('Codex')
  })
})
