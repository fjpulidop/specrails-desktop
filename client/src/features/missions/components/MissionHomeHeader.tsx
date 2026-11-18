import { useTranslation } from 'react-i18next'
import { RailMark } from '../../../components/brand/RailMark'
import { useDesktop } from '../../../hooks/useDesktop'
import { useProjectCache } from '../../../hooks/useProjectCache'
import { API_ORIGIN } from '../../../lib/origin'

/**
 * Identity block above the empty-mission composer: the rail mark, a greeting
 * that names the project, and one caption with the project's backlog ("3 to
 * do"). What waits for review and what runs are the inbox's and the live
 * board's to count (one number per question in the whole app), so the caption
 * does not repeat them. The count comes from the /tickets endpoint the board
 * already uses, through the shared project cache (stale-while-revalidate, no
 * new API). Nothing is shown until real data exists, nor for an empty backlog;
 * the caption's height is reserved so it never shifts the layout. A failed
 * fetch counts as no data.
 */
export function MissionHomeHeader() {
  const { t } = useTranslation('agent')
  const { activeProjectId, projects } = useDesktop()
  const projectName = (projects ?? []).find((p) => p.id === activeProjectId)?.name ?? ''

  const { data: todo } = useProjectCache<number | null>({
    namespace: 'mission-home-todo',
    projectId: activeProjectId,
    initialValue: null,
    pollInterval: 15_000,
    fetcher: async ({ projectId, signal }) => {
      const base = `${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}`
      try {
        const res = await fetch(`${base}/tickets`, { signal, cache: 'no-store' })
        if (!res.ok) return null
        const body = await res.json() as { tickets?: Array<{ status: string }> } | Array<{ status: string }>
        const list = Array.isArray(body) ? body : body.tickets ?? []
        return list.filter((ticket) => ticket.status === 'todo').length
      } catch {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        return null
      }
    },
  })

  return (
    <div className="u-enter mb-6 flex flex-col items-center gap-3 text-center" data-testid="mission-home-header">
      <RailMark size={40} />
      <h1 className="text-headline text-balance text-foreground">
        {projectName ? t('missionHome.greeting', { project: projectName }) : t('missionHome.greetingNoProject')}
      </h1>
      <p className="num min-h-4 text-caption text-muted-foreground" data-testid="mission-home-status">
        {todo ? t('missionHome.statusTodo', { count: todo }) : null}
      </p>
    </div>
  )
}
