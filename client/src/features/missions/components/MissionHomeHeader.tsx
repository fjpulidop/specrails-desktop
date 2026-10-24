import { useTranslation } from 'react-i18next'
import { RailMark } from '../../../components/brand/RailMark'
import { useDesktop } from '../../../hooks/useDesktop'
import { useProjectCache } from '../../../hooks/useProjectCache'
import { useUiMode } from '../../../context/UiModeContext'
import { saveSpecStatusFilter } from '../../specs/lib/spec-status-filter'
import { API_ORIGIN } from '../../../lib/origin'

interface HomeStatus {
  todo: number
  review: number
  running: number
}

/**
 * Identity block above the empty-mission composer: the rail mark, a greeting
 * that names the project, and one caption with live counts. Counts come from
 * the same /tickets and /jobs endpoints the board and Jobs page already use,
 * through the shared project cache (stale-while-revalidate, no new API). Nothing
 * is shown until real data exists (no placeholder zeros); the caption's height
 * is reserved so it never shifts the layout. A failed fetch counts as no data.
 */
export function MissionHomeHeader() {
  const { t } = useTranslation('agent')
  const { activeProjectId, projects } = useDesktop()
  const { setUiMode } = useUiMode()
  const projectName = (projects ?? []).find((p) => p.id === activeProjectId)?.name ?? ''

  const { data } = useProjectCache<HomeStatus | null>({
    namespace: 'mission-home-status',
    projectId: activeProjectId,
    initialValue: null,
    pollInterval: 15_000,
    fetcher: async ({ projectId, signal }) => {
      const base = `${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}`
      try {
        const [ticketsRes, jobsRes] = await Promise.all([
          fetch(`${base}/tickets`, { signal, cache: 'no-store' }),
          fetch(`${base}/jobs?limit=20`, { signal }),
        ])
        let todo = 0
        let review = 0
        let running = 0
        if (ticketsRes.ok) {
          const body = await ticketsRes.json() as { tickets?: Array<{ status: string }> } | Array<{ status: string }>
          const list = Array.isArray(body) ? body : body.tickets ?? []
          todo = list.filter((ticket) => ticket.status === 'todo').length
          review = list.filter((ticket) => ticket.status === 'on_review').length
        }
        if (jobsRes.ok) {
          const body = await jobsRes.json() as { jobs?: Array<{ status: string }> }
          running = (body.jobs ?? []).filter((job) => job.status === 'running').length
        }
        return { todo, review, running }
      } catch {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        return null
      }
    },
  })

  const openReview = () => {
    saveSpecStatusFilter(activeProjectId, 'on_review')
    setUiMode('kanban')
  }

  return (
    <div className="u-enter mb-6 flex flex-col items-center gap-3 text-center" data-testid="mission-home-header">
      <RailMark size={40} />
      <h1 className="text-headline text-balance text-foreground">
        {projectName ? t('missionHome.greeting', { project: projectName }) : t('missionHome.greetingNoProject')}
      </h1>
      <p className="num min-h-4 text-caption text-muted-foreground" data-testid="mission-home-status">
        {data && (
          <>
            {t('missionHome.statusTodo', { count: data.todo })}
            {' · '}
            <button
              type="button"
              onClick={openReview}
              data-testid="mission-home-review"
              className="rounded-sm underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('missionHome.statusReview', { count: data.review })}
            </button>
            {' · '}
            {t('missionHome.statusRunning', { count: data.running })}
          </>
        )}
      </p>
    </div>
  )
}
