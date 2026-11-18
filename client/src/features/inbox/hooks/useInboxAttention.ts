/**
 * Inbox → attention: when the projection gains an item version the person has
 * not been told about, announce it once through the app's attention pipeline
 * (an OS notification when away, a toast when the app is focused elsewhere,
 * nothing when its place is on screen). The first snapshot after startup is
 * recorded silently, so a restart never announces old news.
 */
import { useEffect, useRef, type MutableRefObject } from 'react'
import i18n from '../../../lib/i18n'
import { appAttention } from '../../../lib/attention/app-attention'
import type { AttentionCenter, AttentionEvent } from '../../../lib/attention/attention-center'
import { isMainFocused } from '../../../lib/attention/window-focus'
import { INBOX_PARAM, JOB_PARAM, REVIEW_PARAM } from '../../../lib/places'
import { inboxItemText } from '../lib/inbox-item-text'
import {
  attentionCategoryOf, inboxItemKey, inboxTarget, planAnnouncements, readAnnounced, writeAnnounced, type InboxItem,
} from '../lib/inbox-model'

/** The notification of an item: its kind as the title, then project · item · why, worded exactly like the inbox row. */
export function inboxAttentionText(item: InboxItem): { title: string; body: string } {
  const text = inboxItemText(item, i18n.t.bind(i18n), i18n.language)
  const parts = [item.projectName, text.title, text.detail].filter((part): part is string => !!part)
  return { title: text.kindLabel, body: parts.join(' · ') }
}

/** Is the item's own place (or the inbox) what the main window shows right now? */
export function inboxItemOnScreen(item: InboxItem, location: { pathname: string; search: string }, mode: 'kanban' | 'agent'): boolean {
  const params = new URLSearchParams(location.search)
  if (params.get(INBOX_PARAM) === '1') return true
  if (item.action !== 'open-review' && item.action !== 'open-run') return false
  const target = inboxTarget(item, mode)
  if (mode === 'kanban') return location.pathname === target.pathname
  return params.get(target.place === 'review' ? REVIEW_PARAM : JOB_PARAM) === item.subjectId
}

export interface InboxAttentionInput {
  status: 'loading' | 'ready' | 'error'
  /** Every item of the last snapshot (snoozed / done included). */
  snapshot: InboxItem[]
  /** What the inbox shows (without the snoozed / done ones). */
  visible: InboxItem[]
  locationRef: MutableRefObject<{ pathname: string; search: string }>
  uiModeRef: MutableRefObject<'kanban' | 'agent'>
  /** Where the return toast / a browser notification click leads for this item. */
  open: (item: InboxItem) => void
  center?: AttentionCenter
}

export function useInboxAttention({ status, snapshot, visible, locationRef, uiModeRef, open, center = appAttention }: InboxAttentionInput): void {
  const seeded = useRef(false)
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    if (status !== 'ready') return
    const now = Date.now()
    const { announce, ledger } = planAnnouncements(readAnnounced(now), snapshot, visible, !seeded.current, now)
    seeded.current = true
    writeAnnounced(ledger)
    for (const item of announce) {
      const { title, body } = inboxAttentionText(item)
      const category = attentionCategoryOf(item)
      const event: AttentionEvent = {
        key: `inbox:${inboxItemKey(item)}`,
        subjectKey: `${category}:${item.kind === 'review' ? 'review' : 'run'}:${item.subjectId}`,
        category,
        projectId: item.projectId,
        title,
        body,
        isOnScreen: (focus) => isMainFocused(focus) && inboxItemOnScreen(item, locationRef.current, uiModeRef.current),
        open: () => openRef.current(item),
      }
      void center.dispatch(event)
    }
  }, [status, snapshot, visible, locationRef, uiModeRef, center])
}
