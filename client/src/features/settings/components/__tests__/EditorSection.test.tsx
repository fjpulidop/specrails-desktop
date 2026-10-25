import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { EditorSection } from '../EditorSection'
import { getEditorPref } from '../../../../lib/open-in-editor'

beforeEach(() => { localStorage.clear() })

describe('EditorSection', () => {
  it('defaults to VS Code and persists the chosen editor', () => {
    render(<EditorSection />)
    const trigger = screen.getByTestId('editor-choice')
    expect(trigger).toHaveTextContent('VS Code')
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    fireEvent.click(screen.getByRole('option', { name: 'Cursor' }))
    expect(getEditorPref()).toBe('cursor')
    expect(screen.getByTestId('editor-choice')).toHaveTextContent('Cursor')
  })
})
