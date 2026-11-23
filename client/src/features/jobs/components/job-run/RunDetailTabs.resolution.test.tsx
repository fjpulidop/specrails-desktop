import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '../../../../test-utils'
import { RunDetailTabs, type RunDetailTabsProps, type RunResolution } from './RunDetailTabs'
import { readFailureDiagnosis } from '../../../recovery/lib/failure-diagnosis'
import type { JobSummary } from '../../../../types'

const job: JobSummary = { id: 'fork-dfff', command: 'loop:implement', status: 'failed', started_at: null, finished_at: null, duration_ms: null, total_cost_usd: null, tokens_in: null, tokens_out: null, num_turns: null }
const FLAKY = ['tests/desktop/menus.spec.ts › Salir exits from main', 'tests/desktop/menus.spec.ts › native close exits during an idle reload before the shell subscribes']
const diagnosis = readFailureDiagnosis({ kind: 'blocked', confidence: 'high', phase: 'correction-exhausted', rounds: 9, detail: 'Automatic corrections ran out.', source: 'core', resumablePhase: null,
  remedies: ['continue', 'edit-spec', 'open-logs', 'retry'], failingTests: FLAKY, flakyTests: FLAKY })!
const OPTIONS = [
  { id: 'deterministic-close', kind: 'continue-with-guidance', label: 'Make the close tests deterministic', does: 'Launches Electron without the Playwright debugger.', consequence: 'The run can deliver once they pass every round.', risk: 'low', recommended: true, guidance: 'Launch Electron without --inspect.' },
  { id: 'manual-close', kind: 'mark-human-check', label: 'Check closing by hand after delivery', does: 'Moves the 3 close checks to manual checks.', consequence: 'The run can deliver; you verify closing by hand.', risk: 'medium', guidance: 'Salir exits from main' },
  { id: 'keep', kind: 'continue-with-guidance', label: 'Keep trying as is', does: 'Another round of corrections.', consequence: 'Likely the same stop.', risk: 'high', guidance: '' },
]
const ready = (options: unknown) => ({ status: 'ready', provider: 'codex', model: null, createdAt: '', stale: false,
  analysis: { headline: 'The close tests fail under the debugger', cause: 'Electron waits for the inspector to detach.', category: 'tests', failedStep: 'verify', evidence: [], nextSteps: ['Open the evidence'], ...(options ? { options } : {}) } })

function setup(resolution: RunResolution, analysis: unknown) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response(JSON.stringify(analysis), { status: 200 })))
  const cont = vi.fn()
  const props: RunDetailTabsProps = { job, events: [], surface: 'page', diagnosis, showDiagnosis: true, onOpenLogs: vi.fn(), detailsContent: null, isLoop: true, logContent: null,
    projectId: 'p', diagnosisHandlers: { continue: { run: cont }, retry: { run: vi.fn() } }, resolution }
  render(<RunDetailTabs {...props} />)
  return { cont }
}
const choice = () => ({ choose: vi.fn(), instruct: vi.fn(), keepGoing: vi.fn(), busy: null, done: false })
const card = () => screen.getByTestId('failure-diagnosis-card')

afterEach(() => { vi.restoreAllMocks() })

describe('the failed run window with resolution options', () => {
  it('after the same stop again, leads with the options and the spend, with no plain Continue', async () => {
    const actions = choice()
    setup({ chain: { attempts: 5, costUsd: 15.06, costEstimated: false, repeated: true, times: 3 }, actions }, ready(OPTIONS))
    const options = await screen.findAllByTestId('resolution-option')
    expect(options.map((item) => item.getAttribute('data-option-id'))).toEqual(['deterministic-close', 'manual-close', 'keep'])
    expect(within(card()).queryByTestId('failure-remedy-continue')).toBeNull()
    expect(screen.getByTestId('failure-repeat')).toHaveTextContent('Stopped the same way 3 times in a row')
    expect(screen.getByTestId('failure-repeat-spend')).toHaveTextContent('5 attempts, $15.06 so far')
    expect(screen.getByTestId('failure-flaky-tests')).toHaveTextContent('Salir exits from main')
    // The numbered plan is gone: options replace it.
    expect(screen.queryByText('The plan to fix it')).toBeNull()
    fireEvent.click(options[0])
    expect(actions.choose).toHaveBeenCalledWith('deterministic-close', 'Make the close tests deterministic')
  })

  it('adds "keep trying as is" with the cost per attempt when the analysis gave none after a repeat', async () => {
    const actions = choice()
    setup({ chain: { attempts: 4, costUsd: 14, costEstimated: false, repeated: true, times: 2 }, actions }, ready(OPTIONS.slice(0, 2)))
    const options = await screen.findAllByTestId('resolution-option')
    expect(options.at(-1)).toHaveTextContent('Keep trying as is')
    expect(options.at(-1)).toHaveTextContent('each attempt has cost about $3.50 so far')
    fireEvent.click(options.at(-1)!)
    expect(actions.keepGoing).toHaveBeenCalledWith('Keep trying as is')
  })

  it('without a repeat, Continue stays the primary "keep going" and the plain option is not shown twice', async () => {
    setup({ chain: null, actions: choice() }, ready(OPTIONS))
    const options = await screen.findAllByTestId('resolution-option')
    expect(options.map((item) => item.getAttribute('data-option-id'))).toEqual(['deterministic-close', 'manual-close'])
    expect(within(card()).getByTestId('failure-remedy-continue')).toHaveAttribute('data-primary', '')
    expect(screen.queryByTestId('failure-repeat')).toBeNull()
  })

  it('an older analysis without options keeps today\'s plan, and a repeat still never leads with Continue', async () => {
    setup({ chain: { attempts: 3, costUsd: null, costEstimated: false, repeated: true, times: 3 }, actions: choice() }, ready(null))
    expect(await screen.findByText('The plan to fix it')).toBeInTheDocument()
    expect(screen.queryByTestId('resolution-options')).toBeNull()
    const cont = within(card()).getByTestId('failure-remedy-continue')
    expect(cont).not.toHaveAttribute('data-primary')
    // "3 attempts so far" would only repeat the title's count.
    expect(screen.getByTestId('failure-repeat')).toHaveTextContent('Stopped the same way 3 times in a row')
    expect(screen.queryByTestId('failure-repeat-spend')).toBeNull()
    // The analysis below is ready: the notice points at it.
    expect(screen.getByTestId('failure-repeat')).toHaveTextContent('The AI analysis below suggests ways forward.')
  })

  it('a repeat whose AI analysis did not finish does not point at an analysis below', async () => {
    setup({ chain: { attempts: 2, costUsd: null, costEstimated: false, repeated: true, times: 2 }, actions: choice() }, { status: 'error', error: 'analysis_failed', detail: 'failure analysis: no JSON object in the answer' })
    const notice = await screen.findByTestId('failure-repeat')
    await waitFor(() => expect(screen.getByTestId('failure-analysis')).toHaveAttribute('data-state', 'error'))
    expect(notice).toHaveTextContent('Continuing unchanged will likely stop here again.')
    expect(notice).not.toHaveTextContent('AI analysis below')
  })
})
