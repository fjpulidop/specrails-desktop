import { humanDetail } from './notify-error'

export interface LocalizedStatusDetail {
  /** What to show: the server's text when it reads in the app language, else the generic line. */
  text: string
  /** The server's own text when it was hidden (English in another language, a bare code), for support. */
  raw: string | null
}

/**
 * A delivery's `statusDetail` is written by the server (git/gh stderr, English). Show it only when it is
 * fit to read; otherwise a localized line, with the original kept reachable behind a disclosure.
 */
export function localizeStatusDetail(detail: string | null | undefined, generic: string): LocalizedStatusDetail | null {
  const raw = detail?.trim()
  if (!raw) return null
  const shown = humanDetail(raw)
  return shown ? { text: shown, raw: null } : { text: generic, raw }
}
