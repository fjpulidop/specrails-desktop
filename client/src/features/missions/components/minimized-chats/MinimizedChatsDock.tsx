import { useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ChevronUp } from 'lucide-react'
import type { MinimizedChat } from '../../context/MinimizedChatsContext'
import { MinimizedChatChip } from './MinimizedChatChip'
import { LAYER_CLASS } from '../../../../lib/layers'

/**
 * Always-visible dock of minimized chats. Replaces the previous sonner-toast
 * rendering so that:
 *   - every minimized chip is reachable (no `visibleToasts` cap),
 *   - project names stay live (this is a real React subtree, re-rendering when
 *     the `projects` list changes),
 *   - switching between many parked sessions is a plain click on any chip.
 *
 * Anchored bottom-right (clearing the right icon rail, w-12). The container is
 * pointer-events-none with pointer-events-auto chips so the empty gutter never
 * blocks a full-screen Explore / AI-Edit overlay underneath — yet a chip can
 * still be clicked to switch sessions while an overlay is open. It sits on the
 * `dock` layer (75, `LAYER_CLASS.dock` in lib/layers): above base dialogs (50),
 * the floating chat (60), entity modals such as Job detail (65) and stacked
 * modals (70), but below capture surfaces (80) and the media lightbox (100).
 * `flex-col-reverse` keeps the newest chip pinned to the bottom edge (always
 * visible even when the list overflows and scrolls).
 */
export function MinimizedChatsDock({
  chats,
  projects,
  hidden,
  onRestore,
  onClose,
}: {
  chats: MinimizedChat[]
  projects: Array<{ id: string; name: string }>
  hidden: boolean
  onRestore: (id: string) => void
  onClose: (id: string) => void
}) {
  const { t } = useTranslation('chat')
  const projectsById = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of projects) m.set(p.id, p.name)
    return m
  }, [projects])

  // Newest first → with flex-col-reverse this lands the newest chip at the
  // bottom (nearest the anchor / always on screen), older ones scroll up.
  const ordered = useMemo(
    () => [...chats].sort((a, b) => b.createdAt - a.createdAt),
    [chats],
  )

  if (hidden || ordered.length === 0) return null

  // Anchored bottom-right, clearing the right icon rail (w-12).
  const rightClass = 'right-14'

  return createPortal(
    <div
      data-testid="minimized-chats-dock"
      aria-label={t('dock.minimizedSessions', { count: ordered.length })}
      className={`fixed bottom-4 ${rightClass} ${LAYER_CLASS.dock} flex flex-col-reverse gap-2 w-[320px] max-w-[calc(100vw-15rem)] max-h-[70vh] overflow-y-auto pointer-events-none`}
    >
      {ordered.map((chat) => (
        <div
          key={chat.id}
          className="pointer-events-auto glass-card border border-border/30 rounded-lg p-3 shadow-lg w-full"
        >
          <MinimizedChatChip
            chat={chat}
            projectName={projectsById.get(chat.projectId) ?? t('dock.unknownProject')}
            onRestore={() => onRestore(chat.id)}
            onClose={() => onClose(chat.id)}
          />
        </div>
      ))}
      {ordered.length > 1 && (
        <div className="pointer-events-auto self-end inline-flex items-center gap-1 rounded-full bg-card/80 border border-border/40 px-2 py-0.5 text-[11px] text-muted-foreground">
          <ChevronUp className="w-3 h-3" />
          {t('dock.minimizedCount', { count: ordered.length })}
        </div>
      )}
    </div>,
    document.body,
  )
}
