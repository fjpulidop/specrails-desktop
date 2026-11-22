import { describe, it, expect, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor } from '../../../../../test-utils'
import { RunBudgetPause } from '../RunBudgetPause'

const perRun = { scope: 'project', period: 'run', budgetUsd: 0.05, spentUsd: 0, resetsAt: null, nextStep: { label: 'Architect', usd: 0.13 }, remainingUsd: 0.05 }
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }))
  vi.stubGlobal('fetch', fetchMock)
})
const sentBody = () => JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body))

describe('RunBudgetPause', () => {
  it('says the run stopped before its first step, with the limit, the spend and the next step estimate', () => {
    render(<RunBudgetPause projectId="p1" runId="r1" budget={perRun} stepsRan={false} layout="centered" />)
    expect(screen.getByTestId('run-budget-pause-what')).toHaveTextContent('It stopped before its first step, so nothing has run yet.')
    expect(screen.getByTestId('run-budget-pause-limit')).toHaveTextContent('Limit$0.05')
    expect(screen.getByTestId('run-budget-pause-spent')).toHaveTextContent('Spent$0.00')
    expect(screen.getByTestId('run-budget-pause-next')).toHaveTextContent('about $0.13')
    expect(screen.getByTestId('run-budget-pause-next')).toHaveTextContent('Architect, an estimate')
    // The suggested raise covers the next step, so raising does not stop the run again at once.
    expect(screen.getByTestId('run-budget-pause-amount')).toHaveValue(0.13)
  })

  it('answers with the cap dialog\'s three choices and leaves once one is sent', async () => {
    const { unmount } = render(<RunBudgetPause projectId="p1" runId="r1" budget={perRun} stepsRan />)
    expect(screen.getByTestId('run-budget-pause-what')).toHaveTextContent('It stopped before Architect.')
    await userEvent.click(screen.getByTestId('run-budget-pause-once'))
    expect(String(fetchMock.mock.calls.at(-1)![0])).toContain('/api/projects/p1/loop-runs/r1/resume')
    expect(sentBody()).toEqual({ runCap: 'once' })
    await waitFor(() => expect(screen.queryByTestId('run-budget-pause')).toBeNull())
    unmount()

    render(<RunBudgetPause projectId="p1" runId="r1" budget={perRun} stepsRan />)
    await userEvent.click(screen.getByTestId('run-budget-pause-ignore'))
    expect(sentBody()).toEqual({ runCap: 'ignore' })
  })

  it('raises the limit only above what was spent, and names the rule otherwise', async () => {
    render(<RunBudgetPause projectId="p1" runId="r1" budget={{ ...perRun, spentUsd: 0.2 }} stepsRan />)
    const amount = screen.getByTestId('run-budget-pause-amount')
    await userEvent.clear(amount)
    await userEvent.type(amount, '0.1')
    expect(screen.getByTestId('run-budget-pause-raise')).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('Must be above the $0.20 already spent')
    await userEvent.clear(amount)
    await userEvent.type(amount, '0.5')
    await userEvent.click(screen.getByTestId('run-budget-pause-raise'))
    expect(sentBody()).toEqual({ runCapUsd: 0.5 })
  })

  it('after a restart (no limit known) resumes, and a per-run refusal brings the choices', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'daily_budget_exceeded', ...perRun }), { status: 409 }))
    render(<RunBudgetPause projectId="p1" runId="r1" budget={null} stepsRan={false} />)
    expect(screen.queryByTestId('run-budget-pause-raise')).toBeNull()
    await userEvent.click(screen.getByTestId('run-budget-pause-resume'))
    expect(sentBody()).toEqual({})
    expect(await screen.findByTestId('run-budget-pause-raise')).toBeInTheDocument()
    expect(screen.getByTestId('run-budget-pause-once')).toBeInTheDocument()
  })

  it('a daily limit offers Resume and the spend limits, not the per-run choices', () => {
    render(<RunBudgetPause projectId="p1" runId="r1" budget={{ scope: 'project', budgetUsd: 5, spentUsd: 5.2, resetsAt: null }} stepsRan />)
    expect(screen.getByText('Run paused at a spending limit')).toBeInTheDocument()
    expect(screen.getByTestId('run-budget-pause-what')).toHaveTextContent('Paused on the project daily limit')
    expect(screen.getByTestId('run-budget-pause-resume')).toBeInTheDocument()
    expect(screen.getByTestId('run-budget-pause-settings')).toBeInTheDocument()
    expect(screen.queryByTestId('run-budget-pause-once')).toBeNull()
  })
})
