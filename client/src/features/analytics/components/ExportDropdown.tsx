import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Download } from 'lucide-react'
import { toast } from 'sonner'

export interface ExportDropdownProps {
  /** Base URL for the export endpoint, e.g. `${getApiBase()}/analytics/export` */
  baseUrl: string
  /** Page-level filter params to forward */
  params?: Record<string, string>
  /** Label shown on button. Default: localized "Export" */
  label?: string
  /** Disable the button when there is no data to export */
  disabled?: boolean
}

type ExportEntry = {
  labelKey: string
  format: 'csv' | 'json'
  mode: 'summary' | 'raw'
}

const ENTRIES: ExportEntry[] = [
  { labelKey: 'export.summaryCsv', format: 'csv', mode: 'summary' },
  { labelKey: 'export.rawCsv',     format: 'csv', mode: 'raw' },
  { labelKey: 'export.summaryJson', format: 'json', mode: 'summary' },
  { labelKey: 'export.rawJson',     format: 'json', mode: 'raw' },
]

function filenameFromHeader(header: string | null): string | null {
  if (!header) return null
  const m = header.match(/filename="?([^"]+)"?/)
  return m ? m[1] : null
}

export function ExportDropdown({ baseUrl, params, label, disabled }: ExportDropdownProps) {
  const { t } = useTranslation('analytics')
  const [open, setOpen] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const buildUrl = useCallback((entry: ExportEntry): string => {
    const sp = new URLSearchParams({ format: entry.format, mode: entry.mode, ...params })
    return `${baseUrl}?${sp.toString()}`
  }, [baseUrl, params])

  const triggerDownload = useCallback(async (entry: ExportEntry) => {
    setOpen(false)
    setDownloading(true)
    try {
      const res = await fetch(buildUrl(entry))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      const fromHeader = filenameFromHeader(res.headers.get('Content-Disposition'))
      const fallback = `analytics-${entry.mode}.${entry.format}`
      anchor.download = fromHeader ?? fallback
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(objectUrl)
    } catch (err) {
      console.warn('[ExportDropdown] download failed:', err)
      toast.error(t('export.failed'))
    } finally {
      setDownloading(false)
    }
  }, [buildUrl, t])

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        disabled={downloading || disabled}
        onClick={() => setOpen((o) => !o)}
        title={disabled ? t('export.noData') : undefined}
        className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium border border-border/60 bg-card/50 text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors disabled:opacity-50 disabled:pointer-events-none"
      >
        <Download className="w-3 h-3" />
        {downloading ? t('export.downloading') : (label ?? t('common:actions.export'))}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 min-w-[180px] rounded-md border border-border/60 bg-popover shadow-md text-xs overflow-hidden"
        >
          {ENTRIES.map((entry) => (
            <button
              key={`${entry.format}-${entry.mode}`}
              role="menuitem"
              type="button"
              onClick={() => triggerDownload(entry)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-foreground hover:bg-accent/60 transition-colors"
            >
              <Download className="w-3 h-3 shrink-0" />
              <span className="flex-1">{t(entry.labelKey)}</span>
              {entry.mode === 'raw' && <span className="text-[9px] text-muted-foreground">≤10k</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
