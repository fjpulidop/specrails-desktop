import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GitPullRequest, GitFork, Loader2, X } from 'lucide-react'
import { getApiBase } from '../lib/api'

/** Explicit delivery target selected for a rail (deliver-rail-into-existing-pr). */
export interface RailTargetPr {
  number: number
  title?: string
  headRefName?: string
}

interface PrCandidate {
  number: number
  title: string
  headRefName: string
  baseRefName: string
  url: string
  isDraft: boolean
  isCrossRepository: boolean
}

interface Props {
  /** Server rail index (0-based) — feeds the candidates endpoint. */
  railIndex: number
  /** Selected target. null/undefined = new PR (legacy default). */
  value: RailTargetPr | null | undefined
  onChange: (value: RailTargetPr | null) => void
}

/**
 * Compact rail-header "deliver into existing PR" picker. Default is always
 * "New PR" (byte-identical legacy launch); candidates are display-only
 * suggestions fetched on open and NEVER auto-selected. Fork PRs render
 * disabled — their heads are not pushable with origin rights. A manual
 * PR-number field covers PRs the matchers didn't surface.
 */
export function RailTargetPrSelector({ railIndex, value, onChange }: Props) {
  const { t } = useTranslation('dashboard')
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [candidates, setCandidates] = useState<PrCandidate[] | null>(null)
  const [manual, setManual] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    fetch(`${getApiBase()}/rails/${railIndex}/pr-candidates`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`${res.status}`))))
      .then((data: { candidates?: PrCandidate[] }) => {
        if (!cancelled) setCandidates(Array.isArray(data.candidates) ? data.candidates : [])
      })
      .catch(() => { if (!cancelled) setCandidates([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, railIndex])

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (target: RailTargetPr | null) => {
    onChange(target)
    setOpen(false)
    setManual('')
  }

  const manualNumber = /^\d{1,9}$/.test(manual.trim()) ? parseInt(manual.trim(), 10) : null

  return (
    <div
      ref={rootRef}
      className="relative inline-flex items-center"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        data-testid="rail-target-pr-selector"
        title={t('targetPr.chipTitle')}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex h-5 items-center gap-1 rounded border px-1 text-[10px] transition-colors focus:outline-none focus:ring-1 focus:ring-primary/40 ${
          value
            ? 'border-accent-info/50 text-accent-info hover:text-accent-info'
            : 'border-border/50 bg-transparent text-muted-foreground hover:text-foreground'
        }`}
      >
        <GitPullRequest className="h-3 w-3" aria-hidden />
        {value ? `#${value.number}` : t('targetPr.chipNew')}
      </button>
      {value && (
        <button
          type="button"
          aria-label={t('targetPr.clear')}
          onClick={() => onChange(null)}
          className="ml-0.5 rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="h-2.5 w-2.5" aria-hidden />
        </button>
      )}

      {open && (
        <div
          role="listbox"
          aria-label={t('targetPr.chipTitle')}
          className="absolute left-0 top-6 z-50 w-72 rounded-lg border border-border bg-popover p-1.5 shadow-xl"
        >
          <button
            type="button"
            role="option"
            aria-selected={!value}
            onClick={() => pick(null)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground hover:bg-muted/60"
          >
            <GitPullRequest className="h-3 w-3 text-muted-foreground" aria-hidden />
            {t('targetPr.newPr')}
          </button>
          <div className="my-1 border-t border-border/60" />
          {loading && (
            <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              {t('targetPr.loading')}
            </div>
          )}
          {!loading && candidates !== null && candidates.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">{t('targetPr.none')}</div>
          )}
          {!loading && (candidates ?? []).map((c) => (
            <button
              key={c.number}
              type="button"
              role="option"
              aria-selected={value?.number === c.number}
              disabled={c.isCrossRepository}
              onClick={() => pick({ number: c.number, title: c.title, headRefName: c.headRefName })}
              title={c.isCrossRepository ? t('targetPr.fork') : c.url}
              className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                c.isCrossRepository
                  ? 'cursor-not-allowed text-muted-foreground/50'
                  : 'text-foreground hover:bg-muted/60'
              }`}
            >
              {c.isCrossRepository
                ? <GitFork className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                : <GitPullRequest className="mt-0.5 h-3 w-3 shrink-0 text-accent-info" aria-hidden />}
              <span className="min-w-0">
                <span className="block truncate font-medium">#{c.number} · {c.title}</span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {c.headRefName}
                  {c.isCrossRepository && ` — ${t('targetPr.fork')}`}
                </span>
              </span>
            </button>
          ))}
          <div className="my-1 border-t border-border/60" />
          <form
            className="flex items-center gap-1.5 px-1 py-1"
            onSubmit={(e) => {
              e.preventDefault()
              if (manualNumber) pick({ number: manualNumber })
            }}
          >
            <input
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              inputMode="numeric"
              placeholder={t('targetPr.manualPlaceholder')}
              aria-label={t('targetPr.manualPlaceholder')}
              className="h-6 w-full rounded border border-border/60 bg-transparent px-1.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/40"
            />
            <button
              type="submit"
              disabled={!manualNumber}
              className="h-6 shrink-0 rounded border border-border/60 px-2 text-[10px] text-muted-foreground enabled:hover:text-foreground disabled:opacity-40"
            >
              {t('targetPr.manualUse')}
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
