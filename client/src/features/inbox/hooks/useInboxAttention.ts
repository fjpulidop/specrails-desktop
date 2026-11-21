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
import type { AttentionCopy, AttentionCopyKind } from '../../../lib/attention/attention-copy'
import { isMissionOnScreen } from '../../../lib/attention/mission-screen'
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

/** What the item is, for the return toast: its kind, project and title ("Alpha · Add login is ready for review"). */
export function inboxAttentionCopy(item: InboxItem): AttentionCopy {
  const kind: AttentionCopyKind = item.kind === 'question' ? (item.question?.kind === 'approval' ? 'approval' : 'question')
    : item.kind === 'review' ? 'review'
    : item.kind === 'failed' ? 'stopped'
    : item.kind === 'budget' || item.action === 'raise-cap' ? 'paused'
    : item.kind === 'blocked' ? (item.diagnosis?.kind === 'provider_limit' || item.detail === 'held:paused' || item.detail?.startsWith('held:paused:') ? 'paused' : 'stopped')
    : 'generic'
  // A reached cap is about the project's spending, not one spec.
  return { kind, project: item.projectName, subject: item.cap ? null : item.title }
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
  const pending = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (status !== 'ready') return
    // An item answered or dismissed since (often in the mission's own window) is no longer
    // waiting: it must not come back in the return toast.
    const stillVisible = new Set(visible.map((item) => `inbox:${inboxItemKey(item)}`))
    for (const key of pending.current) if (!stillVisible.has(key)) center.forget(key)
    pending.current = stillVisible
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
        // Its own place in the main window, or the mission it belongs to (main window or its own window).
        isOnScreen: (focus) => (isMainFocused(focus) && inboxItemOnScreen(item, locationRef.current, uiModeRef.current))
          || (!!item.conversationId && isMissionOnScreen(item.conversationId, focus)),
        open: () => openRef.current(item),
        copy: inboxAttentionCopy(item),
      }
      void center.dispatch(event)
    }
  }, [status, snapshot, visible, locationRef, uiModeRef, center])
}
