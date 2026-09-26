import { expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '../../../../test-utils'
import { RuntimeRecovery } from '../RuntimeRecovery'
import type { RuntimeRun } from '../../lib/agent-runtime'

it('selects exact attempts in different scopes and drops attempts removed by a fresh status', async () => {
  const user = userEvent.setup(), recover = vi.fn()
  const run: RuntimeRun = { runId: 'r', engineVersion: 2, status: 'paused', nextStep: 'write', active: false, canResume: true, canCancel: false,
    recoverableSteps: ['first', 'second'], recoveryAttempts: [{ attemptId: 'first', nodePath: 'write', scopeId: 'left' }, { attemptId: 'second', nodePath: 'write', scopeId: 'right' }] }
  const view = render(<RuntimeRecovery run={run} busy={false} onRecover={recover} />)
  expect(screen.getByRole('button', { name: 'Recover interrupted phase' })).toBeDisabled()
  await user.click(screen.getByRole('checkbox', { name: 'write · right · second' }))
  await user.click(screen.getByRole('button', { name: 'Recover interrupted phase' }))
  expect(recover).toHaveBeenCalledWith(['second'])
  view.rerender(<RuntimeRecovery run={{ ...run, recoverableSteps: ['first'] }} busy={false} onRecover={recover} />)
  expect(screen.getByRole('button', { name: 'Recover interrupted phase' })).toBeDisabled()
})
