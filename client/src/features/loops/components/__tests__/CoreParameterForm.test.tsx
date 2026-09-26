import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CoreParameterForm } from '../CoreParameterForm'
import type { ParameterSchema } from '../../lib/core-authoring'
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string }) => key + (values?.name ? ` ${values.name}` : ''),
  }),
}))
function Editor({ schema, initial }: { schema: ParameterSchema; initial: unknown }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <CoreParameterForm
        schema={schema}
        value={value}
        onChange={setValue}
        choices={{ roles: ['security-reviewer'], providers: ['claude', 'local'], components: ['review'] }}
      />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  )
}
const result = () => JSON.parse(screen.getByTestId('value').textContent!)
describe('Core parameter authoring', () => {
  it('edits required roles, optional scalar values and arrays without raw JSON', () => {
    render(
      <Editor
        schema={{
          type: 'object',
          required: ['roleId'],
          additionalProperties: false,
          properties: {
            roleId: { type: 'string' },
            concurrency: { type: 'integer', minimum: 1, maximum: 8 },
            argv: { type: 'array', items: { type: 'string' } },
          },
        }}
        initial={{ roleId: '' }}
      />,
    )
    fireEvent.change(screen.getByLabelText('roleId'), { target: { value: 'security-reviewer' } })
    fireEvent.click(screen.getByRole('button', { name: 'builder.core.addField concurrency' }))
    fireEvent.change(screen.getByLabelText('concurrency'), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'builder.core.addField argv' }))
    fireEvent.click(screen.getByRole('button', { name: 'builder.core.addItem' }))
    fireEvent.change(screen.getByLabelText('1'), { target: { value: 'npm' } })
    expect(result()).toEqual({ roleId: 'security-reviewer', concurrency: 4, argv: ['npm'] })
  })
  it('replaces mutually exclusive text with the native-command form', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        nativeCommand: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
          additionalProperties: false,
        },
      },
      oneOf: [{ required: ['text'] }, { required: ['nativeCommand'] }],
    }
    render(<Editor schema={schema} initial={{ text: 'Work' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'builder.core.addField nativeCommand' }))
    fireEvent.change(screen.getByLabelText('id'), { target: { value: 'implement' } })
    expect(result()).toEqual({ nativeCommand: { id: 'implement' } })
  })
  it('builds typed dictionary values and removes optional entries', () => {
    render(
      <Editor
        schema={{ type: 'object', additionalProperties: { type: 'number' } }}
        initial={{ security: 75 }}
      />,
    )
    fireEvent.change(screen.getByLabelText('builder.core.fieldName'), { target: { value: 'coverage' } })
    fireEvent.click(screen.getByRole('button', { name: 'builder.core.addField coverage' }))
    fireEvent.change(screen.getByLabelText('coverage'), { target: { value: '90' } })
    fireEvent.click(screen.getByRole('button', { name: 'builder.core.removeField security' }))
    expect(result()).toEqual({ coverage: 90 })
  })
  it('chooses a collection source or an output reference using schema alternatives', () => {
    render(
      <Editor
        schema={{
          oneOf: [
            { enum: ['tickets', 'repositories'] },
            {
              type: 'object',
              required: ['outputsOf'],
              properties: { outputsOf: { type: 'string' } },
              additionalProperties: false,
            },
          ],
        }}
        initial="tickets"
      />,
    )
    fireEvent.change(screen.getByLabelText('builder.core.variant params'), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText('outputsOf'), { target: { value: 'discover' } })
    expect(result()).toEqual({ outputsOf: 'discover' })
  })
})
