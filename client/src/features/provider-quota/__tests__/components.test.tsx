import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '../../../test-utils'
import { SharedWebSocketContext } from '../../../hooks/useSharedWebSocket'
import { LaunchAllDialog } from '../../rails/components/LaunchAllDialog'
import { LimitPauseCard } from '../components/LimitPauseCard'
import { useProviderSwitchChoice } from '../components/ProviderSwitchSection'
import { MissionUsageLimitCard } from '../components/MissionUsageLimitCard'
import { ProviderQuotaBridge } from '../components/ProviderQuotaBridge'
import { quotaStore } from '../lib/quota-store'
import type { AttentionCenter } from '../../../lib/attention/attention-center'
import type { ProviderQuota } from '../lib/types'

const handlers = new Map<string, (msg: unknown) => void>()
const ws = { registerHandler: (id: string, fn: (msg: unknown) => void) => { handlers.set(id, fn) }, unregisterHandler: (id: string) => { handlers.delete(id) }, connectionStatus: 'connected' as const }
const withWs = (ui: React.ReactElement) => <SharedWebSocketContext.Provider value={ws}>{ui}</SharedWebSocketContext.Provider>
const push = (msg: unknown) => act(() => { for (const fn of handlers.values()) fn(msg) })
const quota = (over: Partial<ProviderQuota> = {}): ProviderQuota => ({ providerId: 'claude', level: 'ok', usedPercent: 40, windowId: 'five_hour', rejectedUntil: null, rejectedIndefinitely: false, windows: [], observedAt: null, ...over })

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  handlers.clear()
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/launch-preflight')) return new Response(JSON.stringify(preflight), { status: 200 })
    if (url.includes('/provider-quota')) return new Response(JSON.stringify({ providers: [] }), { status: 200 })
    if (url.includes('/limit-continue')) return new Response(JSON.stringify({ at: init?.method === 'POST' ? JSON.parse(String(init.body)).at : null }), { status: 200 })
    if (url.includes('/limit')) return new Response(JSON.stringify({ limit: { providerId: 'claude', resumeAt: '2099-01-01T00:00:00.000Z', autoResume: false, message: '', pausedAt: 't', switchable: true } }), { status: 200 })
    return new Response('{}', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals(); quotaStore.accept({ providers: [] }) })

let preflight: unknown = null

describe('LaunchAllDialog preflight', () => {
  it('shows the checks as chips, warns before launching rails into a window ≥80 %, and blocks only on a failed check', async () => {
    preflight = { blocking: true, checkedAt: 't', chips: [
      { id: 'disk', kind: 'disk', state: 'fail', freeBytes: 512 * 1024 ** 2 },
      { id: 'provider:claude', kind: 'provider', state: 'ok', providerId: 'claude', status: 'signed-in' },
      { id: 'github', kind: 'github', state: 'warn', status: 'signed-out' },
      { id: 'quota:claude', kind: 'quota', state: 'warn', providerId: 'claude', level: 'critical', usedPercent: 91, rejectedUntil: null },
    ] }
    quotaStore.accept({ providers: [quota({ level: 'critical', usedPercent: 91, windowId: 'five_hour' })] })
    const onConfirm = vi.fn()
    render(withWs(<LaunchAllDialog open railCount={3} specCount={3} onConfirm={onConfirm} onCancel={() => {}} projectId="p1" providers={['', 'claude']} />))
    const chips = await screen.findByTestId('launch-preflight')
    await waitFor(() => expect(within(chips).getByTestId('preflight-chip-disk')).toHaveAttribute('data-state', 'fail'))
    expect(within(chips).getByTestId('preflight-chip-disk')).toHaveTextContent('Only 512 MB free — free up space first')
    expect(within(chips).getByTestId('preflight-chip-github')).toHaveTextContent('GitHub signed out — pull requests will not open')
    expect(screen.getByTestId('launch-all-quota-warning')).toHaveTextContent('Claude has used 91% of its 5-hour limit. Launching 3 rails may pause them at the limit')
    expect(screen.getByTestId('launch-preflight-blocking')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Launch 3/ })).toBeDisabled()
    expect(String(fetchMock.mock.calls.find(([url]) => String(url).includes('launch-preflight'))?.[0])).toContain('providers=%2Cclaude')
  })

  it('warns about a refused provider with its reset and lets the launch go ahead', async () => {
    preflight = { blocking: false, checkedAt: 't', chips: [
      { id: 'disk', kind: 'disk', state: 'ok', freeBytes: 50 * 1024 ** 3 },
      { id: 'quota:claude', kind: 'quota', state: 'warn', providerId: 'claude', level: 'rejected', usedPercent: 100, rejectedUntil: '2099-01-01T15:00:00.000Z' },
    ] }
    render(withWs(<LaunchAllDialog open railCount={1} specCount={1} onConfirm={() => {}} onCancel={() => {}} projectId="p1" providers={['claude']} />))
    expect(await screen.findByTestId('launch-all-quota-warning')).toHaveTextContent('Claude refuses requests until')
    expect(screen.getByTestId('launch-all-quota-warning')).toHaveTextContent('The rail will wait and start working after the reset.')
    expect(screen.getByRole('button', { name: /Launch/ })).toBeEnabled()
  })
})

describe('LimitPauseCard', () => {
  it('says when the run resumes on its own and answers resume / automatic resume / switch', async () => {
    const onChanged = vi.fn()
    const limit = { providerId: 'claude', resumeAt: new Date(Date.now() + 3 * 3_600_000).toISOString(), autoResume: true, message: 'You have hit your limit', pausedAt: 't', switchable: true }
    render(withWs(<LimitPauseCard projectId="p1" runId="run-1" limit={limit} providers={['claude', 'codex']} onChanged={onChanged} />))
    expect(screen.getByTestId('limit-pause-when')).toHaveTextContent(/Resumes on its own at .* \(in (2h 59m|3h)\)\./)
    // The limited provider (and any sharing its quota) is never offered.
    expect(screen.queryByTestId('limit-pause-switch-claude')).toBeNull()
    await userEvent.click(screen.getByTestId('limit-pause-auto'))
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body))).toEqual({ action: 'auto', enabled: false })
    expect(onChanged).toHaveBeenLastCalledWith(expect.objectContaining({ autoResume: false }))
    await userEvent.click(screen.getByTestId('limit-pause-switch-codex'))
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body))).toEqual({ action: 'switch', provider: 'codex' })
    await userEvent.click(screen.getByRole('button', { name: 'Resume now' }))
    expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('/loop-runs/run-1/limit')
  })

  it('a Core run continues on another provider with its model and effort, never on the limited one', async () => {
    const onChanged = vi.fn()
    // The server offers only providers that do not share the limited one's quota (and drops it defensively here too).
    const limit = { providerId: 'codex', resumeAt: new Date(Date.now() + 3_600_000).toISOString(), autoResume: true, message: '', pausedAt: 't', switchable: true,
      switchRoles: ['developer', 'fixer'], switchTargets: [{ provider: 'claude', model: 'sonnet', effort: 'medium' }, { provider: 'codex', model: 'gpt-6-sol', effort: 'low' }, { provider: 'gemini', model: 'gemini-3.5-flash', effort: null }] }
    render(withWs(<LimitPauseCard projectId="p1" runId="run-1" limit={limit} providers={['claude', 'codex', 'gemini']} onChanged={onChanged} />))
    const section = screen.getByTestId('limit-pause-switch')
    expect(section).toHaveTextContent('Continue now with another provider')
    // Legacy one-click buttons are not shown for a Core run.
    expect(screen.queryByTestId('limit-pause-switch-claude')).toBeNull()
    expect(screen.getByTestId('limit-pause-switch-provider')).toHaveTextContent('Claude')
    expect(screen.getByTestId('limit-pause-switch-model')).toHaveTextContent('Claude Sonnet 5.5')
    expect(screen.getByTestId('limit-pause-switch-effort')).toHaveTextContent('Medium')
    expect(screen.getByTestId('limit-pause-switch-consequence')).toHaveTextContent("every later step that used Codex switch to Claude. Work already in the worktree is kept.")
    expect(screen.getByTestId('limit-pause-switch-consequence')).toHaveTextContent("The project's settings don't change.")
    fireEvent.pointerDown(screen.getByTestId('limit-pause-switch-provider'), { button: 0, ctrlKey: false, pointerType: 'mouse' })
    expect(screen.queryByRole('option', { name: 'Codex' })).toBeNull()
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Claude', 'Gemini'])
    fireEvent.click(screen.getByRole('option', { name: 'Claude' }))
    fireEvent.pointerDown(screen.getByTestId('limit-pause-switch-model'), { button: 0, ctrlKey: false, pointerType: 'mouse' })
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Claude Sonnet 5.5', 'Claude Fable 5.2', 'Claude Opus 5.5', 'Claude Haiku 5.5'])
    fireEvent.click(screen.getByRole('option', { name: 'Claude Haiku 5.5' }))
    fireEvent.pointerDown(screen.getByTestId('limit-pause-switch-effort'), { button: 0, ctrlKey: false, pointerType: 'mouse' })
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Low', 'Medium', 'High', 'Extra high'])
    fireEvent.click(screen.getByRole('option', { name: 'Low' }))
    await userEvent.click(screen.getByTestId('limit-pause-switch-remember'))
    expect(screen.getByTestId('limit-pause-switch-consequence')).toHaveTextContent('will also route these roles to Claude')
    await userEvent.click(screen.getByRole('button', { name: 'Resume with Claude' }))
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body))).toEqual({ action: 'switch', provider: 'claude', model: 'haiku', effort: 'low', remember: true })
    expect(onChanged).toHaveBeenLastCalledWith(null)
  })

  it('a provider without reasoning efforts sends no effort; a run with no other provider keeps today\'s card', async () => {
    const limit = { providerId: 'codex', resumeAt: null, autoResume: false, message: '', pausedAt: 't', switchable: true, switchRoles: ['developer'], switchTargets: [{ provider: 'gemini', model: 'gemini-3.5-flash', effort: null }] }
    const { unmount } = render(withWs(<LimitPauseCard projectId="p1" runId="run-1" limit={limit} />))
    expect(screen.queryByTestId('limit-pause-switch-effort')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Resume with Gemini' }))
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body))).toEqual({ action: 'switch', provider: 'gemini', model: 'gemini-3.5-flash' })
    unmount()
    // An older Core (no routeOverrides) or nothing else installed: the server offers no switch.
    render(withWs(<LimitPauseCard projectId="p1" runId="run-2" limit={{ ...limit, switchable: false, switchTargets: undefined }} providers={['claude', 'codex']} />))
    expect(screen.queryByTestId('limit-pause-switch')).toBeNull()
    expect(screen.queryByTestId('limit-pause-switch-claude')).toBeNull()
    expect(screen.getByRole('button', { name: 'Resume now' })).toBeInTheDocument()
  })

  it('offers no switch on a Core run and says when the reset is unknown', () => {
    render(withWs(<LimitPauseCard projectId="p1" runId="run-1" limit={{ providerId: 'codex', resumeAt: null, autoResume: false, message: '', pausedAt: 't', switchable: false }} providers={['claude', 'codex']} />))
    expect(screen.getByTestId('limit-pause-when')).toHaveTextContent('Codex did not say when the limit resets.')
    expect(screen.queryByTestId('limit-pause-switch-claude')).toBeNull()
    expect(screen.queryByTestId('limit-pause-auto')).toBeNull()
  })
})

describe('MissionUsageLimitCard', () => {
  it('offers to continue at the reset (never automatic) and on another provider', async () => {
    const resumeAt = new Date(Date.now() + 3_600_000).toISOString()
    const onContinueWith = vi.fn(async () => {})
    render(withWs(<MissionUsageLimitCard row={{ kind: 'usage-limit', provider: 'claude', resumeAt, message: 'limit', at: 't' }} conversationId="c1" latest installedProviders={['claude', 'codex']} onContinueWith={onContinueWith} />))
    expect(screen.queryByTestId('mission-usage-limit-scheduled')).toBeNull()
    await userEvent.click(await screen.findByTestId('mission-usage-limit-schedule'))
    expect(await screen.findByTestId('mission-usage-limit-scheduled')).toHaveTextContent('Continues on its own at')
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body))).toEqual({ at: resumeAt })
    push({ type: 'agent_limit_continue', conversationId: 'c1', at: null })
    expect(screen.queryByTestId('mission-usage-limit-scheduled')).toBeNull()
    await userEvent.click(screen.getByTestId('mission-usage-limit-switch-codex'))
    expect(onContinueWith).toHaveBeenCalledWith('codex', expect.stringContaining('Check what was already done'))
    expect(screen.queryByTestId('mission-usage-limit-switch-claude')).toBeNull()
  })
})

describe('ProviderQuotaBridge', () => {
  it('keeps the quota store live from pushes and announces escalations once, as budget attention', async () => {
    const dispatch = vi.fn(async () => 'toast' as const)
    const center = { dispatch, takeAway: () => [], forget: () => {} } as unknown as AttentionCenter
    render(withWs(<ProviderQuotaBridge center={center} />))
    await waitFor(() => expect(quotaStore.getSnapshot().loaded).toBe(true))
    push({ type: 'provider_quota.updated', providers: [quota({ level: 'warning', usedPercent: 82 })] })
    push({ type: 'provider_quota.updated', providers: [quota({ level: 'warning', usedPercent: 85 })] })
    push({ type: 'provider_quota.updated', providers: [quota({ level: 'rejected', usedPercent: 100, rejectedUntil: '2099-01-01T15:00:00.000Z' })] })
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch.mock.calls[0]![0]).toMatchObject({ category: 'budget', title: 'Claude usage at 82%' })
    expect(dispatch.mock.calls[1]![0]).toMatchObject({ category: 'budget', title: 'Claude usage limit reached' })
  })
})

describe('useProviderSwitchChoice', () => {
  it('starts on the first target when the targets arrive after the first render, and keeps the person\'s pick', () => {
    const targets = [{ provider: 'claude', model: 'sonnet', effort: 'medium' }, { provider: 'gemini', model: 'gemini-3.5-flash', effort: null }]
    const { result, rerender } = renderHook(({ list }) => useProviderSwitchChoice(list), { initialProps: { list: [] as typeof targets } })
    expect(result.current).toBeNull()
    rerender({ list: targets })
    expect(result.current!.choice).toEqual({ provider: 'claude', model: 'sonnet', effort: 'medium' })
    act(() => result.current!.chooseModel('haiku'))
    expect(result.current!.choice).toMatchObject({ provider: 'claude', model: 'haiku' })
    act(() => result.current!.setEffort('low'))
    expect(result.current!.choice).toEqual({ provider: 'claude', model: 'haiku', effort: 'low' })
    act(() => result.current!.chooseProvider('gemini'))
    expect(result.current!.choice).toMatchObject({ provider: 'gemini', model: 'gemini-3.5-flash' })
  })
})
