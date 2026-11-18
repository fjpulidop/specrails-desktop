/**
 * The main window's attention center, bound to the real prefs store, focus
 * probe, OS notification helper and the app's toaster.
 */
import { toast } from 'sonner'
import i18n from '../i18n'
import { createAttentionCenter } from './attention-center'
import { attentionPrefsStore } from './attention-prefs-store'
import { showNativeNotification } from './native-notify'
import { readWindowFocus } from './window-focus'
import { requestOpenInbox } from '../inbox-events'

export const appAttention = createAttentionCenter({
  prefs: () => attentionPrefsStore.ready(),
  focus: readWindowFocus,
  notify: showNativeNotification,
  summary: (count, lines) => ({
    title: i18n.t('commands:notifications.attention.away', { count }),
    body: lines.slice(0, 3).join('\n') + (lines.length > 3 ? '\n…' : ''),
    tag: 'attention:summary',
    onClick: () => { requestOpenInbox() },
  }),
  toast: (event) => {
    toast(event.title, {
      id: `attention:${event.key}`,
      description: event.body,
      action: event.open ? { label: i18n.t('commands:notifications.attention.open'), onClick: event.open } : undefined,
    })
  },
})
