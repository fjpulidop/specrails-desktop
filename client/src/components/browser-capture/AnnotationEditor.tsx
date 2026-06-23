import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, Square, Type, Droplet, Hash, Undo2, Redo2, Check, ArrowLeft, X, Loader2 } from 'lucide-react'
import { Button } from '../ui/button'
import { uploadCaptureImage, type CaptureResult } from '../../lib/browser-capture'
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
  onConfirm: (augmented: CaptureResult) => void
  /** Discard markup, return to the rubber-band selection step. */
  onReselect: () => void
  /** Discard markup + close (confirm-if-dirty handled by the caller chain). */
  onCancel: () => void
}

// A tight, high-contrast palette (concrete hex — canvas fillStyle can't read CSS
// vars). Red default = the universal "attention/this is wrong" convention.
const PALETTE = ['#ef4444', '#f59e0b', '#3b82f6', '#22c55e', '#ffffff']

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
 * blur (real pixel-destroying redaction at flatten time), and step badges.
 * Add-only with undo/redo + tool persistence (move/resize deferred). On confirm
 * the objects are flattened onto the bitmap at natural resolution, uploaded, and
 * the annotated image becomes the screenshot the spec uses. Excluded from
 * coverage — canvas + pointer drag is not exercisable under jsdom; the model and
 * geometry live in `lib/annotations.ts` and are unit-tested.
 */
export function AnnotationEditor({ result, pendingSpecId, macOverlay, confirmLabel, onConfirm, onReselect, onCancel }: AnnotationEditorProps) {
  const { t } = useTranslation('browser')
  const [state, dispatch] = useReducer(annotationReducer, initialEditorState)
  const [tool, setTool] = useState<AnnotationTool>('arrow')
  const [color, setColor] = useState(PALETTE[0])
  const [draft, setDraft] = useState<{ start: Pt; cur: Pt } | null>(null)
  const [disp, setDisp] = useState({ w: 1, h: 1 })
  const [busy, setBusy] = useState(false)

  const imgRef = useRef<HTMLImageElement | null>(null)
  const objects = state.objects

  const measure = useCallback(() => {
    const img = imgRef.current
    if (!img) return
    const r = img.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) setDisp({ w: r.width, h: r.height })
  }, [])

  useEffect(() => {
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
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

  // ─── Keyboard shortcuts ─────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy) return
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key.toLowerCase() === 'z') { e.preventDefault(); dispatch({ type: e.shiftKey ? 'redo' : 'undo' }); return }
      if (meta && e.key === 'Enter') { e.preventDefault(); void handleConfirm(); return }
      if (meta) return
      const t = TOOLS.find((x) => x.key === e.key.toLowerCase())
      if (t) { setTool(t.tool); return }
      if (e.key === 'Escape') { e.preventDefault(); handleCancel() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, objects, color, tool])

  // ─── Flatten + confirm ──────────────────────────────────────────────────────

  const flatten = useCallback(async (): Promise<{ blob: Blob; dataUrl: string } | null> => {
    const img = imgRef.current
    if (!img || !img.naturalWidth) return null
    const nw = img.naturalWidth
    const nh = img.naturalHeight
    const canvas = document.createElement('canvas')
    canvas.width = nw
    canvas.height = nh
    const cx = canvas.getContext('2d')
    if (!cx) return null
    cx.drawImage(img, 0, 0, nw, nh)
    // Blur regions FIRST so they sit over the sharp base and under the marks. Real
    // pixel destruction (clip + blurred redraw), not a translucent overlay.
    for (const o of objects) {
      if (o.kind !== 'blur') continue
      cx.save()
      cx.beginPath()
      cx.rect(o.x * nw, o.y * nh, o.w * nw, o.h * nh)
      cx.clip()
      cx.filter = `blur(${Math.max(6, nw * 0.012)}px)`
      cx.drawImage(img, 0, 0, nw, nh)
      cx.restore()
    }
    cx.filter = 'none'
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
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), 'image/png'))
    return blob ? { blob, dataUrl } : null
  }, [objects])

  const handleConfirm = useCallback(async () => {
    if (busy) return
    if (objects.length === 0) { onConfirm(result); return }
    setBusy(true)
    try {
      const flat = await flatten()
      const img = imgRef.current
      if (!flat || !img) { onConfirm(result); return }
      const attachment = await uploadCaptureImage(pendingSpecId, flat.blob, `screen-annotated-${Date.now()}.png`)
      onConfirm({
        ...result,
        rawScreenshot: result.screenshot,
        screenshot: attachment,
        screenshotDataUrl: flat.dataUrl,
        annotations: toAnnotationSet(objects, img.naturalWidth, img.naturalHeight),
      })
    } catch {
      // Upload failed → fall back to the un-annotated capture so the user isn't stuck.
      onConfirm(result)
    } finally {
      setBusy(false)
    }
  }, [busy, objects, flatten, pendingSpecId, result, onConfirm])

  const handleCancel = useCallback(() => {
    if (objects.length > 0 && !window.confirm(t('editor.discardConfirm'))) return
    onCancel()
  }, [objects.length, onCancel, t])

  // ─── Render ─────────────────────────────────────────────────────────────────

  const px = (n: number, axis: 'w' | 'h') => n * (axis === 'w' ? disp.w : disp.h)
  const draftBox = draft ? normalizeBox(draft.start, draft.cur) : null

  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center overflow-hidden p-3 gap-2">
      {/* Floating tool strip */}
      <div className={`flex items-center gap-1 rounded-lg border border-border/60 bg-surface/90 px-1.5 py-1 shadow-xl ${macOverlay ? 'ml-[80px]' : ''}`}>
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
      <div className="relative inline-block max-w-full max-h-full">
        <img
          ref={imgRef}
          src={result.screenshotDataUrl}
          alt={t('editor.capturedAlt')}
          onLoad={measure}
          draggable={false}
          className="block max-w-full max-h-full select-none rounded shadow-2xl"
        />
        {/* Blur previews (under the pointer/svg layer) */}
        {objects.map((o) => o.kind === 'blur' ? (
          <div key={o.id} className="absolute backdrop-blur-md bg-background-deep/10 border border-border/40 pointer-events-none rounded-sm"
            style={{ left: `${o.x * 100}%`, top: `${o.y * 100}%`, width: `${o.w * 100}%`, height: `${o.h * 100}%` }} />
        ) : null)}
        {draft && tool === 'blur' && draftBox && (
          <div className="absolute backdrop-blur-md bg-background-deep/10 border border-accent-info pointer-events-none rounded-sm"
            style={{ left: `${draftBox.x * 100}%`, top: `${draftBox.y * 100}%`, width: `${draftBox.w * 100}%`, height: `${draftBox.h * 100}%` }} />
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

      {/* Footer actions */}
      <div className="flex items-center gap-2">
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
