import { Fragment, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Code2, Palette, Pipette, Network, X } from 'lucide-react'
import { domSummary, type CapturedDom } from '../../lib/browser-capture'

/** Short, readable path for a captured request URL (host + pathname, query dropped). */
function reqLabel(url: string): string {
  try {
    const u = new URL(url)
    return u.host + u.pathname
  } catch {
    return url
  }
}
import { tokenizeHtml, HL_CLASS } from '../../../../lib/html-highlight'

interface CapturedDomPanelProps {
  dom: CapturedDom
  /** Optional remove handler — when provided renders an × to drop this capture. */
  onRemove?: () => void
}

// Above this size we skip per-token highlighting (thousands of spans) and render
// plain text to keep the panel responsive.
const HIGHLIGHT_CAP = 40_000

function HighlightedHtml({ html }: { html: string }) {
  // Memoise so panel/CSS toggles (parent rerenders) don't re-tokenize + re-diff
  // thousands of spans. `null` signals "too big to highlight" → render plain.
  const tokens = useMemo(() => (html.length > HIGHLIGHT_CAP ? null : tokenizeHtml(html)), [html])
  if (!tokens) return <>{html}</>
  return (
    <>
      {tokens.map((t, i) => (
        <span key={i} className={HL_CLASS[t.type]}>{t.text}</span>
      ))}
    </>
  )
}

/**
 * Collapsible, scrollable panel showing the DOM (and applied CSS) captured for a
 * browser selection. Collapsed by default (a non-technical user never has to look
 * at HTML), but the captured markup — syntax-highlighted — and the matched CSS are
 * one click away and travel to the AI as an attachment.
 */
export function CapturedDomPanel({ dom, onRemove }: CapturedDomPanelProps) {
  const { t } = useTranslation('browser')
  const [openPanel, setOpenPanel] = useState(false)
  const [openCss, setOpenCss] = useState(false)
  const [openTokens, setOpenTokens] = useState(false)
  const [openNet, setOpenNet] = useState(false)
  const [copied, setCopied] = useState(false)
  const summary = domSummary(dom)
  const tokens = dom.designTokens
  const anchorRows = tokens ? Object.entries(tokens.anchor) : []
  const hasTokens = !!tokens && (tokens.palette.length > 0 || anchorRows.length > 0)
  const requests = dom.networkRequests ?? []
  const hasNetwork = requests.length > 0
  const host = (() => {
    try { return new URL(dom.url).host } catch { return dom.url }
  })()

  const copyTokens = () => {
    try {
      void navigator.clipboard?.writeText(JSON.stringify(tokens, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable (non-secure context / jsdom) — ignore */
    }
  }

  return (
    <div className="rounded-lg border border-accent-secondary/40 bg-accent-secondary/5 text-xs">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpenPanel((v) => !v)}
          aria-expanded={openPanel}
          className="flex items-center gap-2 flex-1 min-w-0 text-left text-foreground/90 hover:text-foreground transition-colors"
        >
          <ChevronRight className={`w-3.5 h-3.5 shrink-0 transition-transform ${openPanel ? 'rotate-90' : ''}`} />
          <Code2 className="w-3.5 h-3.5 shrink-0 text-accent-secondary" />
          <span className="truncate font-medium">{t('domPanel.header', { title: dom.title || host })}</span>
        </button>
        <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
          {t('domPanel.badge.elements', { count: summary.nodeCount })}{dom.css ? ' · CSS' : ''}{hasTokens ? ` · ${t('domPanel.badge.tokens')}` : ''}{hasNetwork ? ` · ${t('domPanel.badge.requests', { count: requests.length })}` : ''}{summary.truncated ? ` · ${t('domPanel.badge.truncated')}` : ''}
        </span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={t('domPanel.removeLabel')}
            className="shrink-0 text-muted-foreground/60 hover:text-destructive transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {openPanel && (
        <div className="border-t border-accent-secondary/30">
          <div className="px-3 py-1.5 text-[10px] text-muted-foreground truncate" title={dom.url}>
            {dom.url}
          </div>
          <pre
            className="max-h-64 overflow-auto px-3 pb-3 text-[11px] leading-relaxed whitespace-pre-wrap break-words font-mono"
            data-testid="captured-dom-html"
          >
            {dom.html ? <HighlightedHtml html={dom.html} /> : t('domPanel.noMarkup')}
          </pre>
          {dom.css && (
            <div className="border-t border-accent-secondary/30">
              <button
                type="button"
                onClick={() => setOpenCss((v) => !v)}
                aria-expanded={openCss}
                className="flex items-center gap-2 w-full px-3 py-2 text-left text-foreground/90 hover:text-foreground transition-colors"
              >
                <ChevronRight className={`w-3.5 h-3.5 shrink-0 transition-transform ${openCss ? 'rotate-90' : ''}`} />
                <Palette className="w-3.5 h-3.5 shrink-0 text-accent-highlight" />
                <span className="font-medium">{dom.cssTruncated ? t('domPanel.appliedCssTruncated') : t('domPanel.appliedCss')}</span>
              </button>
              {openCss && (
                <pre
                  className="max-h-64 overflow-auto px-3 pb-3 text-[11px] leading-relaxed whitespace-pre-wrap break-words font-mono text-accent-success/90"
                  data-testid="captured-dom-css"
                >
                  {dom.css}
                </pre>
              )}
            </div>
          )}
          {hasTokens && tokens && (
            <div className="border-t border-accent-secondary/30">
              <button
                type="button"
                onClick={() => setOpenTokens((v) => !v)}
                aria-expanded={openTokens}
                className="flex items-center gap-2 w-full px-3 py-2 text-left text-foreground/90 hover:text-foreground transition-colors"
              >
                <ChevronRight className={`w-3.5 h-3.5 shrink-0 transition-transform ${openTokens ? 'rotate-90' : ''}`} />
                <Pipette className="w-3.5 h-3.5 shrink-0 text-accent-highlight" />
                <span className="font-medium">{t('domPanel.designTokens')}</span>
              </button>
              {openTokens && (
                <div className="px-3 pb-3 space-y-2" data-testid="captured-dom-tokens">
                  {tokens.palette.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {tokens.palette.map((c, i) => (
                        <span
                          key={i}
                          className="inline-flex items-center gap-1 rounded border border-border/50 px-1.5 py-0.5 font-mono text-[10px] text-foreground/80"
                        >
                          {/* Swatch colour is captured data (not a layout/brand token) → inline style is intentional. */}
                          <span className="inline-block w-3 h-3 rounded-sm border border-border/40" style={{ background: c }} aria-hidden />
                          {c}
                        </span>
                      ))}
                    </div>
                  )}
                  {anchorRows.length > 0 && (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
                      {anchorRows.map(([k, v]) => (
                        <Fragment key={k}>
                          <dt className="text-muted-foreground">{k}</dt>
                          <dd className="text-accent-success/90 break-all">{v}</dd>
                        </Fragment>
                      ))}
                    </dl>
                  )}
                  {tokens.fonts.length > 0 && (
                    <div className="text-[11px] text-muted-foreground">
                      {t('domPanel.fonts')} <span className="font-mono text-foreground/80 break-all">{tokens.fonts.join(', ')}</span>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={copyTokens}
                    className="text-[10px] text-accent-info hover:underline"
                  >
                    {copied ? t('domPanel.copied') : t('domPanel.copyJson')}
                  </button>
                </div>
              )}
            </div>
          )}
          {hasNetwork && (
            <div className="border-t border-accent-secondary/30">
              <button
                type="button"
                onClick={() => setOpenNet((v) => !v)}
                aria-expanded={openNet}
                className="flex items-center gap-2 w-full px-3 py-2 text-left text-foreground/90 hover:text-foreground transition-colors"
              >
                <ChevronRight className={`w-3.5 h-3.5 shrink-0 transition-transform ${openNet ? 'rotate-90' : ''}`} />
                <Network className="w-3.5 h-3.5 shrink-0 text-accent-info" />
                <span className="font-medium">{t('domPanel.network', { count: requests.length })}</span>
              </button>
              {openNet && (
                <div className="max-h-64 overflow-auto px-3 pb-3 space-y-1.5" data-testid="captured-dom-network">
                  {requests.map((r, i) => (
                    <div key={i} className="font-mono text-[11px] leading-snug">
                      <div className="flex items-baseline gap-2">
                        <span className="text-accent-highlight shrink-0">{r.method}</span>
                        <span className={`shrink-0 tabular-nums ${r.failed ? 'text-destructive' : (r.status ?? 0) >= 400 ? 'text-accent-warning' : 'text-accent-success/90'}`}>
                          {r.failed ? 'ERR' : r.status ?? '…'}
                        </span>
                        <span className="truncate flex-1 text-foreground/80" title={r.url}>{reqLabel(r.url)}</span>
                        {r.durationMs != null && <span className="shrink-0 text-muted-foreground tabular-nums">{r.durationMs}ms</span>}
                      </div>
                      {r.responseShape && (
                        <div className="pl-4 text-accent-info/80 break-all whitespace-pre-wrap">→ {r.responseShape}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
