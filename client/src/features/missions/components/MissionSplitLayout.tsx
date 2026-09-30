import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AgentChatProvider, useAgentChat } from '../context/AgentChatContext'
import { AgentWorkspaceProvider } from '../context/AgentWorkspaceContext'
import { MissionSplitWindowScope } from '../context/MissionWindowsContext'
import { MissionPaneControls, useMissionSplitViews } from '../context/MissionSplitViewsContext'
import { AgentModeSurface } from './AgentModeSurface'
import { AgentBrowserCaptureHost } from './AgentBrowserCaptureHost'
import { missionSplitLayout } from '../lib/mission-split-layout'

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
  return <MissionPaneControls paneId={id} onClose={onClose}><AgentModeSurface splitPane /><AgentBrowserCaptureHost /></MissionPaneControls>
}

/** Stable sibling keys keep remaining transcripts, drafts and streams mounted
 * when panes are added or closed. The original conversation is never replaced. */
export function MissionSplitLayout({ children }: { children: ReactNode }) {
  const { t } = useTranslation('agent')
  const { conversations, active } = useAgentChat()
  const split = useMissionSplitViews()
  const root = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(window.innerWidth)
  const ids = split.conversationIds.filter(id => id !== active?.id)
  const count = ids.length + (split.primaryVisible ? 1 : 0)
  const layout = missionSplitLayout(count, width)
  useEffect(() => {
    const element = root.current
    if (!element) return
    const resize = () => { if (element.clientWidth) setWidth(element.clientWidth) }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (split.focusedId) Array.from(root.current?.querySelectorAll<HTMLElement>('[data-split-id]') ?? []).find(pane => pane.dataset.splitId === split.focusedId)?.focus()
  }, [split.focusedId])
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" ref={root} data-mission-split-layout>
    <div className="grid min-h-0 flex-1 overflow-auto" data-split-count={count} data-split-columns={layout.columns}
      style={{ gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${layout.rows}, minmax(${layout.minimumRowHeight}px, 1fr))` }}>
      <div key="primary" className="relative flex min-h-0 min-w-0 flex-col overflow-hidden" style={{ ...layout.placements[0], display: split.primaryVisible ? undefined : 'none' }}>
        <MissionPaneControls onClose={ids.length ? split.closePrimary : null}>{children}</MissionPaneControls>
      </div>
      {ids.map((id, index) => <section key={id} data-split-id={id} tabIndex={-1} aria-label={conversations.find(conversation => conversation.id === id)?.title?.trim() || t('untitled')}
        className="relative min-h-0 min-w-0 overflow-hidden border-l border-t border-border outline-none focus:ring-1 focus:ring-inset focus:ring-accent-primary"
        style={layout.placements[index + (split.primaryVisible ? 1 : 0)]} onFocusCapture={() => split.focus(id)}>
        <MissionSplitWindowScope><AgentWorkspaceProvider><AgentChatProvider fixedConversationId={id}>
          <SplitConversation id={id} onClose={() => split.close(id)} />
        </AgentChatProvider></AgentWorkspaceProvider></MissionSplitWindowScope>
      </section>)}
    </div>
  </div>
}
