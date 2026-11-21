import { useTranslation } from 'react-i18next'
import { inboxItemText, type InboxItemText } from '../lib/inbox-item-text'
import type { InboxItem } from '../lib/inbox-model'

export type { InboxItemText } from '../lib/inbox-item-text'

const NAMESPACES = ['inbox', 'providerQuota', 'recovery', 'agentRuntime']

/**
 * How an inbox item reads in React (the inbox row, a live board card): the
 * one wording of `inboxItemText`, which notifications use too.
 */
export function useInboxItemText(item: InboxItem): InboxItemText {
  const { t, i18n } = useTranslation(NAMESPACES)
  return inboxItemText(item, t, i18n.language)
}

/** The same words for a card that may or may not carry an inbox item (hooks cannot be conditional). */
export function useInboxItemTextOf(item: InboxItem | null): InboxItemText | null {
  const { t, i18n } = useTranslation(NAMESPACES)
  return item ? inboxItemText(item, t, i18n.language) : null
}
