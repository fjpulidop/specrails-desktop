import { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Panel,
  Handle,
  Position,
  MarkerType,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ArrowLeft, Save, Upload, Trash2, Play, Terminal, Brain, GitBranch, Flag, Square, Plus, Info, MoveVertical, MoveHorizontal, Grid3x3, RotateCcw, Settings, AlertTriangle, Eye } from 'lucide-react'
import { useActiveTheme } from '../context/ThemeContext'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '../components/ui/tooltip'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/dialog'
import { Button } from '../components/ui/button'
import { layoutLoop, type LayoutMode } from '../lib/loop-layout'
import { cn } from '../lib/utils'
import { loopsApi, LoopPublishError, type LoopNodeType, type LoopConstant, type LoopPreviewStep } from '../lib/loops-api'
import {
  graphToReactFlow,
  reactFlowToGraph,
  makeNode,
  newNodeId,
  type LoopNodeData,
} from '../lib/loop-graph-rf'
import { serializeSelection, parseNodeClipboard, cloneForPaste } from '../lib/loop-clipboard'
import { validateBuilderGraph, severityByNode, type IssueSeverity } from '../lib/loop-validate'

// Per-node validation severity (error/warning), provided by BuilderInner so the
// node component can ring itself without prop-drilling through React Flow.
const NodeValidationContext = createContext<Map<string, IssueSeverity>>(new Map())

// Palette: 'condition' is intentionally OMITTED — the engine treats it as a
// pass-through (AND/OR branching isn't implemented), so offering it would create
// dead no-op nodes. The type + rendering are kept so any pre-existing graph that
// still contains a Condition node loads and runs (as pass-through) without error.
const NODE_KINDS: LoopNodeType[] = ['start', 'ai-step', 'shell', 'decider', 'end']

const NODE_ICON: Record<LoopNodeType, typeof Brain> = {
  start: Play,
  'ai-step': Brain,
  shell: Terminal,
  decider: GitBranch,
  condition: GitBranch,
  end: Flag,
}

const NODE_ACCENT: Record<LoopNodeType, string> = {
  start: 'border-accent-success/60',
  'ai-step': 'border-accent-primary/60',
  shell: 'border-accent-warning/60',
  decider: 'border-accent-highlight/60',
  condition: 'border-accent-info/60',
  end: 'border-accent-secondary/60',
}

// ── Custom node (one component renders every kind via data.kind) ─────────────
function LoopNodeBox({ id, data, selected }: NodeProps<Node<LoopNodeData>>) {
  const { t } = useTranslation('loops')
  const kind = data.kind
  const Icon = NODE_ICON[kind] ?? Square
  const label = String(data.label ?? '').trim() // user-given name; falls back to the type
  const severity = useContext(NodeValidationContext).get(id)
  const summary =
    kind === 'ai-step' ? String(data.model || data.provider || '') :
    kind === 'shell' ? String(data.command || '') :
    kind === 'decider' ? String(data.goal || '') :
    kind === 'condition' ? String(data.join || 'AND') :
    kind === 'end' ? String(data.outcome || 'success') :
    ''
  return (
    <div
      className={cn(
        'rounded-md border-2 bg-card px-3 py-2 min-w-[140px] shadow-sm',
        NODE_ACCENT[kind],
        // Validation ring takes precedence over the selection ring so problems
        // stay visible even when the node isn't selected.
        severity === 'error' ? 'ring-2 ring-destructive'
          : selected ? 'ring-2 ring-accent-primary'
          : severity === 'warning' ? 'ring-2 ring-accent-warning'
          : ''
      )}
    >
      {/* Typed handles: Start = source only, End = target only, Decider = one
          target + TWO named source handles (continue / stop), everything else
          one target + one source. */}
      {kind !== 'start' && <Handle type="target" position={Position.Top} />}
      <div className="flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5 text-foreground flex-shrink-0" />
        <span className="text-xs font-semibold text-foreground truncate max-w-[150px]">{label || t(`builder.nodes.${kind}`)}</span>
        {label && <span className="text-[9px] text-muted-foreground/70 flex-shrink-0">{t(`builder.nodes.${kind}`)}</span>}
      </div>
      {summary && <p className="text-[10px] text-muted-foreground mt-1 truncate max-w-[160px]">{summary}</p>}
      {kind === 'decider' ? (
        <>
          {/* Two named, colour-coded outputs at the bottom (layout-agnostic): the
              continue branch loops back, the stop branch exits. The edges route
              orthogonally (smoothstep) to whichever node the layout places them. */}
          <div className="mt-1.5 flex items-center justify-between gap-2 text-[9px] font-medium">
            <span className="text-accent-highlight">{t('builder.branch.continue')}</span>
            <span className="text-accent-success">{t('builder.branch.stop')}</span>
          </div>
          <Handle id="continue" type="source" position={Position.Bottom} style={{ left: '30%' }} className="!bg-accent-highlight" />
          <Handle id="stop" type="source" position={Position.Bottom} style={{ left: '70%' }} className="!bg-accent-success" />
        </>
      ) : kind !== 'end' ? (
        <Handle type="source" position={Position.Bottom} />
      ) : null}
    </div>
  )
}

function BuilderInner() {
  const { t } = useTranslation('loops')
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const theme = useActiveTheme()
  const { fitView } = useReactFlow()

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<LoopNodeData>>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [name, setName] = useState('')
  const [maxIterations, setMaxIterations] = useState(10)
  const [timeoutMinutes, setTimeoutMinutes] = useState(30)
  // Optional cost cap (USD). null = no cap. Stored on graph.config.maxCostUsd.
  const [maxCostUsd, setMaxCostUsd] = useState<number | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showProblems, setShowProblems] = useState(false)
  const [preview, setPreview] = useState<LoopPreviewStep[] | null>(null)
  const [previewing, setPreviewing] = useState(false)
  // Live validation (mirrors the server publish gate + authoring warnings). Drives
  // the per-node ring (via context) and the Problems panel.
  const issues = useMemo(() => validateBuilderGraph(nodes, edges), [nodes, edges])
  const nodeSeverity = useMemo(() => severityByNode(issues), [issues])
  const errorCount = issues.filter((i) => i.severity === 'error').length
  // The saved auto-arrange decision for THIS loop (persisted in graph.config.layout).
  // 'manual' = hand-placed; an auto mode is re-applied whenever the loop re-opens.
  const [layoutMode, setLayoutMode] = useState<LayoutMode | 'manual'>('manual')
  // Positions the loop loaded with — restored by the "Default" arrange action.
  const initialPositions = useRef<Map<string, { x: number; y: number }>>(new Map())
  // Global constants library (shared across all loops), lifted here so the
  // manager modal and every step's palette stay in sync after a CRUD.
  const [constants, setConstants] = useState<LoopConstant[]>([])
  const [showConstants, setShowConstants] = useState(false)
  const reloadConstants = useCallback(async () => {
    try { setConstants(await loopsApi.loopConstants()) } catch { /* keep last */ }
  }, [])
  useEffect(() => { void reloadConstants() }, [reloadConstants])

  const nodeTypes = useMemo(() => ({ loop: LoopNodeBox }), [])

  useEffect(() => {
    if (!id) return
    let cancelled = false
    loopsApi
      .get(id)
      .then((loop) => {
        if (cancelled) return
        const { nodes: rfNodes, edges: rfEdges } = graphToReactFlow(loop.graph)
        initialPositions.current = new Map(rfNodes.map((n) => [n.id, { ...n.position }]))
        // Re-apply the loop's saved arrange decision so it always opens tidy in
        // the chosen orientation; 'manual'/unset keeps the stored positions.
        const saved = loop.graph.config?.layout
        const mode: LayoutMode | 'manual' = saved === 'vertical' || saved === 'horizontal' || saved === 'grid' ? saved : 'manual'
        setLayoutMode(mode)
        setNodes(mode === 'manual' ? rfNodes : layoutLoop(rfNodes, rfEdges, mode))
        setEdges(rfEdges)
        setName(loop.name)
        setMaxIterations(loop.graph.config?.maxIterations ?? 10)
        setTimeoutMinutes(loop.graph.config?.timeoutMinutes ?? 30)
        setMaxCostUsd(typeof loop.graph.config?.maxCostUsd === 'number' ? loop.graph.config!.maxCostUsd! : null)
      })
      .catch(() => toast.error(t('errors.load')))
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id, setNodes, setEdges, t])

  // Connections drawn from a Decider's named handle ('continue' / 'stop') are
  // colour-coded and carry the branch so the engine routes by it.
  const onConnect = useCallback((params: Connection) => {
    const branch = params.sourceHandle === 'continue' || params.sourceHandle === 'stop' ? params.sourceHandle : undefined
    const edge = branch
      ? { ...params, data: { branch }, style: { stroke: branch === 'stop' ? 'var(--color-accent-success)' : 'var(--color-accent-highlight)' } }
      : params
    setEdges((eds) => addEdge(edge, eds))
  }, [setEdges])

  // Typed-handle validation: no edge INTO a Start, no edge OUT of an End, and no
  // self-loops. Combined with the per-kind handles above, this makes only the
  // valid wiring drawable, so "how do I connect these?" stops being a guess.
  const isValidConnection = useCallback((c: Connection | Edge) => {
    if (!c.source || !c.target || c.source === c.target) return false
    const src = nodes.find((n) => n.id === c.source)?.data.kind
    const tgt = nodes.find((n) => n.id === c.target)?.data.kind
    if (!src || !tgt) return false
    if (src === 'end') return false
    if (tgt === 'start') return false
    return true
  }, [nodes])

  // Auto-arrange the steps. 'default' restores the layout the loop loaded with;
  // the others recompute positions (vertical / horizontal layering, or grid
  // snap). Re-fit the viewport after the position commit so the result is framed.
  const arrange = useCallback((mode: LayoutMode | 'default') => {
    // 'default' = drop back to manual placement (restore loaded positions); the
    // others record the auto-arrange decision so it persists on Save + re-opens.
    setLayoutMode(mode === 'default' ? 'manual' : mode)
    setNodes((nds) =>
      mode === 'default'
        ? nds.map((n) => {
            const p = initialPositions.current.get(n.id)
            return p ? { ...n, position: { ...p } } : n
          })
        : layoutLoop(nds, edges, mode)
    )
    requestAnimationFrame(() => fitView({ padding: 0.25, maxZoom: 0.85, duration: 300 }))
  }, [setNodes, edges, fitView])

  // A hand drag reverts the decision to 'manual' so the next open doesn't snap
  // the user's bespoke placement back into an auto layout. (Programmatic layout
  // via setNodes does NOT flow through onNodesChange, so it never trips this.)
  const handleNodesChange = useCallback((changes: Parameters<typeof onNodesChange>[0]) => {
    if (changes.some((c) => c.type === 'position' && c.dragging === false)) setLayoutMode('manual')
    onNodesChange(changes)
  }, [onNodesChange])

  // Copy/paste steps via the system clipboard — works ACROSS loops (the payload
  // travels as tagged JSON text). Uses the copy/paste DOM events (no clipboard
  // permission prompt) and bails while a text field is focused so native
  // copy/paste inside the prompt/goal inputs is untouched. Refs keep the handlers
  // reading live nodes/edges without rebinding on every change.
  const nodesRef = useRef(nodes); nodesRef.current = nodes
  const edgesRef = useRef(edges); edgesRef.current = edges
  useEffect(() => {
    const inField = () => {
      const el = document.activeElement as HTMLElement | null
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
    }
    const onCopy = (e: ClipboardEvent) => {
      if (inField()) return
      const payload = serializeSelection(nodesRef.current, edgesRef.current)
      if (!payload || !e.clipboardData) return
      e.clipboardData.setData('text/plain', JSON.stringify(payload))
      e.preventDefault()
    }
    const onPaste = (e: ClipboardEvent) => {
      if (inField()) return
      const payload = parseNodeClipboard(e.clipboardData?.getData('text/plain') ?? '')
      if (!payload) return
      e.preventDefault()
      // A graph can have only one Start — skip a pasted one if we already have it.
      const hasStart = nodesRef.current.some((n) => n.data.kind === 'start')
      const cloned = cloneForPaste(payload, { mintId: newNodeId, offset: { x: 40, y: 40 }, excludeKinds: hasStart ? ['start'] : [] })
      if (cloned.nodes.length === 0) return
      setNodes((nds) => [...nds.map((n) => ({ ...n, selected: false })), ...cloned.nodes])
      setEdges((eds) => [...eds, ...cloned.edges])
      setLayoutMode('manual') // pasted nodes are hand-placed
      toast.success(t('builder.paste.done', { count: cloned.nodes.length }))
    }
    window.addEventListener('copy', onCopy)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('copy', onCopy)
      window.removeEventListener('paste', onPaste)
    }
  }, [setNodes, setEdges, t])

  const addNode = useCallback(
    (kind: LoopNodeType) => {
      const node = makeNode(kind, { x: 120 + Math.random() * 120, y: 80 + Math.random() * 240 })
      setNodes((nds) => [...nds, node])
      setSelectedId(node.id)
    },
    [setNodes]
  )

  const updateSelectedData = useCallback(
    (patch: Partial<LoopNodeData>) => {
      setNodes((nds) => nds.map((n) => (n.id === selectedId ? { ...n, data: { ...n.data, ...patch } } : n)))
    },
    [selectedId, setNodes]
  )

  const deleteSelected = useCallback(() => {
    if (!selectedId) return
    setNodes((nds) => nds.filter((n) => n.id !== selectedId))
    setEdges((eds) => eds.filter((e) => e.source !== selectedId && e.target !== selectedId))
    setSelectedId(null)
  }, [selectedId, setNodes, setEdges])

  // Dry-run: resolve the CURRENT (unsaved) graph's tokens and show what would run.
  const runPreview = useCallback(async () => {
    setPreviewing(true)
    try {
      const graph = reactFlowToGraph(nodes, edges, { maxIterations, timeoutMinutes, maxCostUsd: maxCostUsd ?? undefined, layout: layoutMode })
      const { steps } = await loopsApi.previewLoop(graph)
      setPreview(steps)
    } catch {
      toast.error(t('builder.preview.error'))
    } finally {
      setPreviewing(false)
    }
  }, [nodes, edges, maxIterations, timeoutMinutes, maxCostUsd, layoutMode, t])

  const save = useCallback(async (): Promise<boolean> => {
    if (!id) return false
    setSaving(true)
    try {
      const graph = reactFlowToGraph(nodes, edges, { maxIterations, timeoutMinutes, maxCostUsd: maxCostUsd ?? undefined, layout: layoutMode })
      await loopsApi.update(id, { name, graph })
      return true
    } catch (err) {
      // Surface the server reason (e.g. "Loop is running; stop the run before
      // editing") instead of an opaque generic — far easier to diagnose.
      toast.error(err instanceof Error && err.message ? err.message : t('errors.save'))
      return false
    } finally {
      setSaving(false)
    }
  }, [id, nodes, edges, maxIterations, timeoutMinutes, maxCostUsd, layoutMode, name, t])

  const publish = useCallback(async () => {
    if (!id) return
    const ok = await save()
    if (!ok) return
    try {
      await loopsApi.publish(id)
      toast.success(t('builder.published'))
      navigate('/loops')
    } catch (err) {
      if (err instanceof LoopPublishError) {
        toast.error(t('errors.publishInvalid'))
      } else {
        toast.error(err instanceof Error && err.message ? err.message : t('errors.save'))
      }
    }
  }, [id, save, navigate, t])

  const selected = nodes.find((n) => n.id === selectedId) ?? null

  return (
    <NodeValidationContext.Provider value={nodeSeverity}>
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 px-4 h-12 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <button type="button" onClick={() => navigate('/loops')} className="text-muted-foreground hover:text-foreground" aria-label={t('builder.back')}>
            <ArrowLeft className="w-4 h-4" />
          </button>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="text-sm font-semibold bg-transparent text-foreground border-b border-transparent focus:border-border focus:outline-none min-w-0"
            aria-label="name"
          />
        </div>
        <div className="flex items-center gap-2">
          <TooltipProvider delayDuration={150}>
            <label className="text-[10px] text-muted-foreground flex items-center gap-1">
              {t('builder.config.maxIterations')}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" onClick={(e) => e.preventDefault()} className="text-muted-foreground/60 hover:text-foreground" aria-label={t('builder.config.maxIterations')}>
                    <Info className="w-3 h-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs leading-relaxed">{t('builder.config.maxIterationsHint')}</TooltipContent>
              </Tooltip>
              <input type="number" min={1} value={maxIterations} onChange={(e) => setMaxIterations(Math.max(1, Number(e.target.value) || 1))} className="w-14 h-6 text-xs rounded border border-border bg-transparent px-1 text-foreground" />
            </label>
            <label className="text-[10px] text-muted-foreground flex items-center gap-1">
              {t('builder.config.timeout')}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" onClick={(e) => e.preventDefault()} className="text-muted-foreground/60 hover:text-foreground" aria-label={t('builder.config.timeout')}>
                    <Info className="w-3 h-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs leading-relaxed">{t('builder.config.timeoutHint')}</TooltipContent>
              </Tooltip>
              <input type="number" min={1} value={timeoutMinutes} onChange={(e) => setTimeoutMinutes(Math.max(1, Number(e.target.value) || 1))} className="w-14 h-6 text-xs rounded border border-border bg-transparent px-1 text-foreground" />
            </label>
            <label className="text-[10px] text-muted-foreground flex items-center gap-1">
              {t('builder.config.maxCost')}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" onClick={(e) => e.preventDefault()} className="text-muted-foreground/60 hover:text-foreground" aria-label={t('builder.config.maxCost')}>
                    <Info className="w-3 h-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs leading-relaxed">{t('builder.config.maxCostHint')}</TooltipContent>
              </Tooltip>
              <input
                type="number"
                min={0}
                step={0.5}
                placeholder="∞"
                value={maxCostUsd ?? ''}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  setMaxCostUsd(e.target.value === '' || !(v > 0) ? null : v)
                }}
                className="w-16 h-6 text-xs rounded border border-border bg-transparent px-1 text-foreground"
              />
            </label>
          </TooltipProvider>
          <button type="button" onClick={() => void runPreview()} disabled={previewing} className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs border border-border hover:bg-muted text-foreground disabled:opacity-50">
            <Eye className="w-3 h-3" /> {t('builder.preview.label')}
          </button>
          <button type="button" onClick={() => void save().then((ok) => ok && toast.success(t('builder.saved')))} disabled={saving} className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs border border-border hover:bg-muted text-foreground disabled:opacity-50">
            <Save className="w-3 h-3" /> {t('builder.save')}
          </button>
          <button type="button" onClick={() => void publish()} disabled={saving} className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs bg-accent-primary text-white hover:bg-accent-primary/90 disabled:opacity-50">
            <Upload className="w-3 h-3" /> {t('builder.publish')}
          </button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Palette */}
        <div className="w-44 border-r border-border p-2 space-y-1 flex-shrink-0 overflow-y-auto">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground px-1 mb-1">{t('builder.addNode')}</p>
          {NODE_KINDS.map((kind) => {
            const Icon = NODE_ICON[kind]
            return (
              <button key={kind} type="button" onClick={() => addNode(kind)} className="flex items-center gap-2 w-full h-8 px-2 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50">
                <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="truncate">{t(`builder.nodes.${kind}`)}</span>
                <Plus className="w-3 h-3 ml-auto opacity-50" />
              </button>
            )
          })}
        </div>

        {/* Canvas */}
        <div className="flex-1 min-w-0 relative">
          {loading ? (
            <div className="flex items-center justify-center h-full"><p className="text-sm text-muted-foreground">…</p></div>
          ) : (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={handleNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              onNodeClick={(_, n) => setSelectedId(n.id)}
              onPaneClick={() => setSelectedId(null)}
              nodeTypes={nodeTypes}
              colorMode={theme.scheme === 'dark' ? 'dark' : 'light'}
              fitView
              fitViewOptions={{ padding: 0.25, maxZoom: 0.85 }}
              minZoom={0.2}
              defaultEdgeOptions={{ type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 } }}
              proOptions={{ hideAttribution: true }}
            >
              <Background />
              <Controls />
              <MiniMap pannable zoomable />
              {/* Auto-arrange the steps: vertical / horizontal layering, grid snap,
                  or restore the layout the loop loaded with. */}
              <Panel position="top-left">
                <div className="flex items-center gap-0.5 rounded-md border border-border bg-card/90 backdrop-blur p-0.5" role="group" aria-label={t('builder.arrange.label')}>
                  {([['vertical', MoveVertical], ['horizontal', MoveHorizontal], ['grid', Grid3x3], ['default', RotateCcw]] as const).map(([mode, Icon]) => {
                    const key = mode === 'default' ? 'reset' : mode
                    const active = mode === 'default' ? layoutMode === 'manual' : layoutMode === mode
                    return (
                      <button
                        key={mode}
                        type="button"
                        title={t(`builder.arrange.${key}`)}
                        aria-label={t(`builder.arrange.${key}`)}
                        aria-pressed={active}
                        onClick={() => arrange(mode)}
                        className={cn(
                          'inline-flex items-center justify-center w-7 h-7 rounded hover:bg-muted',
                          active ? 'bg-muted text-accent-primary' : 'text-muted-foreground hover:text-foreground'
                        )}
                      >
                        <Icon className="w-3.5 h-3.5" />
                      </button>
                    )
                  })}
                </div>
              </Panel>
              {/* How the boxes connect — control-flow, not data-flow. */}
              <Panel position="top-right">
                <TooltipProvider delayDuration={150}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button type="button" className="inline-flex items-center gap-1 h-6 px-2 rounded-md text-[10px] border border-border bg-card/90 text-muted-foreground hover:text-foreground backdrop-blur">
                        <Info className="w-3 h-3" />
                        {t('builder.edgesHelp.label')}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs leading-relaxed">
                      {t('builder.edgesHelp.body')}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </Panel>
              {/* Live problems — errors (red) + warnings (amber); click to select. */}
              {issues.length > 0 && (
                <Panel position="bottom-center">
                  <div className="rounded-md border border-border bg-card/95 backdrop-blur text-xs overflow-hidden max-w-md mb-2">
                    <button
                      type="button"
                      onClick={() => setShowProblems((v) => !v)}
                      className={cn('flex items-center gap-1.5 w-full px-2.5 py-1.5 font-medium', errorCount > 0 ? 'text-destructive' : 'text-accent-warning')}
                    >
                      <AlertTriangle className="w-3.5 h-3.5" />
                      {t('builder.problems.count', { count: issues.length })}
                    </button>
                    {showProblems && (
                      <ul className="border-t border-border max-h-40 overflow-y-auto py-1">
                        {issues.map((issue, i) => (
                          <li key={`${issue.code}-${issue.nodeId ?? i}`}>
                            <button
                              type="button"
                              disabled={!issue.nodeId}
                              onClick={() => issue.nodeId && setSelectedId(issue.nodeId)}
                              className="flex items-start gap-1.5 w-full text-left px-2.5 py-1 hover:bg-muted disabled:cursor-default"
                            >
                              <span className={cn('mt-1 w-1.5 h-1.5 rounded-full flex-shrink-0', issue.severity === 'error' ? 'bg-destructive' : 'bg-accent-warning')} />
                              <span className="text-foreground">{t(`builder.problems.${issue.code}`)}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </Panel>
              )}
            </ReactFlow>
          )}
        </div>

        {/* Inspector */}
        <div className="w-64 border-l border-border p-3 flex-shrink-0 overflow-y-auto">
          {!selected ? (
            <p className="text-xs text-muted-foreground">{t('builder.inspector.selectNode')}</p>
          ) : (
            <NodeInspector
              data={selected.data}
              onChange={updateSelectedData}
              onDelete={deleteSelected}
              constants={constants}
              onManageConstants={() => setShowConstants(true)}
            />
          )}
        </div>
      </div>

      <LoopConstantsManager
        open={showConstants}
        onClose={() => setShowConstants(false)}
        constants={constants}
        onChanged={reloadConstants}
        t={t}
      />
      <LoopPreviewModal steps={preview} onClose={() => setPreview(null)} t={t} />
    </div>
    </NodeValidationContext.Provider>
  )
}

// Magic-token palette for the AI Step prompt. Spec fields are data tokens
// (`{{spec.*}}`, resolved at launch); commands are provider-invariant prompt
// snippets (`{{cmd:*}}`, expanded by the engine — see loop-command-catalog).
const TOKEN_GROUPS: { labelKey: string; tokens: { token: string; label: string }[] }[] = [
  {
    labelKey: 'builder.inspector.tokensSpec',
    tokens: [
      { token: '{{spec.title}}', label: 'spec.title' },
      { token: '{{spec.description}}', label: 'spec.description' },
      { token: '{{spec.id}}', label: 'spec.id' },
      { token: '{{spec.status}}', label: 'spec.status' },
      { token: '{{spec.priority}}', label: 'spec.priority' },
      { token: '{{spec.labels}}', label: 'spec.labels' },
    ],
  },
  {
    labelKey: 'builder.inspector.tokensJira',
    tokens: [
      { token: '{{spec.jira_key}}', label: 'spec.jira_key' },
      { token: '{{spec.jira_url}}', label: 'spec.jira_url' },
    ],
  },
]

function TokenChip({ token, label, description, onInsert }: { token: string; label: string; description?: string; onInsert: (token: string) => void }) {
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/plain', token)}
      onClick={() => onInsert(token)}
      title={description ? `${token} — ${description}` : token}
      className="px-1.5 py-0.5 rounded border border-border bg-surface/40 text-[10px] font-mono text-accent-primary hover:bg-accent-primary/10 cursor-grab active:cursor-grabbing"
    >
      {label}
    </button>
  )
}

function TokenPalette({ t, onInsert }: { t: (key: string) => string; onInsert: (token: string) => void }) {
  // Magic commands come from the server catalog so the palette never drifts from
  // what the engine actually expands ({{cmd:implement|batch|freestyle|verify}}, …).
  const [commands, setCommands] = useState<{ name: string; label: string; description: string }[]>([])
  useEffect(() => {
    let cancelled = false
    loopsApi.loopCommands()
      .then((cmds) => { if (!cancelled) setCommands(cmds) })
      .catch(() => { /* leave empty; spec tokens still available */ })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="mb-2 space-y-1.5">
      {TOKEN_GROUPS.map((group) => (
        <div key={group.labelKey}>
          <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/70 mb-0.5">{t(group.labelKey)}</span>
          <div className="flex flex-wrap gap-1">
            {group.tokens.map((tok) => (
              <TokenChip key={tok.token} token={tok.token} label={tok.label} onInsert={onInsert} />
            ))}
          </div>
        </div>
      ))}
      {commands.length > 0 && (
        <div>
          <span className="block text-[9px] uppercase tracking-wide text-muted-foreground/70 mb-0.5">{t('builder.inspector.tokensCommands')}</span>
          <div className="flex flex-wrap gap-1">
            {commands.map((c) => (
              <TokenChip key={c.name} token={`{{cmd:${c.name}}}`} label={`⚡ ${c.label}`} description={c.description} onInsert={onInsert} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// Draggable/clickable chips for the global constants library. Inserts a live
// `{{const:NAME}}` token (resolved at run time). The gear opens the manager.
function ConstantPalette({ t, constants, onInsert, onManage }: {
  t: (key: string) => string
  constants: LoopConstant[]
  onInsert: (token: string) => void
  onManage: () => void
}) {
  return (
    <div className="mb-2">
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[9px] uppercase tracking-wide text-muted-foreground/70">{t('builder.constants.label')}</span>
        <button type="button" onClick={onManage} title={t('builder.constants.manage')} aria-label={t('builder.constants.manage')} className="text-muted-foreground hover:text-foreground">
          <Settings className="w-3 h-3" />
        </button>
      </div>
      <div className="flex flex-wrap gap-1">
        {constants.map((c) => (
          <TokenChip key={c.id} token={`{{const:${c.name}}}`} label={c.builtin ? `🔒 ${c.name}` : c.name} description={c.value} onInsert={onInsert} />
        ))}
      </div>
    </div>
  )
}

// One editable custom-constant row in the manager (value-only edit; name is the
// immutable token key). Local value state so typing doesn't refetch.
function ConstantRow({ c, onSave, onDelete }: { c: LoopConstant; onSave: (v: string) => void; onDelete: () => void }) {
  const [v, setV] = useState(c.value)
  return (
    <div className="flex items-center gap-1.5">
      <code className="text-[10px] font-mono text-accent-primary w-28 truncate" title={c.name}>{c.name}</code>
      <input className="flex-1 text-xs rounded border border-border bg-transparent px-2 py-1 text-foreground" value={v} onChange={(e) => setV(e.target.value)} />
      <button type="button" disabled={v === c.value || !v} onClick={() => onSave(v)} className="text-muted-foreground hover:text-foreground disabled:opacity-40" aria-label="save"><Save className="w-3.5 h-3.5" /></button>
      <button type="button" onClick={onDelete} className="text-muted-foreground hover:text-destructive" aria-label="delete"><Trash2 className="w-3.5 h-3.5" /></button>
    </div>
  )
}

// Global constants manager: built-ins (read-only) + custom CRUD. Mutations call
// the API then `onChanged()` to refetch the lifted list (so palettes update live).
function LoopConstantsManager({ open, onClose, constants, onChanged, t }: {
  open: boolean
  onClose: () => void
  constants: LoopConstant[]
  onChanged: () => Promise<void> | void
  t: (key: string) => string
}) {
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const builtins = constants.filter((c) => c.builtin)
  const custom = constants.filter((c) => !c.builtin)
  const add = async () => {
    setBusy(true); setErr(null)
    try {
      await loopsApi.createConstant(name.trim(), value)
      setName(''); setValue('')
      await onChanged()
    } catch (e) { setErr(e instanceof Error ? e.message : 'error') } finally { setBusy(false) }
  }
  const input = 'text-xs rounded border border-border bg-transparent px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-accent-primary/40'
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('builder.constants.title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            {custom.length === 0 && <p className="text-xs text-muted-foreground">{t('builder.constants.empty')}</p>}
            {custom.map((c) => (
              <ConstantRow
                key={c.id}
                c={c}
                onSave={(v) => void loopsApi.updateConstant(c.id, v).then(onChanged)}
                onDelete={() => void loopsApi.deleteConstant(c.id).then(onChanged)}
              />
            ))}
          </div>
          {/* Add form */}
          <div className="flex items-center gap-1.5 border-t border-border pt-2">
            <input className={`${input} w-28`} placeholder={t('builder.constants.name')} value={name} onChange={(e) => setName(e.target.value)} />
            <input className={`${input} flex-1`} placeholder={t('builder.constants.value')} value={value} onChange={(e) => setValue(e.target.value)} />
            <Button size="sm" disabled={busy || !name.trim() || !value} onClick={() => void add()}>{t('builder.constants.add')}</Button>
          </div>
          {err && <p className="text-[10px] text-destructive">{err}</p>}
          {/* Built-ins (read-only) */}
          {builtins.length > 0 && (
            <div className="border-t border-border pt-2 space-y-1">
              <span className="text-[9px] uppercase tracking-wide text-muted-foreground/70">{t('builder.constants.builtinBadge')}</span>
              {builtins.map((c) => (
                <div key={c.id} className="flex items-center gap-1.5 text-[10px]">
                  <code className="font-mono text-accent-primary w-28 truncate" title={c.name}>{c.name}</code>
                  <span className="text-muted-foreground truncate">{c.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('common:actions.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Dry-run preview modal: the exact prompt/command/goal each step would send,
// with all tokens resolved (spec values are sample data).
function LoopPreviewModal({ steps, onClose, t }: {
  steps: LoopPreviewStep[] | null
  onClose: () => void
  t: (key: string) => string
}) {
  return (
    <Dialog open={steps !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('builder.preview.title')}</DialogTitle>
        </DialogHeader>
        <p className="text-[11px] text-muted-foreground">{t('builder.preview.sampleNote')}</p>
        <div className="space-y-2 max-h-[60vh] overflow-y-auto">
          {steps && steps.length === 0 && <p className="text-xs text-muted-foreground">{t('builder.preview.empty')}</p>}
          {steps?.map((s, i) => (
            <div key={`${s.nodeId}-${i}`} className="rounded-md border border-border">
              <div className="px-2.5 py-1 text-[10px] border-b border-border flex items-center gap-1.5">
                <span className="font-medium text-foreground">{s.label || t(`builder.nodes.${s.kind}`)}</span>
                <span className="text-muted-foreground">· {t(`builder.nodes.${s.kind}`)}</span>
              </div>
              <pre className="px-2.5 py-2 text-[11px] text-foreground whitespace-pre-wrap break-words font-mono">{s.text || '—'}</pre>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('common:actions.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function NodeInspector({
  data,
  onChange,
  onDelete,
  constants,
  onManageConstants,
}: {
  data: LoopNodeData
  onChange: (patch: Partial<LoopNodeData>) => void
  onDelete: () => void
  constants: LoopConstant[]
  onManageConstants: () => void
}) {
  const { t } = useTranslation('loops')
  const kind = data.kind
  const field = 'block text-[10px] font-medium text-muted-foreground mb-1'
  const input = 'w-full text-xs rounded border border-border bg-transparent px-2 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-accent-primary/40'
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const goalRef = useRef<HTMLTextAreaElement>(null)
  // Insert a magic token at the caret of the given field's textarea (or append if
  // not focused), then restore the caret just after it. Drag-drop inserts natively
  // (the chip carries the token as text/plain), so this only covers the click path.
  const insertAt = (ref: React.RefObject<HTMLTextAreaElement | null>, key: 'prompt' | 'goal', token: string) => {
    const el = ref.current
    const current = String((data as Record<string, unknown>)[key] ?? '')
    if (!el) { onChange({ [key]: current + token } as Partial<LoopNodeData>); return }
    const start = el.selectionStart ?? current.length
    const end = el.selectionEnd ?? current.length
    onChange({ [key]: current.slice(0, start) + token + current.slice(end) } as Partial<LoopNodeData>)
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + token.length
      el.setSelectionRange(pos, pos)
    })
  }
  const insertToken = (token: string) => insertAt(promptRef, 'prompt', token)
  const insertGoal = (token: string) => insertAt(goalRef, 'goal', token)
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-foreground">{t(`builder.nodes.${kind}`)}</span>
        <button type="button" onClick={onDelete} aria-label={t('builder.deleteNode')} className="text-muted-foreground hover:text-destructive">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Custom name for this step (all kinds). Empty → the node shows its type.
          The run log uses it too, so a well-named step reads clearly there. */}
      <div>
        <label className={field}>{t('builder.inspector.label')}</label>
        <input
          className={input}
          value={String(data.label ?? '')}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder={t(`builder.nodes.${kind}`)}
        />
      </div>

      {kind === 'ai-step' && (
        <div>
          <label className={field}>{t('builder.inspector.prompt')}</label>
          {/* Provider / model / reasoning effort are NOT set here — the RAIL
              governs them for the whole run ("lo que pongamos en el rail manda"). */}
          <TokenPalette t={t} onInsert={insertToken} />
          <ConstantPalette t={t} constants={constants} onInsert={insertToken} onManage={onManageConstants} />
          <textarea
            ref={promptRef}
            rows={7}
            className={input}
            value={String(data.prompt ?? '')}
            onChange={(e) => onChange({ prompt: e.target.value })}
          />
          <p className="text-[10px] text-muted-foreground mt-1">{t('builder.inspector.promptHint')}</p>
        </div>
      )}

      {kind === 'shell' && (
        <div>
          <label className={field}>{t('builder.inspector.command')}</label>
          <input className={input} value={String(data.command ?? '')} onChange={(e) => onChange({ command: e.target.value })} placeholder="npm test" />
        </div>
      )}

      {kind === 'decider' && (
        <div>
          <label className={field}>{t('builder.inspector.goal')}</label>
          <ConstantPalette t={t} constants={constants} onInsert={insertGoal} onManage={onManageConstants} />
          <textarea ref={goalRef} rows={4} className={input} value={String(data.goal ?? '')} onChange={(e) => onChange({ goal: e.target.value })} />
        </div>
      )}

      {kind === 'condition' && (
        <div>
          <label className={field}>{t('builder.inspector.join')}</label>
          <select className={input} value={String(data.join ?? 'AND')} onChange={(e) => onChange({ join: e.target.value })}>
            <option value="AND">AND</option>
            <option value="OR">OR</option>
          </select>
        </div>
      )}

      {kind === 'end' && (
        <div>
          <label className={field}>{t('builder.inspector.outcome')}</label>
          <select className={input} value={String(data.outcome ?? 'success')} onChange={(e) => onChange({ outcome: e.target.value })}>
            <option value="success">success</option>
            <option value="failure">failure</option>
          </select>
        </div>
      )}

      {kind === 'start' && <p className="text-[10px] text-muted-foreground">{t('builder.inspector.startNote')}</p>}
    </div>
  )
}

export default function LoopBuilderPage() {
  return (
    <ReactFlowProvider>
      <BuilderInner />
    </ReactFlowProvider>
  )
}
