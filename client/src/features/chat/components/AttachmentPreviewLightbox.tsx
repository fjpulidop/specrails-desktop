import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Download } from 'lucide-react'
import type { Attachment } from '../../../types'
import { fetchAttachmentBlob } from '../lib/attachments'
import { cn } from '../../../lib/utils'

interface Props {
  ticketKey: string | number
  attachment: Attachment | null
  onClose: () => void
}

export function AttachmentPreviewLightbox({ ticketKey, attachment, onClose }: Props) {
  const { t } = useTranslation('attachments')
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!attachment) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [attachment, onClose])

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

  if (!attachment) return null

  const isImage = attachment.mimeType.startsWith('image/')
  const isPdf = attachment.mimeType === 'application/pdf'

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('lightbox.preview', { name: attachment.filename })}
      className="fixed inset-0 z-[100] flex flex-col bg-black/85 backdrop-blur-sm animate-in fade-in-0 duration-200"
      onClick={onClose}
    >
      {/* Top bar */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-black/40"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t('lightbox.backToDesktop')}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm text-white/85 hover:bg-white/10 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          {t('common:actions.back')}
        </button>
        <div className="flex-1 text-center min-w-0 px-4">
          <div className="text-sm font-medium text-white/95 truncate">{attachment.filename}</div>
          <div className="text-[11px] text-white/50">{attachment.mimeType}</div>
        </div>
        <a
          href={objectUrl ?? '#'}
          download={attachment.filename}
          onClick={(e) => {
            e.stopPropagation()
            if (!objectUrl) e.preventDefault()
          }}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm text-white/85 hover:bg-white/10 hover:text-white transition-colors"
          aria-label={t('lightbox.download')}
        >
          <Download className="w-4 h-4" />
          {t('lightbox.download')}
        </a>
      </div>

      {/* Body */}
      <div
        className={cn('flex-1 flex items-center justify-center overflow-auto p-6')}
        onClick={onClose}
      >
        {loadError ? (
          <div
            onClick={(e) => e.stopPropagation()}
            className="text-center text-white/80 px-8 py-10 rounded-lg bg-white/5 border border-white/10"
          >
            <p className="text-sm">{t('lightbox.loadError', { error: loadError })}</p>
          </div>
        ) : !objectUrl ? (
          <div
            onClick={(e) => e.stopPropagation()}
            className="text-center text-white/70 px-8 py-10 rounded-lg bg-white/5 border border-white/10"
          >
            <p className="text-sm">{t('lightbox.loading')}</p>
          </div>
        ) : isImage ? (
          <img
            src={objectUrl}
            alt={attachment.filename}
            onClick={(e) => e.stopPropagation()}
            className="max-h-full max-w-full rounded-lg shadow-2xl animate-in zoom-in-95 duration-200"
          />
        ) : isPdf ? (
          <iframe
            src={objectUrl}
            title={attachment.filename}
            onClick={(e) => e.stopPropagation()}
            className="w-full h-full max-w-5xl bg-white rounded-lg shadow-2xl"
          />
        ) : (
          <div
            onClick={(e) => e.stopPropagation()}
            className="text-center text-white/80 px-8 py-10 rounded-lg bg-white/5 border border-white/10"
          >
            <p className="text-sm mb-3">{t('lightbox.previewUnavailable')}</p>
            <a
              href={objectUrl}
              download={attachment.filename}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-white/10 hover:bg-white/20 text-white transition-colors"
            >
              <Download className="w-4 h-4" />
              {t('lightbox.downloadFile', { name: attachment.filename })}
            </a>
          </div>
        )}
      </div>
    </div>
  )
}
