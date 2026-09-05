import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentContextChip } from '../../lib/agent-context-palette'

/** Offsets refer to the plain message, where a pill occupies its chip.token. */
export interface AgentInlineReference {
  key: string
  start: number
  end: number
  chip: AgentContextChip
}

export interface AgentComposerEditorHandle {
  focus(): void
  setSelectionRange(start: number, end: number): void
  readonly selectionStart: number
  readonly selectionEnd: number
  readonly value: string
}

interface AgentComposerEditorProps {
  value: string
  references: AgentInlineReference[]
  onChange(value: string, references: AgentInlineReference[], selectionStart: number): void
  onSelect(start: number, end: number): void
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void
  onPaste(event: ClipboardEvent<HTMLDivElement>): void
  disabled?: boolean
  placeholder?: string
  autoFocus?: boolean
  title?: string
  className?: string
  ariaLabel?: string
}

interface NodePosition {
  start: number
  end: number
  boundaries?: number[]
  atomic?: boolean
}

interface EditorSnapshot {
  value: string
  references: AgentInlineReference[]
  positions: Map<Node, NodePosition>
}

interface HistoryEntry {
  value: string
  references: AgentInlineReference[]
  selection: [number, number]
}

interface EditorHistory {
  entries: HistoryEntry[]
  index: number
  typing: { at: number; caret: number } | null
}

const BLOCKS = new Set(['DIV', 'P', 'LI'])
// An invisible caret anchor keeps Chromium/WebKit on the intended side of an
// atomic pill next to a block. It is excluded from message and clipboard text.
const CARET_BOUNDARY = '\u200b'

/** Read DOM text without ever including the visible pill label or remove button. */
function snapshot(root: HTMLElement, known: Map<string, AgentContextChip>): EditorSnapshot {
  let value = ''
  const references: AgentInlineReference[] = []
  const positions = new Map<Node, NodePosition>()
  const visit = (node: Node): void => {
    const start = value.length
    if (node.nodeType === Node.TEXT_NODE) {
      const boundaries = [start]
      for (const character of (node.textContent ?? '').split('')) {
        if (character !== CARET_BOUNDARY) value += character === '\u00a0' ? ' ' : character
        boundaries.push(value.length)
      }
      positions.set(node, { start, end: value.length, boundaries })
      return
    }
    if (!(node instanceof HTMLElement)) return
    const key = node.dataset.inlineReference
    const chip = key ? known.get(key) : undefined
    if (key && chip) {
      value += chip.token
      references.push({ key, start, end: value.length, chip })
      positions.set(node, { start, end: value.length, atomic: true })
      return
    }
    if (node.tagName === 'BR') {
      // WebKit appends a trailing BR to keep the final line editable; Chromium
      // uses a sole BR for empty blocks. Neither represents a message newline.
      if (node.nextSibling) value += '\n'
      positions.set(node, { start, end: value.length })
      return
    }
    const boundaries = [start]
    Array.from(node.childNodes).forEach((child, index) => {
      const previous = node.childNodes[index - 1]
      const followsBlock = previous instanceof HTMLElement && BLOCKS.has(previous.tagName)
      if (index > 0 && child instanceof HTMLElement && BLOCKS.has(child.tagName) && (followsBlock || !value.endsWith('\n'))) {
        value += '\n'
      }
      boundaries[index] = value.length
      visit(child)
      boundaries.push(value.length)
    })
    positions.set(node, { start, end: value.length, boundaries })
  }
  visit(root)
  return { value, references, positions }
}

function pointOffset(state: EditorSnapshot, node: Node, offset: number): number {
  const position = state.positions.get(node)
  if (position) {
    if (position.boundaries) return position.boundaries[Math.min(offset, position.boundaries.length - 1)]
    if (position.atomic) return offset === 0 ? position.start : position.end
    return Math.min(position.end, position.start + offset)
  }
  // Selection can briefly point inside a contenteditable=false pill on WebKit.
  let parent = node.parentNode
  while (parent) {
    const outer = state.positions.get(parent)
    if (outer?.atomic) return offset === 0 ? outer.start : outer.end
    parent = parent.parentNode
  }
  return state.value.length
}

function selectionOffsets(root: HTMLElement, state: EditorSnapshot): [number, number] | null {
  const selection = root.ownerDocument.getSelection()
  if (!selection?.anchorNode || !selection.focusNode || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null
  const anchor = pointOffset(state, selection.anchorNode, selection.anchorOffset)
  const focus = pointOffset(state, selection.focusNode, selection.focusOffset)
  return [Math.min(anchor, focus), Math.max(anchor, focus)]
}

function domPoint(root: HTMLElement, state: EditorSnapshot, offset: number): [Node, number] {
  const target = Math.max(0, Math.min(offset, state.value.length))
  for (const [node, position] of state.positions) {
    if (target < position.start || target > position.end) continue
    if (node.nodeType === Node.TEXT_NODE) return [node, position.boundaries?.lastIndexOf(target) ?? target - position.start]
    if (position.atomic && node.parentNode) {
      const index = Array.prototype.indexOf.call(node.parentNode.childNodes, node) as number
      if (target === position.end && node.nextSibling?.nodeType === Node.TEXT_NODE && node.nextSibling.textContent?.startsWith(CARET_BOUNDARY)) {
        return [node.nextSibling, 1]
      }
      // An atomic pill has only two caret positions, even if a caller passes an
      // offset within its token. Prefer the closest boundary.
      return [node.parentNode, index + (target - position.start > (position.end - position.start) / 2 ? 1 : 0)]
    }
    if (node !== root && node instanceof HTMLElement && node.tagName === 'BR' && node.parentNode) {
      const index = Array.prototype.indexOf.call(node.parentNode.childNodes, node) as number
      return [node.parentNode, index + (target > position.start ? 1 : 0)]
    }
  }
  return [root, root.childNodes.length]
}

function setSelection(root: HTMLElement, state: EditorSnapshot, start: number, end: number): void {
  const [startNode, startOffset] = domPoint(root, state, start)
  const [endNode, endOffset] = domPoint(root, state, Math.max(start, end))
  const range = root.ownerDocument.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  const selection = root.ownerDocument.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function validReferences(value: string, references: AgentInlineReference[]): AgentInlineReference[] {
  let previousEnd = 0
  const keys = new Set<string>()
  return [...references].sort((a, b) => a.start - b.start).filter((reference) => {
    if (!reference.key || !Number.isInteger(reference.start) || !Number.isInteger(reference.end) || keys.has(reference.key) || reference.start < previousEnd || reference.end <= reference.start || value.slice(reference.start, reference.end) !== reference.chip.token) return false
    previousEnd = reference.end
    keys.add(reference.key)
    return true
  })
}

function sameReferences(left: AgentInlineReference[], right: AgentInlineReference[]): boolean {
  return left.length === right.length && left.every((reference, index) => {
    const other = right[index]
    return reference.key === other.key && reference.start === other.start && reference.end === other.end && JSON.stringify(reference.chip) === JSON.stringify(other.chip)
  })
}

function chipTone(kind: AgentContextChip['kind']): string {
  if (kind === 'spec' || kind === 'action') return 'border-accent-highlight/30 bg-accent-highlight/10 text-accent-highlight'
  if (kind === 'job' || kind === 'trace') return 'border-accent-info/30 bg-accent-info/10 text-accent-info'
  if (kind === 'project' || kind === 'alias') return 'border-accent-primary/30 bg-accent-primary/10 text-accent-primary'
  return 'border-border/60 bg-surface/70 text-foreground/80'
}

function renderContents(document: Document, value: string, references: AgentInlineReference[], disabled: boolean, removeLabel: (label: string) => string): DocumentFragment {
  const fragment = document.createDocumentFragment()
  let offset = 0
  for (const reference of references) {
    fragment.append(document.createTextNode(`${offset > 0 ? CARET_BOUNDARY : ''}${value.slice(offset, reference.start)}${CARET_BOUNDARY}`))
    const pill = document.createElement('span')
    pill.setAttribute('contenteditable', 'false')
    pill.dataset.inlineReference = reference.key
    pill.dataset.token = reference.chip.token
    pill.className = `mx-0.5 inline-flex max-w-[240px] items-center gap-1 align-middle rounded-full border px-2 py-0.5 text-[11px] select-none ${chipTone(reference.chip.kind)}`
    pill.title = [reference.chip.label, reference.chip.detail, reference.chip.projectName, reference.chip.status].filter(Boolean).join(' · ')
    const glyph = document.createElement('span')
    glyph.textContent = /^[#@/]/.test(reference.chip.token) ? reference.chip.token[0] : '@'
    glyph.setAttribute('aria-hidden', 'true')
    const label = document.createElement('span')
    label.className = 'truncate font-medium'
    label.textContent = reference.chip.label
    pill.append(glyph, label)
    if (reference.chip.status) {
      const status = document.createElement('span')
      status.className = 'text-foreground/40'
      status.textContent = reference.chip.status
      pill.append(status)
    }
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.tabIndex = -1
    remove.disabled = disabled ?? false
    remove.dataset.removeReference = reference.key
    remove.setAttribute('aria-label', removeLabel(reference.chip.label))
    remove.className = 'rounded-sm px-0.5 text-foreground/45 hover:bg-background/60 hover:text-foreground'
    remove.textContent = '×'
    pill.append(remove)
    fragment.append(pill)
    offset = reference.end
  }
  fragment.append(document.createTextNode(`${references.length ? CARET_BOUNDARY : ''}${value.slice(offset)}`))
  return fragment
}

/**
 * The browser owns editable text. React only replaces the DOM for an external
 * change (palette selection, history, or conversation switch), so ordinary
 * typing and IME composition stay native. Model history preserves text and
 * reference identity across WebKit's inconsistent DOM undo transactions.
 */
export const AgentComposerEditor = forwardRef<AgentComposerEditorHandle, AgentComposerEditorProps>(function AgentComposerEditor(props, forwardedRef) {
  const { t } = useTranslation('agent')
  const rootRef = useRef<HTMLDivElement>(null)
  const propsRef = useRef(props)
  propsRef.current = props
  const knownReferences = useRef(new Map<string, AgentContextChip>())
  const composing = useRef(false)
  const lastSelection = useRef<[number, number]>([props.value.length, props.value.length])
  const renderedReferences = useRef<AgentInlineReference[]>([])
  const renderedRemoveLabel = useRef('')
  const pendingInputKind = useRef<string | null>(null)
  const history = useRef<EditorHistory>({
    entries: [{ value: props.value, references: validReferences(props.value, props.references), selection: [props.value.length, props.value.length] }],
    index: 0,
    typing: null,
  })
  const read = (): EditorSnapshot => snapshot(rootRef.current!, knownReferences.current)

  const rememberSelection = (selection: [number, number]): void => {
    lastSelection.current = selection
    history.current.entries[history.current.index].selection = selection
  }

  const recordHistory = (entry: HistoryEntry, kind: string): void => {
    const store = history.current
    const previous = store.entries[store.index]
    if (previous.value === entry.value && sameReferences(previous.references, entry.references)) {
      previous.selection = entry.selection
      return
    }
    previous.selection = lastSelection.current
    const now = Date.now()
    const coalesce = kind === 'insertText' && store.typing !== null && now - store.typing.at < 1_000
      && previous.selection[0] === previous.selection[1] && previous.selection[0] === store.typing.caret
      && entry.selection[0] === entry.selection[1] && entry.selection[0] >= previous.selection[0]
      && previous.references.length === entry.references.length
      && previous.references.every((reference, index) => reference.key === entry.references[index].key)
    store.entries.splice(store.index + 1)
    if (coalesce && store.index > 0) store.entries[store.index] = entry
    else {
      store.entries.push(entry)
      if (store.entries.length > 64) store.entries.shift()
      store.index = store.entries.length - 1
    }
    store.typing = kind === 'insertText' ? { at: now, caret: entry.selection[0] } : null
  }

  const paint = (value: string, references: AgentInlineReference[], selection: [number, number] | null): void => {
    const root = rootRef.current!
    for (const reference of references) knownReferences.current.set(reference.key, reference.chip)
    root.replaceChildren(renderContents(root.ownerDocument, value, references, propsRef.current.disabled ?? false, (label) => t('palette.remove', { label })))
    root.dataset.empty = String(value.length === 0)
    renderedReferences.current = references
    renderedRemoveLabel.current = removeLabel
    if (selection) {
      setSelection(root, read(), ...selection)
      rememberSelection(selectionOffsets(root, read()) ?? selection)
    }
  }

  const restoreHistory = (direction: -1 | 1): void => {
    const root = rootRef.current
    if (!root || propsRef.current.disabled) return
    const store = history.current
    store.index = Math.max(0, Math.min(store.entries.length - 1, store.index + direction))
    store.typing = null
    const entry = store.entries[store.index]
    root.focus()
    paint(entry.value, entry.references, entry.selection)
    propsRef.current.onChange(entry.value, entry.references, entry.selection[0])
  }

  const reportSelection = (): void => {
    const root = rootRef.current
    if (!root) return
    const selection = selectionOffsets(root, read())
    if (selection && (selection[0] !== lastSelection.current[0] || selection[1] !== lastSelection.current[1])) {
      rememberSelection(selection)
      propsRef.current.onSelect(...selection)
    }
  }

  const reportInput = (inputKind = 'insertText'): void => {
    const root = rootRef.current
    if (!root || composing.current) return
    if (inputKind === 'historyUndo' || inputKind === 'historyRedo') {
      restoreHistory(inputKind === 'historyUndo' ? -1 : 1)
      return
    }
    const state = read()
    const selection: [number, number] = selectionOffsets(root, state) ?? [state.value.length, state.value.length]
    recordHistory({ value: state.value, references: state.references, selection }, pendingInputKind.current ?? inputKind)
    rememberSelection(selection)
    renderedReferences.current = state.references
    root.dataset.empty = String(state.value.length === 0)
    propsRef.current.onChange(state.value, state.references, selection[0])
  }

  useImperativeHandle(forwardedRef, () => ({
    focus: () => rootRef.current?.focus(),
    setSelectionRange: (start, end) => {
      if (!rootRef.current) return
      setSelection(rootRef.current, read(), start, end)
      rememberSelection(selectionOffsets(rootRef.current, read()) ?? [start, end])
    },
    get selectionStart() { return rootRef.current ? (selectionOffsets(rootRef.current, read()) ?? lastSelection.current)[0] : 0 },
    get selectionEnd() { return rootRef.current ? (selectionOffsets(rootRef.current, read()) ?? lastSelection.current)[1] : 0 },
    get value() { return rootRef.current ? read().value : propsRef.current.value },
  }))

  const removeLabel = t('palette.remove', { label: '{{label}}' })
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || composing.current) return
    const references = validReferences(props.value, props.references)
    const before = read()
    for (const reference of references) knownReferences.current.set(reference.key, reference.chip)
    root.querySelectorAll<HTMLButtonElement>('[data-remove-reference]').forEach((button) => { button.disabled = props.disabled ?? false })
    const hasFocus = root.ownerDocument.activeElement === root
    const selection = selectionOffsets(root, before) ?? lastSelection.current
    if (before.value === props.value && sameReferences(before.references, references) && sameReferences(renderedReferences.current, references) && renderedRemoveLabel.current === removeLabel) return
    recordHistory({ value: props.value, references, selection }, 'external')
    paint(props.value, references, hasFocus ? selection : null)
  })

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    root.ownerDocument.addEventListener('selectionchange', reportSelection)
    const beforeInput = (event: InputEvent): void => {
      if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') return
      event.preventDefault()
      if (event.cancelable) restoreHistory(event.inputType === 'historyUndo' ? -1 : 1)
    }
    root.addEventListener('beforeinput', beforeInput)
    if (props.autoFocus) root.focus()
    return () => {
      root.ownerDocument.removeEventListener('selectionchange', reportSelection)
      root.removeEventListener('beforeinput', beforeInput)
    }
  }, [])

  /** Let the engine insert text/newlines; model snapshots own undo across engines. */
  const replaceSelectedText = (text: string, kind: string): void => {
    const root = rootRef.current
    const selection = root?.ownerDocument.getSelection()
    if (!root || !selection?.rangeCount || !selection.anchorNode || !selection.focusNode || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return
    rememberSelection(selectionOffsets(root, read()) ?? lastSelection.current)
    pendingInputKind.current = kind
    let inserted = false
    try {
      inserted = root.ownerDocument.execCommand?.(text ? 'insertText' : 'delete', false, text) ?? false
    } catch { /* WebViews without editing commands use the scoped Range below. */ }
    if (!inserted) {
      const range = selection.getRangeAt(0)
      range.deleteContents()
      if (text) {
        const node = root.ownerDocument.createTextNode(text)
        range.insertNode(node)
        range.setStartAfter(node)
      }
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }
    reportInput(kind)
    pendingInputKind.current = null
  }

  const removeReference = (key: string): void => {
    const root = rootRef.current
    if (!root || propsRef.current.disabled) return
    const state = read()
    const reference = state.references.find((item) => item.key === key)
    if (!reference) return
    root.focus()
    setSelection(root, state, reference.start, reference.end)
    replaceSelectedText('', 'deleteAtomic')
  }

  const copySelection = (event: ClipboardEvent<HTMLDivElement>, cut: boolean): void => {
    const root = rootRef.current
    if (!root) return
    const state = read()
    const selection = selectionOffsets(root, state)
    if (!selection || selection[0] === selection[1]) return
    event.preventDefault()
    event.clipboardData.setData('text/plain', state.value.slice(...selection))
    if (cut && !propsRef.current.disabled) replaceSelectedText('', 'deleteByCut')
  }

  return (
    <div
      ref={rootRef}
      role="textbox"
      aria-label={props.ariaLabel ?? props.placeholder}
      aria-multiline="true"
      aria-disabled={props.disabled || undefined}
      data-agent-interactive
      contentEditable={!props.disabled}
      suppressContentEditableWarning
      data-placeholder={props.placeholder}
      data-empty={props.value.length === 0}
      title={props.title}
      className={`whitespace-pre-wrap break-words outline-none data-[empty=true]:before:pointer-events-none data-[empty=true]:before:text-foreground/35 data-[empty=true]:before:content-[attr(data-placeholder)] ${props.className ?? ''}`}
      onInput={(event) => reportInput((event.nativeEvent as InputEvent).inputType || 'insertText')}
      onCompositionStart={() => { composing.current = true }}
      onCompositionEnd={() => { composing.current = false; reportInput('insertCompositionText') }}
      onKeyUp={reportSelection}
      onMouseUp={reportSelection}
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest('[data-remove-reference]')) event.preventDefault()
      }}
      onClick={(event) => {
        const button = (event.target as HTMLElement).closest<HTMLElement>('[data-remove-reference]')
        if (button?.dataset.removeReference) removeReference(button.dataset.removeReference)
      }}
      onKeyDown={(event) => {
        if (propsRef.current.disabled || composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
        if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key.toLowerCase() === 'z' || (!event.metaKey && event.key.toLowerCase() === 'y'))) {
          event.preventDefault()
          restoreHistory(event.shiftKey || event.key.toLowerCase() === 'y' ? 1 : -1)
          return
        }
        rememberSelection(selectionOffsets(rootRef.current!, read()) ?? lastSelection.current)
        propsRef.current.onKeyDown(event)
        if (event.defaultPrevented || propsRef.current.disabled) return
        if (event.key === 'Enter') {
          event.preventDefault()
          replaceSelectedText('\n', 'insertLineBreak')
        } else if (event.key === 'Backspace' || event.key === 'Delete') {
          const root = rootRef.current!
          const state = read()
          const selection = selectionOffsets(root, state)
          if (!selection || selection[0] !== selection[1]) return
          const reference = state.references.find((item) => event.key === 'Backspace' ? item.end === selection[0] : item.start === selection[0])
          if (reference) {
            event.preventDefault()
            removeReference(reference.key)
          }
        }
      }}
      onPaste={(event) => {
        propsRef.current.onPaste(event)
        if (event.defaultPrevented || propsRef.current.disabled) return
        event.preventDefault()
        replaceSelectedText(event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n'), 'insertFromPaste')
      }}
      onCopy={(event) => copySelection(event, false)}
      onCut={(event) => copySelection(event, true)}
    />
  )
})
