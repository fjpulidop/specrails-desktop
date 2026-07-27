import { useEffect, useState } from 'react'
import { Paperclip, X, Loader2 } from 'lucide-react'
import { fetchAgentAttachmentBlob, type AgentAttachment } from '../../lib/agent-api'

function isImageAttachment(attachment: AgentAttachment): boolean {
  return attachment.mimeType.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(attachment.filename)
}

/**
 * Composer attachment chip. Images (uploads AND browser captures) render as a
 * real THUMBNAIL — the visual confirmation that the capture landed — with a
 * hover remove button; other files keep the compact paperclip pill. The
 * preview blob is fetched through the authenticated API (same pattern as the
 * message lightbox — a plain <img src> would bypass auth) and its object URL
 * is revoked on unmount.
 */
export function AgentComposerAttachmentChip({
  conversationId,
  attachment,
  removeLabel,
  onRemove,
}: {
  /** Attachments always belong to a real conversation; null only in exotic
   *  draft states — those fall back to the pill (no fetchable preview). */
  conversationId: string | null
  attachment: AgentAttachment
  removeLabel: string
  onRemove: () => void
}) {
  const image = isImageAttachment(attachment) && conversationId !== null
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!image || !conversationId) return
    let disposed = false
    let url: string | null = null
    fetchAgentAttachmentBlob(conversationId, attachment.id)
      .then((blob) => {
        if (disposed) return
        url = URL.createObjectURL(blob)
        setObjectUrl(url)
      })
      .catch(() => {
        if (!disposed) setFailed(true)
      })
    return () => {
      disposed = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [image, conversationId, attachment.id])

  if (image && !failed) {
    return (
      <span
        className="group relative inline-flex h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-border/60 bg-surface/70"
        title={attachment.filename}
        data-testid="composer-attachment-thumb"
      >
        {objectUrl ? (
          <img src={objectUrl} alt={attachment.filename} className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-foreground/40" />
          </span>
        )}
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
        >
          <X className="h-3 w-3" />
        </button>
      </span>
    )
  }

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-surface/70 px-2 py-0.5 text-[11px] text-foreground/80"
      data-testid="composer-attachment-pill"
    >
      <Paperclip className="h-3 w-3 text-accent-primary" />
      <span className="max-w-[160px] truncate">{attachment.filename}</span>
      <button type="button" onClick={onRemove} aria-label={removeLabel} className="rounded-sm hover:bg-muted">
        <X className="h-3 w-3" />
      </button>
    </span>
  )
}
