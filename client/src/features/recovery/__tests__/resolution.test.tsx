import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '../../../test-utils'
import { ResolutionOptions } from '../components/ResolutionOptions'
import { continueMode, costPerAttempt, isPlainContinue, KEEP_TRYING_ID, readChainResolution, readResolutionOptions, visibleOptions, type ResolutionOption } from '../lib/resolution'
import type { ResolutionActions } from '../hooks/useContinueRemedies'
import en from '../../../locales/en/recovery.json'
import es from '../../../locales/es/recovery.json'
import de from '../../../locales/de/recovery.json'
import fr from '../../../locales/fr/recovery.json'
import it_ from '../../../locales/it/recovery.json'
import ja from '../../../locales/ja/recovery.json'
import pt from '../../../locales/pt/recovery.json'
import zh from '../../../locales/zh/recovery.json'

/** The motivating case: Electron close tests that fail only under the Playwright debugger. */
const CLOSE_TEST_OPTIONS: ResolutionOption[] = [
  { id: 'deterministic-close', kind: 'continue-with-guidance', label: 'Make the close tests deterministic', does: 'Launches Electron without the Playwright debugger in tests/desktop/menus.spec.ts and asserts only the exit code.',
    consequence: 'The run can deliver once the 3 close tests pass on every round.', risk: 'low', recommended: true, guidance: 'Launch Electron without --inspect in the close tests; assert only the exit code.' },
  { id: 'manual-close', kind: 'mark-human-check', label: 'Check closing by hand after delivery', does: 'Moves "Salir exits from main" and the 2 native close tests to manual checks.',
    consequence: 'The run can deliver; you verify closing the app by hand.', risk: 'medium', guidance: 'Salir exits from main; native close exits during an idle reload; native close exits after the idle renderer crashes' },
  { id: 'keep', kind: 'continue-with-guidance', label: 'Keep trying as is', does: 'Another round of corrections.', consequence: 'Likely the same stop, about $3-4 per attempt.', risk: 'high', guidance: '' },
  { id: 'spec', kind: 'edit-spec', label: 'Relax what closing must guarantee', does: 'Opens the spec.', consequence: 'You decide the exit requirement.', guidance: '' },
]

const actions = (patch: Partial<ResolutionActions> = {}): ResolutionActions => ({ choose: vi.fn(), instruct: vi.fn(), keepGoing: vi.fn(), busy: null, done: false, ...patch })

describe('resolution options model', () => {
  it('reads options defensively: unknown kinds dropped, at most four, one recommendation; an older analysis has none', () => {
    const raw = [...CLOSE_TEST_OPTIONS, { ...CLOSE_TEST_OPTIONS[0], id: 'x', kind: 'format-disk' }, { ...CLOSE_TEST_OPTIONS[0], id: 'fifth' }]
    const read = readResolutionOptions([{ ...CLOSE_TEST_OPTIONS[1], recommended: true, id: 'first' }, ...raw])
    expect(read.map((option) => option.id)).toEqual(['first', 'deterministic-close', 'manual-close', 'keep'])
    expect(read.filter((option) => option.recommended).map((option) => option.id)).toEqual(['first'])
    expect(readResolutionOptions(undefined)).toEqual([])
    expect(readResolutionOptions([{ id: 'no-label', kind: 'edit-spec' }])).toEqual([])
  })

  it('never shows two equivalent buttons: a plain continue option hides behind Continue, unless the run repeats', () => {
    expect(isPlainContinue(CLOSE_TEST_OPTIONS[2])).toBe(true)
    expect(visibleOptions(CLOSE_TEST_OPTIONS, false, null).map((option) => option.id)).toEqual(['deterministic-close', 'manual-close', 'spec'])
    expect(visibleOptions(CLOSE_TEST_OPTIONS, true, null).map((option) => option.id)).toEqual(['deterministic-close', 'manual-close', 'spec', 'keep'])
    const keepTrying = { ...CLOSE_TEST_OPTIONS[2], id: KEEP_TRYING_ID }
    expect(visibleOptions(CLOSE_TEST_OPTIONS.slice(0, 2), true, keepTrying).map((option) => option.id)).toEqual(['deterministic-close', 'manual-close', KEEP_TRYING_ID])
    expect(continueMode(false, true)).toBe('primary')
    expect(continueMode(true, false)).toBe('secondary')
    expect(continueMode(true, true)).toBe('hidden')
  })

  it('reads the chain\'s spend and repeat, and the cost of one attempt', () => {
    const chain = readChainResolution({ attempts: 5, costUsd: 15.06, costEstimated: false, repeated: true, times: 3 })!
    expect(chain).toEqual({ attempts: 5, costUsd: 15.06, costEstimated: false, repeated: true, times: 3 })
    expect(costPerAttempt(chain)).toBeCloseTo(3.012)
    expect(readChainResolution({ attempts: 0 })).toBeNull()
    expect(readChainResolution(null)).toBeNull()
  })

  it('has its copy in all eight locales', () => {
    for (const locale of [en, es, de, fr, it_, ja, pt, zh] as Array<Record<string, Record<string, unknown>>>) {
      expect(Object.keys(locale.resolution).sort()).toEqual(Object.keys(en.resolution).sort())
      expect(Object.keys(locale.repeat).sort()).toEqual(Object.keys(en.repeat).sort())
      expect(Object.keys(locale.flaky).sort()).toEqual(Object.keys(en.flaky).sort())
      expect(locale.remedyResult).toHaveProperty('continuingWith')
      expect(locale.remedyResult).toHaveProperty('continuingWithInstruction')
    }
    expect(es.resolution.title).toBe('Elige cómo seguir')
    expect(es.resolution.whatMayHappen).toBe('Qué puede pasar:')
  })
})

describe('ResolutionOptions', () => {
  it('shows each option with what it does, what may happen, its risk and the recommendation', () => {
    render(<ResolutionOptions options={CLOSE_TEST_OPTIONS.slice(0, 2)} actions={actions()} />)
    const [first, second] = screen.getAllByTestId('resolution-option')
    expect(first).toHaveTextContent('Make the close tests deterministic')
    expect(first).toHaveTextContent('Recommended')
    expect(first).toHaveTextContent('Low risk')
    expect(first).toHaveTextContent('What may happen: The run can deliver once the 3 close tests pass on every round.')
    expect(second).toHaveTextContent('Some risk')
    expect(second).not.toHaveAttribute('data-recommended')
    expect(first).toHaveAttribute('data-recommended')
  })

  it('one click continues with that option (the server reads its guidance); client kinds run their own action', () => {
    const run = actions(), editSpec = vi.fn()
    render(<ResolutionOptions options={CLOSE_TEST_OPTIONS} actions={run} handlers={{ 'edit-spec': { run: editSpec } }} />)
    fireEvent.click(screen.getByText('Make the close tests deterministic'))
    expect(run.choose).toHaveBeenCalledWith('deterministic-close', 'Make the close tests deterministic')
    fireEvent.click(screen.getByText('Relax what closing must guarantee'))
    expect(editSpec).toHaveBeenCalledTimes(1)
  })

  it('the added "keep trying" goes on as is', () => {
    const run = actions()
    render(<ResolutionOptions options={[{ ...CLOSE_TEST_OPTIONS[2], id: KEEP_TRYING_ID }]} actions={run} />)
    fireEvent.click(screen.getByText('Keep trying as is'))
    expect(run.keepGoing).toHaveBeenCalledWith('Keep trying as is')
    expect(run.choose).not.toHaveBeenCalled()
  })

  it('"Other instruction…" continues with the person\'s own words', () => {
    const run = actions()
    render(<ResolutionOptions options={CLOSE_TEST_OPTIONS.slice(0, 1)} actions={run} />)
    fireEvent.click(screen.getByTestId('resolution-other'))
    expect(screen.getByTestId('resolution-send')).toBeDisabled()
    fireEvent.change(screen.getByTestId('resolution-input'), { target: { value: '  Use a fake clock  ' } })
    fireEvent.click(screen.getByTestId('resolution-send'))
    expect(run.instruct).toHaveBeenCalledWith('Use a fake clock')
  })

  it('offers no Continue option where the surface cannot continue the run, and confirms the choice once sent', () => {
    const { rerender } = render(<ResolutionOptions options={CLOSE_TEST_OPTIONS} actions={null} handlers={{ 'edit-spec': { run: vi.fn() } }} />)
    expect(screen.getAllByTestId('resolution-option').map((item) => item.getAttribute('data-option-id'))).toEqual(['spec'])
    expect(screen.queryByTestId('resolution-other')).toBeNull()
    const run = actions()
    rerender(<ResolutionOptions options={CLOSE_TEST_OPTIONS} actions={run} />)
    fireEvent.click(screen.getByText('Check closing by hand after delivery'))
    rerender(<ResolutionOptions options={CLOSE_TEST_OPTIONS} actions={{ ...run, done: true }} />)
    expect(screen.getByTestId('resolution-sent')).toHaveTextContent('Continuing with: Check closing by hand after delivery')
  })
})
