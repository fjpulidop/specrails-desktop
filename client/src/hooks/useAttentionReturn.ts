import { useEffect } from 'react'
import { toast } from 'sonner'
import i18n from '../lib/i18n'
import { appAttention } from '../lib/attention/app-attention'
import type { AttentionCenter } from '../lib/attention/attention-center'
import { requestOpenInbox } from '../lib/inbox-events'

/** Wait for a browser notification's own click handler (it focuses the window first) before summarizing. */
export const RETURN_SETTLE_MS = 250

/**
 * Back from away: one toast for everything announced while the app was in the
 * background ("3 things need you"). A native notification in the desktop app
 * cannot be clicked through, so this is the way back: a single item opens
 * directly, several open the inbox. Main window only.
 */
export function useAttentionReturn(center: AttentionCenter = appAttention): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const onFocus = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        const entries = center.takeAway()
        if (entries.length === 0) return
        const single = entries.length === 1 ? entries[0].open : undefined
        toast(i18n.t('commands:notifications.attention.away', { count: entries.length }), {
          id: 'attention-away',
          duration: 15_000,
          action: {
            label: single ? i18n.t('commands:notifications.attention.open') : i18n.t('commands:notifications.attention.openInbox'),
            onClick: single ?? requestOpenInbox,
          },
        })
      }, RETURN_SETTLE_MS)
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      if (timer) clearTimeout(timer)
    }
  }, [center])
}
