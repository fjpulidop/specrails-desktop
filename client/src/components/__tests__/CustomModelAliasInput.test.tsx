import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CustomModelAliasInput } from '../CustomModelAliasInput'

describe('CustomModelAliasInput', () => {
  const options = [
    { value: 'k3', label: 'Kimi K3' },
    { value: 'kimi-for-coding', label: 'Kimi for Coding' },
  ]

  it('commits a safe provider alias exactly without trimming or normalising it', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(
      <CustomModelAliasInput
        value="k3"
        options={options}
        onCommit={onCommit}
        ariaLabel="Model"
      />,
    )

    const input = screen.getByRole('combobox', { name: 'Model' })
    await user.clear(input)
    await user.type(input, 'Moonshot-Team/Private_Coder:v2')
    fireEvent.blur(input)

    expect(onCommit).toHaveBeenCalledOnce()
    expect(onCommit).toHaveBeenCalledWith('Moonshot-Team/Private_Coder:v2')
  })

  it.each(['--yolo', 'moonshot team/model'])(
    'rejects %j and restores the last committed value',
    (unsafeAlias) => {
      const onCommit = vi.fn()
      render(
        <CustomModelAliasInput
          value="k3"
          options={options}
          onCommit={onCommit}
          ariaLabel="Model"
        />,
      )

      const input = screen.getByRole('combobox', { name: 'Model' })
      fireEvent.change(input, { target: { value: unsafeAlias } })
      expect(input).toHaveAttribute('aria-invalid', 'true')
      fireEvent.blur(input)

      expect(onCommit).not.toHaveBeenCalled()
      expect(input).toHaveValue('k3')
    },
  )

  it('commits on Enter and cancels on Escape', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(
      <CustomModelAliasInput
        value="k3"
        options={options}
        onCommit={onCommit}
        ariaLabel="Model"
      />,
    )

    const input = screen.getByRole('combobox', { name: 'Model' })
    await user.clear(input)
    await user.type(input, 'moonshot/private{enter}')
    expect(onCommit).toHaveBeenCalledWith('moonshot/private')

    await user.clear(input)
    await user.type(input, 'moonshot/other{escape}')
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(input).toHaveValue('k3')
  })
})
