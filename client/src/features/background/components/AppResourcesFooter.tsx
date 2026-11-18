import { useState, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, Bot, Box, ChevronRight, Cog, Cpu, GitBranch, Plug, Sparkles, Terminal, TrainTrack } from 'lucide-react'
import { HoverPopover } from '../../../components/ui/hover-popover'
import { cn } from '../../../lib/utils'
import { formatBytes } from '../lib/format-bytes'
import { useAppResources } from '../hooks/useAppResources'
import { useRunPorts } from '../hooks/useRunPorts'
import { RunPortsSection } from './RunPortsSection'
import type { RunPortsSnapshot } from '../lib/run-ports-api'
import type { AppResourceCategory, AppResourceCategoryId, AppResourceItem, AppResourcesSnapshot } from '../lib/app-resources-api'
import type { ResourceSample } from '../lib/mission-resources-api'

const CATEGORY_STYLE: Record<AppResourceCategoryId, { icon: ComponentType<{ className?: string }>; bar: string }> = {
  missions: { icon: Bot, bar: 'bg-accent-primary' },
  rails: { icon: TrainTrack, bar: 'bg-accent-secondary' },
  background: { icon: Cog, bar: 'bg-accent-info' },
  terminals: { icon: Terminal, bar: 'bg-accent-success' },
  'agent-cli': { icon: Sparkles, bar: 'bg-accent-intent' },
  mcp: { icon: Plug, bar: 'bg-accent-review' },
  git: { icon: GitBranch, bar: 'bg-foreground' },
  other: { icon: Box, bar: 'bg-muted-foreground' },
  server: { icon: Cpu, bar: 'bg-accent-highlight' },
}

export function formatCpu(percent: number): string {
  return `${percent.toFixed(percent >= 100 ? 0 : 1)}%`
}

/** Memory trend as a tiny line: decorative next to the numbers it summarises. */
function Sparkline({ samples }: { samples: ResourceSample[] }) {
  if (samples.length < 2) return null
  const values = samples.map(sample => sample.memoryBytes)
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min || 1
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${22 - ((value - min) / span) * 20}`).join(' ')
  return <svg data-testid="app-resources-sparkline" aria-hidden="true" viewBox="0 0 100 24" preserveAspectRatio="none" className="h-6 w-full text-accent-info">
    <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
  </svg>
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-card bg-muted px-2 py-1.5">
    <div className="text-caption text-muted-foreground">{label}</div>
    <div className="num truncate text-title text-foreground">{value}</div>
  </div>
}

function ItemRow({ item }: { item: AppResourceItem }) {
  const { t } = useTranslation('resources')
  const label = item.label === 'Specrails server' ? t('items.server') : item.label || t('items.untitled')
  return <li className="flex items-center gap-2 py-0.5 pl-6 text-caption">
    <span className="min-w-0 flex-1 truncate text-foreground" title={label}>
      {label}
      {item.projectName && <span className="text-muted-foreground"> · {item.projectName}</span>}
    </span>
    <span className="num w-12 shrink-0 text-right text-muted-foreground">{formatCpu(item.cpuPercent)}</span>
    <span className="num w-16 shrink-0 text-right text-foreground">{formatBytes(item.memoryBytes)}</span>
    <span className="num w-6 shrink-0 text-right text-muted-foreground">{item.processCount}</span>
  </li>
}

function CategoryRow({ category }: { category: AppResourceCategory }) {
  const { t } = useTranslation('resources')
  const [expanded, setExpanded] = useState(false)
  const { icon: Icon, bar } = CATEGORY_STYLE[category.id]
  const name = t(`categories.${category.id}`)
  return <li data-testid={`app-resources-category-${category.id}`}>
    <button type="button" aria-expanded={expanded} aria-label={t('toggleCategory', { category: name })} onClick={() => setExpanded(value => !value)}
      className="flex w-full items-center gap-2 rounded-control px-1 py-1 text-label hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary">
      <ChevronRight className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} aria-hidden />
      <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', bar)} />
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-left text-foreground">{name}</span>
      <span className="num w-12 shrink-0 text-right text-muted-foreground">{formatCpu(category.cpuPercent)}</span>
      <span className="num w-16 shrink-0 text-right text-foreground">{formatBytes(category.memoryBytes)}</span>
      <span className="num w-6 shrink-0 text-right text-muted-foreground">{category.processCount}</span>
    </button>
    {expanded && <ul className="pb-1">{category.items.map(item => <ItemRow key={`${item.label}:${item.projectId ?? ''}:${item.chatId ?? ''}:${item.runId ?? ''}`} item={item} />)}</ul>}
  </li>
}

/** The popover body: totals, memory split by category and expandable per-category rows. */
export function AppResourcesPanel({ snapshot, error, ports = null }: { snapshot: AppResourcesSnapshot | null; error: string | null; ports?: RunPortsSnapshot | null }) {
  const { t } = useTranslation('resources')
  const totals = snapshot?.totals
  const memory = totals?.memoryBytes ?? 0
  return <div data-testid="app-resources-panel" className="space-y-3">
    <div className="flex items-start gap-2">
      <Activity className="mt-0.5 h-4 w-4 shrink-0 text-accent-info" aria-hidden />
      <div className="min-w-0">
        <div className="text-strong text-foreground">{t('title')}</div>
        <div className="text-caption text-muted-foreground">{t('subtitle')}</div>
      </div>
    </div>
    {error && <p role="alert" className="text-caption text-destructive">{t('error', { error })}</p>}
    {!snapshot && !error && <p className="text-caption text-muted-foreground">{t('loading')}</p>}
    {snapshot && !snapshot.supported && <p className="text-caption text-muted-foreground">{t('unsupported')}</p>}
    {snapshot?.supported && <>
      <div className="grid grid-cols-3 gap-2">
        <Metric label={t('cpu')} value={formatCpu(snapshot.totals.cpuPercent)} />
        <Metric label={t('memory')} value={formatBytes(snapshot.totals.memoryBytes)} />
        <Metric label={t('processes')} value={String(snapshot.totals.processCount)} />
      </div>
      <Sparkline samples={snapshot.history ?? []} />
      {snapshot.categories.length === 0 ? <p className="text-caption text-muted-foreground">{t('empty')}</p> : <>
        <div className="space-y-1.5">
          <div className="text-caption text-muted-foreground">{t('memoryByCategory')}</div>
          <div data-testid="app-resources-bar" role="img" aria-label={t('memoryByCategory')} className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
            {snapshot.categories.map(category => memory > 0 && category.memoryBytes > 0 && <span key={category.id} className={cn('h-full', CATEGORY_STYLE[category.id].bar)} style={{ width: `${(category.memoryBytes / memory) * 100}%` }} />)}
          </div>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-caption text-muted-foreground">
            {snapshot.categories.map(category => <li key={category.id} className="flex items-center gap-1">
              <span aria-hidden className={cn('h-2 w-2 rounded-full', CATEGORY_STYLE[category.id].bar)} />
              <span>{t(`categories.${category.id}`)}</span>
              <span className="num">{memory > 0 ? Math.round((category.memoryBytes / memory) * 100) : 0}%</span>
            </li>)}
          </ul>
        </div>
        <div>
          <div className="flex items-center gap-2 px-1 pb-1 text-caption text-muted-foreground">
            <span className="flex-1 pl-12">{t('source')}</span>
            <span className="w-12 text-right">{t('cpu')}</span>
            <span className="w-16 text-right">{t('memory')}</span>
            <span className="w-6 text-right" title={t('processes')}><span aria-hidden>#</span><span className="sr-only">{t('processes')}</span></span>
          </div>
          <ul>{snapshot.categories.map(category => <CategoryRow key={category.id} category={category} />)}</ul>
        </div>
      </>}
    </>}
    <RunPortsSection snapshot={ports} />
  </div>
}

/** Status-bar control: total memory and process count of everything Specrails launched; hover or click opens
 * the breakdown. Polls every few seconds only while open. */
export function AppResourcesFooter() {
  const { t } = useTranslation('resources')
  const [open, setOpen] = useState(false)
  const { snapshot, error } = useAppResources(open)
  const { snapshot: ports } = useRunPorts(open)
  const supported = snapshot?.supported ?? false
  const memory = supported && snapshot ? formatBytes(snapshot.totals.memoryBytes) : null
  const count = supported && snapshot ? snapshot.totals.processCount : null
  return <HoverPopover label={t('title')} description={t('subtitle')} testId="app-resources-popover" width={384} onOpenChange={setOpen}
    trigger={<button type="button" data-testid="app-resources-trigger"
      aria-label={memory !== null ? t('openWithSummary', { memory, count }) : t('open')}
      className="flex h-6 items-center gap-1.5 rounded px-2 text-label hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-ring">
      <Activity className="h-3.5 w-3.5 shrink-0 text-foreground" aria-hidden />
      {memory === null ? <span>{t('button')}</span> : <>
        <span className="num">{memory}</span>
        <span aria-hidden className="text-muted-foreground">·</span>
        <span className="num">{count}</span>
      </>}
    </button>}>
    <AppResourcesPanel snapshot={snapshot} error={error} ports={ports} />
  </HoverPopover>
}
