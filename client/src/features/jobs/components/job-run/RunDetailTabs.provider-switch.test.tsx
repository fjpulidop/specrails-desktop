import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '../../../../test-utils'
import { RunDetailTabs, type RunDetailTabsProps } from './RunDetailTabs'
import { readFailureDiagnosis } from '../../../recovery/lib/failure-diagnosis'
import type { ProviderSwitchContinue } from '../../../recovery/hooks/useContinueRemedies'
import type { JobSummary } from '../../../../types'

const settings = vi.hoisted(() => vi.fn())
vi.mock('../../../../lib/app-settings-events', async () => ({ ...await vi.importActual<object>('../../../../lib/app-settings-events'), openProjectSettings: settings }))

const job: JobSummary = { id: 'fork-2c2', command: 'loop:implement', status: 'failed', started_at: null, finished_at: null, duration_ms: null, total_cost_usd: null, tokens_in: null, tokens_out: null, num_turns: null }
// An older Core settled the limit refusal as a crash at the fixer.
const diagnosis = readFailureDiagnosis({ kind: 'crash', confidence: 'high', phase: 'fixer', detail: 'codex execution failed (exit 1).', source: 'core', resumablePhase: 'fixer', remedies: ['continue', 'open-logs', 'retry'] })!
const analysis = { status: 'ready', provider: 'claude', model: null, createdAt: '', stale: false,
  analysis: { headline: 'Codex hit its usage limit at the fixer', cause: 'The Codex account refused the turn.', category: 'provider_limit', failedStep: 'fixer', evidence: [], nextSteps: [],
    options: [
      { id: 'switch-provider', kind: 'change-model', label: 'Run the fixer on another model', does: 'Moves the fixer off Codex.', consequence: 'The fixer starts with a fresh session.', risk: 'low', recommended: true, guidance: '' },
      { id: 'wait', kind: 'continue-with-guidance', label: 'Wait for the reset', does: 'Continue after the reset.', consequence: 'Codex may refuse again.', risk: 'medium', guidance: 'Retry after the reset.' },
    ] } }

function setup(providerSwitch: ProviderSwitchContinue | null) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response(JSON.stringify(analysis), { status: 200 })))
  const props: RunDetailTabsProps = { job, events: [], surface: 'page', diagnosis, showDiagnosis: true, onOpenLogs: vi.fn(), detailsContent: null, isLoop: true, logContent: null,
    projectId: 'p', diagnosisHandlers: { continue: { run: vi.fn() }, retry: { run: vi.fn() } }, resolution: { chain: null, actions: { choose: vi.fn(), instruct: vi.fn(), keepGoing: vi.fn(), busy: null, done: false } }, providerSwitch }
  render(<RunDetailTabs {...props} />)
}
const offer = { providerId: 'codex', roles: ['developer', 'fixer'], targets: [{ provider: 'claude', model: 'haiku', effort: 'low' }] }

afterEach(() => { vi.restoreAllMocks(); settings.mockClear() })

describe('a run that settled on a usage limit', () => {
  it('offers "Continue with Claude" on the failure card, beside Continue, with what it does to the run', async () => {
    const action: ProviderSwitchContinue = { offer, continueWith: vi.fn(), busy: false, done: false }
    setup(action)
    const card = screen.getByTestId('failure-diagnosis-card')
    expect(within(card).getByTestId('failure-remedy-continue')).toBeInTheDocument()
    const section = within(card).getByTestId('failure-switch')
    expect(section).toHaveTextContent('Continue with another provider')
    expect(within(section).getByTestId('failure-switch-provider')).toHaveTextContent('Claude')
    expect(within(section).getByTestId('failure-switch-model')).toHaveTextContent(/Haiku/)
    expect(within(section).getByTestId('failure-switch-consequence')).toHaveTextContent('The next attempt goes on from the Fixer step, and every step that used Codex runs on Claude for the rest of the run.')
    expect(within(section).getByTestId('failure-switch-consequence')).toHaveTextContent("The project's settings don't change.")
    fireEvent.click(within(section).getByTestId('failure-switch-remember'))
    expect(within(section).getByTestId('failure-switch-consequence')).toHaveTextContent('also route these roles to Claude')
    fireEvent.click(within(section).getByTestId('failure-switch-resume'))
    expect(within(section).getByTestId('failure-switch-resume')).toHaveTextContent('Continue with Claude')
    expect(action.continueWith).toHaveBeenCalledWith({ provider: 'claude', model: 'haiku', effort: 'low', remember: true })
  })

  it('the analysis\' "change the model" option continues with the card\'s choice and its own guidance', async () => {
    const action: ProviderSwitchContinue = { offer, continueWith: vi.fn(), busy: false, done: false }
    setup(action)
    const options = await screen.findAllByTestId('resolution-option')
    fireEvent.click(options.find((option) => option.getAttribute('data-option-id') === 'switch-provider')!)
    expect(action.continueWith).toHaveBeenCalledWith({ provider: 'claude', model: 'haiku', effort: 'low' }, 'switch-provider')
    expect(settings).not.toHaveBeenCalled()
  })

  it('without an offer (no limit, an older Core) there is no switch, and "change the model" opens the agent settings', async () => {
    setup(null)
    expect(screen.queryByTestId('failure-switch')).toBeNull()
    const options = await screen.findAllByTestId('resolution-option')
    fireEvent.click(options.find((option) => option.getAttribute('data-option-id') === 'switch-provider')!)
    expect(settings).toHaveBeenCalledWith('agentRuntime')
  })
})
