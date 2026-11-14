import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, FolderOpen, Loader2 } from 'lucide-react'
import { Line, LineChart, ResponsiveContainer, Tooltip, YAxis } from 'recharts'
import { startWorktreeScan, type MissionResourcesSnapshot } from '../lib/mission-resources-api'
import { summarizeHistory, type ResourceSample } from '../lib/mission-resource-history'

export { MISSION_RESOURCES_POLL_MS } from '../hooks/useMissionResourceHistory'

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** One metric over time: titled, with its peak, start/end times and a tooltip that names the time and value. */
function MetricChart({ samples, pick, format, title, peak, testId }: {
  samples: ResourceSample[]
  pick: (sample: ResourceSample) => number
  format: (value: number) => string
  title: string
  peak: string
  testId: string
}) {
  const data = samples.map(sample => ({ at: sample.at, value: pick(sample) }))
  return <div data-testid={testId} className="space-y-0.5">
    <div className="flex items-baseline justify-between text-xs">
      <span className="font-medium text-foreground">{title}</span>
      <span className="tabular-nums text-muted-foreground">{peak}</span>
    </div>
    <div role="img" aria-label={title} className="h-12 w-full text-accent-info">
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 2, left: 4 }}>
          <YAxis hide domain={[0, 'auto']} />
          <Tooltip
            cursor={{ stroke: 'currentColor', strokeOpacity: 0.3 }}
            contentStyle={{ background: 'hsl(var(--popover, 220 15% 12%))', border: '1px solid hsl(var(--border, 220 10% 25%))', borderRadius: 6, fontSize: 12, padding: '4px 8px' }}
            labelFormatter={(_, payload) => (payload?.[0]?.payload?.at ? clock(payload[0].payload.at as number) : '')}
            formatter={(value) => [format(Number(value)), title]}
          />
          <Line type="linear" dataKey="value" stroke="currentColor" strokeWidth={1.5} dot={false} activeDot={{ r: 3 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  </div>
}

/** Read-only view of what a mission is consuming: live CPU/memory per owned process tree, a short history
 * so the numbers stay readable after the mission ends, and worktree disk on demand. Data comes from
 * `useMissionResourceHistory`; this panel only renders it. */
export function MissionResourcesPanel({ projectId, chatId, snapshot, samples, error: loadError, onScanned }: {
  projectId: string
  chatId: string
  snapshot: MissionResourcesSnapshot | null
  samples: ResourceSample[]
  error?: string | null
  onScanned?: () => void
}) {
  const { t } = useTranslation('agent')
  const [scanError, setScanError] = useState<string | null>(null)
  const error = scanError ?? loadError ?? null
  const summary = summarizeHistory(samples)
  const live = (snapshot?.totals.processCount ?? 0) > 0
  const shown = live ? snapshot?.totals : summary.lastActive ?? snapshot?.totals

  const scan = async () => {
    try { await startWorktreeScan(projectId, chatId); setScanError(null); onScanned?.() } catch (err) { setScanError(err instanceof Error ? err.message : String(err)) }
  }

  const disk = snapshot?.worktree?.disk
  const control = 'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border/60 px-2 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:opacity-40'

  return <div data-testid="mission-resources-panel" className="space-y-3">
    <div className="flex items-start gap-2">
      <Activity className="mt-0.5 h-4 w-4 shrink-0 text-accent-info" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{t('missionResources.title')}</div>
        <div className="text-xs text-muted-foreground">{t('missionResources.description')}</div>
      </div>
    </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!snapshot && !error && <p className="text-sm text-muted-foreground">{t('missionResources.loading')}</p>}
        {snapshot && !snapshot.supported && <p className="text-sm text-muted-foreground" data-testid="mission-resources-unsupported">{t('missionResources.unsupported')}</p>}
        {snapshot?.supported && (
          <>
            {!live && summary.lastActive && (
              <p className="text-xs text-muted-foreground" data-testid="mission-resources-finished">
                {t('missionResources.finishedAt', { time: new Date(samples[samples.length - 1].at).toLocaleTimeString() })} · {t('missionResources.lastActive')}
              </p>
            )}
            <div className={`grid grid-cols-3 gap-2 text-sm ${live ? '' : 'opacity-70'}`} data-testid="mission-resources-totals">
              <div><div className="text-xs text-muted-foreground">{t('missionResources.cpu')}</div><div className="tabular-nums font-medium">{(shown?.cpuPercent ?? 0).toFixed(1)}%</div></div>
              <div><div className="text-xs text-muted-foreground">{t('missionResources.memory')}</div><div className="tabular-nums font-medium">{formatBytes(shown?.memoryBytes ?? 0)}</div></div>
              <div><div className="text-xs text-muted-foreground">{t('missionResources.processes')}</div><div className="tabular-nums font-medium">{shown?.processCount ?? 0}</div></div>
            </div>
            {samples.length >= 2 && (
              <div className="space-y-2 rounded-md border border-border/60 px-3 py-2" data-testid="mission-resources-history">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{t('missionResources.history')}</span>
                  <span className="tabular-nums" data-testid="mission-resources-range">{clock(samples[0].at)} → {clock(samples[samples.length - 1].at)}</span>
                </div>
                <MetricChart testId="mission-resources-cpu-chart" samples={samples} pick={x => x.cpuPercent} format={v => `${v.toFixed(1)}%`}
                  title={t('missionResources.cpu')} peak={t('missionResources.peakValue', { value: `${summary.peakCpuPercent.toFixed(1)}%` })} />
                <MetricChart testId="mission-resources-memory-chart" samples={samples} pick={x => x.memoryBytes} format={formatBytes}
                  title={t('missionResources.memory')} peak={t('missionResources.peakValue', { value: formatBytes(summary.peakMemoryBytes) })} />
                <p className="text-xs text-muted-foreground" data-testid="mission-resources-peak">{t('missionResources.historyHint')}</p>
              </div>
            )}
            {snapshot.entries.length === 0
              ? (!summary.lastActive && <p className="text-sm text-muted-foreground">{t('missionResources.empty')}</p>)
              : <ul className="divide-y divide-border/50 rounded-md border border-border/60" data-testid="mission-resources-entries">
                {[...snapshot.entries].sort((a, b) => b.memoryBytes - a.memoryBytes).map(entry => (
                  <li key={entry.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{entry.kind === 'agent-session' ? t('missionResources.agentSession') : entry.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {t(`missionResources.kind.${entry.kind}`)} · PID {entry.pid} · {entry.running ? t('missionResources.processCount', { count: entry.processCount }) : t('missionResources.notRunning')}
                      </div>
                    </div>
                    <div className="w-16 text-right tabular-nums">{entry.cpuPercent.toFixed(1)}%</div>
                    <div className="w-20 text-right tabular-nums">{formatBytes(entry.memoryBytes)}</div>
                  </li>
                ))}
              </ul>}
          </>
        )}
        {snapshot?.worktree && (
          <div className="flex items-center gap-3 rounded-md border border-border/60 px-3 py-2 text-sm" data-testid="mission-resources-worktree">
            <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{t('missionResources.worktree')}</div>
              <div className="truncate text-xs text-muted-foreground">{snapshot.worktree.path}</div>
            </div>
            <div className="tabular-nums" data-testid="mission-resources-disk">
              {disk?.status === 'done' && formatBytes(disk.bytes)}
              {disk?.status === 'not-scanned' && <span className="text-muted-foreground">{t('missionResources.notScanned')}</span>}
              {disk?.status === 'scanning' && <span className="inline-flex items-center gap-1 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />{t('missionResources.scanning')}</span>}
              {disk?.status === 'failed' && <span className="text-destructive">{t('missionResources.scanFailed')}</span>}
            </div>
            <button type="button" className={control} onClick={() => void scan()} disabled={disk?.status === 'scanning'}>
              {disk?.status === 'done' || disk?.status === 'failed' ? t('missionResources.rescan') : t('missionResources.scan')}
            </button>
          </div>
        )}
  </div>
}
