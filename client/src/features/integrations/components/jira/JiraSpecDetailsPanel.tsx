import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { ExternalLink, GitBranch, GitPullRequest, GitCommit } from 'lucide-react'
import { openExternalUrl } from '../../../../lib/tauri-shell'
import { getDateFnsLocale } from '../../../../lib/i18n'
import { FEATURE_JIRA } from '../../../../lib/feature-flags'
import { useJiraConnection } from '../../hooks/useJiraConnection'
import { useDesktop } from '../../../../hooks/useDesktop'
import { jiraApi, type JiraSpecDetails } from '../../lib/jira-api'

const ISO_DT = /^\d{4}-\d{2}-\d{2}T/

/** Render an ISO datetime as relative time; pass any other string through. */
function display(value: string): { text: string; title?: string } {
  if (ISO_DT.test(value)) {
    try {
      const d = parseISO(value)
      return { text: formatDistanceToNow(d, { addSuffix: true, locale: getDateFnsLocale() }), title: value }
    } catch {
      /* fall through */
    }
  }
  return { text: value }
}

/**
 * Read-only "Jira details" + "Development" panel for a Jira-backed spec, rendered
 * in the spec-detail modal sidebar. Lazy-fetches every populated issue field plus
 * the issue's branches / PRs / commits. Renders nothing until data arrives and
 * nothing when both sections are empty. Mounted only for Jira-backed specs.
 */
export function JiraSpecDetailsPanel({ localId }: { localId: number }) {
  const { t } = useTranslation('jira')
  const { activeProjectId } = useDesktop()
  const jira = useJiraConnection()
  const [data, setData] = useState<JiraSpecDetails | null>(null)

  useEffect(() => {
    if (!FEATURE_JIRA || !jira.connected) return
    let cancelled = false
    setData(null)
    jiraApi
      .getSpecDetails(localId)
      .then((d) => { if (!cancelled) setData(d) })
      .catch(() => { if (!cancelled) setData(null) })
    return () => { cancelled = true }
  }, [localId, activeProjectId, jira.connected])

  if (!FEATURE_JIRA || !jira.connected || !data) return null

  const dev = data.development
  const hasFields = data.fields.length > 0
  const hasPRs = dev.pullRequests.length > 0
  const hasBranches = dev.branches.length > 0
  const hasCommits = (dev.commits?.length ?? 0) > 0
  if (!hasFields && !hasPRs && !hasBranches && !hasCommits) return null

  return (
    <div className="space-y-4" data-testid="jira-details-panel">
      {hasFields && (
        <div>
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">
            {t('detail.detailsTitle')}
          </span>
          <div className="space-y-1.5">
            {data.fields.map((f, i) => {
              const d = display(f.value)
              return (
                <div key={`${f.label}-${i}`} className="text-xs">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wide block">{f.label}</span>
                  {f.href ? (
                    <button
                      type="button"
                      onClick={() => { void openExternalUrl(f.href!) }}
                      className="inline-flex items-center gap-1 text-accent-info hover:underline text-left"
                    >
                      <span className="truncate">{f.value}</span>
                      <ExternalLink className="w-3 h-3 shrink-0" />
                    </button>
                  ) : (
                    <span className="text-foreground/80 whitespace-pre-line" title={d.title}>{d.text}</span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {(hasPRs || hasBranches || hasCommits) && (
        <div>
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">
            {t('detail.developmentTitle')}
          </span>

          {hasPRs && (
            <div className="mb-2">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide block mb-1">{t('detail.dev.pullRequests')}</span>
              <div className="space-y-1">
                {dev.pullRequests.map((pr) => (
                  <button
                    key={pr.url}
                    type="button"
                    onClick={() => { void openExternalUrl(pr.url) }}
                    className="w-full flex items-start gap-1.5 text-left text-xs hover:bg-accent-info/10 rounded px-1 py-0.5"
                    data-testid="jira-dev-pr"
                  >
                    <GitPullRequest className="w-3 h-3 mt-0.5 shrink-0 text-accent-info" />
                    <span className="min-w-0 flex-1">
                      <span className="truncate text-foreground/80 block">{pr.title}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {pr.status}{pr.sourceBranch ? ` · ${pr.sourceBranch} → ${pr.destBranch ?? ''}` : ''}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {hasBranches && (
            <div className="mb-2">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide block mb-1">{t('detail.dev.branches')}</span>
              <div className="space-y-1">
                {dev.branches.map((b) => (
                  <button
                    key={b.url}
                    type="button"
                    onClick={() => { void openExternalUrl(b.url) }}
                    className="w-full flex items-center gap-1.5 text-left text-xs hover:bg-accent-info/10 rounded px-1 py-0.5"
                    data-testid="jira-dev-branch"
                  >
                    <GitBranch className="w-3 h-3 shrink-0 text-accent-info" />
                    <span className="truncate font-mono text-foreground/80">{b.name}</span>
                    {b.repo && <span className="text-[10px] text-muted-foreground truncate">{b.repo}</span>}
                  </button>
                ))}
              </div>
            </div>
          )}

          {hasCommits && (
            <div>
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide block mb-1">{t('detail.dev.commits')}</span>
              <div className="space-y-1">
                {dev.commits!.map((c) => (
                  <button
                    key={c.url}
                    type="button"
                    onClick={() => { void openExternalUrl(c.url) }}
                    className="w-full flex items-center gap-1.5 text-left text-xs hover:bg-accent-info/10 rounded px-1 py-0.5"
                    data-testid="jira-dev-commit"
                  >
                    <GitCommit className="w-3 h-3 shrink-0 text-accent-info" />
                    <span className="font-mono text-[10px] text-muted-foreground shrink-0">{c.displayId}</span>
                    <span className="truncate text-foreground/80">{c.message}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
