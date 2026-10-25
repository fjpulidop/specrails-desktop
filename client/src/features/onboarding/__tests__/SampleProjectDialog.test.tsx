import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '../../../test-utils'
import userEvent from '@testing-library/user-event'
import { SampleProjectDialog } from '../components/SampleProjectDialog'
import { SampleApiError } from '../lib/sample-api'
import { NOT_READY, READY, WITH_LOCAL } from './fixtures'

const createSampleProject = vi.fn()
vi.mock('../lib/sample-api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/sample-api')>()),
  createSampleProject: (...args: unknown[]) => createSampleProject(...args),
}))

let billing = { ready: true, plan: false, metered: true }
vi.mock('../../../hooks/useLaunchForecast', () => ({ useProviderBilling: () => billing }))

const outcome = { reused: false, project: { id: 'sample-p', name: 'tic-tac-toe', path: '/x' }, sample: { sampleId: 'tic-tac-toe', projectId: 'sample-p', path: '/x', specIds: [1, 2, 3] } }

function setup(status = READY) {
  const onCreated = vi.fn().mockResolvedValue(undefined)
  const onOpenChange = vi.fn()
  render(<SampleProjectDialog open onOpenChange={onOpenChange} status={status} onCreated={onCreated} />)
  return { onCreated, onOpenChange }
}

beforeEach(() => {
  createSampleProject.mockReset().mockResolvedValue(outcome)
  billing = { ready: true, plan: false, metered: true }
})

describe('SampleProjectDialog', () => {
  it('confirms the folder, says what is created and states the cost as an estimate before anything runs', () => {
    setup()
    expect(screen.getByTestId('sample-folder')).toHaveValue('/Users/me/Specrails Samples/tic-tac-toe')
    expect(screen.getByText(/Nothing runs until you press Run/i)).toBeInTheDocument()
    const cost = screen.getByTestId('sample-cost')
    expect(cost).toHaveAttribute('data-billing', 'metered')
    expect(cost).toHaveTextContent(/≈ \$0\.30–\$1/)
    expect(cost).toHaveTextContent(/estimate/i)
    expect(cost).toHaveTextContent(/pauses and asks before passing \$1/i)
    expect(cost).toHaveTextContent(/haiku on claude/i)
  })

  it('never shows a dollar figure for a plan-billed or unknown-billing provider as fact', () => {
    billing = { ready: true, plan: true, metered: false }
    setup()
    expect(screen.getByTestId('sample-cost')).toHaveAttribute('data-billing', 'plan')
    expect(screen.getByTestId('sample-cost')).toHaveTextContent(/no extra charge/i)
    expect(screen.getByTestId('sample-cost')).not.toHaveTextContent('$0.30')
  })

  it('creates at the default folder by letting the server pick a free name', async () => {
    const user = userEvent.setup()
    const { onCreated, onOpenChange } = setup()
    await user.click(screen.getByTestId('sample-create'))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(outcome))
    expect(createSampleProject).toHaveBeenCalledWith({ locale: 'en', parentDir: '/Users/me/Specrails Samples' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('sends an edited folder as the exact path and explains a collision', async () => {
    const user = userEvent.setup()
    createSampleProject.mockRejectedValueOnce(new SampleApiError('path_exists', 'That folder already exists'))
    const { onCreated } = setup()
    const field = screen.getByTestId('sample-folder')
    await user.clear(field)
    await user.type(field, '/Users/me/play/game')
    await user.click(screen.getByTestId('sample-create'))
    await waitFor(() => expect(createSampleProject).toHaveBeenCalledWith({ locale: 'en', path: '/Users/me/play/game' }))
    expect(onCreated).not.toHaveBeenCalled()
    expect(await screen.findByTestId('sample-error')).toHaveTextContent(/already exists/i)
  })

  it('mentions a configured local engine as a no-API-cost alternative', () => {
    setup(WITH_LOCAL)
    expect(screen.getByText(/local engine \(local-lan\) is also available/i)).toBeInTheDocument()
  })

  it('still lets you create the sample when no provider is ready, and says a recording is the alternative', () => {
    setup(NOT_READY)
    expect(screen.getByTestId('sample-dialog-not-ready')).toHaveTextContent(/recorded run/i)
    expect(screen.getByTestId('sample-create')).toBeEnabled()
  })
})
