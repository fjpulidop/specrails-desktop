/**
 * Toasts from native surface windows show in the window that opened them
 * (docs/internals/native-window-surfaces.md#toasts).
 *
 * A surface window renders no toaster. `useForwardSurfaceToasts` watches its
 * toasts (sonner's store, `useSonner`) and relays each new or changed toast,
 * and each dismissal, through the host (`surface_window_toast`, delivered to
 * the opener only). The opener's `useShowSurfaceToasts` shows them in its own
 * toaster under a stable id, so loading → success updates replace in place. An
 * action button keeps working: its click is sent back to the surface window,
 * which runs the original handler. Only text crosses windows.
 */
import { isValidElement, useEffect, useRef, type ReactNode } from 'react'
import { toast, useSonner, type ToastT } from 'sonner'
import { isTauri } from './tauri-shell'
import { isSurfaceWindowRoute } from './native-surfaces'

export const SURFACE_TOAST_EVENT = 'surface-window:toast'
export const SURFACE_TOAST_ACTION_EVENT = 'surface-window:toast-action'

const TOAST_TYPES = ['success', 'info', 'warning', 'error', 'loading'] as const
type ForwardedType = (typeof TOAST_TYPES)[number] | 'default'

export interface ForwardedToast {
  id: string | number
  type?: ForwardedType
  title?: string
  description?: string
  duration?: number
  /** Action button label; a click is relayed back to the surface window. */
  action?: string
  dismissed?: true
}

/** Plain text of a toast's title/description (strings, numbers, elements, render functions). */
export function toastText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(toastText).join('')
  if (typeof node === 'function') {
    try { return toastText((node as () => ReactNode)()) } catch { return '' }
  }
  if (isValidElement(node)) return toastText((node.props as { children?: unknown }).children)
  return ''
}

function actionOf(toastItem: ToastT): { label: string; onClick: (event: never) => void } | null {
  const action = toastItem.action as { label?: unknown; onClick?: unknown } | undefined
  if (!action || typeof action !== 'object' || typeof action.onClick !== 'function') return null
  const label = toastText(action.label)
  return label ? { label, onClick: action.onClick as (event: never) => void } : null
}

/** The text-only form of a toast, or null when it has nothing to show. */
export function serializeToast(toastItem: ToastT): ForwardedToast | null {
  const title = toastText(toastItem.title)
  const description = toastText(toastItem.description)
  if (!title && !description) return null
  const type = (TOAST_TYPES as readonly string[]).includes(toastItem.type ?? '') ? toastItem.type as ForwardedType : 'default'
  const action = actionOf(toastItem)?.label
  return {
    id: toastItem.id,
    type,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(typeof toastItem.duration === 'number' ? { duration: toastItem.duration } : {}),
    ...(action ? { action } : {}),
  }
}

async function relay(forwarded: ForwardedToast): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('surface_window_toast', { toast: forwarded })
}

/** Surface window side: relay this window's toasts to its opener. */
export function useForwardSurfaceToasts(): void {
  const { toasts } = useSonner()
  const sent = useRef(new Map<string | number, string>())
  const actions = useRef(new Map<string | number, (event: never) => void>())

  useEffect(() => {
    const live = new Set<string | number>()
    for (const item of toasts) {
      live.add(item.id)
      const forwarded = serializeToast(item)
      if (!forwarded) continue
      const signature = JSON.stringify(forwarded)
      if (sent.current.get(item.id) === signature) continue
      sent.current.set(item.id, signature)
      const action = actionOf(item)
      if (action) actions.current.set(item.id, action.onClick)
      else actions.current.delete(item.id)
      void relay(forwarded).catch(() => {})
    }
    for (const id of [...sent.current.keys()]) {
      if (live.has(id)) continue
      sent.current.delete(id)
      actions.current.delete(id)
      void relay({ id, dismissed: true }).catch(() => {})
    }
  }, [toasts])

  useEffect(() => {
    if (!isTauri()) return
    let stop: (() => void) | undefined
    let disposed = false
    void import('@tauri-apps/api/event').then(({ listen }) => listen<{ id: string | number }>(SURFACE_TOAST_ACTION_EVENT, ({ payload }) => {
      const onClick = actions.current.get(payload?.id)
      // Sonner passes the click event; relayed clicks have none to give.
      onClick?.({ preventDefault() {}, stopPropagation() {} } as never)
    })).then(unlisten => { if (disposed) unlisten(); else stop = unlisten })
    return () => { disposed = true; stop?.() }
  }, [])
}

function isForwardedToast(value: unknown): value is ForwardedToast {
  const item = value as Partial<ForwardedToast> | null
  if (!item || typeof item !== 'object' || (typeof item.id !== 'string' && typeof item.id !== 'number')) return false
  return ['title', 'description', 'action'].every(key => item[key as keyof ForwardedToast] === undefined || typeof item[key as keyof ForwardedToast] === 'string')
}

/** Opener side: show a forwarded toast (or apply its update or dismissal). */
export function showForwardedToast(windowLabel: string, forwarded: ForwardedToast, onAction: () => void): void {
  const id = `surface:${windowLabel}:${forwarded.id}`
  if (forwarded.dismissed) { toast.dismiss(id); return }
  // A description-only toast shows its description as the title.
  const title = forwarded.title ?? forwarded.description ?? ''
  const options = {
    id,
    ...(forwarded.title && forwarded.description ? { description: forwarded.description } : {}),
    ...(typeof forwarded.duration === 'number' ? { duration: forwarded.duration } : {}),
    ...(forwarded.action ? { action: { label: forwarded.action, onClick: onAction } } : {}),
  }
  const show = forwarded.type && forwarded.type !== 'default' ? toast[forwarded.type] : toast
  show(title, options)
}

/** Opener side (main and mission windows): show toasts relayed from the surface windows this window opened. */
export function useShowSurfaceToasts(): void {
  useEffect(() => {
    if (!isTauri() || isSurfaceWindowRoute()) return
    let stop: (() => void) | undefined
    let disposed = false
    void import('@tauri-apps/api/event').then(({ listen, emitTo }) => listen<{ windowLabel?: unknown; toast?: unknown }>(SURFACE_TOAST_EVENT, ({ payload }) => {
      const windowLabel = payload?.windowLabel
      if (typeof windowLabel !== 'string' || !isForwardedToast(payload.toast)) return
      const forwarded = payload.toast
      showForwardedToast(windowLabel, forwarded, () => { void emitTo(windowLabel, SURFACE_TOAST_ACTION_EVENT, { id: forwarded.id }).catch(() => {}) })
    })).then(unlisten => { if (disposed) unlisten(); else stop = unlisten }).catch(() => {})
    return () => { disposed = true; stop?.() }
  }, [])
}
