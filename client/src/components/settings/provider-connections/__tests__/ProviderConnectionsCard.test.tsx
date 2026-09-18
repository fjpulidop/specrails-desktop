import { describe, it, expect, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor, within } from '../../../../test-utils'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
const flags = vi.hoisted(() => ({ enabled: true }))
vi.mock('../../../../lib/feature-flags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/feature-flags')>()),
  isLocalEnginesEnabled: () => flags.enabled,
}))

import { toast } from 'sonner'
import { ProviderConnectionsCard } from '../ProviderConnectionsCard'
import { formatContextWindow } from '../LocalEngineCard'
import { modelsForProvider, resetDynamicModelCatalogs } from '../../../../lib/loop-run-models'

const CLAUDE = { id: 'claude', kind: 'cli', cli: 'claude' }
const CODEX = { id: 'codex', kind: 'cli', cli: 'codex' }
const GEMINI = { id: 'gemini', kind: 'cli', cli: 'gemini' }
const KIMI = { id: 'kimi', kind: 'cli', cli: 'kimi' }
const LOCAL = { id: 'local', kind: 'openai-compatible', baseUrl: 'http://192.168.68.74:8080/v1', apiKeyEnv: 'LOCAL_OLLAMA_API_KEY' }
const LIST = {
  providers: [CLAUDE, LOCAL],
  status: {
    claude: { installed: true, executable: true, version: '2.1.198', authState: 'authenticated' },
    local: { reachable: true, authState: 'authenticated', models: ['qwen3.5-9b:latest'], latencyMs: 80 },
  },
}
function json(ok: boolean, body: unknown) { return { ok, status: ok ? 200 : 400, json: async () => body } as Response }

/** Persisted local engines start collapsed — open the inline editor. */
async function expand(user: ReturnType<typeof userEvent.setup>, card: HTMLElement) {
  await user.click(within(card).getByRole('button', { name: 'Show settings' }))
}

beforeEach(() => { flags.enabled = true; resetDynamicModelCatalogs() })

describe('ProviderConnectionsCard', () => {
  it('renders the AI providers header, a compact read-only CLI row and a collapsed local engine card', async () => {
    const user = userEvent.setup()
    global.fetch = vi.fn().mockResolvedValueOnce(json(true, LIST))
    render(<ProviderConnectionsCard />)
    expect(await screen.findByRole('heading', { name: 'AI providers' })).toBeInTheDocument()
    expect(screen.getByText(/CLI tools/)).toBeInTheDocument()
    expect(screen.getByText(/Local engines/)).toBeInTheDocument()

    // CLI row: icon · name · version · pill · auth — NO inputs, NO select.
    const claude = screen.getByTestId('connection-row-claude')
    expect(claude).toHaveAttribute('data-kind', 'cli')
    expect(within(claude).getByText('Claude')).toBeInTheDocument()
    expect(within(claude).getByTestId('connection-status-pill')).toHaveAttribute('data-state', 'reachable')
    expect(within(claude).getByText('v2.1.198')).toBeInTheDocument()
    expect(within(claude).getByText('Signed in')).toBeInTheDocument()
    expect(within(claude).queryAllByRole('textbox')).toHaveLength(0)
    expect(within(claude).queryAllByRole('combobox')).toHaveLength(0)
    expect(within(claude).queryByRole('button', { name: 'Remove provider' })).toBeNull()

    // Local card: summary row only until expanded.
    const local = screen.getByTestId('connection-row-local')
    expect(local).toHaveAttribute('data-kind', 'local')
    expect(local).toHaveAttribute('data-expanded', 'false')
    expect(within(local).getByText('http://192.168.68.74:8080/v1')).toBeInTheDocument()
    expect(within(local).getByText('1 model')).toBeInTheDocument()
    expect(within(local).getByTestId('agent-loop-chip')).toHaveTextContent('Compact')
    expect(within(local).getByText('32k ctx')).toBeInTheDocument()
    expect(within(local).getByTestId('connection-status-pill')).toHaveTextContent('Reachable')
    expect(within(local).getByTestId('connection-status-pill')).toHaveTextContent('80 ms')
    expect(within(local).queryByLabelText('API base URL')).toBeNull()

    await expand(user, local)
    expect(local).toHaveAttribute('data-expanded', 'true')
    expect(within(local).getByLabelText('API base URL')).toHaveValue('http://192.168.68.74:8080/v1')
    expect(within(local).getByLabelText('API key environment variable (optional)')).toHaveValue('LOCAL_OLLAMA_API_KEY')
    expect(within(local).getByText('qwen3.5-9b:latest', { selector: 'button' })).toBeInTheDocument()
    // Persisted ids are locked behind Rename.
    expect(within(local).getByLabelText('Provider ID')).toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: 'Save runtime settings' })).toBeDisabled()
    // Collapse again.
    await user.click(within(local).getByRole('button', { name: 'Hide settings' }))
    expect(local).toHaveAttribute('data-expanded', 'false')
  })

  it('tests the DRAFT values, updates pill + models + default picker without saving, and surfaces the env hint', async () => {
    const user = userEvent.setup()
    global.fetch = vi.fn()
      .mockResolvedValueOnce(json(true, { providers: [{ ...LOCAL, apiKeyEnv: undefined }], status: {} }))
      .mockResolvedValueOnce(json(true, { reachable: true, authState: 'authenticated', models: ['a-model', 'b-model'], latencyMs: 42, apiKeyEnvMissing: true }))
    render(<ProviderConnectionsCard />)
    const local = await screen.findByTestId('connection-row-local')
    expect(within(local).getByTestId('connection-status-pill')).toHaveAttribute('data-state', 'untested')
    expect(within(local).getByText('0 models')).toBeInTheDocument()
    await expand(user, local)
    await user.type(within(local).getByLabelText('API key environment variable (optional)'), 'MY_KEY')
    await user.click(within(local).getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(within(local).getAllByTestId('connection-status-pill')[0]).toHaveAttribute('data-state', 'reachable'))
    const body = JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string)
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe('/api/runtime-providers/test')
    expect(body).toEqual({ baseUrl: LOCAL.baseUrl, apiKeyEnv: 'MY_KEY' })
    expect(within(local).getByRole('note')).toHaveTextContent('MY_KEY is not set in the app process')
    expect(within(local).getByText('a-model', { selector: 'button' })).toBeInTheDocument()
    expect(within(local).getByText('2 models')).toBeInTheDocument()
    const picker = within(local).getByLabelText('Default model') as HTMLSelectElement
    expect(Array.from(picker.options).map((o) => o.value)).toEqual(['', 'a-model', 'b-model', '__custom__'])
    await user.selectOptions(picker, 'b-model')
    expect(within(local).getByRole('button', { name: 'b-model' })).toHaveAttribute('aria-pressed', 'true')
    // A test never PUTs.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2)
    expect(modelsForProvider('local').map((m) => m.value)).toEqual(['a-model', 'b-model'])
    // Custom alias path.
    await user.selectOptions(picker, '__custom__')
    await user.type(within(local).getByLabelText('Custom alias…'), 'my-alias')
    expect(picker).toHaveValue('__custom__')
  })

  it('maps 401 to not authorized, network errors to unreachable and a failed probe to an alert', async () => {
    const user = userEvent.setup()
    global.fetch = vi.fn()
      .mockResolvedValueOnce(json(true, { providers: [LOCAL], status: {} }))
      .mockResolvedValueOnce(json(true, { reachable: true, authState: 'unauthenticated', models: [], latencyMs: 10, error: 'HTTP 401' }))
      .mockResolvedValueOnce(json(true, { reachable: false, authState: 'unknown', models: [], latencyMs: 0, error: 'ECONNREFUSED' }))
      .mockRejectedValueOnce(new Error('boom'))
    render(<ProviderConnectionsCard />)
    const local = await screen.findByTestId('connection-row-local')
    await expand(user, local)
    const test = within(local).getByRole('button', { name: 'Test connection' })
    await user.click(test)
    await waitFor(() => expect(within(local).getAllByTestId('connection-status-pill')[0]).toHaveAttribute('data-state', 'unauthorized'))
    expect(within(local).getByText('HTTP 401')).toBeInTheDocument()
    await user.click(test)
    await waitFor(() => expect(within(local).getAllByTestId('connection-status-pill')[0]).toHaveAttribute('data-state', 'unreachable'))
    await user.click(test)
    expect(await within(local).findByRole('alert')).toHaveTextContent('boom')
  })

  it('validates rates, adds a local engine (expanded), removes a CLI from its overflow, saves with success toast and keeps the draft on failure', async () => {
    const user = userEvent.setup()
    const savedList = { providers: [LOCAL, { id: 'local-2', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', rates: { inputPer1M: 0.1, outputPer1M: 0.4 } }], status: {} }
    global.fetch = vi.fn()
      .mockResolvedValueOnce(json(true, { providers: [CLAUDE, LOCAL], status: {} }))
      .mockResolvedValueOnce(json(false, { message: 'Provider is referenced by a project' }))
      .mockResolvedValueOnce(json(true, savedList))
    render(<ProviderConnectionsCard />)
    await screen.findByTestId('connection-row-local')
    expect(screen.getByTestId('provider-save-bar')).toHaveAttribute('data-sticky', 'false')
    await user.click(screen.getByRole('button', { name: 'Add local engine' }))
    const added = screen.getByTestId('connection-row-local-2')
    // A fresh engine opens its editor right away; the save bar becomes sticky.
    expect(added).toHaveAttribute('data-expanded', 'true')
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
    expect(screen.getByTestId('provider-save-bar')).toHaveAttribute('data-sticky', 'true')
    // New rows keep an editable id.
    expect(within(added).getByLabelText('Provider ID')).not.toHaveAttribute('readonly')
    // Rates: one side only ⇒ invalid, save blocked.
    await user.type(within(added).getByLabelText('Input per 1M'), '0.1')
    expect(within(added).getByRole('alert')).toHaveTextContent('Enter both rates')
    expect(screen.getByRole('button', { name: 'Save runtime settings' })).toBeDisabled()
    // Collapsing an invalid card is refused so the highlighted fields stay visible.
    expect(within(added).getByRole('button', { name: 'Hide settings' })).toBeDisabled()
    expect(added).toHaveAttribute('data-expanded', 'true')
    await user.type(within(added).getByLabelText('Output per 1M'), '0.4')
    expect(within(added).queryByRole('alert')).toBeNull()
    await user.click(within(added).getByRole('switch'))
    // Remove the CLI row through its overflow menu, then save → server rejects → draft retained + error toast.
    await user.click(within(screen.getByTestId('connection-row-claude')).getByRole('button', { name: 'More actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Remove provider' }))
    expect(screen.queryByTestId('connection-row-claude')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Provider is referenced')
    expect(toast.error).toHaveBeenCalled()
    const put = JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string)
    expect(put.providers.map((p: { id: string }) => p.id)).toEqual(['local', 'local-2'])
    expect(put.providers[1]).toMatchObject({ rates: { inputPer1M: 0.1, outputPer1M: 0.4 }, supportsReasoningEffort: true })
    expect(screen.getByTestId('connection-row-local-2')).toBeInTheDocument()
    // Retry succeeds → snapshot adopted, dirty indicator gone, row now persisted (collapsed) with a locked id.
    await user.click(screen.getByRole('button', { name: 'Save runtime settings' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(screen.queryByText('Unsaved changes')).toBeNull()
    const persisted = screen.getByTestId('connection-row-local-2')
    expect(persisted).toHaveAttribute('data-expanded', 'false')
    await expand(user, persisted)
    expect(within(persisted).getByLabelText('Provider ID')).toHaveAttribute('readonly')
  })

  it('rename unlocks a persisted id and clearing both rates drops them', async () => {
    const user = userEvent.setup()
    global.fetch = vi.fn().mockResolvedValueOnce(json(true, { providers: [{ ...LOCAL, label: 'LAN box', rates: { inputPer1M: 1, outputPer1M: 2 }, agentLoop: 'free', contextWindowTokens: 131072 }], status: {} }))
    render(<ProviderConnectionsCard />)
    const local = await screen.findByTestId('connection-row-local')
    // Summary: label as the name, id as the mono suffix, Free chip, 128k window.
    expect(within(local).getByText('LAN box')).toBeInTheDocument()
    expect(within(local).getByText('local')).toBeInTheDocument()
    expect(within(local).getByTestId('agent-loop-chip')).toHaveTextContent('Free')
    expect(within(local).getByText('128k ctx')).toBeInTheDocument()
    await expand(user, local)
    await user.click(within(local).getByRole('button', { name: 'Rename' }))
    expect(within(local).getByText('Renaming keeps role assignments pointing at this connection.')).toBeInTheDocument()
    const id = within(local).getByLabelText('Provider ID')
    expect(id).not.toHaveAttribute('readonly')
    await user.clear(id); await user.type(id, 'lan-box')
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
    await user.clear(within(local).getByLabelText('Input per 1M'))
    expect(within(local).getByRole('alert')).toBeInTheDocument()
    await user.clear(within(local).getByLabelText('Output per 1M'))
    expect(within(local).queryByRole('alert')).toBeNull()
    await user.type(within(local).getByLabelText('Input per 1M'), '-1')
    expect(within(local).getByRole('alert')).toBeInTheDocument()
  })

  it('shows load errors and the local empty state with its own Add button', async () => {
    const user = userEvent.setup()
    global.fetch = vi.fn().mockResolvedValueOnce(json(false, { message: 'nope' }))
    render(<ProviderConnectionsCard />)
    expect(await screen.findByRole('alert')).toHaveTextContent('nope')
    global.fetch = vi.fn().mockResolvedValueOnce(json(true, { providers: [CLAUDE], status: {} }))
    render(<ProviderConnectionsCard />)
    const empty = await screen.findByTestId('local-empty')
    expect(empty).toHaveTextContent(/No local engine yet/)
    await user.click(within(empty).getByRole('button', { name: 'Add local engine' }))
    expect(screen.queryByTestId('local-empty')).toBeNull()
    expect(screen.getByTestId('connection-row-local')).toHaveAttribute('data-expanded', 'true')
  })

  it('dims undetected CLIs and offers "Add CLI provider" only for CLIs missing from the list', async () => {
    const user = userEvent.setup()
    global.fetch = vi.fn().mockResolvedValueOnce(json(true, { providers: [CLAUDE, CODEX], status: { claude: { installed: true, executable: true, version: '2.1.198', authState: 'authenticated' } } }))
    render(<ProviderConnectionsCard />)
    const codex = await screen.findByTestId('connection-row-codex')
    expect(within(codex).getByText('Not detected on this machine')).toBeInTheDocument()
    expect(within(codex).queryByTestId('connection-status-pill')).toBeNull()
    expect(codex.className).toContain('opacity-55')
    // gemini + kimi are missing → the quiet Add CLI provider menu lists exactly those.
    await user.click(screen.getByRole('button', { name: 'Add CLI provider' }))
    const menu = screen.getByRole('menu', { name: 'Add CLI provider' })
    expect(within(menu).getAllByRole('menuitem').map((el) => el.textContent)).toEqual(['Gemini', 'Kimi'])
    await user.click(within(menu).getByRole('menuitem', { name: 'Gemini' }))
    expect(screen.getByTestId('connection-row-gemini')).toBeInTheDocument()
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add CLI provider' }))
    await user.click(screen.getByRole('menuitem', { name: 'Kimi' }))
    // All four present → the action disappears.
    expect(screen.queryByRole('button', { name: 'Add CLI provider' })).toBeNull()
  })

  it('never offers "Add CLI provider" when every CLI is listed and closes the overflow on Escape', async () => {
    const user = userEvent.setup()
    global.fetch = vi.fn().mockResolvedValueOnce(json(true, { providers: [CLAUDE, CODEX, GEMINI, KIMI], status: {} }))
    render(<ProviderConnectionsCard />)
    await screen.findByTestId('connection-row-kimi')
    expect(screen.queryByRole('button', { name: 'Add CLI provider' })).toBeNull()
    const trigger = within(screen.getByTestId('connection-row-kimi')).getByRole('button', { name: 'More actions' })
    await user.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Remove provider' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('renders children under a collapsible "Provider defaults" block, open by default', async () => {
    const user = userEvent.setup()
    global.fetch = vi.fn().mockResolvedValueOnce(json(true, { providers: [], status: {} }))
    render(<ProviderConnectionsCard><p>role prompts here</p></ProviderConnectionsCard>)
    await screen.findByTestId('provider-connections-card')
    const toggle = screen.getByRole('button', { name: /Provider defaults/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('role prompts here')).toBeInTheDocument()
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('role prompts here')).toBeNull()
  })

  it('formats the context window chip', () => {
    expect(formatContextWindow(undefined)).toBe('32k')
    expect(formatContextWindow(131072)).toBe('128k')
    expect(formatContextWindow(50000)).toBe((50000).toLocaleString())
  })

  it('falls back to the legacy plain rows when the client flag is off', async () => {
    flags.enabled = false
    const user = userEvent.setup()
    global.fetch = vi.fn().mockResolvedValueOnce(json(true, LIST))
    render(<ProviderConnectionsCard />)
    const local = await screen.findByTestId('connection-row-local')
    expect(screen.queryByTestId('connection-status-pill')).toBeNull()
    expect(within(local).queryByRole('button', { name: 'Test connection' })).toBeNull()
    expect(within(local).queryByText('Discovered models')).toBeNull()
    expect(within(local).getByLabelText('Provider ID')).not.toHaveAttribute('readonly')
    await user.type(within(local).getByLabelText('API base URL'), '/x')
    const claude = screen.getByTestId('connection-row-claude')
    await user.selectOptions(within(claude).getByLabelText('Coding CLI'), 'codex')
    await user.click(screen.getByRole('button', { name: 'Add CLI provider' }))
    expect(screen.getByTestId('connection-row-cli')).toBeInTheDocument()
    await user.click(within(screen.getByTestId('connection-row-cli')).getByRole('button', { name: 'Remove provider' }))
    expect(screen.queryByTestId('connection-row-cli')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Add local / API provider' }))
    expect(screen.getByTestId('connection-row-local-2')).toBeInTheDocument()
  })
})
