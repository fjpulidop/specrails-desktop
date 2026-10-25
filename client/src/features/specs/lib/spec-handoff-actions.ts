import { toast } from 'sonner'
import type { TFunction } from 'i18next'
import { getApiBase } from '../../../lib/api'
import { getActiveLanguage } from '../../../lib/i18n'
import { fetchUsageSnapshot, planProviderIds } from '../../../lib/launch-forecast'
import { saveTextFile } from '../../../lib/save-text-file'
import { writeClipboardText } from '../../../lib/tauri-clipboard'

import { notifyError } from '../../../lib/notify-error'
export type HandoffFormat = 'md' | 'html' | 'pr'

export interface HandoffDocument {
  format: HandoffFormat
  filename: string
  contentType: string
  body: string
  redactions: number
  locale: string
}

/** Providers billed through a plan, so the server shows turns for them instead of dollars. */
async function planProviders(): Promise<string[]> {
  try {
    const source = fetchUsageSnapshot()
    return planProviderIds(source.fresh ?? await source.load())
  } catch {
    return []
  }
}

export async function fetchHandoff(ticketId: number, format: HandoffFormat): Promise<HandoffDocument> {
  const params = new URLSearchParams({ format, locale: getActiveLanguage() })
  const plan = await planProviders()
  if (plan.length > 0) params.set('planProviders', plan.join(','))
  const res = await fetch(`${getApiBase()}/tickets/${ticketId}/handoff?${params.toString()}`)
  if (!res.ok) throw new Error(`handoff ${res.status}`)
  return await res.json() as HandoffDocument
}

function redactionNote(t: TFunction, count: number): string | undefined {
  return count > 0 ? t('timeline.export.redacted', { count }) : undefined
}

/** Build the hand-off (Markdown or HTML bundle) and save it through the host's save dialog. */
export async function exportHandoff(ticketId: number, format: 'md' | 'html', t: TFunction): Promise<void> {
  try {
    const doc = await fetchHandoff(ticketId, format)
    const result = await saveTextFile(doc.filename, doc.body, doc.contentType)
    if (result === 'saved') toast.success(t('timeline.export.saved', { id: ticketId }), { description: redactionNote(t, doc.redactions) })
    else if (result === 'failed') notifyError(t('timeline.export.failed'))
  } catch {
    notifyError(t('timeline.export.failed'))
  }
}

/** The concise Markdown variant, straight to the clipboard. */
export async function copyPrDescription(ticketId: number, t: TFunction): Promise<void> {
  let doc: HandoffDocument
  try {
    doc = await fetchHandoff(ticketId, 'pr')
  } catch {
    notifyError(t('timeline.export.failed'))
    return
  }
  if (await writeClipboardText(doc.body)) toast.success(t('timeline.export.copied', { id: ticketId }), { description: redactionNote(t, doc.redactions) })
  else notifyError(t('timeline.export.copyFailed'))
}
