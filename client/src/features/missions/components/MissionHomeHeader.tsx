import { useTranslation } from 'react-i18next'
import { RailMark } from '../../../components/brand/RailMark'
import { useDesktop } from '../../../hooks/useDesktop'
import { useProjectCache } from '../../../hooks/useProjectCache'
import { API_ORIGIN } from '../../../lib/origin'

interface HomeStatus {
  ready: number
  running: number
}

const EMPTY_STATUS: HomeStatus = { ready: 0, running: 0 }

/**
 * Identity block above the empty-mission composer: the rail mark, a greeting
 * that names the project, and one caption with live counts. Counts come from
 * the same /tickets and /jobs endpoints the board and Jobs page already use,
 * through the shared project cache (stale-while-revalidate, no new API). Any
 * failure degrades to zeros rather than blocking the composer.
 */
export function MissionHomeHeader() {
  const { t } = useTranslation('agent')
  const { activeProjectId, projects } = useDesktop()
  const projectName = (projects ?? []).find((p) => p.id === activeProjectId)?.name ?? ''

  const { data } = useProjectCache<HomeStatus>({
    namespace: 'mission-home-status',
    projectId: activeProjectId,
    initialValue: EMPTY_STATUS,
    pollInterval: 15_000,
    fetcher: async ({ projectId, signal }) => {
      const base = `${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}`
      try {
        const [ticketsRes, jobsRes] = await Promise.all([
          fetch(`${base}/tickets`, { signal, cache: 'no-store' }),
          fetch(`${base}/jobs?limit=20`, { signal }),
        ])
        let ready = 0
        let running = 0
        if (ticketsRes.ok) {
          const body = await ticketsRes.json() as { tickets?: Array<{ status: string }> } | Array<{ status: string }>
          const list = Array.isArray(body) ? body : body.tickets ?? []
          ready = list.filter((ticket) => ticket.status === 'todo').length
        }
        if (jobsRes.ok) {
          const body = await jobsRes.json() as { jobs?: Array<{ status: string }> }
          running = (body.jobs ?? []).filter((job) => job.status === 'running').length
        }
        return { ready, running }
      } catch {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        return EMPTY_STATUS
      }
    },
  })

  return (
    <div className="u-enter mb-6 flex flex-col items-center gap-3 text-center" data-testid="mission-home-header">
      <RailMark size={40} />
      <h1 className="text-headline text-balance text-foreground">
        {projectName ? t('missionHome.greeting', { project: projectName }) : t('missionHome.greetingNoProject')}
      </h1>
      <p className="num text-caption text-muted-foreground" data-testid="mission-home-status">
        {t('missionHome.status', { ready: data.ready, running: data.running })}
      </p>
    </div>
  )
}
