import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '../../test-utils'
import userEvent from '@testing-library/user-event'
import { MilestoneGenerationControls } from '../../features/builder/components/project-builder/MilestoneGenerationControls'
import { MilestoneLaunchControls } from '../../features/builder/components/project-builder/MilestoneLaunchControls'

vi.mock('../../lib/api', () => ({ getApiBase: (id = 'proj-1') => `/api/projects/${id}` }))
// Selector keyboard/portal behavior is covered by the shared primitives' tests.
vi.mock('../../features/missions/components/AgentToolbarSelector', () => ({
  AgentToolbarSelector: (props: { value: string; options: Array<{ value: string; label: string }>; onSelect: (value: string) => void; testId: string; disabled: boolean }) => (
    <select data-testid={props.testId} value={props.value} onChange={(event) => props.onSelect(event.target.value)} disabled={props.disabled}>
      {props.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  ),
}))
vi.mock('../../features/missions/components/AgentModelSelector', () => ({
  AgentModelSelector: (props: { model: string; models: Array<{ value: string; label: string }>; onSelect: (value: string) => void; testId: string }) => (
    <select data-testid={props.testId} value={props.model} onChange={(event) => props.onSelect(event.target.value)}>
      {props.models.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
    </select>
  ),
}))

const initial = { provider: 'claude', model: 'sonnet', reasoningEffort: 'low' }
const providers = [
  { provider: 'claude', defaultModel: 'sonnet', models: [{ value: 'sonnet', label: 'Sonnet' }], effortsByModel: { sonnet: ['low', 'high'] } },
  { provider: 'codex', defaultModel: 'gpt-6.1-sol', models: [{ value: 'gpt-6.1-sol', label: 'Sol' }, { value: 'gpt-6.1-terra', label: 'Terra' }], effortsByModel: { 'gpt-6.1-sol': ['high', 'ultra'], 'gpt-6.1-terra': ['high'] } },
]
let saved = initial

beforeEach(() => {
  saved = { ...initial }
  global.fetch = vi.fn().mockImplementation(async (_url: unknown, options?: RequestInit) => {
    if (options?.method === 'PUT') saved = JSON.parse(String(options.body))
    return { ok: true, json: async () => ({ selection: saved, providers }) }
  })
})

async function open(onGenerate = vi.fn()) {
  const view = render(<MilestoneGenerationControls projectId="proj-1" milestoneN={2} onGenerate={onGenerate} />)
  await waitFor(() => expect(screen.getByTestId('sidebar-generate-next')).toBeEnabled())
  return { ...view, user: userEvent.setup(), onGenerate }
}

describe('Milestone generation settings', () => {
  it('offers the execution choice for a newly created project and sends all three values', async () => {
    const onLaunch = vi.fn()
    render(<MilestoneLaunchControls projectId="new-project" busy={false} onLaunch={onLaunch} />)
    expect(screen.getByTestId('launch-m1')).toBeDisabled()
    await waitFor(() => expect(screen.getByTestId('launch-m1')).toBeEnabled())
    expect(global.fetch).toHaveBeenCalledWith('/api/projects/new-project/blueprint/launch-settings', expect.anything())
    await userEvent.selectOptions(screen.getByTestId('milestone-launch-provider'), 'codex')
    await userEvent.selectOptions(screen.getByTestId('milestone-launch-model'), 'gpt-6.1-terra')
    await userEvent.selectOptions(screen.getByTestId('milestone-launch-effort'), 'high')
    await userEvent.click(screen.getByTestId('launch-m1'))
    expect(onLaunch).toHaveBeenCalledWith({ provider: 'codex', model: 'gpt-6.1-terra', reasoningEffort: 'high' })
    expect(saved).toEqual(initial)
  })

  it('blocks execution when the catalog fails and permits a retry', async () => {
    const onLaunch = vi.fn()
    vi.mocked(global.fetch).mockResolvedValueOnce({ ok: false } as Response)
    render(<MilestoneLaunchControls projectId="new-project" busy={false} onLaunch={onLaunch} />)
    await screen.findByRole('alert')
    expect(screen.getByTestId('launch-m1')).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByTestId('launch-m1')).toBeEnabled())
    expect(onLaunch).not.toHaveBeenCalled()
  })

  it('saves all three values and restores them when the panel reopens', async () => {
    const { user, unmount } = await open()
    await user.selectOptions(screen.getByTestId('milestone-default-provider'), 'codex')
    expect(screen.getByTestId('milestone-default-model')).toHaveValue('gpt-6.1-sol')
    expect(screen.getByTestId('milestone-default-effort')).toHaveValue('default')
    await user.selectOptions(screen.getByTestId('milestone-default-effort'), 'ultra')
    expect(screen.getByTestId('sidebar-generate-next')).toBeDisabled()
    await user.click(screen.getByTestId('milestone-save-default'))
    await waitFor(() => expect(screen.getByTestId('sidebar-generate-next')).toBeEnabled())
    unmount()
    const reopened = await open()
    expect(screen.getByTestId('milestone-default-provider')).toHaveValue('codex')
    expect(screen.getByTestId('milestone-default-effort')).toHaveValue('ultra')
    await reopened.user.click(screen.getByTestId('sidebar-generate-next'))
    expect(reopened.onGenerate).toHaveBeenCalledWith({ provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'ultra' })
  })

  it('uses a one-milestone exception without saving it and resets model and effort on provider/model changes', async () => {
    const { user, onGenerate } = await open()
    await user.click(screen.getByRole('checkbox'))
    await user.selectOptions(screen.getByTestId('milestone-override-provider'), 'codex')
    await user.selectOptions(screen.getByTestId('milestone-override-effort'), 'ultra')
    await user.selectOptions(screen.getByTestId('milestone-override-model'), 'gpt-6.1-terra')
    expect(screen.getByTestId('milestone-override-effort')).toHaveValue('default')
    expect(screen.queryByRole('option', { name: 'Ultra' })).not.toBeInTheDocument()
    await user.selectOptions(screen.getByTestId('milestone-override-effort'), 'high')
    await user.click(screen.getByTestId('sidebar-generate-next'))
    expect(onGenerate).toHaveBeenCalledWith({ provider: 'codex', model: 'gpt-6.1-terra', reasoningEffort: 'high' })
    expect(saved).toEqual(initial)
    expect(vi.mocked(global.fetch).mock.calls).toHaveLength(1)
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByTestId('sidebar-generate-next'))
    expect(onGenerate).toHaveBeenLastCalledWith(initial)
  })

  it('keeps launch disabled after a failed save', async () => {
    const { user, onGenerate } = await open()
    await user.selectOptions(screen.getByTestId('milestone-default-provider'), 'codex')
    vi.mocked(global.fetch).mockResolvedValue({ ok: false } as Response)
    await user.click(screen.getByTestId('milestone-save-default'))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar-generate-next')).toBeDisabled()
    expect(onGenerate).not.toHaveBeenCalled()
    expect(saved).toEqual(initial)
  })

  it('blocks an unavailable saved provider instead of silently changing AI', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ selection: { ...initial, provider: 'missing' }, providers }) })
    render(<MilestoneGenerationControls projectId="proj-1" milestoneN={2} onGenerate={vi.fn()} />)
    expect(await screen.findByRole('status')).toHaveTextContent('unavailable')
    expect(screen.getByTestId('sidebar-generate-next')).toBeDisabled()
  })

  it('repairs an obsolete effort even when the model no longer offers an effort selector', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      selection: initial, providers: [{ ...providers[0], effortsByModel: { sonnet: [] } }],
    }) })
    render(<MilestoneGenerationControls projectId="proj-1" milestoneN={2} onGenerate={vi.fn()} />)
    await screen.findByRole('status')
    expect(screen.queryByTestId('milestone-default-effort')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Use provider defaults' }))
    expect(screen.getByTestId('milestone-save-default')).toBeEnabled()
    expect(screen.getByTestId('sidebar-generate-next')).toBeDisabled()
  })

  it('discards a late response from a previous project', async () => {
    let finishOld!: (response: Response) => void
    global.fetch = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOld = resolve }))
      .mockResolvedValue({ ok: true, json: async () => ({ selection: { ...initial, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: null }, providers }) })
    const onGenerate = vi.fn()
    const view = render(<MilestoneGenerationControls key="proj-1" projectId="proj-1" milestoneN={2} onGenerate={onGenerate} />)
    view.rerender(<MilestoneGenerationControls key="proj-2" projectId="proj-2" milestoneN={2} onGenerate={onGenerate} />)
    await waitFor(() => expect(screen.getByTestId('milestone-default-provider')).toHaveValue('codex'))
    finishOld({ ok: true, json: async () => ({ selection: initial, providers }) } as Response)
    await userEvent.click(screen.getByTestId('sidebar-generate-next'))
    expect(onGenerate).toHaveBeenCalledWith({ ...initial, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: null })
  })
})
