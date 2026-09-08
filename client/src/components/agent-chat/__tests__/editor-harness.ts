import { fireEvent } from '@testing-library/react'

// Shared contenteditable-composer helpers. They live outside the suites so a
// regression test can drive the real editor exactly the way the main agent-chat
// suite does, instead of re-deriving caret/pill semantics per file.
/** Read the editable document as the user-facing tokens, without the pill's label
 *  or remove-button text becoming part of the message. */
export function editorText(editor: HTMLElement): string {
  const document = editor.cloneNode(true) as HTMLElement
  document.querySelectorAll<HTMLElement>('[data-inline-reference]').forEach((pill) => {
    pill.replaceWith(pill.dataset.token ?? '')
  })
  return visibleNodeText(document)
}

export function visibleNodeText(node: Node | null): string {
  return (node?.textContent ?? '').replace(/\u200b/g, '')
}

/** Place a real DOM caret at a token-aware offset. Atomic pills occupy the
 *  length of their token; a caret can only sit before or after a pill. */
export function selectEditor(editor: HTMLElement, offset: number, report = true): void {
  editor.focus()
  const range = document.createRange()
  let remaining = offset
  let placed = false
  const visit = (node: Node): void => {
    if (placed) return
    if (node instanceof HTMLElement && node.hasAttribute('data-inline-reference')) {
      const size = (node.dataset.token ?? '').length
      if (remaining <= size) {
        if (remaining === 0) range.setStartBefore(node)
        else if (node.nextSibling?.nodeType === Node.TEXT_NODE && node.nextSibling.textContent?.startsWith('\u200b')) {
          range.setStart(node.nextSibling, 1)
        } else range.setStartAfter(node)
        placed = true
      } else remaining -= size
      return
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.textContent ?? ''
      const length = visibleNodeText(node).length
      if (remaining <= length) {
        let rawOffset = 0
        let plainOffset = 0
        while (rawOffset < raw.length && (plainOffset < remaining || raw[rawOffset] === '\u200b')) {
          if (raw[rawOffset] !== '\u200b') plainOffset += 1
          rawOffset += 1
        }
        range.setStart(node, rawOffset)
        placed = true
      } else remaining -= length
      return
    }
    node.childNodes.forEach(visit)
  }
  visit(editor)
  if (!placed) {
    range.selectNodeContents(editor)
    range.collapse(false)
  }
  range.collapse(true)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  if (report) fireEvent(document, new Event('selectionchange'))
}

export function inputEditor(editor: HTMLElement, text: string, caret = text.length): void {
  editor.textContent = text
  selectEditor(editor, caret, false)
  fireEvent.input(editor, { inputType: 'insertText' })
}

export function insertEditorText(editor: HTMLElement, text: string): void {
  const selection = window.getSelection()!
  const range = selection.getRangeAt(0)
  const node = document.createTextNode(text)
  range.deleteContents()
  range.insertNode(node)
  range.setStart(node, text.length)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  fireEvent.input(editor, { inputType: 'insertText', data: text })
}
