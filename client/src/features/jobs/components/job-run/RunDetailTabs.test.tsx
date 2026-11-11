import { useEffect, useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '../../../../test-utils'
import userEvent from '@testing-library/user-event'
import { RunDetailTabs, type RunDetailTabsProps } from './RunDetailTabs'
import { LogViewer } from '../LogViewer'
import { LoopStepExplorer } from '../../../loops/components/loop-log/LoopStepExplorer'
import type { EventRow, JobSummary } from '../../../../types'
import { openLogsAtFailure, readFailureDiagnosis } from '../../../recovery/lib/failure-diagnosis'

const job: JobSummary = { id: 'j', command: 'loop:l', status: 'running', started_at: null, finished_at: null, duration_ms: null, total_cost_usd: null, tokens_in: null, tokens_out: null, num_turns: null }
const diagnosis = readFailureDiagnosis({ kind: 'unknown', confidence: 'low', source: 'exit', phase: null, detail: null, resumablePhase: null, evidence: [] })!
function props(overrides: Partial<RunDetailTabsProps> = {}): RunDetailTabsProps {
  return { job, events: [], surface: 'page', diagnosis, showDiagnosis: false, onOpenLogs: vi.fn(), detailsContent: <p>Real metrics</p>, isLoop: true, graphContent: <p>Graph evidence</p>, logContent: <p>Raw evidence</p>, ...overrides }
}
const tab = (name: string) => screen.getByRole('tab', { name })
const event = (id: number, event_type: string, payload: unknown): EventRow => ({ id, job_id: 'j', seq: id, event_type, payload: JSON.stringify(payload), timestamp: '' })
const events = [event(1, 'loop_step', { index: 1, kind: 'ai-step', title: 'First step' }), event(2, 'log', { line: 'first output' }), event(3, 'loop_step_end', { index: 1, status: 'ok', exitCode: 0 }), event(4, 'loop_step', { index: 2, kind: 'ai-step', title: 'Second step' }), event(5, 'log', { line: 'second output' })]

beforeEach(() => { localStorage.clear() })

describe('RunDetailTabs', () => {
  it.each(['queued', 'running', 'completed', 'skipped', 'zombie_terminated', 'failed', 'canceled'] as const)('[spec:job-run-detail-navigation/failure-navigation-is-conditional-and-initially-selected] opens %s without an eligible diagnosis on Log', status => {
    render(<RunDetailTabs {...props({ job: { ...job, status }, diagnosis: null })} />)
    expect(screen.queryByRole('tab', { name: 'Failure reasons' })).not.toBeInTheDocument()
    expect(tab('Log')).toHaveAttribute('aria-selected', 'true')
  })

  it.each(['failed', 'canceled'] as const)('[spec:job-run-detail-navigation/failure-navigation-is-conditional-and-initially-selected] [spec:job-run-detail-navigation/failure-information-cannot-displace-navigation] selects eligible %s diagnosis and bounds expanded Details', status => {
    render(<RunDetailTabs {...props({ job: { ...job, status }, showDiagnosis: true })} />)
    expect(tab('Failure reasons')).toHaveAttribute('aria-selected', 'true')
    const panel = screen.getByRole('tabpanel', { name: 'Failure reasons' })
    expect(panel).toHaveClass('max-h-full', 'overflow-y-auto', 'min-h-0')
    expect(panel).toContainElement(screen.getByTestId('failure-diagnosis-card'))
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(panel).toContainElement(screen.getByText('Real metrics'))
    expect(panel).not.toContainElement(screen.getByRole('tablist', { name: 'Run detail' }))
  })

  it('[spec:job-run-detail-navigation/failure-navigation-is-conditional-and-initially-selected] makes question-only Failure reasons available without fabricating a diagnosis', () => {
    render(<RunDetailTabs {...props({ diagnosis: null, pendingQuestion: true })} />)
    expect(tab('Log')).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(tab('Failure reasons'))
    expect(screen.queryByTestId('failure-diagnosis-card')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('Real metrics')).toBeVisible()
  })

  it('[spec:job-run-detail-navigation/log-offers-graph-and-detail-navigation] suppresses graph controls for plain jobs and retains their Details access', () => {
    render(<RunDetailTabs {...props({ isLoop: false })} />)
    expect(screen.queryByRole('tab', { name: 'Execution graph' })).not.toBeInTheDocument()
    expect(screen.getByText('Raw evidence')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('Real metrics')).toBeVisible()
  })

  it('[spec:job-run-detail-navigation/both-navigation-levels-are-keyboard-accessible] supports both roving tablists with linked per-instance panels', async () => {
    const user = userEvent.setup()
    render(<RunDetailTabs {...props({ showDiagnosis: true })} />)
    tab('Failure reasons').focus()
    await user.keyboard('{ArrowRight}')
    expect(tab('Log')).toHaveFocus()
    expect(tab('Log')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel', { name: 'Log' })).toHaveAttribute('id', tab('Log').getAttribute('aria-controls'))
    await user.keyboard('{Home}')
    expect(tab('Failure reasons')).toHaveFocus()
    await user.keyboard('{End}')
    tab('Execution graph').focus()
    await user.keyboard('{ArrowLeft}')
    expect(tab('Log detail')).toHaveFocus()
    await user.keyboard('{Home}')
    expect(tab('Execution graph')).toHaveFocus()
    await user.keyboard('{End}')
    expect(tab('Log detail')).toHaveFocus()
  })

  it('lazily visits evidence, disconnects inactive effects and retains state', async () => {
    const connected = new Set<string>()
    const mounts = vi.fn()
    function Evidence({ name }: { name: string }) {
      useEffect(() => { mounts(name); connected.add(name); return () => { connected.delete(name) } }, [name])
      return <input aria-label={name} defaultValue="" />
    }
    render(<RunDetailTabs {...props({ graphContent: <Evidence name="graph" />, logContent: <Evidence name="detail" /> })} />)
    expect(mounts).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByRole('textbox', { name: 'graph' }), { target: { value: 'explored' } })
    fireEvent.click(tab('Log detail'))
    expect(screen.queryByRole('textbox', { name: 'graph' })).not.toBeInTheDocument()
    expect(connected).toEqual(new Set(['detail']))
    fireEvent.click(tab('Execution graph'))
    expect(screen.getByRole('textbox', { name: 'graph' })).toHaveValue('explored')
    expect(connected).toEqual(new Set(['graph']))
  })

  it('[spec:job-run-detail-navigation/log-offers-graph-and-detail-navigation] preserves real graph expansion/filter/manual mode and paused real log scroll/filter', async () => {
    const user = userEvent.setup()
    render(<RunDetailTabs {...props({ graphContent: <LoopStepExplorer events={events} jobStatus="running" />, logContent: <LogViewer events={events} /> })} />)
    await user.click(within(screen.getAllByTestId('loop-step-section')[0]).getByText('First step'))
    expect(screen.getByTestId('resume-follow-pill')).toBeVisible()
    const graphScroll = screen.getByRole('tabpanel', { name: 'Execution graph' }).querySelector('.overflow-y-auto') as HTMLElement
    Object.defineProperties(graphScroll, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 100 } })
    graphScroll.scrollTop = 150
    fireEvent.scroll(graphScroll)
    await user.type(screen.getByRole('textbox'), 'first')
    await user.click(tab('Log detail'))
    const input = screen.getByRole('textbox')
    await user.type(input, 'second')
    const logPanel = screen.getByRole('tabpanel', { name: 'Log detail' })
    const scroll = logPanel.querySelector('.overflow-y-auto') as HTMLElement
    Object.defineProperties(scroll, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 100 } })
    scroll.scrollTop = 120
    fireEvent.scroll(scroll)
    await user.click(tab('Execution graph'))
    expect(screen.getByRole('textbox')).toHaveValue('first')
    expect(graphScroll.scrollTop).toBe(150)
    expect(screen.getByText('first output')).toBeVisible()
    await user.clear(screen.getByRole('textbox'))
    expect(screen.getByTestId('resume-follow-pill')).toBeVisible()
    await user.click(tab('Log detail'))
    expect(screen.getByRole('textbox')).toHaveValue('second')
    expect(scroll.scrollTop).toBe(120)
  })

  it('reconnects following real log effects after receiving events while hidden', async () => {
    const initial = props({ logContent: <LogViewer events={events} /> })
    const view = render(<RunDetailTabs {...initial} />)
    fireEvent.click(tab('Log detail'))
    const scroll = screen.getByRole('tabpanel', { name: 'Log detail' }).querySelector('.overflow-y-auto') as HTMLElement
    Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 1000 })
    fireEvent.click(tab('Execution graph'))
    view.rerender(<RunDetailTabs {...initial} logContent={<LogViewer events={[...events, event(6, 'log', { line: 'new output' })]} />} />)
    scroll.scrollTop = 0
    fireEvent.click(tab('Log detail'))
    expect(scroll.scrollTop).toBe(1000)
  })
  it('[spec:job-run-detail-navigation/view-preferences-preserve-surface-independence] restores independent section and Details choices, but resets top-level selection on visits', () => {
    const p = props({ showDiagnosis: true })
    const first = render(<RunDetailTabs {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    fireEvent.click(tab('Log'))
    fireEvent.click(tab('Log detail'))
    first.unmount()
    const modal = render(<RunDetailTabs {...p} surface="modal" />)
    expect(tab('Failure reasons')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'Details' })).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(tab('Log'))
    expect(tab('Execution graph')).toHaveAttribute('aria-selected', 'true')
    modal.unmount()
    const second = render(<RunDetailTabs {...p} />)
    expect(tab('Failure reasons')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'Details' })).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(tab('Log'))
    expect(tab('Log detail')).toHaveAttribute('aria-selected', 'true')
    second.unmount()
  })

  it('does not overwrite a loop preference when rendering plain-job detail', () => {
    const plain = render(<RunDetailTabs {...props({ isLoop: false })} />)
    expect(screen.getByText('Raw evidence')).toBeVisible()
    plain.unmount()
    render(<RunDetailTabs {...props()} />)
    expect(tab('Execution graph')).toHaveAttribute('aria-selected', 'true')
  })

  it('[spec:job-run-detail-navigation/live-diagnosis-respects-explicit-user-selection] selects late diagnosis once without stealing focus, and removes ineligible failure', () => {
    const p = props()
    const view = render(<RunDetailTabs {...p} />)
    tab('Log').focus()
    view.rerender(<RunDetailTabs {...p} job={{ ...job, status: 'failed' }} />)
    expect(tab('Log')).toHaveAttribute('aria-selected', 'true')
    view.rerender(<RunDetailTabs {...p} showDiagnosis />)
    expect(tab('Failure reasons')).toHaveAttribute('aria-selected', 'true')
    expect(tab('Log')).toHaveFocus()
    fireEvent.click(tab('Log'))
    view.rerender(<RunDetailTabs {...p} />)
    view.rerender(<RunDetailTabs {...p} showDiagnosis />)
    expect(tab('Log')).toHaveAttribute('aria-selected', 'true')
    view.rerender(<RunDetailTabs {...p} />)
    expect(screen.queryByRole('tab', { name: 'Failure reasons' })).not.toBeInTheDocument()
  })

  it('counts choosing already-active Log as explicit and resets intent on job replacement', () => {
    const p = props()
    const view = render(<RunDetailTabs {...p} />)
    fireEvent.click(tab('Log'))
    view.rerender(<RunDetailTabs {...p} showDiagnosis />)
    expect(tab('Log')).toHaveAttribute('aria-selected', 'true')
    view.rerender(<RunDetailTabs {...p} job={{ ...job, id: 'another' }} showDiagnosis />)
    expect(tab('Failure reasons')).toHaveAttribute('aria-selected', 'true')
  })

  it('[spec:job-run-detail-navigation/pending-questions-reveal-the-answer-form] honors repeated question requests and keeps drafts and errors through navigation and settlement', () => {
    const p = props({ pendingQuestion: true, diagnosis: null, detailsContent: <><input aria-label="Answer" defaultValue="draft" /><p role="alert">Answer failed</p></> })
    const view = render(<RunDetailTabs {...p} detailsRequest={0} />)
    view.rerender(<RunDetailTabs {...p} detailsRequest={1} />)
    expect(tab('Failure reasons')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('textbox', { name: 'Answer' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    view.rerender(<RunDetailTabs {...p} detailsRequest={2} />)
    expect(screen.getByRole('textbox', { name: 'Answer' })).toBeVisible()
    fireEvent.change(screen.getByRole('textbox', { name: 'Answer' }), { target: { value: 'edited' } })
    fireEvent.click(tab('Log'))
    fireEvent.click(tab('Failure reasons'))
    expect(screen.getByRole('textbox', { name: 'Answer' })).toHaveValue('edited')
    expect(screen.getByRole('alert')).toHaveTextContent('Answer failed')
    view.rerender(<RunDetailTabs {...p} pendingQuestion={false} detailsRequest={2} />)
    expect(screen.queryByRole('tab', { name: 'Failure reasons' })).not.toBeInTheDocument()
    expect(tab('Log')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'Details' })).toHaveAttribute('aria-expanded', 'true')
  })

  it.each([true, false])('[spec:job-run-detail-navigation/remedies-reveal-evidence-before-navigating-to-it] reveals evidence before dispatching an open-logs remedy (loop=%s)', isLoop => {
    const callbacks = new Map<number, FrameRequestCallback>()
    let next = 0
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callbacks.set(++next, callback); return next })
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { callbacks.delete(id) })
    const opened = vi.fn(() => {
      expect(screen.getByText(isLoop ? 'Graph evidence' : 'Raw evidence')).toBeVisible()
      expect(tab('Log')).toHaveAttribute('aria-selected', 'true')
    })
    const p = props({ showDiagnosis: true, isLoop, onOpenLogs: opened })
    const view = render(<RunDetailTabs {...p} />)
    const remedy = screen.getByTestId('failure-remedy-open-logs')
    act(() => { fireEvent.click(remedy); fireEvent.click(remedy) })
    expect(callbacks.size).toBe(1)
    expect(opened).not.toHaveBeenCalled()
    act(() => { callbacks.forEach(callback => callback(0)); callbacks.clear() })
    expect(opened).toHaveBeenCalledTimes(1)
    fireEvent.click(tab('Failure reasons'))
    fireEvent.click(screen.getByTestId('failure-remedy-open-logs'))
    view.rerender(<RunDetailTabs {...p} job={{ ...job, id: 'replacement' }} />)
    act(() => { callbacks.forEach(callback => callback(0)); callbacks.clear() })
    expect(opened).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('failure-remedy-open-logs'))
    view.unmount()
    act(() => { callbacks.forEach(callback => callback(0)); callbacks.clear() })
    expect(opened).toHaveBeenCalledTimes(1)
    raf.mockRestore()
    cancel.mockRestore()
  })

  it('keeps simultaneous page and modal structure equivalent, IDs distinct and remedy navigation scoped', async () => {
    function Surface({ surface }: { surface: 'page' | 'modal' }) {
      const root = useRef<HTMLDivElement>(null)
      return <div ref={root} data-testid={surface}>
        <RunDetailTabs {...props({ showDiagnosis: true, surface, graphContent: <LoopStepExplorer events={events} jobStatus="failed" />, logContent: <LogViewer events={events} />, onOpenLogs: () => { openLogsAtFailure(root.current?.querySelector('[data-run-evidence][data-active="true"]') ?? null) } })} />
      </div>
    }
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
    render(<><Surface surface="page" /><Surface surface="modal" /></>)
    const page = screen.getByTestId('page')
    const modal = screen.getByTestId('modal')
    const pageTabs = within(page).getAllByRole('tab')
    const modalTabs = within(modal).getAllByRole('tab')
    expect(pageTabs.map(node => node.textContent)).toEqual(modalTabs.map(node => node.textContent))
    expect(new Set([...pageTabs, ...modalTabs].map(node => node.id)).size).toBe(4)
    expect(within(page).getByTestId('failure-headline').textContent).toBe(within(modal).getByTestId('failure-headline').textContent)
    fireEvent.click(within(modal).getByRole('tab', { name: 'Log' }))
    fireEvent.click(within(page).getByTestId('failure-remedy-open-logs'))
    await vi.waitFor(() => expect(scroll).toHaveBeenCalled())
    expect(page).toContainElement(scroll.mock.instances[0] as HTMLElement)
    expect(modal).not.toContainElement(scroll.mock.instances[0] as HTMLElement)
    fireEvent.click(within(page).getByRole('tab', { name: 'Failure reasons' }))
    fireEvent.click(within(page).getByRole('button', { name: 'Details' }))
    const panel = within(page).getByRole('tabpanel', { name: 'Failure reasons' })
    expect(panel).toContainElement(within(page).getByText('Real metrics'))
    expect(panel).not.toContainElement(within(page).getByRole('tablist', { name: 'Run detail' }))
    scroll.mockRestore()
  })

  it('keeps session choices usable when storage is denied', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    try {
      render(<RunDetailTabs {...props()} />)
      fireEvent.click(tab('Log detail'))
      expect(screen.getByText('Raw evidence')).toBeVisible()
      fireEvent.click(screen.getByRole('button', { name: 'Details' }))
      expect(screen.getByText('Real metrics')).toBeVisible()
    } finally {
      read.mockRestore()
      write.mockRestore()
    }
  })

})
