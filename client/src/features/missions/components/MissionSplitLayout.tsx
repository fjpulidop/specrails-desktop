import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AgentChatProvider, useAgentChat } from '../context/AgentChatContext'
import { AgentWorkspaceProvider } from '../context/AgentWorkspaceContext'
import { MissionSplitWindowScope } from '../context/MissionWindowsContext'
import { MissionPaneControls, PRIMARY_PANE, useMissionSplitViews } from '../context/MissionSplitViewsContext'
import { AgentModeSurface } from './AgentModeSurface'
import { AgentBrowserCaptureHost } from './AgentBrowserCaptureHost'
import { MissionSplitDivider, dividerStyle, type DividerDrag } from './MissionSplitDivider'
import {
  clampRatio, fitTree, fitsIn, nodeAt, paneRects, ratioBounds, setRatioAt, snapRatio, splitDividers, splitLeaves,
  type PaneRect, type SplitBranch, type SplitNode, type SplitSize,
} from '../lib/mission-split-tree'
import { missionSplitCommand } from '../lib/mission-split-keys'
import { isMacKeyboard } from '../../../lib/keyboard-label'
import { cn } from '../../../lib/utils'

function SplitConversation({ id, onClose }: { id: string; onClose(): void }) {
  const { t } = useTranslation('agent')
  const { active, selectConversation } = useAgentChat()
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setError(false)
    void selectConversation(id, { windowRestore: true, signal: controller.signal }).catch(() => {
      if (!controller.signal.aborted) setError(true)
    })
    return () => controller.abort()
  }, [id, retry, selectConversation])
  if (error) return <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-4 text-sm">
    <p>{t('split.loadFailed')}</p>
    <button onClick={() => setRetry(value => value + 1)}>{t('split.retry')}</button>
    <button onClick={onClose}>{t('split.close')}</button>
  </div>
  if (active?.id !== id) return <div className="flex h-full flex-col items-center justify-center gap-2 text-sm">
    <span role="status">{t('window.loading')}</span><button onClick={onClose}>{t('split.close')}</button>
  </div>
  return <MissionPaneControls paneId={id} splitPaneId={id} onClose={onClose}><AgentModeSurface splitPane /><AgentBrowserCaptureHost /></MissionPaneControls>
}

/** An extra pane's whole mission stack. Memoised: a layout change re-renders only the frame around it. */
const SplitPaneContent = memo(function SplitPaneContent({ id, onClose }: { id: string; onClose(id: string): void }) {
  const close = useCallback(() => onClose(id), [id, onClose])
  return <MissionSplitWindowScope><AgentWorkspaceProvider><AgentChatProvider fixedConversationId={id}>
    <SplitConversation id={id} onClose={close} />
  </AgentChatProvider></AgentWorkspaceProvider></MissionSplitWindowScope>
})

const FULL: PaneRect = { x: 0, y: 0, width: 1, height: 1 }
const pct = (value: number) => `${value * 100}%`
function boxStyle(rect: PaneRect): Pick<CSSProperties, 'left' | 'top' | 'width' | 'height'> {
  return { left: pct(rect.x), top: pct(rect.y), width: pct(rect.width), height: pct(rect.height) }
}
const pathKey = (path: readonly number[]) => path.join('.') || 'root'
/** What the layout draws for a tree in a box: clamped ratios and whether the panes must stack. */
function fitFor(tree: SplitNode, size: SplitSize): { tree: SplitNode; stacked: boolean } {
  const measured = size.width > 0 && size.height > 0
  return {
    tree: measured ? fitTree(tree, size) ?? tree : tree,
    stacked: measured && tree.type === 'split' && !fitsIn(tree, size),
  }
}
const fitSignature = (fit: { tree: SplitNode; stacked: boolean }) => `${fit.stacked}|${JSON.stringify(fit.tree)}`
const isEditable = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable === true)
}

/**
 * Missions side by side. The arrangement is a binary split tree
 * (`lib/mission-split-tree.ts`), drawn as absolute boxes over ONE flat list of
 * panes in the order they were added: moving, swapping, resizing or zooming a
 * pane only changes its box, so its React element (transcript, draft, stream,
 * scroll, embedded browser) is never remounted or even moved in the DOM.
 *
 * When the panes cannot all keep their minimum size (a narrow window), they
 * stack: a tab strip picks the one shown, the others stay mounted and hidden.
 */
export function MissionSplitLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation('agent')
  const { conversations, active } = useAgentChat()
  const split = useMissionSplitViews()
  const { tree, maximizedId, reportLayout, setRatio, equalize, closePane, focusPane } = split
  const root = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const sizeRef = useRef<SplitSize>({ width: 0, height: 0 })
  // The drawn layout depends on the box size only where it clamps a ratio or
  // stacks the panes: a resize that changes neither renders nothing.
  const [sizeTick, setSizeTick] = useState(0)
  const fit = useMemo(() => fitFor(tree, sizeRef.current), [tree, sizeTick])
  const fitRef = useRef(fit)
  fitRef.current = fit
  const treeRef = useRef(tree)
  treeRef.current = tree
  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    const measure = () => {
      const width = element.clientWidth
      const height = element.clientHeight
      if (width === sizeRef.current.width && height === sizeRef.current.height) return
      sizeRef.current = { width, height }
      const next = fitFor(treeRef.current, sizeRef.current)
      if (fitSignature(next) !== fitSignature(fitRef.current)) setSizeTick(tick => tick + 1)
      reportLayout(sizeRef.current, next.stacked)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [reportLayout])
  useEffect(() => { reportLayout(sizeRef.current, fit.stacked) }, [fit.stacked, reportLayout])

  const panes = useMemo(() => splitLeaves(tree), [tree])
  const multiple = panes.length > 1
  const shownAlone = maximizedId ?? (fit.stacked && multiple ? (split.focusedId ?? PRIMARY_PANE) : null)
  const rects = useMemo(() => paneRects(fit.tree), [fit.tree])
  const dividers = useMemo(() => shownAlone ? [] : splitDividers(fit.tree), [fit.tree, shownAlone])
  const titleOf = useCallback((paneId: string) => {
    const id = paneId === PRIMARY_PANE ? active?.id : paneId
    if (!id) return t('mission.new')
    return conversations.find(conversation => conversation.id === id)?.title?.trim() || t('untitled')
  }, [active?.id, conversations, t])

  /** Imperative preview of a ratio during a drag: one style write per pane and divider. */
  const preview = useCallback((path: readonly (0 | 1)[], ratio: number) => {
    const element = box.current
    const live = setRatioAt(fitRef.current.tree, path, ratio)
    if (!element || !live) return
    const nextRects = paneRects(live)
    for (const pane of element.querySelectorAll<HTMLElement>(':scope > [data-split-pane]')) {
      const rect = nextRects.get(pane.dataset.splitPane!)
      if (rect) Object.assign(pane.style, boxStyle(rect))
    }
    for (const divider of splitDividers(live)) {
      const node = element.querySelector<HTMLElement>(`:scope > [data-split-divider="${pathKey(divider.path)}"]`)
      if (node) Object.assign(node.style, dividerStyle(divider.direction, divider.box, divider.ratio))
    }
  }, [])
  const restore = useCallback(() => {
    const element = box.current
    if (!element) return
    for (const pane of element.querySelectorAll<HTMLElement>(':scope > [data-split-pane]')) {
      const rect = shownAloneRef.current ? null : paneRects(fitRef.current.tree).get(pane.dataset.splitPane!)
      if (rect) Object.assign(pane.style, boxStyle(rect))
    }
    for (const divider of splitDividers(fitRef.current.tree)) {
      const node = element.querySelector<HTMLElement>(`:scope > [data-split-divider="${pathKey(divider.path)}"]`)
      if (node) Object.assign(node.style, dividerStyle(divider.direction, divider.box, divider.ratio))
    }
  }, [])
  const shownAloneRef = useRef(shownAlone)
  shownAloneRef.current = shownAlone

  const beginDrag = useCallback((path: readonly (0 | 1)[], divider: { box: PaneRect; ratio: number }, pointer: number): DividerDrag | null => {
    const element = box.current
    const node = nodeAt(fitRef.current.tree, path)
    if (!element || !node || node.type !== 'split') return null
    const bounds = element.getBoundingClientRect()
    const row = node.direction === 'row'
    const start = row ? bounds.left + divider.box.x * bounds.width : bounds.top + divider.box.y * bounds.height
    const along = row ? divider.box.width * bounds.width : divider.box.height * bounds.height
    const boxPixels = { width: divider.box.width * bounds.width, height: divider.box.height * bounds.height }
    // Keep where the divider was grabbed: the hairline never jumps under the pointer.
    const grab = pointer - (start + along * divider.ratio)
    const clamp = (ratio: number) => clampRatio(node as SplitBranch, ratio, boxPixels)
    return {
      ratioAt: (position) => clamp(along > 0 ? (position - grab - start) / along : divider.ratio),
      preview: (ratio) => preview(path, ratio),
      commit: (ratio) => {
        const final = clamp(snapRatio(ratio, along))
        preview(path, final)
        setRatio(path, final)
      },
      cancel: restore,
    }
  }, [preview, restore, setRatio])

  // Move DOM focus into a pane that becomes focused from outside it (menu, shortcut, sidebar).
  useEffect(() => {
    const pane = box.current?.querySelector<HTMLElement>(`:scope > [data-split-pane="${CSS.escape(split.focusedId ?? PRIMARY_PANE)}"]`)
    if (!pane || !split.focusedId || pane.contains(document.activeElement)) return
    pane.focus({ preventScroll: true })
  }, [split.focusedId])

  // Layout shortcuts, while more than one pane is open (lib/mission-split-keys.ts).
  const commandsRef = useRef({ split, panes })
  commandsRef.current = { split, panes }
  useEffect(() => {
    const mac = isMacKeyboard()
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.defaultPrevented || !target || typeof target.closest !== 'function') return
      if (target.closest('[role="dialog"], .monaco-editor, .cm-editor, [data-code-editor], .xterm')) return
      const area = target.closest<HTMLElement>('[data-area]')?.dataset.area
      if (area && area !== 'missions') return
      const command = missionSplitCommand(event, mac, isEditable(target))
      const { split: views, panes: order } = commandsRef.current
      if (!command || order.length < 2) return
      event.preventDefault()
      event.stopPropagation()
      const current = views.focusedId ?? PRIMARY_PANE
      const index = Math.max(0, order.indexOf(current))
      if (command === 'focus-next' || command === 'focus-previous') {
        const next = order[(index + (command === 'focus-next' ? 1 : order.length - 1)) % order.length]!
        if (views.maximizedId) views.toggleMaximize(next)
        views.focusPane(next)
        const pane = box.current?.querySelector<HTMLElement>(`:scope > [data-split-pane="${CSS.escape(next)}"]`)
        requestAnimationFrame(() => (pane?.querySelector<HTMLElement>('[data-mission-composer] [role="textbox"]') ?? pane)?.focus({ preventScroll: true }))
      } else if (command === 'maximize') views.toggleMaximize(current)
      else if (command === 'equalize') views.equalize()
      else views.closePane(current)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  const frame = (paneId: string) => {
    const hidden = shownAlone ? shownAlone !== paneId : !rects.has(paneId)
    const rect = shownAlone || !rects.has(paneId) ? FULL : rects.get(paneId)!
    return {
      hidden,
      props: {
        'data-split-pane': paneId,
        'data-split-focused': multiple && (split.focusedId ?? PRIMARY_PANE) === paneId ? 'true' : undefined,
        tabIndex: -1,
        inert: hidden || undefined,
        'aria-hidden': hidden || undefined,
        role: fit.stacked && multiple && !maximizedId ? 'tabpanel' : undefined,
        id: `mission-pane-${paneId}`,
        style: { ...boxStyle(rect), visibility: hidden ? 'hidden' : undefined } as CSSProperties,
        onFocusCapture: () => { if ((split.focusedId ?? PRIMARY_PANE) !== paneId) focusPane(paneId) },
        className: cn('absolute flex min-h-0 min-w-0 flex-col overflow-hidden outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-primary',
          !hidden && shownAlone && 'z-[1]'),
      },
    }
  }
  const primary = frame(PRIMARY_PANE)

  return <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" ref={root} data-mission-split-layout
    data-split-mode={maximizedId ? 'maximized' : fit.stacked && multiple ? 'stacked' : 'split'}>
    {fit.stacked && multiple && !maximizedId && <StackedTabs panes={panes} focused={split.focusedId ?? PRIMARY_PANE} titleOf={titleOf} onPick={focusPane} />}
    <div ref={box} className="relative min-h-0 flex-1" data-split-count={panes.length}>
      <div key={PRIMARY_PANE} {...primary.props}>
        <MissionPaneControls splitPaneId={PRIMARY_PANE} onClose={multiple ? split.closePrimary : null}>{children}</MissionPaneControls>
      </div>
      {split.conversationIds.map(id => {
        const pane = frame(id)
        return <section key={id} data-split-id={id} aria-label={titleOf(id)} {...pane.props}>
          <SplitPaneContent id={id} onClose={closePane} />
        </section>
      })}
      {dividers.map(divider => {
        const node = nodeAt(fit.tree, divider.path) as SplitBranch
        const size = { width: divider.box.width * sizeRef.current.width, height: divider.box.height * sizeRef.current.height }
        const bounds = ratioBounds(node, size)
        const [first, second] = [splitLeaves(node.first)[0]!, splitLeaves(node.second)[0]!]
        return <MissionSplitDivider key={`${pathKey(divider.path)}:${divider.direction}`} id={pathKey(divider.path)} direction={divider.direction}
          box={divider.box} ratio={divider.ratio} min={bounds.min} max={bounds.max}
          label={t('split.resize', { first: titleOf(first), second: titleOf(second) })}
          begin={(pointer) => beginDrag(divider.path, divider, pointer)}
          onKeyboard={(ratio) => setRatio(divider.path, clampRatio(node, ratio, size))}
          onEqualize={() => equalize(divider.path)} />
      })}
    </div>
  </div>
}

/** The narrow-window layout: one pane at a time, picked from a tab strip (arrows, Home/End). */
function StackedTabs({ panes, focused, titleOf, onPick }: { panes: string[]; focused: string; titleOf(id: string): string; onPick(id: string): void }) {
  const { t } = useTranslation('agent')
  const list = useRef<HTMLDivElement>(null)
  const move = (event: React.KeyboardEvent, index: number) => {
    const last = panes.length - 1
    const next = event.key === 'ArrowRight' ? (index + 1) % panes.length : event.key === 'ArrowLeft' ? (index + last) % panes.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? last : null
    if (next === null) return
    event.preventDefault()
    onPick(panes[next]!)
    requestAnimationFrame(() => list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus())
  }
  return <div ref={list} role="tablist" aria-label={t('split.panes')} data-split-tabs
    className="flex h-8 shrink-0 items-stretch gap-px overflow-x-auto border-b border-border bg-background px-1">
    {panes.map((paneId, index) => {
      const selected = paneId === focused
      return <button key={paneId} type="button" role="tab" aria-selected={selected} aria-controls={`mission-pane-${paneId}`}
        tabIndex={selected ? 0 : -1} onClick={() => onPick(paneId)} onKeyDown={event => move(event, index)}
        className={cn('relative max-w-48 truncate px-3 text-label transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary',
          selected ? 'text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-px after:bg-accent-primary' : 'text-muted-foreground hover:text-foreground')}>
        {titleOf(paneId)}
      </button>
    })}
  </div>
}
