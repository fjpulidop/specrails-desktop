import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Circle, CircleHelp, Loader2, Maximize2, Minimize2, PauseCircle, XCircle } from 'lucide-react'
import { ReactFlow, Background, Controls, MarkerType } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Button } from '../../../../components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogTrigger } from '../../../../components/ui/dialog'
import { modalTitleBarInset } from '../../../../lib/modal-safe-area'
import { useActiveTheme } from '../../../settings/context/ThemeContext'
import { layoutLoop } from '../../lib/loop-layout'
import type { LoopNodeData } from '../../lib/loop-graph-rf'
import { segmentStatus, type LoopStepSegment } from './loop-log-model'
import type { RuntimeTopology, RuntimeTopologyBody } from './runtime-topology'

export function RuntimeGraphExplorer({ topology, segments, settled, onFocus, onFork, forkBusy }: {
  topology: RuntimeTopology; segments: LoopStepSegment[]; settled: boolean; onFocus(key: string): void
  onFork?(attempt: LoopStepSegment): void; forkBusy?: boolean
}) {
  const { t } = useTranslation('jobs')
  const theme = useActiveTheme()
  const [open, setOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [trail, setTrail] = useState<Array<{ path: string; body: RuntimeTopologyBody }>>([])
  const [selected, setSelected] = useState<string | null>(null)
  const view = trail[trail.length - 1] ?? { path: '', body: topology }
  const pathFor = (id: string) => view.path ? `${view.path}/${id}` : id
  const attempts = segments.filter(segment => (segment.meta.nodePath ?? segment.meta.nodeId) === selected)
  const flow = useMemo(() => {
    const edges = view.body.nodes.flatMap(node => Object.entries(node.ends).flatMap(([outcome, target]) => target === null ? [] : [{ id: `${node.id}:${outcome}`, source: node.id, target, label: outcome, markerEnd: { type: MarkerType.ArrowClosed } }]))
    const attemptsByNode = new Map<string, Map<string, LoopStepSegment>>()
    for (const segment of segments) {
      const nodePath = segment.meta.nodePath ?? segment.meta.nodeId
      if (!nodePath) continue
      const scoped = attemptsByNode.get(nodePath) ?? new Map<string, LoopStepSegment>()
      scoped.set(segment.meta.scopeId ?? 'legacy', segment)
      attemptsByNode.set(nodePath, scoped)
    }
    const nodes = view.body.nodes.map(node => {
      const nodePath = view.path ? `${view.path}/${node.id}` : node.id
      const latest = attemptsByNode.get(nodePath) ?? new Map<string, LoopStepSegment>()
      const states = [...latest.values()].map(segment => segmentStatus(segment, { isLast: segment === segments[segments.length - 1], jobSettled: settled }))
      const state = ['running', 'paused', 'failed', 'stalled', 'interrupted'].find(value => states.includes(value as typeof states[number])) ?? (states.length ? states.every(value => value === 'ok') ? 'ok' : 'unknown' : 'pending')
      const color = state === 'running' ? 'var(--color-accent-primary)' : state === 'ok' ? 'var(--color-accent-success)'
        : state === 'failed' ? 'var(--color-destructive)' : ['paused', 'stalled', 'interrupted'].includes(state) ? 'var(--color-accent-warning)' : 'var(--color-border)'
      const Icon = state === 'running' ? Loader2 : state === 'ok' ? CheckCircle2 : state === 'failed' ? XCircle : ['paused', 'stalled', 'interrupted'].includes(state) ? PauseCircle : state === 'unknown' ? CircleHelp : Circle
      return { id: node.id, type: 'default', position: { x: 0, y: 0 }, data: { kind: 'core', label: <span className="block text-left" data-state={state}><strong className="flex items-center gap-2"><Icon aria-hidden className={`h-4 w-4 shrink-0 ${state === 'running' ? 'motion-safe:animate-spin' : ''}`} style={{ color: state === 'pending' || state === 'unknown' ? 'var(--color-muted-foreground)' : color }} />{node.label}</strong><span className="mt-1 block text-[10px]">{node.kind} · {t(`loopExplorer.graphState.${state}`)}</span></span> } as LoopNodeData,
        style: { background: state === 'pending' || state === 'unknown' ? 'var(--color-background)' : `color-mix(in srgb, ${color} 12%, var(--color-background))`, color: 'var(--color-foreground)', borderColor: color,
          borderWidth: state === 'pending' || state === 'unknown' ? 1 : 2,
          boxShadow: state === 'running' ? `0 0 0 2px color-mix(in srgb, ${color} 30%, transparent), 0 0 22px color-mix(in srgb, ${color} 35%, transparent)` : undefined } }
    })
    // Entry first gives the existing deterministic layout the real Core root.
    nodes.sort((a, b) => a.id === view.body.entry ? -1 : b.id === view.body.entry ? 1 : 0)
    return { nodes: layoutLoop(nodes, edges, 'vertical'), edges }
  }, [view.body, view.path, segments, settled, t])
  const selectedNode = view.body.nodes.find(node => pathFor(node.id) === selected)
  const component = selectedNode?.component ? topology.components[selectedNode.component] : undefined
  const content = (expanded: boolean) => <>
      <div className="flex shrink-0 items-center gap-2 py-2 text-xs">
        {trail.length > 0 && <Button size="sm" variant="ghost" onClick={() => { setTrail(value => value.slice(0, -1)); setSelected(null) }}>{t('loopExplorer.graphBack')}</Button>}
        <code>{view.path || '/'}</code>
        {expanded ? <DialogClose asChild><Button className="ml-auto" size="sm" variant="ghost" aria-label={t('loopExplorer.graphExitFullscreen')} title={t('loopExplorer.graphExitFullscreen')}><Minimize2 className="h-4 w-4" /></Button></DialogClose>
          : <DialogTrigger asChild><Button className="ml-auto" size="sm" variant="ghost" aria-label={t('loopExplorer.graphFullscreen')} title={t('loopExplorer.graphFullscreen')}><Maximize2 className="h-4 w-4" /></Button></DialogTrigger>}
      </div>
      <div className={expanded ? 'min-h-0 flex-1 rounded border border-border' : 'h-72 rounded border border-border'} aria-label={t('loopExplorer.runtimeGraph')}>
        <ReactFlow key={`${view.path}:${expanded}`} colorMode={theme.scheme === 'dark' ? 'dark' : 'light'} nodes={flow.nodes} edges={flow.edges} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} fitView minZoom={0.1}
          onNodeClick={(_event, node) => setSelected(pathFor(node.id))}>
          <Background /><Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {selected && <div className="shrink-0 space-y-2 py-2 text-xs">
        <code className="break-all">{selected}</code>
        {component && trail.length < 16 && <Button size="sm" variant="outline" onClick={() => { setTrail(value => [...value, { path: selected, body: component }]); setSelected(null) }}>{t('loopExplorer.graphOpenComponent')}</Button>}
        {attempts.length === 0 ? <p>{t('loopExplorer.graphNoAttempts')}</p> : <ul className="max-h-40 space-y-1 overflow-auto">
          {attempts.map(attempt => <li key={attempt.key}><button className="text-left underline underline-offset-2" onClick={() => onFocus(attempt.key)}>{attempt.meta.scopeId ?? '/'} · {attempt.meta.attemptId ?? attempt.meta.index} · {t(`loopExplorer.graphState.${segmentStatus(attempt, { isLast: true, jobSettled: settled })}`)}</button>{onFork && attempt.end && attempt.meta.nodePath && attempt.meta.scopeId && attempt.meta.iteration != null && <Button className="ml-2" size="sm" variant="outline" disabled={forkBusy} onClick={() => onFork(attempt)}>{t('loopExplorer.repeatFromHere')}</Button>}{attempt.meta.traceId && <code className="block break-all text-[10px] text-muted-foreground">traceId: {attempt.meta.traceId}{attempt.meta.spanId ? ` · spanId: ${attempt.meta.spanId}` : ''}</code>}</li>)}
        </ul>}
      </div>}
    </>
  return <Dialog open={fullscreen} onOpenChange={setFullscreen}>
    <details className="shrink-0 border-b border-border p-2" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-xs font-medium">{t('loopExplorer.runtimeGraph')}</summary>
      {open && content(false)}
    </details>
    {/* Keep both portal layers above the log modal, dock and browser overlays. */}
    <DialogContent overlayClassName="z-[2147483646]" className="z-[2147483647] flex w-screen max-w-none !max-h-none flex-col gap-0 rounded-none p-3 sm:rounded-none" style={{ height: `calc(100dvh - ${modalTitleBarInset()}px)` }} showCloseButton={false} aria-describedby={undefined}>
      <DialogTitle className="shrink-0 text-sm">{t('loopExplorer.runtimeGraph')}</DialogTitle>
      {content(true)}
    </DialogContent>
  </Dialog>
}
