import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Attachment } from '../../../types'
import { cn } from '../../../lib/utils'

interface Props {
  attachment?: Attachment
  uploading?: { name: string }
  onRemove?: () => void
  onClick?: () => void
  index?: number
  className?: string
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function iconForMime(mime: string): string {
  if (mime.startsWith('image/')) return '🖼'
  if (mime === 'application/pdf') return '📄'
  if (mime === 'text/csv' || mime.includes('spreadsheetml') || mime === 'application/vnd.ms-excel') return '📊'
  if (mime === 'application/json') return '{ }'
  if (mime === 'text/plain' || mime.includes('sql')) return '📝'
  return '📎'
}

export function AttachmentChip({ attachment, uploading, onRemove, onClick, index = 0, className }: Props) {
  const { t } = useTranslation('attachments')
  const [mounted, setMounted] = useState(false)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    const delay = Math.min(index * 50, 250)
    const t = setTimeout(() => setMounted(true), delay)
    return () => clearTimeout(t)
  }, [index])

  const name = attachment?.filename ?? uploading?.name ?? t('chip.genericFile')
  const mime = attachment?.mimeType ?? 'application/octet-stream'
  const subtitle = uploading
    ? t('chip.uploading')
    : attachment
      ? formatBytes(attachment.size)
      : ''

  function handleRemove(e: React.MouseEvent) {
    e.stopPropagation()
    setLeaving(true)
    setTimeout(() => onRemove?.(), 180)
  }

  return (
    <div
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => onClick && e.key === 'Enter' && onClick()}
      className={cn(
        'group/chip relative inline-flex items-center gap-2 pl-2 pr-1 py-1.5 rounded-lg border border-border bg-card/70 backdrop-blur-sm text-xs shadow-sm',
        'transition-all duration-200 ease-out origin-left',
        mounted && !leaving ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-[0.85] translate-y-1',
        leaving && 'max-w-0 overflow-hidden pl-0 pr-0 py-0 border-transparent ml-0 mr-0',
        onClick && 'cursor-pointer hover:border-primary/50',
        uploading && 'animate-pulse',
        className,
      )}
      style={leaving ? { maxWidth: 0 } : undefined}
    >
      <span aria-hidden className="text-sm leading-none shrink-0 w-5 text-center">
        {iconForMime(mime)}
      </span>
      <div className="flex flex-col min-w-0 mr-1">
        <span className="font-medium truncate max-w-[160px] text-foreground">{name}</span>
        <span className="text-[10px] text-muted-foreground leading-tight">{subtitle}</span>
      </div>
      {onRemove && !uploading && (
        <button
          type="button"
          onClick={handleRemove}
          aria-label={t('removeFile', { name })}
          className="ml-0.5 w-5 h-5 inline-flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
        >
          ×
        </button>
      )}
    </div>
  )
}
