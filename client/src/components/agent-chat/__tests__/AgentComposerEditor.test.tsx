import { createRef, useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AgentComposerEditor, type AgentComposerEditorHandle, type AgentInlineReference } from '../AgentComposerEditor'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, values?: { label?: string }) => `${key} ${values?.label ?? ''}` }),
}))

const spec = { kind: 'spec' as const, id: '1', token: '#1', label: 'Runnable project foundation', status: 'todo', projectId: 'p1' }
const reference = (start: number, key = 'spec-1'): AgentInlineReference => ({ key, start, end: start + spec.token.length, chip: spec })

function mount(value = 'implementemos el #1 después', references = [reference(17)]) {
  const ref = createRef<AgentComposerEditorHandle>()
  const onChange = vi.fn()
  const onSelect = vi.fn()
  const onKeyDown = vi.fn()
  const onPaste = vi.fn()
  function Harness() {
    const [state, setState] = useState({ value, references })
    return <AgentComposerEditor ref={ref} {...state} placeholder="Write a message" onChange={(next, nextReferences, selection) => {
      onChange(next, nextReferences, selection)
      setState({ value: next, references: nextReferences })
    }} onSelect={onSelect} onKeyDown={onKeyDown} onPaste={onPaste} />
  }
  render(<Harness />)
  const box = screen.getByRole('textbox', { name: 'Write a message' })
  ref.current!.focus()
  return { box, ref, onChange, onSelect, onKeyDown, onPaste }
}

describe('AgentComposerEditor', () => {
  it('renders pills between the text on either side and serializes their tokens only', () => {
    const { box, ref } = mount()
    expect(box.childNodes[0].textContent?.replace(/\u200b/g, '')).toBe('implementemos el ')
    expect(box.childNodes[1]).toHaveAttribute('data-inline-reference', 'spec-1')
    expect(box.childNodes[2].textContent?.replace(/\u200b/g, '')).toBe(' después')
    expect(box.childNodes[1]).toHaveAttribute('contenteditable', 'false')
    expect(ref.current!.value).toBe('implementemos el #1 después')
    expect(ref.current!.value).not.toContain(spec.label)
  })

  it('keeps native text nodes and cursor when a keystroke shifts a following reference', () => {
    const { box, ref, onChange } = mount()
    const text = box.firstChild as Text
    text.insertData(0, 'Ahora ')
    ref.current!.setSelectionRange(6, 6)
    fireEvent.input(box)
    expect(onChange).toHaveBeenLastCalledWith('Ahora implementemos el #1 después', [reference(23)], 6)
    expect(box.firstChild).toBe(text)
    expect(ref.current!.selectionStart).toBe(6)
  })

  it('maps selections across text and atomic references using serialized offsets', () => {
    const { ref } = mount()
    for (const offset of [0, 4, 17, 19, 24]) {
      ref.current!.setSelectionRange(offset, offset)
      expect(ref.current!.selectionStart).toBe(offset)
      expect(ref.current!.selectionEnd).toBe(offset)
    }
    ref.current!.setSelectionRange(3, 22)
    expect(ref.current!.selectionStart).toBe(3)
    expect(ref.current!.selectionEnd).toBe(22)
  })

  it('removes only the clicked occurrence of a repeated reference and moves the caret there', () => {
    const { box, ref, onChange } = mount('#1 y #1', [reference(0, 'first'), reference(5, 'second')])
    fireEvent.mouseDown(box.querySelector('[data-remove-reference="second"]')!)
    fireEvent.click(box.querySelector('[data-remove-reference="second"]')!)
    expect(onChange).toHaveBeenLastCalledWith('#1 y ', [reference(0, 'first')], 5)
    expect(ref.current!.selectionStart).toBe(5)
    expect(box.querySelectorAll('[data-inline-reference]')).toHaveLength(1)
  })

  it.each([['Backspace', 19], ['Delete', 17]])('deletes an adjacent reference atomically with %s', (key, offset) => {
    const { box, ref, onChange } = mount()
    ref.current!.setSelectionRange(Number(offset), Number(offset))
    fireEvent.keyDown(box, { key })
    expect(onChange).toHaveBeenLastCalledWith('implementemos el  después', [], 17)
    expect(box.querySelector('[data-inline-reference]')).toBeNull()
  })

  it('copies the selected token and surrounding text without its title or remove label', () => {
    const { box, ref } = mount()
    ref.current!.setSelectionRange(0, 19)
    const setData = vi.fn()
    fireEvent.copy(box, { clipboardData: { setData } })
    expect(setData).toHaveBeenCalledWith('text/plain', 'implementemos el #1')
  })

  it('cuts a selection through a pill and updates remaining anchors', () => {
    const { box, ref, onChange } = mount('#1 y #1', [reference(0, 'first'), reference(5, 'second')])
    ref.current!.setSelectionRange(0, 5)
    fireEvent.cut(box, { clipboardData: { setData: vi.fn() } })
    expect(onChange).toHaveBeenLastCalledWith('#1', [reference(0, 'second')], 0)
  })

  it('pastes plain multiline text at the caret without accepting clipboard HTML', () => {
    const { box, ref, onChange } = mount()
    ref.current!.setSelectionRange(19, 19)
    const getData = vi.fn((type: string) => type === 'text/plain' ? ' listo\r\n<script>x</script>' : '<img src="x" onerror="alert(1)">')
    fireEvent.paste(box, { clipboardData: { getData } })
    expect(onChange.mock.lastCall?.[0]).toBe('implementemos el #1 listo\n<script>x</script> después')
    expect(box.querySelector('img,script')).toBeNull()
    expect(ref.current!.selectionStart).toBe(44)
  })

  it('lets the attachment paste handler consume clipboard data', () => {
    const { box, ref, onPaste, onChange } = mount()
    onPaste.mockImplementation((event) => event.preventDefault())
    ref.current!.setSelectionRange(19, 19)
    fireEvent.paste(box, { clipboardData: { getData: vi.fn(() => 'image') } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('waits until composition ends and does not submit IME confirmation Enter', () => {
    const { box, ref, onChange, onKeyDown } = mount('Hola ', [])
    fireEvent.compositionStart(box)
    box.firstChild!.textContent += '世界'
    ref.current!.setSelectionRange(7, 7)
    fireEvent.input(box)
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
    expect(onChange).not.toHaveBeenCalled()
    expect(onKeyDown).not.toHaveBeenCalled()
    fireEvent.compositionEnd(box)
    expect(onChange).toHaveBeenLastCalledWith('Hola 世界', [], 7)
  })

  it('preserves literal newlines and reads native editable blocks as multiline text', () => {
    const { box, ref, onChange } = mount('first\nsecond', [])
    expect(ref.current!.value).toBe('first\nsecond')
    box.innerHTML = '<div>first</div><div>second</div><div><br></div>'
    ref.current!.setSelectionRange(13, 13)
    fireEvent.input(box)
    expect(onChange.mock.lastCall?.[0]).toBe('first\nsecond\n')
  })

  it('preserves consecutive blank lines generated as empty editable blocks', () => {
    const { box, ref, onChange } = mount('#1', [reference(0)])
    const emptyLine = document.createElement('div')
    emptyLine.append(document.createElement('br'))
    const lastLine = document.createElement('div')
    lastLine.textContent = 'fin'
    box.append(emptyLine, lastLine)
    ref.current!.setSelectionRange(7, 7)
    fireEvent.input(box)
    expect(onChange).toHaveBeenLastCalledWith('#1\n\nfin', [reference(0)], 7)
  })

  it('inserts a newline for Shift+Enter when the parent does not consume it', () => {
    const { box, ref, onChange } = mount('Hola mundo', [])
    ref.current!.setSelectionRange(4, 4)
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(onChange).toHaveBeenLastCalledWith('Hola\n mundo', [], 5)
  })

  it('restores reference metadata when native undo brings a previously removed pill back', () => {
    const { box, ref, onChange } = mount()
    const savedPill = box.querySelector('[data-inline-reference]')!.cloneNode(true)
    ref.current!.setSelectionRange(19, 19)
    fireEvent.keyDown(box, { key: 'Backspace' })
    const range = document.createRange()
    range.setStart(box.firstChild!, 17)
    range.collapse(true)
    range.insertNode(savedPill)
    ref.current!.setSelectionRange(19, 19)
    fireEvent.input(box, { inputType: 'historyUndo' })
    expect(onChange).toHaveBeenLastCalledWith('implementemos el #1 después', [reference(17)], 17)
    expect(ref.current!.selectionEnd).toBe(19)
  })

  it('applies external text/references without moving them to the start', () => {
    const ref = createRef<AgentComposerEditorHandle>()
    const props = { ref, placeholder: 'Message', onChange: vi.fn(), onSelect: vi.fn(), onKeyDown: vi.fn(), onPaste: vi.fn() }
    const { rerender } = render(<AgentComposerEditor {...props} value="implementemos el #" references={[]} />)
    ref.current!.focus()
    ref.current!.setSelectionRange(18, 18)
    rerender(<AgentComposerEditor {...props} value="implementemos el #1 " references={[reference(17)]} />)
    const box = screen.getByRole('textbox', { name: 'Message' })
    expect(box.firstChild!.textContent?.replace(/\u200b/g, '')).toBe('implementemos el ')
    expect(box.childNodes[1]).toHaveAttribute('data-token', '#1')
    expect(ref.current!.value).toBe('implementemos el #1 ')
  })

  it('ignores invalid overlapping or stale reference anchors', () => {
    const { box, ref } = mount('#1 and #2', [reference(0), reference(0, 'overlap'), reference(7, 'stale')])
    expect(box.querySelectorAll('[data-inline-reference]')).toHaveLength(1)
    expect(ref.current!.value).toBe('#1 and #2')
  })

  it('does not insert pasted text into a selection outside the editor', () => {
    const { box, onChange } = mount()
    const other = document.createElement('div')
    other.textContent = 'outside'
    document.body.append(other)
    const range = document.createRange()
    range.selectNodeContents(other)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    fireEvent.paste(box, { clipboardData: { getData: () => 'changed' } })
    expect(other.textContent).toBe('outside')
    expect(onChange).not.toHaveBeenCalled()
    other.remove()
  })

  it('restores exact reference occurrences with keyboard undo and redo', () => {
    const { box, ref } = mount('#1 y #1', [reference(0, 'first'), reference(5, 'second')])
    ref.current!.setSelectionRange(7, 7)
    fireEvent.keyDown(box, { key: 'Backspace' })
    expect(ref.current!.value).toBe('#1 y ')
    fireEvent.keyDown(box, { key: 'z', metaKey: true })
    expect(ref.current!.value).toBe('#1 y #1')
    expect(box.querySelector('[data-inline-reference="second"]')).not.toBeNull()
    fireEvent.keyDown(box, { key: 'z', metaKey: true, shiftKey: true })
    expect(ref.current!.value).toBe('#1 y ')
    expect(box.querySelector('[data-inline-reference="second"]')).toBeNull()
  })

  it('intercepts menu undo before the browser can corrupt a controlled reference edit', () => {
    const { box, ref } = mount()
    ref.current!.setSelectionRange(19, 19)
    fireEvent.keyDown(box, { key: 'Backspace' })
    const event = new InputEvent('beforeinput', { inputType: 'historyUndo', bubbles: true, cancelable: true })
    fireEvent(box, event)
    expect(event.defaultPrevented).toBe(true)
    expect(ref.current!.value).toBe('implementemos el #1 después')
    expect(box.querySelector('[data-inline-reference]')).not.toBeNull()
  })

  it('repairs noncancelable native undo from the saved message and reference model', () => {
    const { box, ref } = mount()
    ref.current!.setSelectionRange(19, 19)
    fireEvent.keyDown(box, { key: 'Backspace' })
    box.textContent = '#1#1 corrupted native undo'
    fireEvent.input(box, { inputType: 'historyUndo' })
    expect(ref.current!.value).toBe('implementemos el #1 después')
    expect(box.querySelectorAll('[data-inline-reference]')).toHaveLength(1)
  })

  it('coalesces consecutive typing into one undo action and discards redo after a new edit', () => {
    const { box, ref } = mount('', [])
    const type = (text: string) => {
      for (const character of text) {
        fireEvent.keyDown(box, { key: character })
        const node = box.lastChild as Text
        node.appendData(character)
        const range = document.createRange()
        range.setStart(node, node.length)
        range.collapse(true)
        window.getSelection()!.removeAllRanges()
        window.getSelection()!.addRange(range)
        fireEvent.input(box, { inputType: 'insertText' })
      }
    }
    type('hola')
    fireEvent.keyDown(box, { key: 'z', ctrlKey: true })
    expect(ref.current!.value).toBe('')
    fireEvent.keyDown(box, { key: 'y', ctrlKey: true })
    expect(ref.current!.value).toBe('hola')
    fireEvent.keyDown(box, { key: 'z', ctrlKey: true })
    type('otro')
    fireEvent.keyDown(box, { key: 'y', ctrlKey: true })
    expect(ref.current!.value).toBe('otro')
  })

  it('disables editing controls, history shortcuts and parent submit callbacks', () => {
    const ref = createRef<AgentComposerEditorHandle>()
    const onChange = vi.fn()
    const onKeyDown = vi.fn()
    render(<AgentComposerEditor ref={ref} value="#1" references={[reference(0)]} disabled placeholder="Disabled message" onChange={onChange} onSelect={vi.fn()} onKeyDown={onKeyDown} onPaste={vi.fn()} />)
    const box = screen.getByRole('textbox', { name: 'Disabled message' })
    expect(box).toHaveAttribute('contenteditable', 'false')
    expect(box.querySelector('button')).toBeDisabled()
    fireEvent.keyDown(box, { key: 'Enter' })
    fireEvent.keyDown(box, { key: 'z', metaKey: true })
    expect(onKeyDown).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
    expect(ref.current!.value).toBe('#1')
  })
})
