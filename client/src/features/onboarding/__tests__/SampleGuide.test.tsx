import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '../../../test-utils'
import userEvent from '@testing-library/user-event'
import { SampleGuide } from '../components/SampleGuide'
import { SAMPLE_GUIDE_KEY } from '../lib/sample-guide-state'
import { NOT_READY, WITH_LOCAL, WITH_SAMPLE } from './fixtures'
import type { SampleStatus } from '../lib/sample-model'

let status: SampleStatus | null = WITH_SAMPLE
let activeProjectId: string | null = 'sample-p'
const fetchSampleStatus = vi.fn()
const launchFirstSpec = vi.fn()
const removeSampleProject = vi.fn()
const refreshProjects = vi.fn().mockResolvedValue(undefined)

vi.mock('../lib/sample-api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/sample-api')>()),
  fetchSampleStatus: (...args: unknown[]) => fetchSampleStatus(...args),
  launchFirstSpec: (...args: unknown[]) => launchFirstSpec(...args),
  removeSampleProject: (...args: unknown[]) => removeSampleProject(...args),
}))
vi.mock('../../../hooks/useDesktop', () => ({
  useDesktop: () => ({ activeProjectId, refreshProjects, projects: [], setActiveProjectId: vi.fn() }),
}))
vi.mock('../../../hooks/useLaunchForecast', () => ({ useProviderBilling: () => ({ ready: true, plan: false, metered: true }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

beforeEach(() => {
  localStorage.clear()
  status = WITH_SAMPLE
  activeProjectId = 'sample-p'
  fetchSampleStatus.mockReset().mockImplementation(async () => status)
  launchFirstSpec.mockReset().mockResolvedValue({ ok: true })
  removeSampleProject.mockReset().mockResolvedValue(undefined)
  refreshProjects.mockClear()
})
afterEach(() => { localStorage.clear() })

async function setup() {
  const onAddProject = vi.fn()
  const user = userEvent.setup()
  render(<SampleGuide onAddProject={onAddProject} />)
  return { onAddProject, user }
}

describe('SampleGuide: exactly three steps', () => {
  it('walks spec -> rail -> review and ends with "Now add your own project"', async () => {
    const { user, onAddProject } = await setup()
    expect(await screen.findByTestId('sample-guide')).toHaveAttribute('data-step', 'spec')
    expect(screen.getByTestId('sample-step-count')).toHaveTextContent('Step 1 of 3')
    expect(screen.getByTestId('sample-back')).toBeDisabled()

    await user.click(screen.getByTestId('sample-next'))
    expect(screen.getByTestId('sample-guide')).toHaveAttribute('data-step', 'rail')
    expect(screen.getByTestId('sample-step-count')).toHaveTextContent('Step 2 of 3')

    await user.click(screen.getByTestId('sample-next'))
    expect(screen.getByTestId('sample-guide')).toHaveAttribute('data-step', 'review')
    expect(screen.getByTestId('sample-step-count')).toHaveTextContent('Step 3 of 3')
    expect(screen.queryByTestId('sample-next')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('sample-add-own'))
    expect(onAddProject).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('sample-pill')).toBeInTheDocument()
  })

  it('only shows for the sample project', async () => {
    activeProjectId = 'someone-else'
    await setup()
    await waitFor(() => expect(fetchSampleStatus).toHaveBeenCalled())
    expect(screen.queryByTestId('sample-guide')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sample-pill')).not.toBeInTheDocument()
  })

  it('is dismissible (button and Escape), collapses to a pill and remembers it per viewer', async () => {
    const { user } = await setup()
    await user.click(await screen.findByTestId('sample-dismiss'))
    expect(screen.queryByTestId('sample-guide')).not.toBeInTheDocument()
    expect(screen.getByTestId('sample-pill')).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem(SAMPLE_GUIDE_KEY) as string)).toMatchObject({ projectId: 'sample-p', done: true })

    await user.click(screen.getByTestId('sample-show-guide'))
    expect(await screen.findByTestId('sample-guide')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await user.click(screen.getByTestId('sample-next'))
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('sample-guide')).not.toBeInTheDocument()
  })

  it('starts collapsed when this viewer already finished the guide', async () => {
    localStorage.setItem(SAMPLE_GUIDE_KEY, JSON.stringify({ projectId: 'sample-p', step: 2, done: true, launched: true }))
    await setup()
    expect(await screen.findByTestId('sample-pill')).toBeInTheDocument()
    expect(screen.queryByTestId('sample-guide')).not.toBeInTheDocument()
  })
})

describe('SampleGuide: run the first spec', () => {
  async function toRail() {
    const ctx = await setup()
    await ctx.user.click(await screen.findByTestId('sample-next'))
    return ctx
  }

  it('launches the first spec with the cost-bounded preset (Quick SDD, cheapest model, run cap) and states the cost first', async () => {
    const { user } = await toRail()
    expect(screen.getByTestId('sample-cost')).toHaveTextContent(/≈ \$0\.30–\$1/)
    expect(screen.getByTestId('sample-cost')).toHaveTextContent(/estimate/i)
    await user.click(screen.getByTestId('run-first-spec'))
    await waitFor(() => expect(launchFirstSpec).toHaveBeenCalledTimes(1))
    expect(launchFirstSpec).toHaveBeenCalledWith('sample-p', 11, { provider: 'claude', model: 'haiku', local: false, loopId: 'factory:sdd-quick-openspec', runCapUsd: 1 })
    expect(await screen.findByTestId('sample-launched')).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem(SAMPLE_GUIDE_KEY) as string)).toMatchObject({ launched: true })
    expect(screen.queryByTestId('run-first-spec')).not.toBeInTheDocument()
  })

  it('offers the local engine when one is configured, uncapped', async () => {
    status = WITH_LOCAL
    const { user } = await toRail()
    await user.click(screen.getByTestId('sample-engine-local'))
    expect(screen.getByTestId('sample-cost')).toHaveAttribute('data-billing', 'local')
    expect(screen.getByTestId('sample-cost')).toHaveTextContent(/no api cost/i)
    await user.click(screen.getByTestId('run-first-spec'))
    await waitFor(() => expect(launchFirstSpec).toHaveBeenCalled())
    expect(launchFirstSpec.mock.calls[0][2]).toMatchObject({ provider: 'local-lan', local: true, runCapUsd: null })
  })

  it('falls back to a recorded run, honestly labelled, when no provider is ready (and never launches)', async () => {
    status = NOT_READY
    const { user } = await toRail()
    expect(screen.queryByTestId('run-first-spec')).not.toBeInTheDocument()
    expect(screen.getByTestId('sample-fallback')).toHaveTextContent(/recording: nothing runs and nothing is charged/i)
    await user.click(screen.getByTestId('watch-recording'))
    expect(await screen.findByTestId('recorded-run-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('recording-badge')).toBeInTheDocument()
    expect(launchFirstSpec).not.toHaveBeenCalled()
  })

  it('re-probes providers on "Check again" and switches to the real run once one is ready', async () => {
    status = NOT_READY
    const { user } = await toRail()
    status = WITH_SAMPLE
    await user.click(screen.getByTestId('recheck-providers'))
    expect(fetchSampleStatus).toHaveBeenLastCalledWith({ refresh: true })
    expect(await screen.findByTestId('run-first-spec')).toBeInTheDocument()
  })

  it('reports a refused launch without losing the call to action', async () => {
    launchFirstSpec.mockResolvedValueOnce({ ok: false, code: 'over_budget' })
    const { user } = await toRail()
    await user.click(screen.getByTestId('run-first-spec'))
    expect(await screen.findByTestId('sample-run-error')).toHaveTextContent(/budget/i)
    expect(screen.getByTestId('run-first-spec')).toBeEnabled()
  })
})

describe('SampleGuide: remove the sample', () => {
  it('unregisters but keeps the folder by default', async () => {
    const { user } = await setup()
    await user.click(await screen.findByTestId('sample-dismiss'))
    await user.click(screen.getByTestId('sample-remove'))
    expect(await screen.findByTestId('remove-sample-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('remove-sample-delete-folder')).not.toBeChecked()
    await user.click(screen.getByTestId('remove-sample-confirm'))
    await waitFor(() => expect(removeSampleProject).toHaveBeenCalledWith(false))
    expect(refreshProjects).toHaveBeenCalled()
  })

  it('deleting the folder is a separate, explicit, irreversible choice', async () => {
    const { user } = await setup()
    await user.click(await screen.findByTestId('sample-dismiss'))
    await user.click(screen.getByTestId('sample-remove'))
    await user.click(await screen.findByTestId('remove-sample-delete-folder'))
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument()
    expect(screen.getByTestId('remove-sample-confirm')).toHaveTextContent(/delete folder/i)
    await user.click(screen.getByTestId('remove-sample-confirm'))
    await waitFor(() => expect(removeSampleProject).toHaveBeenCalledWith(true))
  })

  it('shows the failure and keeps the dialog open', async () => {
    removeSampleProject.mockRejectedValueOnce(new Error('boom'))
    const { user } = await setup()
    await user.click(await screen.findByTestId('sample-dismiss'))
    await user.click(screen.getByTestId('sample-remove'))
    await user.click(await screen.findByTestId('remove-sample-confirm'))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByTestId('remove-sample-dialog')).toBeInTheDocument()
  })
})
