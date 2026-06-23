import { getApiBase } from './api'
import i18n from './i18n'
import type { Attachment } from '../types'

export async function uploadAttachment(
  ticketKey: string | number,
  file: File,
  signal?: AbortSignal,
): Promise<Attachment> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${getApiBase()}/tickets/${ticketKey}/attachments`, {
    method: 'POST',
    body: form,
    signal,
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? i18n.t('attachments:errors.uploadFailed', { status: res.status }))
  }
  const data = (await res.json()) as { attachment: Attachment }
  return data.attachment
}

export async function deleteAttachment(ticketKey: string | number, attachmentId: string): Promise<void> {
  const res = await fetch(`${getApiBase()}/tickets/${ticketKey}/attachments/${attachmentId}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) {
    throw new Error(i18n.t('attachments:errors.deleteFailed', { status: res.status }))
  }
}

export async function deleteAllAttachments(ticketKey: string | number): Promise<void> {
  const res = await fetch(`${getApiBase()}/tickets/${ticketKey}/attachments`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) {
    throw new Error(i18n.t('attachments:errors.bulkDeleteFailed', { status: res.status }))
  }
}

export async function listAttachments(ticketKey: string | number): Promise<Attachment[]> {
  const res = await fetch(`${getApiBase()}/tickets/${ticketKey}/attachments`)
  if (!res.ok) throw new Error(i18n.t('attachments:errors.listFailed', { status: res.status }))
  const data = (await res.json()) as { attachments: Attachment[] }
  return data.attachments
}

export function attachmentFileUrl(ticketKey: string | number, attachmentId: string): string {
  return `${getApiBase()}/tickets/${ticketKey}/attachments/${attachmentId}`
}

export async function fetchAttachmentBlob(ticketKey: string | number, attachmentId: string): Promise<Blob> {
  const res = await fetch(attachmentFileUrl(ticketKey, attachmentId))
  if (!res.ok) throw new Error(i18n.t('attachments:errors.fetchFailed', { status: res.status }))
  return res.blob()
}

export const ATTACHMENT_ACCEPT_MIME =
  'image/jpeg,image/png,image/gif,image/webp,application/pdf,text/csv,text/plain,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/sql,application/x-sql,text/sql,text/x-sql,.sql'

const SUPPORTED_ATTACHMENT_MIMES = new Set(
  ATTACHMENT_ACCEPT_MIME.split(',').filter((part) => !part.startsWith('.')),
)
const SQL_EXTENSION_RE = /\.sql$/i
// Accept images by file extension even when the browser reports an empty or
// non-canonical MIME (e.g. Windows reporting a PNG as `image/x-png`, or some
// drag sources providing an empty `file.type`). This mirrors the server's
// normalizeUploadedMimeType fallback so the client never blocks a file the
// server would accept — the root cause of "won't let me add .png".
const IMAGE_EXTENSION_RE = /\.(png|jpe?g|gif|webp)$/i

export function isSupportedAttachmentFile(file: Pick<File, 'name' | 'type'>): boolean {
  return (
    SUPPORTED_ATTACHMENT_MIMES.has(file.type) ||
    SQL_EXTENSION_RE.test(file.name) ||
    IMAGE_EXTENSION_RE.test(file.name)
  )
}
