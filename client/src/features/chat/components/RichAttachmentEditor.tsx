import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ClipboardEvent,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { Attachment } from '../../../types'
import {
  ATTACHMENT_ACCEPT_MIME,
  isSupportedAttachmentFile,
  uploadAttachment,
} from '../lib/attachments'
import i18n from '../../../lib/i18n'
import { cn } from '../../../lib/utils'
import { AttachmentChip } from './AttachmentChip'

export interface RichAttachmentEditorHandle {
  getPlainText: () => string
  getAttachmentIds: () => string[]
  insertPill: (attachment: Attachment) => void
  focus: () => void
  /** Clear any user-applied resize height so the editor returns to minHeight. */
  resetHeight: () => void
  clear: () => void
  /** Replace the editor's plain-text content. Used to rehydrate a parked
   *  composer draft on shell remount. Does not restore attachment pills. */
  setPlainText: (text: string) => void
}

interface RichAttachmentEditorProps {
  ticketKey: string | number
  placeholder?: string
  minHeight?: number
  /** Cap on the editor's auto-grow height (px). Beyond this the content
   *  scrolls vertically instead of expanding the box without bound — without
   *  it, pasting a very large text grows the editor off-screen with no scroll. */
  maxHeight?: number
  ariaLabel?: string
  autoFocus?: boolean
  className?: string
  disabled?: boolean
  onAttachmentAdded?: (attachment: Attachment) => void
  onAttachmentRemoved?: (attachment: Attachment) => void
  onUnsupportedFile?: (file: File) => void
  onUploadError?: (error: Error, file: File) => void
  onChange?: () => void
  onSubmit?: () => void // Cmd+Enter
  /** Extra action(s) rendered next to "Attach files" in the footer (e.g. the
   *  "From a website" capture button) so all add-context actions sit together. */
  footerExtra?: ReactNode
}

interface PendingUpload {
  id: string
  name: string
}

function filenamesFromDataTransfer(dt: DataTransfer): File[] {
  const out: File[] = []
  for (let i = 0; i < dt.files.length; i++) {
    const f = dt.files.item(i)
    if (f) out.push(f)
  }
  return out
}

function pasteImageName(counter: number): string {
  const d = new Date().toISOString().slice(0, 10)
  return `paste-${d}-${counter}.png`
}

function buildPill(attachment: Attachment): HTMLSpanElement {
  const pill = document.createElement('span')
  pill.setAttribute('contenteditable', 'false')
  pill.dataset.attachmentId = attachment.id
  pill.dataset.filename = attachment.filename
  pill.className =
    'inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded bg-accent/80 hover:bg-accent text-accent-foreground text-xs font-medium align-baseline select-none border border-border shadow-sm transition-all'
  const label = document.createElement('span')
  label.textContent = `@${attachment.filename}`
  label.className = 'max-w-[180px] truncate'
  const close = document.createElement('button')
  close.type = 'button'
  close.setAttribute('aria-label', i18n.t('attachments:removeFile', { name: attachment.filename }))
  close.dataset.role = 'pill-remove'
  close.className = 'text-accent-foreground/60 hover:text-destructive transition-colors leading-none'
  close.textContent = '×'
  pill.appendChild(label)
  pill.appendChild(close)
  return pill
}

function isElement(n: Node | null): n is Element {
  return !!n && n.nodeType === Node.ELEMENT_NODE
}

function serializeNode(node: Node, out: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push(node.nodeValue ?? '')
    return
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return
  const el = node as HTMLElement
  if (el.dataset.attachmentId && el.dataset.filename) {
    out.push(`@[${el.dataset.filename}](${el.dataset.attachmentId})`)
    return
  }
  if (el.tagName === 'BR') {
    out.push('\n')
    return
  }
  if (el.tagName === 'DIV' || el.tagName === 'P') {
    // Contenteditable produces <div><br></div> for newlines in some browsers
    if (out.length && !out[out.length - 1].endsWith('\n')) out.push('\n')
    node.childNodes.forEach((c) => serializeNode(c, out))
    return
  }
  node.childNodes.forEach((c) => serializeNode(c, out))
}

export const RichAttachmentEditor = forwardRef<RichAttachmentEditorHandle, RichAttachmentEditorProps>(
  function RichAttachmentEditor(
    {
      ticketKey,
      placeholder,
      minHeight = 120,
      maxHeight = 320,
      ariaLabel,
      autoFocus,
      className,
      disabled,
      onAttachmentAdded,
      onAttachmentRemoved,
      onUnsupportedFile,
      onUploadError,
      onChange,
      onSubmit,
      footerExtra,
    },
    ref,
  ) {
    const { t } = useTranslation('attachments')
    const editorRef = useRef<HTMLDivElement | null>(null)
    const fileInputRef = useRef<HTMLInputElement | null>(null)
    const savedRangeRef = useRef<Range | null>(null)
    const isComposingRef = useRef(false)
    const pendingComposedQueue = useRef<Attachment[]>([])
    const pasteCounterRef = useRef(0)
    const dragDepthRef = useRef(0)

    const [isDragOver, setIsDragOver] = useState(false)
    const [uploads, setUploads] = useState<PendingUpload[]>([])
    const [attached, setAttached] = useState<Attachment[]>([])
    const [isEmpty, setIsEmpty] = useState(true)

    const notifyChange = useCallback(() => {
      const root = editorRef.current
      if (root) {
        setIsEmpty(root.textContent?.trim().length === 0 && root.querySelectorAll('[data-attachment-id]').length === 0)
      }
      onChange?.()
    }, [onChange])

    const saveSelection = useCallback(() => {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return
      const root = editorRef.current
      if (!root) return
      const range = sel.getRangeAt(0)
      if (root.contains(range.commonAncestorContainer)) {
        savedRangeRef.current = range.cloneRange()
      }
    }, [])

    const restoreSelectionOrEnd = useCallback(() => {
      const root = editorRef.current
      if (!root) return null
      const sel = window.getSelection()
      if (!sel) return null
      let range: Range
      if (savedRangeRef.current && root.contains(savedRangeRef.current.commonAncestorContainer)) {
        range = savedRangeRef.current.cloneRange()
      } else {
        range = document.createRange()
        range.selectNodeContents(root)
        range.collapse(false)
      }
      sel.removeAllRanges()
      sel.addRange(range)
      return range
    }, [])

    const insertPillInternal = useCallback(
      (attachment: Attachment) => {
        const root = editorRef.current
        if (!root) return
        const range = restoreSelectionOrEnd()
        if (!range) return
        const pill = buildPill(attachment)
        const spaceBefore = document.createTextNode(' ')
        const spaceAfter = document.createTextNode(' ')
        range.deleteContents()
        range.insertNode(spaceAfter)
        range.insertNode(pill)
        range.insertNode(spaceBefore)
        // move caret after the trailing space
        const newRange = document.createRange()
        newRange.setStartAfter(spaceAfter)
        newRange.collapse(true)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(newRange)
        savedRangeRef.current = newRange.cloneRange()
        notifyChange()
      },
      [notifyChange, restoreSelectionOrEnd],
    )

    const schedulePill = useCallback(
      (attachment: Attachment) => {
        setAttached((prev) => (prev.some((a) => a.id === attachment.id) ? prev : [...prev, attachment]))
        if (isComposingRef.current) {
          pendingComposedQueue.current.push(attachment)
        } else {
          insertPillInternal(attachment)
        }
      },
      [insertPillInternal],
    )

    const removePillById = useCallback(
      (attachmentId: string) => {
        const root = editorRef.current
        if (!root) return null
        const pill = root.querySelector<HTMLElement>(`[data-attachment-id="${CSS.escape(attachmentId)}"]`)
        const filenameFromPill = pill?.dataset.filename
        pill?.remove()
        setAttached((prev) => {
          const found = prev.find((a) => a.id === attachmentId)
          if (found) {
            const filtered = prev.filter((a) => a.id !== attachmentId)
            return filtered
          }
          return prev
        })
        notifyChange()
        if (!pill && !filenameFromPill) {
          // Chip removed but no pill present (edge case); still return a shape so caller can DELETE server-side
          const fromState = attached.find((a) => a.id === attachmentId)
          if (fromState) return fromState
          return null
        }
        return { id: attachmentId, filename: filenameFromPill ?? '' } as Pick<Attachment, 'id' | 'filename'>
      },
      [attached, notifyChange],
    )

    const uploadFile = useCallback(
      async (file: File) => {
        if (!isSupportedAttachmentFile(file)) {
          onUnsupportedFile?.(file)
          return
        }
        const pendingId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        setUploads((prev) => [...prev, { id: pendingId, name: file.name }])
        try {
          const attachment = await uploadAttachment(ticketKey, file)
          schedulePill(attachment)
          onAttachmentAdded?.(attachment)
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err))
          onUploadError?.(e, file)
        } finally {
          setUploads((prev) => prev.filter((u) => u.id !== pendingId))
        }
      },
      [onAttachmentAdded, onUnsupportedFile, onUploadError, schedulePill, ticketKey],
    )

    const uploadFiles = useCallback(
      async (files: File[]) => {
        saveSelection()
        await Promise.all(files.map(uploadFile))
      },
      [saveSelection, uploadFile],
    )

    // ─── Imperative handle ────────────────────────────────────────────────
    useImperativeHandle(
      ref,
      () => ({
        getPlainText: () => {
          const root = editorRef.current
          if (!root) return ''
          const out: string[] = []
          root.childNodes.forEach((n) => serializeNode(n, out))
          return out.join('').replace(/​/g, '').trim()
        },
        getAttachmentIds: () => {
          const root = editorRef.current
          if (!root) return []
          return Array.from(root.querySelectorAll<HTMLElement>('[data-attachment-id]')).map(
            (el) => el.dataset.attachmentId!,
          )
        },
        insertPill: insertPillInternal,
        focus: () => editorRef.current?.focus(),
        /** Reset any user-resized height back to the configured minHeight. */
        resetHeight: () => {
          const root = editorRef.current
          if (!root) return
          root.style.height = ''
        },
        clear: () => {
          const root = editorRef.current
          if (!root) return
          root.innerHTML = ''
          savedRangeRef.current = null
          setAttached([])
          notifyChange()
        },
        setPlainText: (text: string) => {
          const root = editorRef.current
          if (!root) return
          root.textContent = text
          savedRangeRef.current = null
          notifyChange()
        },
      }),
      [insertPillInternal, notifyChange],
    )

    // ─── Events ───────────────────────────────────────────────────────────

    const handleKeyDown = useCallback(
      (e: KeyboardEvent<HTMLDivElement>) => {
        const root = editorRef.current
        if (!root) return

        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          onSubmit?.()
          return
        }

        if (e.key !== 'Backspace' && e.key !== 'Delete') return
        const sel = window.getSelection()
        if (!sel || sel.rangeCount === 0) return
        const range = sel.getRangeAt(0)
        if (!range.collapsed) return
        // Backspace → look backwards; Delete → look forwards
        const lookBack = e.key === 'Backspace'
        const probe = lookBack
          ? (() => {
              // find the node immediately before caret
              const n = range.startContainer
              if (n.nodeType === Node.TEXT_NODE && range.startOffset > 0) return null
              if (isElement(n)) {
                const child = n.childNodes[range.startOffset - 1] ?? null
                return child
              }
              return n.previousSibling
            })()
          : (() => {
              const n = range.startContainer
              if (n.nodeType === Node.TEXT_NODE && range.startOffset < (n.nodeValue?.length ?? 0)) return null
              if (isElement(n)) {
                const child = n.childNodes[range.startOffset] ?? null
                return child
              }
              return n.nextSibling
            })()
        const pill = isElement(probe) ? (probe as HTMLElement) : null
        if (pill && pill.dataset.attachmentId) {
          e.preventDefault()
          const removed = removePillById(pill.dataset.attachmentId)
          if (removed) onAttachmentRemoved?.(removed as Attachment)
        }
      },
      [onAttachmentRemoved, onSubmit, removePillById],
    )

    const handlePaste = useCallback(
      (e: ClipboardEvent<HTMLDivElement>) => {
        const cd = e.clipboardData
        if (!cd) return
        // image paste → upload
        const items = cd.items ? Array.from(cd.items) : []
        const imageItem = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'))
        if (imageItem) {
          const file = imageItem.getAsFile()
          if (file) {
            e.preventDefault()
            pasteCounterRef.current += 1
            const named = file.name && file.name !== 'image.png'
              ? file
              : new File([file], pasteImageName(pasteCounterRef.current), { type: file.type })
            void uploadFile(named)
            return
          }
        }
        // plain text only — strip HTML
        e.preventDefault()
        const text = cd.getData('text/plain')
        if (!text) return
        const sel = window.getSelection()
        if (!sel || sel.rangeCount === 0) return
        const range = sel.getRangeAt(0)
        range.deleteContents()
        range.insertNode(document.createTextNode(text))
        range.collapse(false)
        notifyChange()
      },
      [notifyChange, uploadFile],
    )

    const handleClick = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement
        if (target.dataset.role === 'pill-remove') {
          e.preventDefault()
          const pill = target.closest<HTMLElement>('[data-attachment-id]')
          if (pill?.dataset.attachmentId) {
            const removed = removePillById(pill.dataset.attachmentId)
            if (removed) onAttachmentRemoved?.(removed as Attachment)
          }
        }
      },
      [onAttachmentRemoved, removePillById],
    )

    const handleInput = useCallback(() => notifyChange(), [notifyChange])
    const handleBlur = useCallback(() => saveSelection(), [saveSelection])

    const handleCompositionStart = useCallback(() => {
      isComposingRef.current = true
    }, [])
    const handleCompositionEnd = useCallback(() => {
      isComposingRef.current = false
      if (pendingComposedQueue.current.length > 0) {
        const queued = pendingComposedQueue.current
        pendingComposedQueue.current = []
        queued.forEach((a) => insertPillInternal(a))
      }
    }, [insertPillInternal])

    // ─── DnD (root zone) ─────────────────────────────────────────────────

    const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      dragDepthRef.current += 1
      setIsDragOver(true)
    }, [])
    const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }, [])
    const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      dragDepthRef.current -= 1
      if (dragDepthRef.current <= 0) {
        dragDepthRef.current = 0
        setIsDragOver(false)
      }
    }, [])
    const handleDrop = useCallback(
      (e: DragEvent<HTMLDivElement>) => {
        if (!e.dataTransfer?.types.includes('Files')) return
        e.preventDefault()
        dragDepthRef.current = 0
        setIsDragOver(false)
        const files = filenamesFromDataTransfer(e.dataTransfer)
        if (files.length > 0) void uploadFiles(files)
      },
      [uploadFiles],
    )

    const handleBrowseClick = useCallback(() => {
      fileInputRef.current?.click()
    }, [])
    const handleBrowseChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files ? Array.from(e.target.files) : []
        if (files.length > 0) void uploadFiles(files)
        // reset so same file can be picked again later
        e.target.value = ''
      },
      [uploadFiles],
    )

    useEffect(() => {
      if (autoFocus) editorRef.current?.focus()
    }, [autoFocus])

    return (
      <div
        className={cn('relative group', className)}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div
          ref={editorRef}
          contentEditable={disabled ? false : true}
          role="textbox"
          aria-multiline="true"
          aria-label={ariaLabel}
          spellCheck
          suppressContentEditableWarning
          onInput={handleInput}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          onClick={handleClick}
          onBlur={handleBlur}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          data-empty={isEmpty ? 'true' : 'false'}
          className={cn(
            'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm leading-relaxed',
            'outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/60',
            'transition-colors whitespace-pre-wrap break-words',
            'data-[empty=true]:before:content-[attr(data-placeholder)]',
            'data-[empty=true]:before:text-muted-foreground data-[empty=true]:before:pointer-events-none',
            'data-[empty=true]:before:absolute data-[empty=true]:before:top-2 data-[empty=true]:before:left-3',
          )}
          style={{ minHeight, maxHeight, resize: 'vertical', overflow: 'auto' }}
          data-placeholder={placeholder ?? ''}
        />

        {/* Chip row + browse */}
        {(attached.length > 0 || uploads.length > 0) && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {attached.map((a, i) => (
              <AttachmentChip
                key={a.id}
                attachment={a}
                index={i}
                onRemove={() => {
                  const removed = removePillById(a.id)
                  if (removed) onAttachmentRemoved?.(removed as Attachment)
                }}
              />
            ))}
            {uploads.map((u, i) => (
              <AttachmentChip key={u.id} uploading={{ name: u.name }} index={attached.length + i} />
            ))}
          </div>
        )}

        <div className="flex items-center justify-between mt-2 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleBrowseClick}
              disabled={disabled}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-border hover:bg-accent/40 transition-colors disabled:opacity-50"
            >
              <span aria-hidden>📎</span>
              <span>{t('editor.attachFiles')}</span>
            </button>
            {footerExtra}
          </div>
          {uploads.length > 0 && (
            <span className="animate-pulse">{t('editor.uploadingFiles', { count: uploads.length })}</span>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT_MIME}
          className="hidden"
          onChange={handleBrowseChange}
        />

        {/* Drop overlay */}
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 rounded-lg border-2 border-dashed transition-all duration-150',
            isDragOver
              ? 'border-primary bg-primary/10 opacity-100 scale-100'
              : 'border-transparent opacity-0 scale-[0.98]',
          )}
        >
          <div
            className={cn(
              'absolute inset-0 flex items-center justify-center text-sm font-medium text-primary',
              isDragOver ? 'opacity-100' : 'opacity-0',
              'transition-opacity',
            )}
          >
            {t('editor.dropToAddContext')}
          </div>
        </div>
      </div>
    )
  },
)
