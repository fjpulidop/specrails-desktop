import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Circle, CircleHelp, Crosshair, Loader2, Maximize2, Minimize2, PauseCircle, Scan, XCircle } from 'lucide-react'
import { ReactFlow, Background, Controls, MarkerType, type Edge, type Node, type ReactFlowInstance } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Button } from '../../../../components/ui/button'
import { Dialog, DialogBody, DialogClose, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '../../../../components/ui/dialog'
import { cn } from '../../../../lib/utils'
import { useActiveTheme } from '../../../settings/context/ThemeContext'
import { layoutLoop } from '../../lib/loop-layout'
import type { LoopNodeData } from '../../lib/loop-graph-rf'
import { segmentStatus, type LoopStepSegment } from './loop-log-model'
import type { RuntimeTopology, RuntimeTopologyBody } from './runtime-topology'

type GraphState = 'running' | 'paused' | 'failed' | 'stalled' | 'interrupted' | 'ok' | 'pending' | 'unknown'
const ATTENTION: GraphState[] = ['running', 'paused', 'failed', 'stalled', 'interrupted']
const LEGEND: GraphState[] = ['running', 'ok', 'failed', 'paused', 'pending']
const NODE_WIDTH = 210

function stateColor(state: GraphState): string {
  if (state === 'running') return 'var(--color-accent-primary)'
  if (state === 'ok') return 'var(--color-accent-success)'
  if (state === 'failed') return 'var(--color-destructive)'
  if (state === 'paused' || state === 'stalled' || state === 'interrupted') return 'var(--color-accent-warning)'
  return 'var(--color-border)'
}
function stateIcon(state: GraphState) {
  if (state === 'running') return Loader2
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
    const edges: Edge[] = view.body.nodes.flatMap(node => Object.entries(node.ends).flatMap(([outcome, target]) => {
      if (target === null) return []
      const walked = visited(node.id) && visited(target)
      const live = walked && states.get(target)?.state === 'running'
      const stroke = live ? 'var(--color-accent-primary)' : walked ? 'var(--color-accent-success)' : 'var(--color-muted-foreground)'
      return [{
        id: `${node.id}:${outcome}`, source: node.id, target, label: outcome, animated: live,
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
        style: { stroke, strokeWidth: walked ? 2 : 1, opacity: walked ? 1 : 0.45, ...(walked ? {} : { strokeDasharray: '4 4' }) },
        labelStyle: { fontSize: 10, fill: 'var(--color-muted-foreground)' },
        labelBgStyle: { fill: 'var(--color-background)' },
      }]
    }))
    const nodes = view.body.nodes.map(node => {
      const { state, attempts: count } = states.get(node.id) ?? { state: 'pending' as GraphState, attempts: 0 }
      const color = stateColor(state)
      const Icon = stateIcon(state)
      return { id: node.id, type: 'default', position: { x: 0, y: 0 }, data: { kind: 'core', label: (
        <span className="block text-left" data-state={state}>
          <strong className="flex items-center gap-2 text-body leading-tight">
            <Icon aria-hidden className={cn('h-4 w-4 shrink-0', state === 'running' && 'motion-safe:animate-spin')} style={{ color: quiet(state) ? 'var(--color-muted-foreground)' : color }} />
            <span className="min-w-0 break-words">{node.label}</span>
          </strong>
          <span className="mt-1 flex items-center gap-1.5 text-caption text-muted-foreground">
            <span>{node.kind}</span><span aria-hidden>·</span><span style={quiet(state) ? undefined : { color }}>{t(`loopExplorer.graphState.${state}`)}</span>
            {count > 1 && <span className="ml-auto rounded-full bg-muted px-1.5 num">×{count}</span>}
          </span>
        </span>
      ) } as LoopNodeData,
      style: {
        width: NODE_WIDTH, borderRadius: 10, padding: '8px 10px',
        background: quiet(state) ? 'var(--color-background)' : `color-mix(in srgb, ${color} 12%, var(--color-background))`,
        color: 'var(--color-foreground)', borderColor: color, borderWidth: quiet(state) ? 1 : 2,
        opacity: quiet(state) ? 0.75 : 1,
        boxShadow: state === 'running' ? `0 0 0 2px color-mix(in srgb, ${color} 30%, transparent), 0 0 22px color-mix(in srgb, ${color} 35%, transparent)` : undefined,
      } }
    })
    // Entry first gives the existing deterministic layout the real Core root.
    nodes.sort((a, b) => a.id === view.body.entry ? -1 : b.id === view.body.entry ? 1 : 0)
    return { nodes: layoutLoop(nodes, edges, 'vertical'), edges }
  }, [view.body, states, t])

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
  const component = selectedNode?.component ? topology.components[selectedNode.component] : undefined
  const nodePanel = (path: string, className: string) => <div className={className} data-testid="runtime-graph-node-panel">
    <code className="break-all font-medium">{path}</code>
    {component && trail.length < 16 && <Button size="sm" variant="outline" onClick={() => { setTrail(value => [...value, { path, body: component }]); setSelected(null) }}>{t('loopExplorer.graphOpenComponent')}</Button>}
    {attempts.length === 0 ? <p className="text-muted-foreground">{t('loopExplorer.graphNoAttempts')}</p> : <ul className="space-y-2">
      {attempts.map(attempt => <li key={attempt.key} className="space-y-1">
        <button className="text-left underline underline-offset-2" onClick={() => onFocus(attempt.key)}>{attempt.meta.scopeId ?? '/'} · {attempt.meta.attemptId ?? attempt.meta.index} · {t(`loopExplorer.graphState.${segmentStatus(attempt, { isLast: true, jobSettled: settled })}`)}</button>
        {onFork && attempt.end && attempt.meta.nodePath && attempt.meta.scopeId && attempt.meta.iteration != null && <Button className="ml-2" size="sm" variant="outline" disabled={forkBusy} onClick={() => onFork(attempt)}>{t('loopExplorer.repeatFromHere')}</Button>}
        {attempt.meta.traceId && <code className="block break-all text-xs text-muted-foreground">traceId: {attempt.meta.traceId}{attempt.meta.spanId ? ` · spanId: ${attempt.meta.spanId}` : ''}</code>}
      </li>)}
    </ul>}
  </div>

  const content = (expanded: boolean) => <>
    <div className="flex shrink-0 flex-wrap items-center gap-2 py-1.5 text-xs">
      {trail.length > 0 && <Button size="sm" variant="ghost" onClick={() => { setTrail(value => value.slice(0, -1)); setSelected(null) }}>{t('loopExplorer.graphBack')}</Button>}
      {trail.length > 0 && <code>{view.path}</code>}
      {!expanded && leading}
      <span className="ml-auto flex items-center gap-1">
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
      <div className={cn('relative min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-background/40', expanded ? 'min-h-0' : 'min-h-[420px]')} aria-label={t('loopExplorer.runtimeGraph')}>
        <ReactFlow key={`${view.path}:${expanded}`} colorMode={theme.scheme === 'dark' ? 'dark' : 'light'} nodes={flow.nodes} edges={flow.edges}
          nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} minZoom={0.1} maxZoom={2}
          onInit={instance => { instances.current.set(expanded, instance); requestAnimationFrame(() => focusActive(instance, false)) }}
          onMoveStart={event => { if (event) setFollow(false) }}
          onNodeClick={(_event, node) => setSelected(pathFor(node.id))} onPaneClick={() => setSelected(null)}
          proOptions={{ hideAttribution: true }}>
          <Background gap={20} size={1} /><Controls showInteractive={false} />
        </ReactFlow>
        <ul className="pointer-events-none absolute left-2 top-2 z-10 flex flex-wrap items-center gap-3 rounded-md border border-border/60 bg-background/80 px-2 py-1 text-caption text-muted-foreground backdrop-blur-sm" aria-label={t('loopExplorer.graphLegend')}>
          {LEGEND.map(state => <li key={state} className="flex items-center gap-1.5"><span aria-hidden className="h-2 w-2 rounded-full border" style={{ borderColor: stateColor(state), background: quiet(state) ? 'transparent' : stateColor(state) }} />{t(`loopExplorer.graphState.${state}`)}</li>)}
        </ul>
      </div>
      {selected && nodePanel(selected, cn('shrink-0 space-y-2 rounded-lg border border-border bg-popover/60 p-3 text-xs', expanded ? 'w-80 overflow-y-auto' : 'lg:w-80 lg:overflow-y-auto'))}
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
