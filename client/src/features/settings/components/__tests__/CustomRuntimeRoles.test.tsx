import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, within } from '../../../../test-utils'
import { CustomRuntimeRoles } from '../CustomRuntimeRoles'
import type { RuntimeRoleDescriptor } from '../../lib/agent-runtime'
function Harness({ supported = true }: { supported?: boolean }) {
  const [roles, setRoles] = useState<Record<string, RuntimeRoleDescriptor>>({})
  return <><CustomRuntimeRoles roles={roles} provider="claude" supported={supported} onChange={setRoles} renderEngine={id => <span>{id} engine</span>} /><output data-testid="roles">{JSON.stringify(roles)}</output></>
}
describe('custom runtime roles', () => {
  it('creates conservative permissions and edits prompt and artifact access independently', async () => {
    const user = userEvent.setup(); render(<Harness />)
    await user.type(screen.getByLabelText('Role ID'), 'auditor')
    await user.click(screen.getByRole('button', { name: 'Add role' }))
    const row = within(screen.getByRole('group', { name: 'auditor' }))
    expect(row.getByLabelText('Source access')).toHaveValue('read')
    expect(row.getByLabelText('OpenSpec artifact access')).toHaveValue('none')
    await user.selectOptions(row.getByLabelText('OpenSpec artifact access'), 'all')
    await user.type(row.getByLabelText('Role instructions'), 'Inspect evidence first.')
    expect(JSON.parse(screen.getByTestId('roles').textContent!)).toMatchObject({ auditor: { provider: 'claude', access: 'read', artifacts: 'all', prompt: 'Inspect evidence first.' } })
    await user.click(row.getByRole('button', { name: 'Remove auditor' }))
    expect(screen.getByTestId('roles')).toHaveTextContent('{}')
  })
  it('rejects built-in and duplicate IDs without changing saved roles', async () => {
    const user = userEvent.setup(); render(<Harness />)
    await user.type(screen.getByLabelText('Role ID'), 'reviewer'); await user.click(screen.getByRole('button', { name: 'Add role' }))
    expect(screen.getByRole('alert')).toBeInTheDocument(); expect(screen.getByTestId('roles')).toHaveTextContent('{}')
    await user.clear(screen.getByLabelText('Role ID')); await user.type(screen.getByLabelText('Role ID'), 'audit'); await user.click(screen.getByRole('button', { name: 'Add role' }))
    await user.type(screen.getByLabelText('Role ID'), 'audit'); await user.click(screen.getByRole('button', { name: 'Add role' }))
    expect(screen.getAllByRole('group', { name: 'audit' })).toHaveLength(1); expect(screen.getByRole('alert')).toBeInTheDocument()
  })
  it('gates new roles when the paired Core does not advertise open roles', () => {
    render(<Harness supported={false} />)
    expect(screen.getByRole('button', { name: 'Add role' })).toBeDisabled()
    expect(screen.getByText('Update Core to edit custom roles.')).toBeInTheDocument()
  })
})
