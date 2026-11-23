/**
 * Toasts in native surface windows (docs/internals/native-window-surfaces.md#toasts).
 *
 * A surface window renders its own toaster: a toast shows in the window where
 * the person acted, never in another window that may sit behind it (a failed
 * Continue in the job window used to land, unseen, in the main window).
 *
 * When the surface window closes itself (its close button, Escape, "do X,
 * then close"), `handOffSurfaceToasts` relays the toasts still on screen
 * (`useTrackSurfaceToasts`) as
 * text through the host (`surface_window_toast`, delivered to the opener only),
 * and the opener's `useShowSurfaceToasts` shows them under a stable id, so the
 * outcome of the last action outlives the window. Their action buttons stay
 * behind: the window that would run them is gone.
 */
import { isValidElement, useEffect, type ReactNode } from 'react'
import { toast, useSonner, type ToastT } from 'sonner'
import { isTauri } from './tauri-shell'
import { isSurfaceWindowRoute } from './native-surfaces'

export const SURFACE_TOAST_EVENT = 'surface-window:toast'

const TOAST_TYPES = ['success', 'info', 'warning', 'error', 'loading'] as const
type ForwardedType = (typeof TOAST_TYPES)[number] | 'default'

export interface ForwardedToast {
  id: string | number
  type?: ForwardedType
  title?: string
  description?: string
  duration?: number
  /** Action button label (a toast handed off by a closing window carries none). */
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

/** The toasts on screen in this surface window (`useTrackSurfaceToasts`); sonner's own store keeps dismissed-all ones. */
let onScreen: readonly ToastT[] = []

/** Surface window side: keep track of the toasts on screen, for the hand-off when the window closes. */
export function useTrackSurfaceToasts(): void {
  const { toasts } = useSonner()
  useEffect(() => { onScreen = toasts }, [toasts])
  useEffect(() => () => { onScreen = [] }, [])
}

/**
 * Surface window side, as the window closes itself: relay the toasts still on screen to the opener
 * (text only, without their action buttons). Never throws; resolves once every relay settled.
 */
export async function handOffSurfaceToasts(): Promise<void> {
  if (!isTauri()) return
  // A loading toast would spin forever in the opener: its update would come from the closed window.
  const forwarded = onScreen.map(item => serializeToast(item)).filter((item): item is ForwardedToast => !!item && item.type !== 'loading')
  await Promise.all(forwarded.map(({ action: _action, ...item }) => relay(item).catch(() => {})))
}

function isForwardedToast(value: unknown): value is ForwardedToast {
  const item = value as Partial<ForwardedToast> | null
  if (!item || typeof item !== 'object' || (typeof item.id !== 'string' && typeof item.id !== 'number')) return false
  return ['title', 'description', 'action'].every(key => item[key as keyof ForwardedToast] === undefined || typeof item[key as keyof ForwardedToast] === 'string')
}

/** Opener side: show a forwarded toast (or apply its update or dismissal). */
export function showForwardedToast(windowLabel: string, forwarded: ForwardedToast, onAction?: () => void): void {
  const id = `surface:${windowLabel}:${forwarded.id}`
  if (forwarded.dismissed) { toast.dismiss(id); return }
  // A description-only toast shows its description as the title.
  const title = forwarded.title ?? forwarded.description ?? ''
  const options = {
    id,
    ...(forwarded.title && forwarded.description ? { description: forwarded.description } : {}),
    ...(typeof forwarded.duration === 'number' ? { duration: forwarded.duration } : {}),
    ...(forwarded.action && onAction ? { action: { label: forwarded.action, onClick: onAction } } : {}),
  }
  const show = forwarded.type && forwarded.type !== 'default' ? toast[forwarded.type] : toast
  show(title, options)
}

/** Opener side (main and mission windows): show the toasts a surface window this window opened handed off as it closed. */
export function useShowSurfaceToasts(): void {
  useEffect(() => {
    if (!isTauri() || isSurfaceWindowRoute()) return
    let stop: (() => void) | undefined
    let disposed = false
    void import('@tauri-apps/api/event').then(({ listen }) => listen<{ windowLabel?: unknown; toast?: unknown }>(SURFACE_TOAST_EVENT, ({ payload }) => {
      const windowLabel = payload?.windowLabel
      if (typeof windowLabel !== 'string' || !isForwardedToast(payload.toast)) return
      showForwardedToast(windowLabel, payload.toast)
    })).then(unlisten => { if (disposed) unlisten(); else stop = unlisten }).catch(() => {})
    return () => { disposed = true; stop?.() }
  }, [])
}
