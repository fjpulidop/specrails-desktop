import { useEffect, useMemo, useRef, useState } from 'react'
import { RailTrack } from '../../../components/brand/RailTrack'
import { useTranslation } from 'react-i18next'
import { AlertCircle, ArrowDownToLine, ArrowLeft, Check, Copy, Download, Loader2, Pause, Play, Search, Square, Terminal } from 'lucide-react'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { backgroundProcessKey, getBackgroundProcessLogs } from '../lib/background-processes-api'
import { isBackgroundProcessFinished, useBackgroundProcessElapsed } from './BackgroundProcessChip'
import { BackgroundProcessAppLinks } from './BackgroundProcessAppLinks'
import type { BackgroundProcess } from '../../../types'

type LogLine = Awaited<ReturnType<typeof getBackgroundProcessLogs>>['lines'][number]
type ProcessView = BackgroundProcess & { stopError?: string }
const MAX_LINES = 2000
const MAX_VIEW_CHARS = 512 * 1024
const POLL_MS = 1000

/** Output is always plain text. Remove terminal controls, including OSC links
 * and incomplete escape sequences, before rendering, searching or exporting. */
export function sanitizeBackgroundLog(value: string): string {
  return value
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b[PX^_][\s\S]*?(?:\x1b\\|$)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][0-2A-Z]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}

/** Independently bound the retained text and DOM even if a server response is
 * oversized. Partial lines keep their sequence and are replaced by snapshots. */
export function boundedBackgroundLogs(lines: readonly LogLine[]): { lines: LogLine[]; truncated: boolean } {
  const retained: LogLine[] = []
  let chars = 0
  let truncated = lines.length > MAX_LINES
  for (let index = lines.length - 1; index >= 0 && retained.length < MAX_LINES; index--) {
    const entry = lines[index]
    const cleaned = sanitizeBackgroundLog(entry.line)
    const line = cleaned.slice(-4000)
    if (cleaned.length > line.length) truncated = true
    if (chars + line.length > MAX_VIEW_CHARS) { truncated = true; break }
    chars += line.length
    retained.push({ ...entry, line })
  }
  return { lines: retained.reverse(), truncated }
}

function formatLogLine(entry: LogLine, locale?: string): string {
  const at = new Date(entry.at)
  return `[${Number.isNaN(at.getTime()) ? '—' : at.toLocaleTimeString(locale, { hour12: false })}] [${entry.source}] ${entry.line}`
}

export function BackgroundProcessLogsModal({ process, onClose, onKill, onBack }: {
  process: ProcessView
  onClose: () => void
  onKill: (process: BackgroundProcess) => Promise<void> | void
  onBack?: () => void
}) {
  // A new process gets a fresh component even if its OS PID was reused.
  return <BackgroundProcessLogs key={backgroundProcessKey(process)} process={process} onClose={onClose} onKill={onKill} onBack={onBack} />
}

function BackgroundProcessLogs({ process, onClose, onKill, onBack }: {
  process: ProcessView
  onClose: () => void
  onKill: (process: BackgroundProcess) => Promise<void> | void
  onBack?: () => void
}) {
  const { t, i18n } = useTranslation('agent')
  const scope = backgroundProcessKey(process)
  const processRef = useRef(process)
  processRef.current = process
  const [snapshot, setSnapshot] = useState<BackgroundProcess>(process)
  const [lines, setLines] = useState<LogLine[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [paused, setPaused] = useState(false)
  const [follow, setFollow] = useState(true)
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<'all' | 'stdout' | 'stderr'>('all')
  const [retry, setRetry] = useState(0)
  const [stopping, setStopping] = useState(false)
  const [stopFailed, setStopFailed] = useState(false)
  const [exportState, setExportState] = useState<'copied' | 'failed' | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(true)
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])
  // A final websocket update is authoritative while a log request is in flight.
  const displayedProcess = isBackgroundProcessFinished(process) ? process
    : isBackgroundProcessFinished(snapshot) ? snapshot : process.status === 'stopping' && snapshot.status !== 'stopping' ? process : snapshot
  const finished = isBackgroundProcessFinished(displayedProcess)
  useEffect(() => { if (finished) setPaused(false) }, [finished])
  const busy = stopping || displayedProcess.status === 'stopping' && !displayedProcess.error && !process.stopError
  const elapsed = useBackgroundProcessElapsed(displayedProcess)

  useEffect(() => {
    if (paused) { setLoading(false); return }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const response = await getBackgroundProcessLogs(processRef.current, { limit: MAX_LINES, signal: controller.signal })
        if (controller.signal.aborted) return
        if (backgroundProcessKey(response.process) !== scope) throw new Error('Unexpected process identity')
        const bounded = boundedBackgroundLogs(response.lines)
        setSnapshot(previous => JSON.stringify(previous) === JSON.stringify(response.process) ? previous : response.process)
        setLines(previous => previous.length === bounded.lines.length && previous.every((entry, index) => {
          const next = bounded.lines[index]
          return entry.sequence === next.sequence && entry.line === next.line && entry.source === next.source && entry.at === next.at && entry.partial === next.partial
        }) ? previous : bounded.lines)
        setTruncated(response.truncated || bounded.truncated)
        setFailed(false)
        setLoading(false)
        if (!isBackgroundProcessFinished(response.process)) timer = setTimeout(() => { void refresh() }, POLL_MS)
      } catch {
        if (controller.signal.aborted) return
        setLoading(false); setFailed(true)
      }
    }
    setLoading(true); setFailed(false)
    void refresh()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [scope, paused, retry])

  useEffect(() => {
    if (!exportState) return
    const timer = setTimeout(() => setExportState(null), 2500)
    return () => clearTimeout(timer)
  }, [exportState])

  const filtered = useMemo(() => {
    const needle = query.toLocaleLowerCase()
    return lines.filter(entry => (source === 'all' || source === entry.source) && (!needle || entry.line.toLocaleLowerCase().includes(needle)))
  }, [lines, query, source])
  const visibleText = useMemo(() => filtered.map(entry => formatLogLine(entry, i18n.language)).join('\n'), [filtered, i18n.language])
  useEffect(() => {
    if (follow && !paused && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [filtered, follow, paused])

  const stop = async () => {
    if (busy || finished) return
    setStopping(true); setStopFailed(false)
    try { await onKill(processRef.current) }
    catch { if (mountedRef.current) setStopFailed(true) }
    finally { if (mountedRef.current) setStopping(false) }
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(visibleText); if (mountedRef.current) setExportState('copied') }
    catch { if (mountedRef.current) setExportState('failed') }
  }
  const download = () => {
    let url: string | undefined
    try {
      url = URL.createObjectURL(new Blob([visibleText], { type: 'text/plain;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `process-${process.pid}-${process.startedAt}.log`
      document.body.appendChild(link); link.click(); link.remove()
    } catch { setExportState('failed') }
    finally { if (url) URL.revokeObjectURL(url) }
  }
  const control = 'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border/60 px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:cursor-not-allowed disabled:opacity-40'

  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    {/* Capture layer: process logs open over the browser capture / web view surfaces. */}
    <DialogContent size="workspace" layer="capture" data-testid="background-process-logs-modal">
      <DialogHeader icon={<Terminal className="text-accent-info" />}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {onBack && <button type="button" onClick={onBack} aria-label={t('backgroundProcess.history.back')} title={t('backgroundProcess.history.back')} className="-ml-1 rounded-md p-1 text-muted-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"><ArrowLeft className="h-4 w-4" aria-hidden /></button>}
          <DialogTitle>{t('backgroundProcess.logsTitle')}</DialogTitle>
          <span data-testid="background-process-status" data-chip="" className={`inline-flex h-5 items-center rounded-full px-2 text-caption ${displayedProcess.status === 'failed' ? 'bg-destructive/10 text-destructive' : finished ? 'bg-muted text-muted-foreground' : 'bg-accent-info/10 text-accent-info'}`}>
            {t(`backgroundProcess.status.${busy ? 'stopping' : displayedProcess.status}`)}
          </span>
          <span className="font-mono text-xs text-muted-foreground">{elapsed}</span>
        </div>
        <DialogDescription>{t('backgroundProcess.logsDescription')}</DialogDescription>
      </DialogHeader>
      <dl className="grid shrink-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-border/50 px-5 py-3 text-xs">
        <dt className="text-muted-foreground">{t('backgroundProcess.command')}</dt><dd className="break-all font-mono">{sanitizeBackgroundLog(displayedProcess.command)}</dd>
        <dt className="text-muted-foreground">{t('backgroundProcess.directory')}</dt><dd className="break-all font-mono text-muted-foreground">{sanitizeBackgroundLog(displayedProcess.cwd)}</dd>
        {(displayedProcess.repositoryName || displayedProcess.repositoryId) && <><dt className="text-muted-foreground">{t('backgroundProcess.repository')}</dt><dd className="break-all text-muted-foreground">{sanitizeBackgroundLog(displayedProcess.repositoryName ?? displayedProcess.repositoryId ?? '')}</dd></>}
        <dt className="text-muted-foreground">PID</dt><dd className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-muted-foreground"><span>{displayedProcess.pid}</span>{displayedProcess.exitCode != null && <span>{t('backgroundProcess.exitCode', { code: displayedProcess.exitCode })}</span>}{displayedProcess.signal && <span>{t('backgroundProcess.signal', { signal: displayedProcess.signal })}</span>}</dd>
      </dl>
      {!finished && <BackgroundProcessAppLinks process={displayedProcess.appUrls ? displayedProcess : process} />}
      {displayedProcess.error && <p role="alert" className="shrink-0 border-b border-border/40 bg-destructive/5 px-5 py-2 text-xs text-destructive">{sanitizeBackgroundLog(displayedProcess.error).slice(0, 1000)}</p>}
      {displayedProcess.status === 'interrupted' && <p role="status" className="shrink-0 border-b border-border/40 bg-accent-warning/5 px-5 py-2 text-xs text-accent-warning">{t('backgroundProcess.interruptedHint')}</p>}
      {displayedProcess.persistenceError && <p role="alert" className="shrink-0 border-b border-border/40 bg-accent-warning/5 px-5 py-2 text-xs text-accent-warning">{t('backgroundProcess.persistenceFailed')}</p>}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/50 px-5 py-2.5">
        <label className="relative min-w-[150px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" aria-hidden />
          <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('backgroundProcess.search')} aria-label={t('backgroundProcess.search')}
            className="h-8 w-full rounded-md border border-border/60 bg-background/50 pl-8 pr-2 text-xs outline-none focus:border-accent-primary/60" />
        </label>
        <select aria-label={t('backgroundProcess.source')} value={source} onChange={event => setSource(event.target.value as typeof source)} className="h-8 rounded-md border border-border/60 bg-background px-2 text-xs outline-none focus:border-accent-primary/60">
          <option value="all">{t('backgroundProcess.allSources')}</option><option value="stdout">stdout</option><option value="stderr">stderr</option>
        </select>
        {!finished && <button type="button" className={control} aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? <Play className="h-3.5 w-3.5" aria-hidden /> : <Pause className="h-3.5 w-3.5" aria-hidden />}{t(paused ? 'backgroundProcess.resume' : 'backgroundProcess.pause')}</button>}
        <button type="button" className={`${control} ${follow ? 'border-accent-info/40 text-accent-info' : ''}`} aria-pressed={follow} onClick={() => setFollow(value => !value)}><ArrowDownToLine className="h-3.5 w-3.5" aria-hidden />{t('backgroundProcess.follow')}</button>
        <button type="button" className={control} disabled={!filtered.length} onClick={() => void copy()} aria-label={t('backgroundProcess.copy')} title={t('backgroundProcess.copy')}>{exportState === 'copied' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}</button>
        <button type="button" className={control} disabled={!filtered.length} onClick={download} aria-label={t('backgroundProcess.download')} title={t('backgroundProcess.download')}><Download className="h-3.5 w-3.5" /></button>
        {!finished && <button type="button" className={`${control} text-destructive`} disabled={busy} onClick={() => void stop()}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Square className="h-3.5 w-3.5" aria-hidden />}{t(busy ? 'backgroundProcess.status.stopping' : 'backgroundProcess.stop')}</button>}
      </div>
      {truncated && <p role="status" className="shrink-0 border-b border-border/40 bg-accent-warning/5 px-5 py-2 text-xs text-accent-warning">{t('backgroundProcess.truncated')}</p>}
      {paused && !finished && <p role="status" className="shrink-0 border-b border-border/40 bg-muted/20 px-5 py-2 text-xs text-muted-foreground">{t('backgroundProcess.paused')}</p>}
      {failed && <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-border/40 bg-destructive/5 px-5 py-2 text-xs text-destructive"><AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden /><span className="flex-1">{t('backgroundProcess.loadFailed')}</span><button type="button" className={control} onClick={() => { setPaused(false); setRetry(value => value + 1) }}>{t('backgroundProcess.retry')}</button></div>}
      {(stopFailed || process.stopError) && <p role="alert" className="shrink-0 bg-destructive/5 px-5 py-2 text-xs text-destructive">{t('backgroundProcess.stopFailed')}</p>}
      {exportState && <p role={exportState === 'failed' ? 'alert' : 'status'} className="shrink-0 px-5 py-1 text-xs text-muted-foreground">{t(exportState === 'copied' ? 'backgroundProcess.copied' : 'backgroundProcess.exportFailed')}</p>}
      <DialogBody ref={listRef} data-testid="background-process-log-output" aria-label={t('backgroundProcess.output')} role="region" tabIndex={0}
        onScroll={event => { const node = event.currentTarget; if (node.scrollHeight - node.clientHeight - node.scrollTop > 40) setFollow(false) }}
        className="overflow-auto bg-background/80 px-3 py-3 font-mono text-xs leading-5 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-primary/50">
        {loading && !lines.length ? <p role="status" className="flex items-center justify-center gap-2 py-12 text-muted-foreground"><span aria-hidden className="w-16 shrink-0"><RailTrack running /></span>{t('backgroundProcess.loading')}</p> : filtered.length ? filtered.map(entry => <div key={entry.sequence} data-log-source={entry.source} className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-x-2 hover:bg-muted/20">
          <span className="select-none whitespace-nowrap tabular-nums text-muted-foreground">{new Date(entry.at).toLocaleTimeString(i18n.language, { hour12: false })}</span>
          <span className={`select-none ${entry.source === 'stderr' ? 'text-accent-warning' : 'text-muted-foreground'}`}>{entry.source}</span>
          <span className={`whitespace-pre-wrap break-words [overflow-wrap:anywhere] ${entry.source === 'stderr' ? 'text-accent-warning' : 'text-foreground/90'}`}>{entry.line || '\u00a0'}</span>
        </div>) : !failed && <p className="py-12 text-center font-sans text-xs text-muted-foreground">{t(lines.length ? 'backgroundProcess.noMatches' : 'backgroundProcess.empty')}</p>}
      </DialogBody>
      <DialogFooter className="text-xs text-muted-foreground" start={<span>{t('backgroundProcess.lineCount', { count: filtered.length, total: lines.length })}</span>}><span>{t('backgroundProcess.exportHint')}</span></DialogFooter>
    </DialogContent>
  </Dialog>
}
