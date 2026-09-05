import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, Square, Type, Droplet, Hash, Undo2, Redo2, Check, ArrowLeft, X, Loader2 } from 'lucide-react'
import { Button } from '../ui/button'
import { uploadCaptureImage, type CaptureResult } from '../../lib/browser-capture'
import { dataUrlToFile } from '../../lib/data-url'
import {
  annotationReducer,
  initialEditorState,
  nextStepNumber,
  normalizeBox,
  arrowHead,
  isUsableDrag,
  clamp01,
  toAnnotationSet,
  type AnnotationTool,
  type AnnotationSet,
  type Pt,
} from '../../lib/annotations'

interface AnnotationEditorProps {
  result: CaptureResult
  pendingSpecId: string
  /** Reserve the macOS traffic-light gutter on the floating toolbar. */
  macOverlay?: boolean
  /** Label for the primary confirm button when the user has drawn annotations.
   *  Lets the caller reflect context ("Crear spec" vs "Actualizar spec");
   *  defaults to the generic create label. */
  confirmLabel?: string
  /** Flattens + uploads, then hands back an augmented CaptureResult. */
  onConfirm: (augmented: CaptureResult) => void | Promise<void>
  /** Discard markup, return to the rubber-band selection step. */
  onReselect: () => void
  /** Discard markup + close (confirm-if-dirty handled by the caller chain). */
  onCancel: () => void
}

export interface AnnotatedImage {
  screenshotDataUrl: string
  annotations?: AnnotationSet
}

export interface ImageAnnotationEditorProps {
  screenshotDataUrl: string
  macOverlay?: boolean
  confirmLabel?: string
  onConfirm: (image: AnnotatedImage) => void | Promise<void>
  onReselect: () => void
  onCancel: () => void
}

/** The advanced capture flow stores its annotated image with the pending spec.
 * Native snapshots reuse ImageAnnotationEditor directly and provide their own
 * attachment destination, without manufacturing server capture metadata. */
export function AnnotationEditor({ result, pendingSpecId, onConfirm, ...props }: AnnotationEditorProps) {
  const confirmImage = useCallback(async (image: AnnotatedImage) => {
    if (!image.annotations) {
      await onConfirm(result)
      return
    }
    const filename = `screen-annotated-${Date.now()}.png`
    const attachment = await uploadCaptureImage(pendingSpecId, dataUrlToFile(image.screenshotDataUrl, filename), filename)
    await onConfirm({
      ...result,
      rawScreenshot: result.screenshot,
      screenshot: attachment,
      screenshotDataUrl: image.screenshotDataUrl,
      annotations: image.annotations,
    })
  }, [onConfirm, pendingSpecId, result])
  return <ImageAnnotationEditor {...props} screenshotDataUrl={result.screenshotDataUrl} onConfirm={confirmImage} />
}

// A tight, high-contrast palette (concrete hex — canvas fillStyle can't read CSS
// vars). Red default = the universal "attention/this is wrong" convention.
const PALETTE = ['#ef4444', '#f59e0b', '#3b82f6', '#22c55e', '#ffffff']
const REDACTION_COLOR = '#111827'

const TOOLS: Array<{ tool: AnnotationTool; icon: typeof Square; labelKey: string; key: string }> = [
  { tool: 'arrow', icon: ArrowUpRight, labelKey: 'editor.tools.arrow', key: 'a' },
  { tool: 'box', icon: Square, labelKey: 'editor.tools.box', key: 'r' },
  { tool: 'text', icon: Type, labelKey: 'editor.tools.text', key: 't' },
  { tool: 'blur', icon: Droplet, labelKey: 'editor.tools.blur', key: 'b' },
  { tool: 'step', icon: Hash, labelKey: 'editor.tools.step', key: 'n' },
]

let idSeq = 0
const newId = () => `a${++idSeq}-${Date.now().toString(36)}`

/**
 * In-place markup editor over a FROZEN capture bitmap. Tools: arrow, box, text,
 * redaction (opaque pixel replacement at flatten time), and step badges.
 * Add-only with undo/redo + tool persistence (move/resize deferred). On confirm
 * the objects are flattened onto the bitmap at natural resolution, and handed
 * to the caller. A failed flatten or save keeps the image and its annotations
 * available for retry: silently using the original would discard redactions.
 * Excluded from
 * coverage — canvas + pointer drag is not exercisable under jsdom; the model and
 * geometry live in `lib/annotations.ts` and are unit-tested.
 */
export function ImageAnnotationEditor({ screenshotDataUrl, macOverlay, confirmLabel, onConfirm, onReselect, onCancel }: ImageAnnotationEditorProps) {
  const { t } = useTranslation('browser')
  const [state, dispatch] = useReducer(annotationReducer, initialEditorState)
  const [tool, setTool] = useState<AnnotationTool>('arrow')
  const [color, setColor] = useState(PALETTE[0])
  const [draft, setDraft] = useState<{ start: Pt; cur: Pt } | null>(null)
  const [disp, setDisp] = useState({ w: 1, h: 1 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const confirmingRef = useRef(false)

  const imgRef = useRef<HTMLImageElement | null>(null)
  const imageAreaRef = useRef<HTMLDivElement | null>(null)
  const objects = state.objects

  const measure = useCallback(() => {
    const img = imgRef.current
    if (!img) return
    const area = imageAreaRef.current?.getBoundingClientRect()
    if (!area || area.width <= 0 || area.height <= 0 || img.naturalWidth <= 0 || img.naturalHeight <= 0) return
    const scale = Math.min(1, area.width / img.naturalWidth, area.height / img.naturalHeight)
    const w = img.naturalWidth * scale
    const h = img.naturalHeight * scale
    setDisp(current => current.w === w && current.h === h ? current : { w, h })
  }, [])

  useEffect(() => {
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (imageAreaRef.current) observer?.observe(imageAreaRef.current)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [measure])

  const toNorm = useCallback((clientX: number, clientY: number): Pt => {
    const img = imgRef.current
    if (!img) return { x: 0, y: 0 }
    const r = img.getBoundingClientRect()
    return clamp01({ x: r.width > 0 ? (clientX - r.left) / r.width : 0, y: r.height > 0 ? (clientY - r.top) / r.height : 0 })
  }, [])

  // ─── Pointer drawing ────────────────────────────────────────────────────────

  const onDown = useCallback((e: React.PointerEvent) => {
    if (busy) return
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    const p = toNorm(e.clientX, e.clientY)
    if (tool === 'text') {
      const text = window.prompt(t('editor.notePrompt'))?.trim()
      if (text) dispatch({ type: 'add', obj: { id: newId(), kind: 'text', x: p.x, y: p.y, text, color } })
      return
    }
    if (tool === 'step') {
      dispatch({ type: 'add', obj: { id: newId(), kind: 'step', x: p.x, y: p.y, n: nextStepNumber(objects), color } })
      return
    }
    setDraft({ start: p, cur: p })
  }, [busy, tool, color, objects, toNorm, t])

  const onMove = useCallback((e: React.PointerEvent) => {
    if (!draft) return
    setDraft((d) => (d ? { ...d, cur: toNorm(e.clientX, e.clientY) } : d))
  }, [draft, toNorm])

  const onUp = useCallback(() => {
    if (!draft) return
    const { start, cur } = draft
    setDraft(null)
    if (!isUsableDrag(start, cur)) return
    if (tool === 'arrow') {
      dispatch({ type: 'add', obj: { id: newId(), kind: 'arrow', from: start, to: cur, color } })
    } else if (tool === 'box') {
      const b = normalizeBox(start, cur)
      dispatch({ type: 'add', obj: { id: newId(), kind: 'box', ...b, color } })
    } else if (tool === 'blur') {
      const b = normalizeBox(start, cur)
      dispatch({ type: 'add', obj: { id: newId(), kind: 'blur', ...b } })
    }
  }, [draft, tool, color])

  // ─── Flatten + confirm ──────────────────────────────────────────────────────

  const flatten = useCallback((): AnnotatedImage => {
    const img = imgRef.current
    if (!img || !img.naturalWidth || !img.naturalHeight) throw new Error('Capture image is not loaded')
    const nw = img.naturalWidth
    const nh = img.naturalHeight
    const canvas = document.createElement('canvas')
    canvas.width = nw
    canvas.height = nh
    const cx = canvas.getContext('2d')
    if (!cx) throw new Error('Image rendering is unavailable')
    cx.drawImage(img, 0, 0, nw, nh)
    // Keep the persisted 'blur' kind for existing annotations, but render it as
    // opaque redaction in both preview and export. WebKit can ignore canvas.filter
    // while the CSS preview looks blurred, silently exporting original pixels.
    // A solid fill replaces those pixels consistently in every supported engine.
    for (const o of objects) {
      if (o.kind !== 'blur') continue
      cx.fillStyle = REDACTION_COLOR
      cx.fillRect(o.x * nw, o.y * nh, o.w * nw, o.h * nh)
    }
    const lw = Math.max(2, nw * 0.004)
    for (const o of objects) {
      if (o.kind === 'box') {
        cx.strokeStyle = o.color
        cx.lineWidth = lw
        cx.strokeRect(o.x * nw, o.y * nh, o.w * nw, o.h * nh)
      } else if (o.kind === 'arrow') {
        const from = { x: o.from.x * nw, y: o.from.y * nh }
        const to = { x: o.to.x * nw, y: o.to.y * nh }
        const h = arrowHead(o.from, o.to, 0.035)
        cx.strokeStyle = o.color
        cx.lineWidth = lw
        cx.lineCap = 'round'
        cx.beginPath(); cx.moveTo(from.x, from.y); cx.lineTo(to.x, to.y)
        cx.moveTo(h.left.x * nw, h.left.y * nh); cx.lineTo(to.x, to.y); cx.lineTo(h.right.x * nw, h.right.y * nh)
        cx.stroke()
      } else if (o.kind === 'text') {
        const fs = Math.max(12, nh * 0.03)
        cx.font = `600 ${fs}px sans-serif`
        cx.textBaseline = 'top'
        cx.lineWidth = Math.max(2, fs * 0.18)
        cx.strokeStyle = 'rgba(0,0,0,0.55)'
        cx.strokeText(o.text, o.x * nw, o.y * nh)
        cx.fillStyle = o.color
        cx.fillText(o.text, o.x * nw, o.y * nh)
      } else if (o.kind === 'step') {
        const rad = Math.max(10, nh * 0.025)
        cx.beginPath(); cx.arc(o.x * nw, o.y * nh, rad, 0, Math.PI * 2)
        cx.fillStyle = o.color; cx.fill()
        cx.fillStyle = '#000'
        cx.font = `700 ${rad * 1.1}px sans-serif`
        cx.textAlign = 'center'; cx.textBaseline = 'middle'
        cx.fillText(String(o.n), o.x * nw, o.y * nh)
        cx.textAlign = 'start'
      }
    }
    const dataUrl = canvas.toDataURL('image/png')
    if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('Image encoding failed')
    return { screenshotDataUrl: dataUrl, annotations: toAnnotationSet(objects, nw, nh) }
  }, [objects])

  const handleConfirm = useCallback(async () => {
    if (confirmingRef.current) return
    confirmingRef.current = true
    setBusy(true)
    setError(false)
    try {
      const image = objects.length === 0 ? { screenshotDataUrl } : flatten()
      await onConfirm(image)
    } catch {
      setError(true)
    } finally {
      confirmingRef.current = false
      setBusy(false)
    }
  }, [objects, flatten, screenshotDataUrl, onConfirm])

  const handleCancel = useCallback(() => {
    if (objects.length > 0 && !window.confirm(t('editor.discardConfirm'))) return
    onCancel()
  }, [objects.length, onCancel, t])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy) return
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key.toLowerCase() === 'z') { e.preventDefault(); dispatch({ type: e.shiftKey ? 'redo' : 'undo' }); return }
      if (meta && e.key === 'Enter') { e.preventDefault(); void handleConfirm(); return }
      if (meta) return
      const shortcut = TOOLS.find((entry) => entry.key === e.key.toLowerCase())
      if (shortcut) { setTool(shortcut.tool); return }
      if (e.key === 'Escape') { e.preventDefault(); handleCancel() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, handleConfirm, handleCancel])

  // ─── Render ─────────────────────────────────────────────────────────────────

  const px = (n: number, axis: 'w' | 'h') => n * (axis === 'w' ? disp.w : disp.h)
  const draftBox = draft ? normalizeBox(draft.start, draft.cur) : null

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col items-center overflow-hidden p-3 gap-2">
      {/* Floating tool strip */}
      <div className={`flex shrink-0 max-w-full items-center gap-1 overflow-x-auto rounded-lg border border-border/60 bg-surface/90 px-1.5 py-1 shadow-xl ${macOverlay ? 'ml-[80px]' : ''}`}>
        {TOOLS.map(({ tool: tl, icon: Icon, labelKey }) => (
          <button
            key={tl}
            type="button"
            title={t(labelKey)}
            aria-label={t(labelKey)}
            aria-pressed={tool === tl}
            onClick={() => setTool(tl)}
            className={`h-7 w-7 inline-flex items-center justify-center rounded transition-colors ${tool === tl ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-card/60'}`}
          >
            <Icon className="w-3.5 h-3.5" />
          </button>
        ))}
        <span className="w-px h-5 bg-border/60 mx-0.5" />
        {PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={t('editor.colorLabel', { color: c })}
            onClick={() => setColor(c)}
            className={`h-5 w-5 rounded-full border transition-transform ${color === c ? 'scale-110 border-foreground' : 'border-border/60'}`}
            style={{ background: c }}
          />
        ))}
        <span className="w-px h-5 bg-border/60 mx-0.5" />
        <button type="button" aria-label={t('editor.undo')} title={t('editor.undoTitle')} disabled={state.past.length === 0} onClick={() => dispatch({ type: 'undo' })} className="h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-card/60 disabled:opacity-40">
          <Undo2 className="w-3.5 h-3.5" />
        </button>
        <button type="button" aria-label={t('editor.redo')} title={t('editor.redoTitle')} disabled={state.future.length === 0} onClick={() => dispatch({ type: 'redo' })} className="h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-card/60 disabled:opacity-40">
          <Redo2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Frozen bitmap + overlay */}
      <div ref={imageAreaRef} className="relative flex-1 min-h-0 w-full flex items-center justify-center">
      <div className="relative shrink-0" style={{ width: disp.w, height: disp.h }}>
        <img
          ref={imgRef}
          src={screenshotDataUrl}
          alt={t('editor.capturedAlt')}
          onLoad={measure}
          draggable={false}
          className="block w-full h-full select-none rounded shadow-2xl"
        />
        {/* Opaque redaction previews match the exported image. */}
        {objects.map((o) => o.kind === 'blur' ? (
          <div key={o.id} className="absolute pointer-events-none"
            style={{ backgroundColor: REDACTION_COLOR, left: `${o.x * 100}%`, top: `${o.y * 100}%`, width: `${o.w * 100}%`, height: `${o.h * 100}%` }} />
        ) : null)}
        {draft && tool === 'blur' && draftBox && (
          <div className="absolute border border-accent-info pointer-events-none"
            style={{ backgroundColor: REDACTION_COLOR, left: `${draftBox.x * 100}%`, top: `${draftBox.y * 100}%`, width: `${draftBox.w * 100}%`, height: `${draftBox.h * 100}%` }} />
        )}
        <svg
          className={`absolute inset-0 w-full h-full ${tool === 'text' || tool === 'step' ? 'cursor-pointer' : 'cursor-crosshair'}`}
          viewBox={`0 0 ${disp.w} ${disp.h}`}
          preserveAspectRatio="none"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
        >
          {objects.map((o) => {
            if (o.kind === 'box') return <rect key={o.id} x={px(o.x, 'w')} y={px(o.y, 'h')} width={px(o.w, 'w')} height={px(o.h, 'h')} fill="none" stroke={o.color} strokeWidth={Math.max(2, disp.w * 0.004)} />
            if (o.kind === 'arrow') {
              const h = arrowHead(o.from, o.to, 0.035)
              const sw = Math.max(2, disp.w * 0.004)
              return (
                <g key={o.id} stroke={o.color} strokeWidth={sw} strokeLinecap="round" fill="none">
                  <line x1={px(o.from.x, 'w')} y1={px(o.from.y, 'h')} x2={px(o.to.x, 'w')} y2={px(o.to.y, 'h')} />
                  <polyline points={`${px(h.left.x, 'w')},${px(h.left.y, 'h')} ${px(o.to.x, 'w')},${px(o.to.y, 'h')} ${px(h.right.x, 'w')},${px(h.right.y, 'h')}`} />
                </g>
              )
            }
            if (o.kind === 'text') return <text key={o.id} x={px(o.x, 'w')} y={px(o.y, 'h')} dominantBaseline="hanging" fontSize={Math.max(12, disp.h * 0.03)} fontWeight={600} fill={o.color} stroke="rgba(0,0,0,0.55)" strokeWidth={1} paintOrder="stroke">{o.text}</text>
            if (o.kind === 'step') {
              const rad = Math.max(10, disp.h * 0.025)
              return (
                <g key={o.id}>
                  <circle cx={px(o.x, 'w')} cy={px(o.y, 'h')} r={rad} fill={o.color} />
                  <text x={px(o.x, 'w')} y={px(o.y, 'h')} textAnchor="middle" dominantBaseline="central" fontSize={rad * 1.1} fontWeight={700} fill="#000">{o.n}</text>
                </g>
              )
            }
            return null
          })}
          {draft && (tool === 'box') && draftBox && (
            <rect x={px(draftBox.x, 'w')} y={px(draftBox.y, 'h')} width={px(draftBox.w, 'w')} height={px(draftBox.h, 'h')} fill="none" stroke={color} strokeDasharray="4 3" strokeWidth={Math.max(2, disp.w * 0.004)} />
          )}
          {draft && tool === 'arrow' && (
            <line x1={px(draft.start.x, 'w')} y1={px(draft.start.y, 'h')} x2={px(draft.cur.x, 'w')} y2={px(draft.cur.y, 'h')} stroke={color} strokeWidth={Math.max(2, disp.w * 0.004)} strokeLinecap="round" />
          )}
        </svg>
        {busy && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-background-deep/50 text-sm text-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> {t('common:states.saving')}
          </div>
        )}
      </div>
      </div>

      {/* Footer actions */}
      {error && <p role="alert" className="shrink-0 text-sm text-destructive">{t('modal.toast.captureFailed')}</p>}
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="ghost" className="gap-1.5" onClick={onReselect} disabled={busy}>
          <ArrowLeft className="w-3.5 h-3.5" /> {t('editor.reselect')}
        </Button>
        <Button size="sm" variant="ghost" className="gap-1.5" onClick={handleCancel} disabled={busy}>
          <X className="w-3.5 h-3.5" /> {t('common:actions.cancel')}
        </Button>
        <Button size="sm" className="gap-1.5" onClick={() => void handleConfirm()} disabled={busy} data-testid="annotation-confirm">
          <Check className="w-3.5 h-3.5" /> {objects.length > 0 ? (confirmLabel ?? t('editor.createSpec')) : t('editor.skipContinue')}
        </Button>
      </div>
    </div>
  )
}
