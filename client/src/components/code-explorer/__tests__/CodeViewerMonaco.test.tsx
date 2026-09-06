import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CodeViewerMonaco } from '../CodeViewerMonaco'

const mocks = vi.hoisted(() => {
  const model = { getLineCount: vi.fn(() => 5), getLineMaxColumn: vi.fn(() => 12), dispose: vi.fn() }
  const run = vi.fn()
  const editor = {
    getModel: vi.fn(() => model), getValue: vi.fn(() => 'source'), setValue: vi.fn(),
    setSelection: vi.fn(), revealLineInCenter: vi.fn(), focus: vi.fn(),
    updateOptions: vi.fn(), getAction: vi.fn(() => ({ run })), dispose: vi.fn(),
  }
  return { editor, model, run, create: vi.fn((_element: unknown, _options: unknown) => editor), setModelLanguage: vi.fn(), setTheme: vi.fn() }
})
vi.mock('monaco-editor', () => ({ editor: { create: mocks.create, setModelLanguage: mocks.setModelLanguage, setTheme: mocks.setTheme } }))
vi.mock('../../../context/ThemeContext', () => ({ useActiveTheme: () => 'dark' }))
vi.mock('../../../lib/monaco-setup', () => ({ ensureMonacoEnvironment: vi.fn(), defineMonacoThemeFor: () => 'fixture' }))

beforeEach(() => vi.clearAllMocks())

describe('CodeViewerMonaco reader', () => {
  it('enforces read-only source and reveals requested lines without stealing focus', async () => {
    const { rerender, unmount } = render(<CodeViewerMonaco content="source" language="typescript" initialLine={3} />)
    await waitFor(() => expect(mocks.create).toHaveBeenCalled())
    expect(mocks.create.mock.calls[0][1]).toMatchObject({ value: 'source', language: 'typescript', readOnly: true, domReadOnly: true })
    expect(mocks.editor.revealLineInCenter).toHaveBeenLastCalledWith(3)
    expect(mocks.editor.focus).not.toHaveBeenCalled()
    rerender(<CodeViewerMonaco content="new source" language="javascript" initialLine={4} />)
    expect(mocks.editor.setValue).toHaveBeenCalledWith('new source')
    expect(mocks.setModelLanguage).toHaveBeenCalledWith(mocks.model, 'javascript')
    expect(mocks.editor.revealLineInCenter).toHaveBeenLastCalledWith(4)
    unmount()
    expect(mocks.editor.dispose).toHaveBeenCalledTimes(1)
    expect(mocks.model.dispose).toHaveBeenCalledTimes(1)
  })

  it('searches, wraps and clamps explicit line navigation to the actual source', async () => {
    render(<CodeViewerMonaco content="source" language="typescript" />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Find in file' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Find in file' }))
    expect(mocks.editor.getAction).toHaveBeenCalledWith('actions.find')
    expect(mocks.run).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Wrap lines' }))
    expect(mocks.editor.updateOptions).toHaveBeenLastCalledWith({ wordWrap: 'on' })
    expect(screen.getByRole('button', { name: 'Wrap lines' })).toHaveAttribute('aria-pressed', 'true')
    const line = screen.getByRole('spinbutton', { name: 'Line number' })
    expect(screen.getByRole('button', { name: 'Go' })).toBeDisabled()
    fireEvent.change(line, { target: { value: '999' } })
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(mocks.editor.revealLineInCenter).toHaveBeenLastCalledWith(5)
    expect(mocks.editor.setSelection).toHaveBeenLastCalledWith({ startLineNumber: 5, startColumn: 1, endLineNumber: 5, endColumn: 12 })
    expect(mocks.editor.focus).toHaveBeenCalledOnce()
    fireEvent.change(line, { target: { value: '-1' } })
    expect(screen.getByRole('button', { name: 'Go' })).toBeDisabled()
  })

  it('retries a failed editor initialization without reloading the application', async () => {
    mocks.create.mockImplementationOnce(() => { throw new Error('Temporary worker initialization failure') })
    render(<CodeViewerMonaco content="source" language="typescript" />)
    await screen.findByTestId('monaco-load-error')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Find in file' })).toBeEnabled())
    expect(mocks.create).toHaveBeenCalledTimes(2)
  })
})
