import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Circle, CircleHelp, Crosshair, Maximize2, Minimize2, PauseCircle, Route, Scan, XCircle } from 'lucide-react'
import { ReactFlow, Background, Controls, MarkerType, type Edge, type Node, type ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Button } from '../../../../components/ui/button'
import { Dialog, DialogBody, DialogClose, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '../../../../components/ui/dialog'
import { cn } from '../../../../lib/utils'
import { LiveDot, type LiveDotTone } from '../../../../components/ui/live-dot'
import { useActiveTheme } from '../../../settings/context/ThemeContext'
import { layoutLoop } from '../../lib/loop-layout'
import type { LoopNodeData } from '../../lib/loop-graph-rf'
import { segmentStatus, type LoopStepSegment } from './loop-log-model'
import type { RuntimeTopology, RuntimeTopologyBody } from './runtime-topology'

type GraphState = 'running' | 'paused' | 'failed' | 'stalled' | 'interrupted' | 'ok' | 'pending' | 'unknown'
const ATTENTION: GraphState[] = ['running', 'paused', 'failed', 'stalled', 'interrupted']
// Pending is what an unvisited node looks like; the legend names lamps only.
const LEGEND: GraphState[] = ['running', 'ok', 'failed', 'paused']
const NODE_WIDTH = 210
export const RUNTIME_GRAPH_PATH_ONLY_KEY = 'specrails-desktop:runtime-graph-path-only'

function loadPathOnly(): boolean {
  try { return localStorage.getItem(RUNTIME_GRAPH_PATH_ONLY_KEY) === 'true' } catch { return false }
}
function savePathOnly(value: boolean) {
  try { localStorage.setItem(RUNTIME_GRAPH_PATH_ONLY_KEY, String(value)) } catch { /* session-local choice still applies */ }
}

function stateTone(state: GraphState): LiveDotTone {
  if (state === 'running') return 'info'
  if (state === 'ok') return 'success'
  if (state === 'failed') return 'destructive'
  if (state === 'paused' || state === 'stalled' || state === 'interrupted') return 'warning'
  return 'muted'
}
/** A state lamp: live (soft ring) only while the step runs. */
function StateLamp({ state }: { state: GraphState }) {
  return <LiveDot tone={stateTone(state)} pulsing={state === 'running'} size="sm" aria-hidden />
}

function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ${secs % 60}s`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

function stateColor(state: GraphState): string {
  if (state === 'running') return 'var(--color-accent-info)'
  if (state === 'ok') return 'var(--color-accent-success)'
  if (state === 'failed') return 'var(--color-destructive)'
  if (state === 'paused' || state === 'stalled' || state === 'interrupted') return 'var(--color-accent-warning)'
  return 'var(--color-border)'
}
function stateIcon(state: GraphState) {
  if (state === 'ok') return CheckCircle2
  if (state === 'failed') return XCircle
  if (state === 'paused' || state === 'stalled' || state === 'interrupted') return PauseCircle
  if (state === 'unknown') return CircleHelp
  return Circle
}
const quiet = (state: GraphState) => state === 'pending' || state === 'unknown'

/**
 * The run's graph, always expanded: Core's topology with each node coloured by
 * what its attempts did. The view follows the step that matters (the one
 * running, else the one that failed) until the person pans or zooms; "Follow"
 * picks it up again and "Fit all" shows the whole graph.
 */
export function RuntimeGraphExplorer({ topology, segments, settled, onFocus, onFork, forkBusy, leading }: {
  topology: RuntimeTopology; segments: LoopStepSegment[]; settled: boolean; onFocus(key: string): void
  onFork?(attempt: LoopStepSegment): void; forkBusy?: boolean
  /** Shown at the start of the toolbar row (the run's outcome). */
  leading?: ReactNode
}) {
  const { t } = useTranslation('jobs')
  const theme = useActiveTheme()
  const [fullscreen, setFullscreen] = useState(false)
  const [trail, setTrail] = useState<Array<{ path: string; body: RuntimeTopologyBody }>>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [follow, setFollow] = useState(true)
  const [pathOnly, setPathOnly] = useState(loadPathOnly)
  const view = trail[trail.length - 1] ?? { path: '', body: topology }
  const pathFor = (id: string) => view.path ? `${view.path}/${id}` : id
  const attempts = segments.filter(segment => (segment.meta.nodePath ?? segment.meta.nodeId) === selected)

  const states = useMemo(() => {
    const attemptsByNode = new Map<string, Map<string, LoopStepSegment>>()
    for (const segment of segments) {
      const nodePath = segment.meta.nodePath ?? segment.meta.nodeId
      if (!nodePath) continue
      const scoped = attemptsByNode.get(nodePath) ?? new Map<string, LoopStepSegment>()
      scoped.set(segment.meta.scopeId ?? 'legacy', segment)
      attemptsByNode.set(nodePath, scoped)
    }
    const result = new Map<string, { state: GraphState; attempts: number }>()
    for (const node of view.body.nodes) {
      const nodePath = view.path ? `${view.path}/${node.id}` : node.id
      const latest = [...(attemptsByNode.get(nodePath) ?? new Map<string, LoopStepSegment>()).values()]
      const values = latest.map(segment => segmentStatus(segment, { isLast: segment === segments[segments.length - 1], jobSettled: settled }))
      const state = (ATTENTION.find(value => values.includes(value as typeof values[number]))
        ?? (values.length ? values.every(value => value === 'ok') ? 'ok' : 'unknown' : 'pending')) as GraphState
      result.set(node.id, { state, attempts: segments.filter(segment => (segment.meta.nodePath ?? segment.meta.nodeId) === nodePath).length })
    }
    return result
  }, [view.body, view.path, segments, settled])

  const flow = useMemo(() => {
    const visited = (id: string) => !quiet(states.get(id)?.state ?? 'pending')
    // "Only the path taken": the visited nodes plus one hop either way, so the
    // next decision stays readable. Nothing visited yet → the whole graph.
    let kept: Set<string> | null = null
    if (pathOnly && view.body.nodes.some(node => visited(node.id))) {
      kept = new Set(view.body.nodes.filter(node => visited(node.id)).map(node => node.id))
      for (const node of view.body.nodes) {
        for (const target of Object.values(node.ends)) {
          if (target === null) continue
          if (visited(node.id)) kept.add(target)
          if (visited(target)) kept.add(node.id)
        }
      }
    }
    const shown = (id: string) => !kept || kept.has(id)
    const edges: Edge[] = view.body.nodes.flatMap(node => Object.entries(node.ends).flatMap(([outcome, target]) => {
      if (target === null || !shown(node.id) || !shown(target)) return []
      const walked = visited(node.id) && visited(target)
      const live = walked && states.get(target)?.state === 'running'
      const stroke = live ? 'var(--color-accent-info)' : walked ? 'var(--color-accent-success)' : 'var(--color-border)'
      return [{
        id: `${node.id}:${outcome}`, source: node.id, target, label: outcome, animated: live,
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
        style: { stroke, strokeWidth: walked ? 2 : 1, ...(walked ? {} : { strokeDasharray: '4 4' }) },
        // Caption size; walked labels read at full contrast.
        labelStyle: { fontSize: 11, fill: walked ? 'var(--color-foreground)' : 'var(--color-muted-foreground)' },
        labelBgStyle: { fill: 'var(--color-background)' },
      }]
    }))
    const nodes = view.body.nodes.filter(node => shown(node.id)).map(node => {
      const { state, attempts: count } = states.get(node.id) ?? { state: 'pending' as GraphState, attempts: 0 }
      const color = stateColor(state)
      const Icon = stateIcon(state)
      const unvisited = quiet(state)
      return { id: node.id, type: 'default', position: { x: 0, y: 0 }, data: { kind: 'core', label: (
        <span className="block text-left" data-state={state}>
          <strong className={cn('flex items-center gap-2 text-body leading-tight', unvisited ? 'font-medium text-muted-foreground' : 'text-foreground')}>
            {state === 'running'
              ? <LiveDot tone="info" size="sm" className="mx-0.5" aria-hidden />
              : <Icon aria-hidden className="h-4 w-4 shrink-0" style={{ color: unvisited ? 'var(--color-muted-foreground)' : color }} />}
            <span className="min-w-0 break-words">{node.label}</span>
          </strong>
          <span className="mt-1 flex items-center gap-1.5 text-caption text-muted-foreground">
            <span>{node.kind}</span><span aria-hidden>·</span><span style={unvisited ? undefined : { color }}>{t(`loopExplorer.graphState.${state}`)}</span>
            {count > 1 && <span className="ml-auto rounded-full bg-muted px-1.5 num">×{count}</span>}
          </span>
        </span>
      ) } as LoopNodeData,
      style: {
        width: NODE_WIDTH, borderRadius: 10, padding: '8px 10px',
        background: unvisited ? 'var(--color-background)' : `color-mix(in srgb, ${color} 12%, var(--color-background))`,
        // Unvisited: a dashed hairline and muted text, never a faded node.
        color: unvisited ? 'var(--color-muted-foreground)' : 'var(--color-foreground)',
        borderColor: color, borderWidth: unvisited ? 1 : 2, borderStyle: unvisited ? 'dashed' : 'solid',
      } }
    })
    // Entry first gives the existing deterministic layout the real Core root.
    nodes.sort((a, b) => a.id === view.body.entry ? -1 : b.id === view.body.entry ? 1 : 0)
    return { nodes: layoutLoop(nodes, edges, 'vertical'), edges }
  }, [view.body, states, t, pathOnly])

  // The step to keep in view: running first, then one that needs attention,
  // then the last one that ran.
  const activeId = useMemo(() => {
    const byState = (wanted: GraphState) => view.body.nodes.find(node => states.get(node.id)?.state === wanted)?.id
    const lastRun = [...segments].reverse().map(segment => segment.meta.nodePath ?? segment.meta.nodeId).find(path => path && view.body.nodes.some(node => pathFor(node.id) === path))
    return byState('running') ?? byState('failed') ?? ATTENTION.map(byState).find(Boolean)
      ?? (lastRun ? view.body.nodes.find(node => pathFor(node.id) === lastRun)?.id : undefined) ?? null
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [states, segments, view.body, view.path])

  // Opening the graph of a failed run lands on the step that failed: its
  // attempts and "Repeat from here" are the first thing to see.
  const failedPath = useMemo(() => [...segments].reverse().find(segment => segmentStatus(segment, { isLast: segment === segments[segments.length - 1], jobSettled: settled }) === 'failed')?.meta.nodePath ?? null, [segments, settled])
  const landed = useRef(false)
  useEffect(() => {
    if (landed.current || !failedPath) return
    landed.current = true
    if (selected === null && trail.length === 0 && view.body.nodes.some(node => node.id === failedPath)) setSelected(failedPath)
  // Only once: a deselection by the person sticks.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedPath])

  const instances = useRef(new Map<boolean, ReactFlowInstance<Node<LoopNodeData>, Edge>>())
  const focusActive = (instance: ReactFlowInstance<Node<LoopNodeData>, Edge> | undefined, animate: boolean) => {
    if (!instance) return
    const node = activeId ? flow.nodes.find(candidate => candidate.id === activeId) : undefined
    if (!node) { void instance.fitView({ padding: 0.15, duration: animate ? 400 : 0 }); return }
    // Centre the step at a readable size; the person can still pan around it.
    void instance.setCenter(node.position.x + NODE_WIDTH / 2, node.position.y + 30, { zoom: 0.95, duration: animate ? 400 : 0 })
  }
  useEffect(() => {
    if (!follow) return
    for (const instance of instances.current.values()) focusActive(instance, true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, follow, view.path])

  const selectedNode = view.body.nodes.find(node => pathFor(node.id) === selected)
  const selectedState = selectedNode ? states.get(selectedNode.id)?.state ?? 'pending' : 'pending'
  const component = selectedNode?.component ? topology.components[selectedNode.component] : undefined
  const scopes = new Set(attempts.map(attempt => attempt.meta.scopeId ?? ''))
  // "Repeat from here" forks the exact attempt the person picks: on a branched
  // run each branch (scope) has its own attempts, so it lives on each row.
  const canFork = (attempt: LoopStepSegment) => !!onFork && !!attempt.end && !!attempt.meta.nodePath && !!attempt.meta.scopeId && attempt.meta.iteration != null
  const nodePanel = (path: string, className: string) => <div className={className} data-testid="runtime-graph-node-panel">
    <div className="flex items-center gap-2">
      <StateLamp state={selectedState} />
      <span className="min-w-0 flex-1 truncate text-strong text-foreground">{selectedNode?.label ?? path}</span>
      {attempts.length > 0 && <span className="shrink-0 text-caption text-muted-foreground num">{t('loopExplorer.graphAttempts', { count: attempts.length })}</span>}
    </div>
    {component && trail.length < 16 && <Button size="sm" variant="outline" onClick={() => { setTrail(value => [...value, { path, body: component }]); setSelected(null) }}>{t('loopExplorer.graphOpenComponent')}</Button>}
    {attempts.length === 0 ? <p className="text-muted-foreground">{t('loopExplorer.graphNoAttempts')}</p> : <ul className="-mx-1">
      {attempts.map((attempt, index) => {
        const state = segmentStatus(attempt, { isLast: true, jobSettled: settled }) as GraphState
        const duration = formatDuration(attempt.end?.durationMs)
        const label = [t('loopExplorer.graphAttempt', { n: attempt.meta.attempt ?? index + 1 }), t(`loopExplorer.graphState.${state}`), duration, scopes.size > 1 ? attempt.meta.scopeId : null].filter(Boolean).join(' · ')
        return <li key={attempt.key} className="flex items-center gap-1">
          <button type="button" data-testid="runtime-graph-attempt" className="flex min-w-0 flex-1 items-center gap-2 rounded-control px-1 py-1 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onFocus(attempt.key)}>
            <StateLamp state={state} />
            <span className="min-w-0 flex-1 truncate">{label}</span>
          </button>
          {canFork(attempt) && <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2" disabled={forkBusy} aria-label={`${t('loopExplorer.repeatFromHere')}: ${label}`} title={t('loopExplorer.repeatFromHere')} onClick={() => onFork?.(attempt)}>{t('loopExplorer.repeatFromHere')}</Button>}
        </li>
      })}
    </ul>}
    <details className="text-caption text-muted-foreground">
      <summary className="cursor-pointer select-none hover:text-foreground">{t('loopExplorer.graphTrace')}</summary>
      <div className="mt-1 space-y-1 break-all font-mono">
        <p>{path}</p>
        {attempts.filter(attempt => attempt.meta.traceId).map(attempt => <p key={attempt.key} data-testid="runtime-graph-trace">
          {attempt.meta.attemptId ?? attempt.meta.index}: traceId: {attempt.meta.traceId}{attempt.meta.spanId ? ` · spanId: ${attempt.meta.spanId}` : ''}
        </p>)}
      </div>
    </details>
  </div>

  const content = (expanded: boolean) => <>
    <div className="flex shrink-0 flex-wrap items-center gap-2 py-1.5 text-xs">
      {trail.length > 0 && <Button size="sm" variant="ghost" onClick={() => { setTrail(value => value.slice(0, -1)); setSelected(null) }}>{t('loopExplorer.graphBack')}</Button>}
      {trail.length > 0 && <code>{view.path}</code>}
      {!expanded && leading}
      <ul className="ml-auto flex flex-wrap items-center gap-3 text-caption text-muted-foreground" aria-label={t('loopExplorer.graphLegend')}>
        {LEGEND.map(state => <li key={state} className="flex items-center gap-1.5"><LiveDot tone={stateTone(state)} pulsing={false} size="xs" aria-hidden />{t(`loopExplorer.graphState.${state}`)}</li>)}
      </ul>
      <span className="flex items-center gap-1">
        <Button size="sm" variant={pathOnly ? 'secondary' : 'ghost'} aria-pressed={pathOnly} data-testid="runtime-graph-path-only" onClick={() => { setPathOnly(!pathOnly); savePathOnly(!pathOnly) }}>
          <Route className="mr-1.5 h-3.5 w-3.5" aria-hidden />{t('loopExplorer.graphPathOnly')}
        </Button>
        <Button size="sm" variant={follow ? 'secondary' : 'ghost'} aria-pressed={follow} onClick={() => { setFollow(true); focusActive(instances.current.get(expanded), true) }}>
          <Crosshair className="mr-1.5 h-3.5 w-3.5" aria-hidden />{t('loopExplorer.graphFollow')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { setFollow(false); void instances.current.get(expanded)?.fitView({ padding: 0.15, duration: 400 }) }}>
          <Scan className="mr-1.5 h-3.5 w-3.5" aria-hidden />{t('loopExplorer.graphFitAll')}
        </Button>
        {expanded ? <DialogClose asChild><Button size="sm" variant="ghost" aria-label={t('loopExplorer.graphExitFullscreen')} title={t('loopExplorer.graphExitFullscreen')}><Minimize2 className="h-4 w-4" /></Button></DialogClose>
          : <DialogTrigger asChild><Button size="sm" variant="ghost" aria-label={t('loopExplorer.graphFullscreen')} title={t('loopExplorer.graphFullscreen')}><Maximize2 className="h-4 w-4" /></Button></DialogTrigger>}
      </span>
    </div>
    <div className={cn('flex min-h-0 flex-1 gap-3', !expanded && 'flex-col lg:flex-row')}>
      <div className="relative min-h-[240px] min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-background/40" aria-label={t('loopExplorer.runtimeGraph')}>
        <ReactFlow key={`${view.path}:${expanded}`} colorMode={theme.scheme === 'dark' ? 'dark' : 'light'} nodes={flow.nodes} edges={flow.edges}
          nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} minZoom={0.1} maxZoom={2}
          onInit={instance => { instances.current.set(expanded, instance); requestAnimationFrame(() => focusActive(instance, false)) }}
          onMoveStart={event => { if (event) setFollow(false) }}
          onNodeClick={(_event, node) => setSelected(pathFor(node.id))} onPaneClick={() => setSelected(null)}
          proOptions={{ hideAttribution: true }}>
          <Background gap={20} size={1} /><Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {selected && nodePanel(selected, cn('shrink-0 space-y-2 rounded-lg border border-border bg-popover p-3 text-label', expanded ? 'w-80 overflow-y-auto' : 'lg:w-80 lg:overflow-y-auto'))}
    </div>
  </>

  return <Dialog open={fullscreen} onOpenChange={setFullscreen}>
    <section className="flex min-h-0 flex-1 flex-col px-3 pb-3" data-testid="runtime-graph">
      <h3 className="sr-only">{t('loopExplorer.runtimeGraph')}</h3>
      {content(false)}
    </section>
    {/*
      * `capture` layer: the fullscreen graph opens from the loop log explorer,
      * which can itself sit over the job detail (entity, z-65) and the
      * minimized chats dock (z-75); capture (z-80) clears both and ties with
      * the browser-capture overlays, where portal order puts the graph on
      * top. The native browser pane is an OS webview composited above the
      * whole DOM, so no z-index can beat it; the old z-[2147483647] did not
      * either. The minimize button in the toolbar is this dialog's close.
      */}
    <DialogContent size="fullscreen" layer="capture" showCloseButton={false} aria-describedby={undefined}>
      <DialogHeader>
        <DialogTitle>{t('loopExplorer.runtimeGraph')}</DialogTitle>
      </DialogHeader>
      <DialogBody className="flex flex-col py-0 pb-3">{content(true)}</DialogBody>
    </DialogContent>
  </Dialog>
}
