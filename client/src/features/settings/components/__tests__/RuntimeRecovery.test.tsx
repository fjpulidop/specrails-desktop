import { expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '../../../../test-utils'
import { RuntimeRecovery, recoveryNeedsChoice } from '../RuntimeRecovery'
import type { RuntimeRun } from '../../lib/agent-runtime'

const base: RuntimeRun = { runId: 'r', engineVersion: 2, status: 'interrupted', nextStep: 'developer', active: false, canResume: true, canCancel: true, recoverableSteps: [] }

it('one interrupted attempt is one primary Continue that recovers exactly it, with its consequence and no raw ids', async () => {
  const user = userEvent.setup(), recover = vi.fn()
  const run: RuntimeRun = { ...base, recoverableSteps: ['a3e7afe4-3510-4a54-be11-9858ef5c4c12'], recoveryAttempts: [{ attemptId: 'a3e7afe4-3510-4a54-be11-9858ef5c4c12', nodePath: 'developer', scopeId: 'root', effect: 'write' }] }
  const view = render(<RuntimeRecovery run={run} busy={false} onRecover={recover} />)
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.getByTestId('runtime-recovery-consequence')).toHaveTextContent('The Developer step resumes where it stopped; its partial changes are kept.')
  expect(view.container.textContent).not.toMatch(/a3e7afe4|root/)
  await user.click(screen.getByRole('button', { name: 'Continue' }))
  expect(recover).toHaveBeenCalledWith(['a3e7afe4-3510-4a54-be11-9858ef5c4c12'])
})

it('branches of the same step are still one Continue for all of them', async () => {
  const user = userEvent.setup(), recover = vi.fn()
  const run: RuntimeRun = { ...base, recoverableSteps: ['first', 'second'], recoveryAttempts: [{ attemptId: 'first', nodePath: 'developer', scopeId: 'left' }, { attemptId: 'second', nodePath: 'developer', scopeId: 'right' }] }
  render(<RuntimeRecovery run={run} busy={false} onRecover={recover} />)
  expect(screen.queryByRole('checkbox')).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Continue' }))
  expect(recover).toHaveBeenCalledWith(['first', 'second'])
})

it('a real choice (steps of different roles) lists them by role name, all chosen, and drops attempts a fresh status removed', async () => {
  const user = userEvent.setup(), recover = vi.fn()
  const run: RuntimeRun = { ...base, recoverableSteps: ['first', 'second', 'third'], recoveryAttempts: [
    { attemptId: 'first', nodePath: 'developer', scopeId: 'left' }, { attemptId: 'second', nodePath: 'developer', scopeId: 'right' }, { attemptId: 'third', nodePath: 'fixer', scopeId: 'root' }] }
  const view = render(<RuntimeRecovery run={run} busy={false} onRecover={recover} />)
  expect(screen.getByText('Choose which interrupted steps to continue')).toBeInTheDocument()
  expect(screen.getByRole('checkbox', { name: 'Developer · branch 1' })).toBeChecked()
  expect(screen.getByRole('checkbox', { name: 'Developer · branch 2' })).toBeChecked()
  expect(screen.getByRole('checkbox', { name: 'Fixer' })).toBeChecked()
  expect(view.container.textContent).not.toMatch(/first|second|third|left|right|root/)
  await user.click(screen.getByRole('checkbox', { name: 'Fixer' }))
  await user.click(screen.getByRole('button', { name: 'Continue' }))
  expect(recover).toHaveBeenCalledWith(['first', 'second'])
  view.rerender(<RuntimeRecovery run={{ ...run, recoverableSteps: ['third'] }} busy={false} onRecover={recover} />)
  // Only one attempt left: back to the single Continue.
  expect(screen.queryByRole('checkbox')).toBeNull()
})

it('an attempt Core does not mark as a workspace write is the person\'s call', () => {
  expect(recoveryNeedsChoice([{ attemptId: 'a', nodePath: 'publish', scopeId: 'root', effect: 'external' }])).toBe(true)
  expect(recoveryNeedsChoice([{ attemptId: 'a', nodePath: 'developer', scopeId: 'root', effect: 'write' }])).toBe(false)
})
