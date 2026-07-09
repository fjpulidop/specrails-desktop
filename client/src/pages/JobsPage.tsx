import { useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { usePipeline } from '../hooks/usePipeline'
import { useProjectCache } from '../hooks/useProjectCache'
import { RecentJobs } from '../components/RecentJobs'
import { ExportDropdown } from '../components/ExportDropdown'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/dialog'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import type { JobSummary } from '../types'
import { getApiBase } from '../lib/api'
import { useDesktop } from '../hooks/useDesktop'

const PROPOSAL_STATUS_LABEL_KEYS: Record<string, string> = {
  input: 'page.proposal.status.input',
  exploring: 'page.proposal.status.exploring',
  review: 'page.proposal.status.review',
  refining: 'page.proposal.status.refining',
  creating_issue: 'page.proposal.status.creatingIssue',
  created: 'page.proposal.status.created',
  cancelled: 'page.proposal.status.cancelled',
}

export default function JobsPage() {
  const { t } = useTranslation('jobs')
  const { activeProjectId } = useDesktop()
  const { recentJobs } = usePipeline(activeProjectId)

  const { data: rawJobs, isFirstLoad: isLoadingJobs, refresh: refreshJobs } = useProjectCache<JobSummary[]>({
    namespace: 'jobs',
    projectId: activeProjectId,
    initialValue: recentJobs,
    fetcher: async () => {
      const res = await fetch(`${getApiBase()}/jobs?limit=10`)
      if (!res.ok) return []
      const data = await res.json() as { jobs: JobSummary[] }
      return data.jobs
    },
    pollInterval: 10_000,
  })

  const { data: proposals } = useProjectCache<Array<{ id: string; idea: string; status: string; created_at: string; issue_url: string | null }>>({
    namespace: 'proposals',
    projectId: activeProjectId,
    initialValue: [],
    fetcher: async () => {
      const res = await fetch(`${getApiBase()}/propose?limit=10`)
      if (!res.ok) return []
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
    status: PROPOSAL_STATUS_MAP[p.status] ?? 'queued',
  }))

  const jobs = [...rawJobs, ...proposalJobs].sort(
    (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()
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
        refreshJobs()
      }
    } catch { /* ignore */ }
  }, [refreshJobs, t])

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-sm font-semibold">{t('page.title')}</h1>
        <ExportDropdown
          baseUrl={`${getApiBase()}/jobs/export`}
          label={t('page.exportJobs')}
        />
      </div>

      <RecentJobs
        jobs={jobs}
        isLoading={isLoadingJobs}
        onJobsCleared={refreshJobs}
        onProposalClick={handleProposalClick}
        onProposalDelete={handleProposalDelete}
      />

      <Dialog open={detailProposal !== null} onOpenChange={(o) => !o && setDetailProposal(null)}>
        <DialogContent className="max-w-3xl glass-card">
          {detailProposal && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2">
                  <DialogTitle className="flex-1 min-w-0">{t('page.proposal.title')}</DialogTitle>
                  <Badge variant={detailProposal.status === 'created' ? 'success' : detailProposal.status === 'cancelled' ? 'destructive' : 'secondary'}>
                    {t(PROPOSAL_STATUS_LABEL_KEYS[detailProposal.status] ?? 'page.proposal.status.unknown', { status: detailProposal.status })}
                  </Badge>
                </div>
              </DialogHeader>
              <div className="text-xs text-muted-foreground bg-muted/20 rounded px-2 py-1 italic">
                {detailProposal.idea}
              </div>
              {detailProposal.result_markdown ? (
                <div className="max-h-[400px] overflow-y-auto rounded-lg px-3 py-2 text-xs bg-muted/40">
                  <div className="prose prose-invert prose-xs max-w-none prose-p:my-1 prose-headings:mt-2 prose-headings:mb-1 prose-headings:text-sm prose-headings:font-semibold prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-code:text-cyan-300 prose-code:text-[10px] prose-code:bg-muted/40 prose-code:px-1 prose-code:py-0.5 prose-code:rounded text-foreground/80">
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
              <DialogFooter>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => { handleProposalDelete(detailProposal.id); setDetailProposal(null) }}
                >
                  {t('common:actions.delete')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setDetailProposal(null)}>{t('common:actions.close')}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
