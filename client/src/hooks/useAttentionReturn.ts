import { useEffect } from 'react'
import { toast } from 'sonner'
import i18n from '../lib/i18n'
import { appAttention } from '../lib/attention/app-attention'
import { attentionReturnCopy } from '../lib/attention/attention-copy'
import { readWindowFocus, type WindowFocus } from '../lib/attention/window-focus'
import type { AttentionCenter } from '../lib/attention/attention-center'
import { requestOpenInbox } from '../lib/inbox-events'
import { startupQueue } from '../lib/startup-queue'

/** Wait for a browser notification's own click handler (it focuses the window first) before summarizing. */
export const RETURN_SETTLE_MS = 250

/**
 * Back from away: one toast for everything announced while the app was in the
 * background: one item by name with its own action ("Alpha · Add login is
 * waiting for your answer" → "Answer"), several as a count ("3 pending items"). A native notification in the desktop app
 * cannot be clicked through, so this is the way back: a single item opens
 * directly, several open the inbox. Main window only.
 */
export function useAttentionReturn(center: AttentionCenter = appAttention, focus: () => Promise<WindowFocus> = readWindowFocus): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let disposed = false
    const onFocus = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        const taken = center.takeAway()
        if (taken.length === 0) return
        void focus().catch(() => null).then((now) => {
          if (disposed) return
          // What the person is already looking at (the mission that asked, open in front) needs no toast.
          const entries = now ? taken.filter((entry) => !entry.isOnScreen?.(now)) : taken
          if (entries.length === 0) return
          const copy = attentionReturnCopy(entries, (key, options) => String(i18n.t(key, options)), i18n.language)
          // Held while a startup modal is open (it then arrives with any other held toast).
          startupQueue.deliver(() => toast(copy.message, {
            id: 'attention-away',
            duration: 15_000,
            action: { label: copy.action, onClick: copy.open ?? requestOpenInbox },
          }))
        })
      }, RETURN_SETTLE_MS)
    }
    window.addEventListener('focus', onFocus)
    return () => {
      disposed = true
      window.removeEventListener('focus', onFocus)
      if (timer) clearTimeout(timer)
    }
  }, [center, focus])
}
