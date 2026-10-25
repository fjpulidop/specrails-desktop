import { createElement, type ReactNode } from 'react'
import { toast } from 'sonner'
import i18n from 'i18next'

export interface NotifyErrorOptions {
  /** Raw failure text (often the server's English). Shown only when it reads in the app language. */
  detail?: string | null
  /** Re-run the failed operation. Must be idempotent. Becomes the toast's "Retry" action. */
  retry?: () => void
  /** A different recovery (raise a limit, open settings). Ignored when `retry` is given. */
  action?: { label: string; onClick: () => void }
  duration?: number
  id?: string | number
}

/** Words only an English sentence carries; localized strings in the app's languages never match. */
const ENGLISH_MARKERS = /\b(the|is|are|was|were|failed|failure|error|invalid|cannot|could not|couldn't|unable|already|not found|missing|required|must|please|timed out|unexpected|exceeded|denied|forbidden|unauthorized|refused|rejected|conflict)\b/i

/** `HTTP 409`, `409`, `Error: HTTP 500`: a status code is never a message. */
const BARE_STATUS = /^(error:\s*)?(http\s*)?\d{3}$/i

/** `rail_active`, `tickets_in_flight`: a server error code, not a sentence. */
const MACHINE_CODE = /^[a-z][a-z0-9]*([_.:-][a-z0-9]+)+$|^[A-Z][A-Z0-9_]+$/

function appLanguage(): string {
  return (i18n.language || 'en').split('-')[0]
}

/**
 * The detail text if it is fit to show a person, else undefined. Hidden: empty text, bare status
 * codes, and (when the app is not in English) text that reads as English, which is the server talking.
 */
export function humanDetail(detail: string | null | undefined): string | undefined {
  const text = detail?.trim()
  if (!text) return undefined
  if (BARE_STATUS.test(text) || MACHINE_CODE.test(text)) return undefined
  if (appLanguage() !== 'en' && ENGLISH_MARKERS.test(text)) return undefined
  return text
}

/**
 * Error toast with a recovery path. The headline is always a localized message the caller chose;
 * raw server text never becomes the headline. When the detail is unfit to show, it stays reachable
 * as a "Technical details" tooltip so nothing is lost for support.
 */
export function notifyError(title: string, opts: NotifyErrorOptions = {}): string | number {
  const { detail, retry, action, duration, id } = opts
  const shown = humanDetail(detail)
  const raw = detail?.trim()
  let description: ReactNode | undefined = shown
  if (!shown && raw && !BARE_STATUS.test(raw)) {  // keep the raw text reachable for support
    description = createElement(
      'span',
      { title: raw, className: 'cursor-help underline decoration-dotted underline-offset-2', 'data-testid': 'toast-technical-details' },
      i18n.t('common:errors.technicalDetails'),
    )
  }
  const recovery = retry
    ? { label: i18n.t('common:actions.retry'), onClick: retry }
    : action
  const options = {
    ...(description !== undefined ? { description } : {}),
    ...(recovery ? { action: recovery } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(id !== undefined ? { id } : {}),
  }
  return Object.keys(options).length > 0 ? toast.error(title, options) : toast.error(title)
}
