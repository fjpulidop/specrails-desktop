/**
 * How a pending attention item reads in the return toast, an in-app toast's
 * action and a grouped notification (pure: the caller passes its translate
 * function and language).
 *
 * - One item says what it is and offers its own action:
 *   "Alpha · Add login is waiting for your answer" → "Answer".
 * - Several read as a sober count ("3 pending items"), or by kind when every
 *   item is a question, an approval or a review ("2 questions and 1 review
 *   pending"); their action opens the inbox.
 *
 * Items come from every project, so the project name leads the subject.
 */

/** What an item is, as far as its wording goes. */
export type AttentionCopyKind =
  | 'question' | 'approval' | 'review' | 'stopped' | 'stuck' | 'paused' | 'done' | 'reply' | 'generic'

export interface AttentionCopy {
  kind: AttentionCopyKind
  /** The project the item belongs to (shown first). */
  project?: string | null
  /** The item itself: a spec or run title, a command. */
  subject?: string | null
  /** A complete sentence of its own (a mission reply, a provider limit) used as is. */
  message?: string | null
}

export type AttentionActionKind = 'answer' | 'review' | 'view' | 'open'

type Translate = (key: string, options?: Record<string, unknown>) => string

const NS = 'commands:notifications.attention'
const SUBJECT_MAX = 60
/** Kinds counted on their own when several items are pending (all others make the plain count). */
const COUNTED: readonly AttentionCopyKind[] = ['question', 'approval', 'review']

export function actionKindOf(kind: AttentionCopyKind | undefined): AttentionActionKind {
  if (kind === 'question') return 'answer'
  if (kind === 'approval' || kind === 'review') return 'review'
  if (kind === 'reply' || kind === undefined) return 'open'
  return 'view'
}

/** The button label that acts on one item. */
export function attentionActionLabel(copy: AttentionCopy | undefined, t: Translate): string {
  return t(`${NS}.actions.${actionKindOf(copy?.kind)}`)
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > SUBJECT_MAX ? `${flat.slice(0, SUBJECT_MAX - 1).trimEnd()}…` : flat
}

/** "Project · Subject", either part optional; empty when neither is known. */
export function subjectLabel(copy: Pick<AttentionCopy, 'project' | 'subject'>): string {
  const project = copy.project?.trim()
  const subject = copy.subject?.trim()
  return [project, subject && subject !== project ? clip(subject) : null].filter((part): part is string => !!part).join(' · ')
}

/** The sentence for one item; `fallback` (the event's own title) when the item names nothing. */
export function singleAttentionMessage(copy: AttentionCopy | undefined, t: Translate, fallback?: string | null): string {
  if (copy?.message?.trim()) return copy.message.trim()
  const subject = copy ? subjectLabel(copy) : ''
  if (copy && subject) {
    const kind = copy.kind === 'reply' ? 'generic' : copy.kind
    return t(`${NS}.single.${kind}`, { subject })
  }
  return fallback?.trim() || pendingCount(1, t)
}

/** "3 pending items". */
export function pendingCount(count: number, t: Translate): string {
  return t(`${NS}.pending`, { count })
}

type ListFormatCtor = new (language: string, options: { style: 'long'; type: 'conjunction' }) => { format(list: string[]): string }

/** "A, B and C" in the person's language (the client's TS lib predates `Intl.ListFormat`'s types). */
function joinList(parts: string[], language: string): string {
  const ListFormat = (Intl as unknown as { ListFormat?: ListFormatCtor }).ListFormat
  try {
    if (ListFormat) return new ListFormat(language, { style: 'long', type: 'conjunction' }).format(parts)
  } catch { /* an unknown language tag: the plain join below */ }
  return parts.join(', ')
}

/**
 * The summary of several items: by kind when every one is a question, an
 * approval or a review; otherwise the plain count.
 */
export function attentionSummary(copies: ReadonlyArray<AttentionCopy | undefined>, t: Translate, language: string): string {
  const count = copies.length
  const known = copies.every((copy) => !!copy && COUNTED.includes(copy.kind))
  if (count < 2 || !known) return pendingCount(count, t)
  const parts = COUNTED
    .map((kind) => ({ kind, n: copies.filter((copy) => copy?.kind === kind).length }))
    .filter((group) => group.n > 0)
    .map((group) => t(`${NS}.group.${group.kind}`, { count: group.n }))
  return t(`${NS}.breakdown`, { list: joinList(parts, language), count })
}

export interface ReturnCopyItem {
  copy?: AttentionCopy
  /** The event's own title, used when the item has no copy. */
  title?: string
  open?: () => void
}

export interface ReturnCopy {
  message: string
  action: string
  /** The single item's own place; absent when the action opens the inbox. */
  open?: () => void
}

/** The return toast: one item with a place opens it, anything else opens the inbox. */
export function attentionReturnCopy(items: ReadonlyArray<ReturnCopyItem>, t: Translate, language: string): ReturnCopy {
  if (items.length === 1) {
    const [item] = items
    const message = singleAttentionMessage(item.copy, t, item.title)
    if (item.open) return { message, action: attentionActionLabel(item.copy, t), open: item.open }
    return { message, action: t(`${NS}.openInbox`) }
  }
  return { message: attentionSummary(items.map((item) => item.copy), t, language), action: t(`${NS}.openInbox`) }
}
