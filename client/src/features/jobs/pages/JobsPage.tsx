import { useState, useCallback, useEffect } from 'react'
import { useSharedWebSocket } from '../../../hooks/useSharedWebSocket'
import { AgentRuntimeRuns } from '../../settings/components/AgentRuntimeRuns'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'
import { ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { usePipeline } from '../hooks/usePipeline'
import { useProjectCache } from '../../../hooks/useProjectCache'
import { RecentJobs } from '../components/RecentJobs'
import { ExportDropdown } from '../../analytics/components/ExportDropdown'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '../../../components/ui/dialog'
import { Button } from '../../../components/ui/button'
import { Badge } from '../../../components/ui/badge'
import { ConfirmDialog } from '../../../components/ui/confirm-dialog'
import type { JobSummary } from '../../../types'
import { getApiBase } from '../../../lib/api'
import { API_ORIGIN } from '../../../lib/origin'
import { useDesktop } from '../../../hooks/useDesktop'
import { PageHeader } from '../../../components/ui/page-header'
import { jobActivityTimestamp, parseJobTimestamp } from '../lib/job-time'

import { notifyError } from '../../../lib/notify-error'
const PROPOSAL_STATUS_LABEL_KEYS: Record<string, string> = {
  input: 'page.proposal.status.input',
  exploring: 'page.proposal.status.exploring',
  review: 'page.proposal.status.review',
  refining: 'page.proposal.status.refining',
  creating_issue: 'page.proposal.status.creatingIssue',
  created: 'page.proposal.status.created',
  cancelled: 'page.proposal.status.cancelled',
}

function projectApiBase(projectId: string): string {
  return `${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}`
}

export default function JobsPage() {
  const [showRuntimeHistory, setShowRuntimeHistory] = useState(false)
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const { t } = useTranslation('jobs')
  const { activeProjectId } = useDesktop()
  const { recentJobs } = usePipeline(activeProjectId)

  const {
    data: rawJobs,
    isFirstLoad: jobsFirstLoad,
    isLoading: jobsRefreshing,
    error: jobsError,
    refresh: refreshJobs,
  } = useProjectCache<JobSummary[]>({
    namespace: 'jobs',
    projectId: activeProjectId,
    initialValue: recentJobs,
    fetcher: async ({ projectId, signal }) => {
      const res = await fetch(`${projectApiBase(projectId)}/jobs?limit=10`, { signal })
      if (!res.ok) throw new Error(`Failed to fetch jobs: ${res.status}`)
      const data = await res.json() as { jobs: JobSummary[] }
      return data.jobs
    },
    pollInterval: 10_000,
  })
  useEffect(() => {
    registerHandler('jobs-runtime-continuation', (message: unknown) => {
      const event = message as { type?: string; projectId?: string }
      if (event.type === 'runtime.continuation' && event.projectId === activeProjectId) void refreshJobs()
    })
    return () => unregisterHandler('jobs-runtime-continuation')
  }, [activeProjectId, refreshJobs, registerHandler, unregisterHandler])

  // Spec titles so a row can read "Implement · #15 Title". Best effort: any
  // failure leaves the verbatim command in place.
  const { data: ticketTitles } = useProjectCache<Record<number, string>>({
    namespace: 'jobs-ticket-titles',
    projectId: activeProjectId,
    initialValue: {},
    fetcher: async ({ projectId, signal }) => {
      try {
        const res = await fetch(`${projectApiBase(projectId)}/tickets`, { signal, cache: 'no-store' })
        if (!res.ok) return {}
        const data = await res.json() as { tickets?: Array<{ id: number; title?: string }> } | Array<{ id: number; title?: string }>
        const list = Array.isArray(data) ? data : data.tickets ?? []
        return Object.fromEntries(list.filter(x => x && typeof x.title === 'string').map(x => [x.id, x.title as string]))
      } catch {
        return {}
      }
    },
    pollInterval: 60_000,
  })

  const {
    data: proposals,
    isFirstLoad: proposalsFirstLoad,
    isLoading: proposalsRefreshing,
    error: proposalsError,
    refresh: refreshProposals,
  } = useProjectCache<Array<{ id: string; idea: string; status: string; created_at: string; issue_url: string | null }>>({
    namespace: 'proposals',
    projectId: activeProjectId,
    initialValue: [],
    fetcher: async ({ projectId, signal }) => {
      const res = await fetch(`${projectApiBase(projectId)}/propose?limit=10`, { signal })
      if (!res.ok) throw new Error(`Failed to fetch proposals: ${res.status}`)
      const data = await res.json() as { proposals: Array<{ id: string; idea: string; status: string; created_at: string; issue_url: string | null }> }
      return data.proposals
    },
    pollInterval: 10_000,
  })

  const PROPOSAL_STATUS_MAP: Record<string, JobSummary['status']> = {
    input: 'queued',
    exploring: 'running',
    review: 'running',
    refining: 'running',
    creating_issue: 'running',
    created: 'completed',
    cancelled: 'canceled',
  }

  const proposalJobs: JobSummary[] = proposals.map((p) => ({
    id: `proposal:${p.id}`,
    command: `/specrails:propose-feature ${p.idea.length > 60 ? p.idea.slice(0, 57) + '...' : p.idea}`,
    started_at: p.created_at,
    enqueued_at: p.created_at,
    status: PROPOSAL_STATUS_MAP[p.status] ?? 'queued',
  }))

  const jobs = [...rawJobs, ...proposalJobs].sort(
    (a, b) => {
      const bTime = parseJobTimestamp(jobActivityTimestamp(b))?.getTime() ?? 0
      const aTime = parseJobTimestamp(jobActivityTimestamp(a))?.getTime() ?? 0
      return bTime - aTime
    }
  )

  const [detailProposal, setDetailProposal] = useState<{
    id: string; idea: string; status: string; result_markdown: string | null; issue_url: string | null; created_at: string
  } | null>(null)

  const handleProposalClick = useCallback(async (proposalId: string) => {
    try {
      const res = await fetch(`${getApiBase()}/propose/${proposalId}`)
      if (!res.ok) return
      const data = await res.json() as { proposal: typeof detailProposal }
      setDetailProposal(data.proposal)
    } catch { /* ignore */ }
  }, [])

  const handleProposalDelete = useCallback(async (proposalId: string) => {
    try {
      const res = await fetch(`${getApiBase()}/propose/${proposalId}`, { method: 'DELETE' })
      if (res.ok) {
        toast.success(t('page.proposalDeleted'))
        await refreshProposals()
      } else {
        notifyError(t('page.proposalDeleteFailed'))
      }
    } catch {
      notifyError(t('page.proposalDeleteFailed'))
    }
  }, [refreshProposals, t])

  // The detail dialog's Delete routes through the same confirmation the list
  // row uses (recent.deleteProposalConfirm.*) — never a one-click delete.
  const [confirmDeleteProposalId, setConfirmDeleteProposalId] = useState<string | null>(null)

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <PageHeader
        className="mb-4"
        title={t('page.title')}
        description={t('page.subtitle')}
        actions={
          <ExportDropdown
            baseUrl={`${getApiBase()}/jobs/export`}
            label={t('page.exportJobs')}
          />
        }
      />

      {activeProjectId && <details className="group mb-4 rounded-lg border border-border" onToggle={event => setShowRuntimeHistory(event.currentTarget.open)}>
        <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground motion-safe:transition-transform motion-safe:duration-150 group-open:rotate-90" aria-hidden />
          {t('agentRuntime:runs.title')}
        </summary>
        {showRuntimeHistory && <AgentRuntimeRuns projectId={activeProjectId} />}
      </details>}
      <RecentJobs
        jobs={jobs}
        ticketTitles={ticketTitles}
        isLoading={jobsFirstLoad || proposalsFirstLoad || jobsRefreshing || proposalsRefreshing}
        error={jobsError ?? proposalsError}
        onRetry={() => { void Promise.all([refreshJobs(), refreshProposals()]) }}
        onJobsCleared={refreshJobs}
        onProposalClick={handleProposalClick}
        onProposalDelete={handleProposalDelete}
      />

      <Dialog open={detailProposal !== null} onOpenChange={(o) => !o && setDetailProposal(null)}>
        <DialogContent size="wide" showCloseButton={false}>
          {detailProposal && (
            <>
              <DialogHeader
                actions={(
                  <Badge variant={detailProposal.status === 'created' ? 'success' : detailProposal.status === 'cancelled' ? 'destructive' : 'secondary'}>
                    {t(PROPOSAL_STATUS_LABEL_KEYS[detailProposal.status] ?? 'page.proposal.status.unknown', { status: detailProposal.status })}
                  </Badge>
                )}
              >
                <DialogTitle>{t('page.proposal.title')}</DialogTitle>
                {/* The consequence-free summary of this proposal: the idea it came from. */}
                <DialogDescription className="italic">{detailProposal.idea}</DialogDescription>
              </DialogHeader>
              <DialogBody className="space-y-3">
                {detailProposal.result_markdown ? (
                  <div className="rounded-lg px-3 py-2 text-xs bg-muted/40">
                    <div className="prose prose-invert prose-xs max-w-none prose-p:my-1 prose-headings:mt-2 prose-headings:mb-1 prose-headings:text-sm prose-headings:font-semibold prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-code:text-accent-info prose-code:text-xs prose-code:bg-muted/40 prose-code:px-1 prose-code:py-0.5 prose-code:rounded text-foreground/80">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{detailProposal.result_markdown}</ReactMarkdown>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground py-4 text-center">{t('page.proposal.noContent')}</p>
                )}
                {detailProposal.issue_url && (
                  <div className="text-xs">
                    {t('page.proposal.githubIssue')}{' '}
                    <a href={detailProposal.issue_url} target="_blank" rel="noopener noreferrer" className="text-accent-primary hover:underline">
                      {detailProposal.issue_url}
                    </a>
                  </div>
                )}
              </DialogBody>
              <DialogFooter
                start={(
                  <Button variant="destructive" onClick={() => setConfirmDeleteProposalId(detailProposal.id)}>
                    {t('common:actions.delete')}
                  </Button>
                )}
              >
                <Button variant="ghost" onClick={() => setDetailProposal(null)}>{t('common:actions.close')}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDeleteProposalId !== null}
        onOpenChange={(o) => { if (!o) setConfirmDeleteProposalId(null) }}
        title={t('recent.deleteProposalConfirm.title')}
        description={t('recent.deleteProposalConfirm.description')}
        onConfirm={() => {
          const id = confirmDeleteProposalId
          setConfirmDeleteProposalId(null)
          setDetailProposal(null)
          if (id) void handleProposalDelete(id)
        }}
      />
    </div>
  )
}
