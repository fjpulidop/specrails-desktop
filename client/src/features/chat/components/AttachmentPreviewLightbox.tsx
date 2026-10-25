import { useCallback, useEffect, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Download } from 'lucide-react'
import type { Attachment } from '../../../types'
import { fetchAttachmentBlob } from '../lib/attachments'
import { cn } from '../../../lib/utils'
import { DIALOG_LAYER_CLASS } from '../../../lib/layers'
import { DialogLayerProvider } from '../../../components/ui/dialog'

export interface MediaLightboxProps {
  /** Whether the lightbox is shown. */
  open: boolean
  onClose: () => void
  /** Visible title (and accessible name): the file name or image caption. */
  filename: string
  /** Secondary line under the title (mime type, size…). */
  subtitle?: string
  /**
   * What to show: an object URL or any plain image `src`. `null` while it is
   * still loading (shows the loading state unless `error` is set).
   */
  src: string | null
  /** Picks the viewer: `image/*` → <img>, PDF → <iframe>, else a download card. Default `image/*`. */
  mimeType?: string
  /** Load failure message; replaces the viewer. */
  error?: string | null
  /** `download` attribute of the download link (defaults to `filename`). Pass `false` to hide it. */
  download?: string | false
}

/**
 * Full-bleed media viewer (modal standard, `media` layer 100, media scrim).
 * A Radix dialog: focus is trapped, Escape closes only this top layer and
 * focus returns to the trigger. Clicking empty space around the media closes
 * it. Reusable for any image `src` — `AttachmentPreviewLightbox` wraps it for
 * ticket attachments (it fetches the blob first).
 */
export function MediaLightbox({
  open,
  onClose,
  filename,
  subtitle,
  src,
  mimeType = 'image/*',
  error = null,
  download,
}: MediaLightboxProps) {
  const { t } = useTranslation('attachments')
  const isImage = mimeType.startsWith('image/')
  const isPdf = mimeType === 'application/pdf'
  const downloadName = download === false ? null : (download ?? filename)

  // Focus return: no Radix `DialogTrigger` here, so remember the opener.
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const capturePanel = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== document.body && !node.contains(active)) {
      returnFocusRef.current = active
    }
  }, [])

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn('modal-scrim fixed inset-0 bg-scrim-media backdrop-blur-sm', DIALOG_LAYER_CLASS.media)}
        />
        <DialogPrimitive.Content
          ref={capturePanel}
          data-dialog-layer="media"
          onCloseAutoFocus={(e) => {
            const target = returnFocusRef.current
            returnFocusRef.current = null
            if (target?.isConnected) { e.preventDefault(); target.focus() }
          }}
          className={cn('modal-scrim fixed inset-0 flex flex-col outline-none', DIALOG_LAYER_CLASS.media)}
          onClick={onClose}
        >
          <DialogLayerProvider layer="media">
            {/* Top bar */}
            <div
              className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-black/40"
              onClick={(e) => e.stopPropagation()}
            >
              <DialogPrimitive.Close
                aria-label={t('lightbox.backToDesktop')}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm text-white/85 hover:bg-white/10 hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              >
                <ArrowLeft className="w-4 h-4" aria-hidden />
                {t('common:actions.back')}
              </DialogPrimitive.Close>
              <div className="flex-1 text-center min-w-0 px-4">
                <DialogPrimitive.Title className="text-sm font-medium text-white/95 truncate">{filename}</DialogPrimitive.Title>
                {subtitle ? (
                  <DialogPrimitive.Description className="text-xs text-white/70">{subtitle}</DialogPrimitive.Description>
                ) : (
                  <DialogPrimitive.Description className="sr-only">{t('lightbox.preview', { name: filename })}</DialogPrimitive.Description>
                )}
              </div>
              {downloadName !== null ? (
                <a
                  href={src ?? '#'}
                  download={downloadName}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (!src) e.preventDefault()
                  }}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm text-white/85 hover:bg-white/10 hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                  aria-label={t('lightbox.download')}
                >
                  <Download className="w-4 h-4" aria-hidden />
                  {t('lightbox.download')}
                </a>
              ) : <span className="w-px" aria-hidden />}
            </div>

            {/* Body — empty space closes; the media itself does not. */}
            <div className="flex-1 flex items-center justify-center overflow-auto p-6">
              {error ? (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="text-center text-white/80 px-8 py-10 rounded-lg bg-white/5 border border-white/10"
                >
                  <p className="text-sm">{t('lightbox.loadError', { error })}</p>
                </div>
              ) : !src ? (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="text-center text-white/70 px-8 py-10 rounded-lg bg-white/5 border border-white/10"
                >
                  <p className="text-sm">{t('lightbox.loading')}</p>
                </div>
              ) : isImage ? (
                <img
                  src={src}
                  alt={filename}
                  onClick={(e) => e.stopPropagation()}
                  className="modal-enter max-h-full max-w-full rounded-lg object-contain shadow-xl"
                />
              ) : isPdf ? (
                <iframe
                  src={src}
                  title={filename}
                  onClick={(e) => e.stopPropagation()}
                  className="w-full h-full max-w-5xl bg-white rounded-lg shadow-xl"
                />
              ) : (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="text-center text-white/80 px-8 py-10 rounded-lg bg-white/5 border border-white/10"
                >
                  <p className="text-sm mb-3">{t('lightbox.previewUnavailable')}</p>
                  <a
                    href={src}
                    download={downloadName ?? filename}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-white/10 hover:bg-white/20 text-white transition-colors"
                  >
                    <Download className="w-4 h-4" aria-hidden />
                    {t('lightbox.downloadFile', { name: filename })}
                  </a>
                </div>
              )}
            </div>
          </DialogLayerProvider>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

interface Props {
  ticketKey: string | number
  attachment: Attachment | null
  onClose: () => void
}

/** Ticket-attachment preview: fetches the blob, then shows it in `MediaLightbox`. */
export function AttachmentPreviewLightbox({ ticketKey, attachment, onClose }: Props) {
  const { t } = useTranslation('attachments')
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!attachment) {
      setObjectUrl(null)
      setLoadError(null)
      return
    }

    let disposed = false
    setObjectUrl(null)
    setLoadError(null)
    fetchAttachmentBlob(ticketKey, attachment.id)
      .then((blob) => {
        if (disposed) return
        setObjectUrl(URL.createObjectURL(blob))
      })
      .catch((err) => {
        if (disposed) return
        setLoadError(err instanceof Error ? err.message : t('errors.loadFailed'))
      })

    return () => {
      disposed = true
    }
  }, [attachment, ticketKey])

  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [objectUrl])

  return (
    <MediaLightbox
      open={attachment !== null}
      onClose={onClose}
      filename={attachment?.filename ?? ''}
      subtitle={attachment?.mimeType}
      mimeType={attachment?.mimeType}
      src={objectUrl}
      error={loadError}
    />
  )
}
