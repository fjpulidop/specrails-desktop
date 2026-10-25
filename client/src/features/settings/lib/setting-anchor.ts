/**
 * Land on a settings block after ⌘K opened its dialog or page: wait for the
 * `data-setting-id` anchor to be visible (panes mount hidden and self-fetch),
 * scroll it into view, focus its first control and flash it briefly.
 */
const POLL_MS = 80
const BUDGET_MS = 3000
const FLASH_MS = 1800
const FOCUSABLE = 'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'

export const SETTING_PARAM = 'setting'

export function findSettingAnchor(id: string, root: ParentNode = document): HTMLElement | null {
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id.replace(/"/g, '\\"')
  const el = root.querySelector<HTMLElement>(`[data-setting-id="${escaped}"]`)
  if (!el) return null
  // A pane that is not the active section is mounted but `hidden`.
  return el.closest('.hidden, [hidden]') ? null : el
}

/** Returns a cancel function (call it from the effect cleanup). */
export function focusSettingAnchor(id: string, root: ParentNode = document): () => void {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let flashed: HTMLElement | null = null
  const deadline = Date.now() + BUDGET_MS
  const attempt = () => {
    if (cancelled) return
    const el = findSettingAnchor(id, root)
    if (el) {
      if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' })
      // Prefer a control of the block; fall back to the block itself.
      const target = el.querySelector<HTMLElement>(FOCUSABLE)
      if (target) target.focus({ preventScroll: true })
      el.setAttribute('data-setting-flash', 'true')
      flashed = el
      timer = setTimeout(() => el.removeAttribute('data-setting-flash'), FLASH_MS)
      return
    }
    if (Date.now() < deadline) timer = setTimeout(attempt, POLL_MS)
  }
  attempt()
  return () => {
    cancelled = true
    if (timer) clearTimeout(timer)
    flashed?.removeAttribute('data-setting-flash')
  }
}
