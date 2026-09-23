// Pure, framework-free model + geometry for the capture annotation editor.
//
// All editor LOGIC (object model, undo/redo reducer, geometry, step numbering)
// lives here so it is fully unit-tested. The canvas/pointer SHELL
// (`AnnotationEditor.tsx`) is excluded from coverage like the other
// browser-capture canvas components. Coordinates are NORMALISED to [0,1] over the
// captured image, so they are resolution-independent and replayable when the
// annotations are flattened onto the bitmap at its natural pixel size.

export interface Pt {
  x: number
  y: number
}

export type Annotation =
  | { id: string; kind: 'arrow'; from: Pt; to: Pt; color: string }
  | { id: string; kind: 'box'; x: number; y: number; w: number; h: number; color: string }
  | { id: string; kind: 'text'; x: number; y: number; text: string; color: string }
  | { id: string; kind: 'blur'; x: number; y: number; w: number; h: number }
  | { id: string; kind: 'step'; x: number; y: number; n: number; color: string }

export type AnnotationTool = 'arrow' | 'box' | 'text' | 'blur' | 'step'

export interface AnnotationSet {
  schemaVersion: 1
  objects: Annotation[]
  baseWidth: number
  baseHeight: number
}

// ─── Undo/redo reducer (object-level snapshots) ───────────────────────────────

export interface EditorState {
  objects: Annotation[]
  past: Annotation[][]
  future: Annotation[][]
}

export type EditorAction =
  | { type: 'add'; obj: Annotation }
  | { type: 'delete'; id: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'clear' }

export const initialEditorState: EditorState = { objects: [], past: [], future: [] }

export function annotationReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'add':
      return { objects: [...state.objects, action.obj], past: [...state.past, state.objects], future: [] }
    case 'delete': {
      if (!state.objects.some((o) => o.id === action.id)) return state
      return { objects: state.objects.filter((o) => o.id !== action.id), past: [...state.past, state.objects], future: [] }
    }
    case 'undo': {
      if (state.past.length === 0) return state
      const prev = state.past[state.past.length - 1]
      return { objects: prev, past: state.past.slice(0, -1), future: [state.objects, ...state.future] }
    }
    case 'redo': {
      if (state.future.length === 0) return state
      const next = state.future[0]
      return { objects: next, past: [...state.past, state.objects], future: state.future.slice(1) }
    }
    case 'clear':
      return state.objects.length === 0 ? state : { objects: [], past: [...state.past, state.objects], future: [] }
    default:
      return state
  }
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

/** Next auto-incrementing step badge number (1-based, contiguous). */
export function nextStepNumber(objects: Annotation[]): number {
  const ns = objects.filter((o): o is Extract<Annotation, { kind: 'step' }> => o.kind === 'step').map((s) => s.n)
  return ns.length === 0 ? 1 : Math.max(...ns) + 1
}

/** Normalise two drag corners (any direction) into an {x,y,w,h} box. */
export function normalizeBox(a: Pt, b: Pt): { x: number; y: number; w: number; h: number } {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}

/** The two barb endpoints of an arrowhead at `to`, given the line and a length. */
export function arrowHead(from: Pt, to: Pt, len = 0.04): { left: Pt; right: Pt } {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const a1 = angle - Math.PI / 7
  const a2 = angle + Math.PI / 7
  return {
    left: { x: to.x - len * Math.cos(a1), y: to.y - len * Math.sin(a1) },
    right: { x: to.x - len * Math.cos(a2), y: to.y - len * Math.sin(a2) },
  }
}

/** True when a drag is large enough to be a deliberate shape (not a stray click). */
export function isUsableDrag(a: Pt, b: Pt, min = 0.01): boolean {
  return Math.abs(a.x - b.x) >= min || Math.abs(a.y - b.y) >= min
}

/** Clamp a normalised point to [0,1] (allow a small overshoot for callout arrows). */
export function clamp01(p: Pt, overshoot = 0.05): Pt {
  const c = (v: number) => Math.min(1 + overshoot, Math.max(-overshoot, v))
  return { x: c(p.x), y: c(p.y) }
}

export function toAnnotationSet(objects: Annotation[], baseWidth: number, baseHeight: number): AnnotationSet {
  return { schemaVersion: 1, objects, baseWidth, baseHeight }
}
