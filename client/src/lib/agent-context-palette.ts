import type { AgentConversation, AgentTierLevel } from './agent-api'
import type { DesktopProject } from '../hooks/useDesktop'
import type { JobSummary, LocalTicket } from '../types'

export type AgentPaletteMode = 'reference' | 'trace' | 'action'

export type AgentContextKind =
  | 'project'
  | 'spec'
  | 'job'
  | 'trace'
  | 'conversation'
  | 'file'
  | 'alias'
  | 'pr'
  | 'action'

export interface AgentContextChip {
  kind: AgentContextKind
  id: string
  label: string
  token: string
  detail?: string
  status?: string | null
  projectId?: string | null
  projectName?: string | null
  metadata?: Record<string, unknown>
}

export interface AgentContextReference {
  kind: AgentContextKind
  id: string
  label: string
  token: string
  scope?: {
    projectId?: string | null
    projectName?: string | null
  }
  status?: string | null
  metadata?: Record<string, unknown>
}

export interface AgentPaletteTrigger {
  mode: AgentPaletteMode
  trigger: '@' | '#' | '/'
  query: string
  start: number
  end: number
}

export interface AgentPaletteItem {
  id: string
  mode: AgentPaletteMode
  title: string
  subtitle?: string
  detail?: string
  group: string
  icon: AgentContextKind | 'action'
  chip?: AgentContextChip
  insertText?: string
  tierLevel?: AgentTierLevel
  risk?: 'cost' | 'destructive'
  keywords?: string[]
}

export interface PaletteSourceState {
  projects: DesktopProject[]
  conversations: AgentConversation[]
  activeConversation: AgentConversation | null
  pinnedProjectId: string | null
  activeProjectId: string | null
  tickets: LocalTicket[]
  jobs: JobSummary[]
  chips: AgentContextChip[]
}

const TRIGGERS = new Set(['@', '#', '/'])
const TOKEN_BREAK_RE = /[\s()[\]{}<>"']/

export function detectAgentPaletteTrigger(text: string, caret = text.length): AgentPaletteTrigger | null {
  const boundedCaret = Math.max(0, Math.min(caret, text.length))
  for (let i = boundedCaret - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === '\n' || ch === '\t' || ch === ' ') break
    if (!TRIGGERS.has(ch)) continue
    const before = i === 0 ? '' : text[i - 1]
    if (before && !TOKEN_BREAK_RE.test(before)) continue
    const raw = text.slice(i + 1, boundedCaret)
    if (/[()[\]{}<>"']/.test(raw)) return null
    const trigger = ch as AgentPaletteTrigger['trigger']
    return {
      trigger,
      mode: trigger === '@' ? 'reference' : trigger === '#' ? 'trace' : 'action',
      query: raw,
      start: i,
      end: boundedCaret,
    }
  }
  return null
}

export function chipKey(chip: Pick<AgentContextChip, 'kind' | 'id'>): string {
  return `${chip.kind}:${chip.id}`
}

export function toContextReference(chip: AgentContextChip): AgentContextReference {
  return {
    kind: chip.kind,
    id: chip.id,
    label: chip.label,
    token: chip.token,
    scope: {
      projectId: chip.projectId ?? null,
      projectName: chip.projectName ?? null,
    },
    status: chip.status ?? null,
    metadata: chip.metadata,
  }
}

export function buildAgentContextBlock(refs: AgentContextReference[]): string {
  if (refs.length === 0) return ''
  const lines = refs.map((ref) => {
    const scope = ref.scope?.projectName || ref.scope?.projectId
      ? ` project=${ref.scope?.projectName ?? ref.scope?.projectId}`
      : ''
    const status = ref.status ? ` status=${ref.status}` : ''
    return `- ${ref.token}: kind=${ref.kind} id=${ref.id} label="${ref.label}"${scope}${status}`
  })
  return `## Resolved Specrails Context\n\n${lines.join('\n')}`
}

function projectName(projects: DesktopProject[], projectId: string | null | undefined): string | null {
  if (!projectId) return null
  return projects.find((p) => p.id === projectId)?.name ?? null
}

function projectChip(project: DesktopProject): AgentContextChip {
  return {
    kind: 'project',
    id: project.id,
    label: project.name,
    token: `@${project.name}`,
    detail: project.path,
    projectId: project.id,
    projectName: project.name,
    metadata: { slug: project.slug, path: project.path },
  }
}

function ticketChip(ticket: LocalTicket, projectId: string | null, projectLabel: string | null): AgentContextChip {
  return {
    kind: 'spec',
    id: String(ticket.id),
    label: ticket.title,
    token: `@${ticket.title}`,
    detail: projectLabel ? `${projectLabel} / #${ticket.id}` : `#${ticket.id}`,
    status: ticket.status,
    projectId,
    projectName: projectLabel,
    metadata: {
      ticketId: ticket.id,
      priority: ticket.priority,
      labels: ticket.labels,
      shortSummary: ticket.short_summary ?? null,
    },
  }
}

function jobChip(job: JobSummary, projectId: string | null, projectLabel: string | null): AgentContextChip {
  const short = job.id.slice(0, 8)
  return {
    kind: 'job',
    id: job.id,
    label: short,
    token: `#${short}`,
    detail: projectLabel ? `${projectLabel} / ${job.command}` : job.command,
    status: job.status,
    projectId,
    projectName: projectLabel,
    metadata: {
      command: job.command,
      startedAt: job.started_at,
      costUsd: job.total_cost_usd ?? null,
    },
  }
}

function conversationChip(conversation: AgentConversation, projectLabel: string | null): AgentContextChip {
  const label = conversation.title || 'Untitled mission'
  return {
    kind: 'conversation',
    id: conversation.id,
    label,
    token: `@${label}`,
    detail: projectLabel ? `Mission / ${projectLabel}` : 'Mission',
    projectId: conversation.pinned_project_id,
    projectName: projectLabel,
    metadata: { provider: conversation.provider },
  }
}

function itemMatches(item: AgentPaletteItem, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystack = [
    item.title,
    item.subtitle,
    item.detail,
    item.group,
    ...(item.keywords ?? []),
  ].filter(Boolean).join(' ').toLowerCase()
  return haystack.includes(q)
}

function stableDedupe(items: AgentPaletteItem[]): AgentPaletteItem[] {
  const seen = new Set<string>()
  const out: AgentPaletteItem[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

export function filterPaletteItems(items: AgentPaletteItem[], query: string): AgentPaletteItem[] {
  const matches = stableDedupe(items).filter((item) => itemMatches(item, query))
  const exactSpec = `#${query.trim()}`
  // An exact spec ID wins over partial matches (#1 before #10/#21), even
  // when a large backlog would otherwise push it beyond the visible limit.
  const isExactSpec = (item: AgentPaletteItem): boolean => (
    item.mode === 'trace' && item.icon === 'spec' && item.title === exactSpec
  )
  return matches.sort((a, b) => Number(isExactSpec(b)) - Number(isExactSpec(a))).slice(0, 12)
}

export function buildReferenceItems(state: PaletteSourceState): AgentPaletteItem[] {
  const pinnedName = projectName(state.projects, state.pinnedProjectId)
  const activeProject = state.pinnedProjectId
    ? state.projects.find((p) => p.id === state.pinnedProjectId) ?? null
    : null
  const items: AgentPaletteItem[] = []

  if (activeProject) {
    items.push({
      id: `alias:current-project:${activeProject.id}`,
      mode: 'reference',
      title: '@current',
      subtitle: activeProject.name,
      detail: 'Pinned project',
      group: 'Current',
      icon: 'alias',
      chip: { ...projectChip(activeProject), kind: 'alias', id: `current:${activeProject.id}`, token: '@current' },
      keywords: ['this', 'project', activeProject.name],
    })
  }
  if (state.activeConversation) {
    const chip = conversationChip(state.activeConversation, pinnedName)
    items.push({
      id: `conversation:${state.activeConversation.id}`,
      mode: 'reference',
      title: chip.label,
      subtitle: chip.detail,
      detail: 'Current mission',
      group: 'Created here',
      icon: 'conversation',
      chip,
      keywords: ['mission', 'conversation', 'last'],
    })
  }

  for (const chip of state.chips) {
    items.push({
      id: `chip:${chipKey(chip)}`,
      mode: 'reference',
      title: chip.label,
      subtitle: chip.detail,
      detail: 'Already in context',
      group: 'Current context',
      icon: chip.kind,
      chip,
    })
  }

  const scopedTickets = state.tickets.map((ticket) => {
    const chip = ticketChip(ticket, state.pinnedProjectId, pinnedName)
    const attention = ticket.status === 'on_review' || ticket.status === 'in_progress' || ticket.status === 'draft'
    return {
      id: `spec:${chip.projectId ?? 'home'}:${ticket.id}`,
      mode: 'reference' as const,
      title: ticket.title,
      subtitle: `Spec #${ticket.id}${ticket.status ? ` · ${ticket.status}` : ''}`,
      detail: chip.detail,
      group: attention ? 'Active in project' : 'Specs',
      icon: 'spec' as const,
      chip,
      keywords: [String(ticket.id), ticket.priority ?? '', ...(ticket.labels ?? [])],
    }
  })
  items.push(...scopedTickets)

  const scopedJobs = state.jobs.slice(0, 8).map((job) => {
    const chip = jobChip(job, state.pinnedProjectId, pinnedName)
    return {
      id: `job:${chip.projectId ?? 'home'}:${job.id}`,
      mode: 'reference' as const,
      title: chip.label,
      subtitle: `Job · ${job.status}`,
      detail: job.command,
      group: job.status === 'running' || job.status === 'failed' ? 'Needs attention' : 'Recent jobs',
      icon: 'job' as const,
      chip,
      keywords: [job.id, job.command, job.status],
    }
  })
  items.push(...scopedJobs)

  for (const project of state.projects) {
    const chip = projectChip(project)
    items.push({
      id: `project:${project.id}`,
      mode: 'reference',
      title: project.name,
      subtitle: 'Project',
      detail: project.path,
      group: project.id === state.activeProjectId ? 'Current app project' : 'Projects',
      icon: 'project',
      chip,
      keywords: [project.slug, project.path],
    })
  }

  return items
}

export function buildTraceItems(state: PaletteSourceState): AgentPaletteItem[] {
  const pinnedName = projectName(state.projects, state.pinnedProjectId)
  const items: AgentPaletteItem[] = []
  // # primarily addresses specs. Keep them together in numeric ID order,
  // before run references, so the first keyboard selection is a spec.
  for (const ticket of [...state.tickets].sort((a, b) => a.id - b.id)) {
    const chip = ticketChip(ticket, state.pinnedProjectId, pinnedName)
    items.push({
      id: `trace:spec:${ticket.id}`,
      mode: 'trace',
      title: `#${ticket.id}`,
      subtitle: `${ticket.title} · ${ticket.status}`,
      detail: pinnedName ?? undefined,
      group: 'Specs',
      icon: 'spec',
      chip: { ...chip, kind: 'trace', token: `#${ticket.id}` },
      keywords: [String(ticket.id), ticket.title, ticket.status],
    })
  }
  for (const job of state.jobs) {
    const chip = jobChip(job, state.pinnedProjectId, pinnedName)
    items.push({
      id: `trace:job:${job.id}`,
      mode: 'trace',
      title: chip.label,
      subtitle: `${job.status} · ${job.command}`,
      detail: pinnedName ?? undefined,
      group: job.status === 'failed' || job.status === 'running' ? 'Active traces' : 'Recent traces',
      icon: 'job',
      chip: { ...chip, kind: 'trace' },
      keywords: [job.id, job.command, job.status, 'failed', 'running', 'deploy', 'run'],
    })
  }
  return items
}

const ACTIONS: AgentPaletteItem[] = [
  { id: 'action:create-spec', mode: 'action', title: 'Create spec', subtitle: 'Turn this into a structured spec', group: 'Create', icon: 'action', insertText: '/create spec', tierLevel: 2, risk: 'cost', keywords: ['new ticket quick add'] },
  { id: 'action:explore-spec', mode: 'action', title: 'Explore spec', subtitle: 'Refine a fuzzy idea first', group: 'Refine', icon: 'action', insertText: '/explore spec', tierLevel: 2, risk: 'cost', keywords: ['discovery draft requirements'] },
  { id: 'action:update-spec', mode: 'action', title: 'Update spec', subtitle: 'Edit the selected spec', group: 'Refine', icon: 'action', insertText: '/update spec', tierLevel: 1, keywords: ['edit ticket'] },
  { id: 'action:assign-rail', mode: 'action', title: 'Assign to rail', subtitle: 'Put selected specs on a rail', group: 'Execute', icon: 'action', insertText: '/assign to rail', tierLevel: 1, keywords: ['tickets rail'] },
  { id: 'action:launch-rail', mode: 'action', title: 'Launch rail', subtitle: 'Run the selected rail or spec', group: 'Execute', icon: 'action', insertText: '/launch rail', tierLevel: 2, risk: 'cost', keywords: ['run implement'] },
  { id: 'action:launch-all', mode: 'action', title: 'Launch all eligible rails', subtitle: 'Start every ready rail in parallel', group: 'Execute', icon: 'action', insertText: '/launch all eligible rails', tierLevel: 2, risk: 'cost', keywords: ['all rails run'] },
  { id: 'action:status', mode: 'action', title: 'Show status', subtitle: 'Summarize the current workbench', group: 'Review', icon: 'action', insertText: '/status', tierLevel: 0, keywords: ['state overview'] },
  { id: 'action:diagnose', mode: 'action', title: 'Diagnose', subtitle: 'Inspect git, jobs, setup, Jira, and failures', group: 'Review', icon: 'action', insertText: '/diagnose', tierLevel: 0, keywords: ['debug health failed'] },
  { id: 'action:compare', mode: 'action', title: 'Compare', subtitle: 'Compare selected specs, jobs, diffs, or costs', group: 'Review', icon: 'action', insertText: '/compare', tierLevel: 0, keywords: ['diff versus'] },
  { id: 'action:summarize', mode: 'action', title: 'Summarize', subtitle: 'Condense selected context', group: 'Review', icon: 'action', insertText: '/summarize', tierLevel: 0, keywords: ['recap'] },
  { id: 'action:save-as-spec', mode: 'action', title: 'Save as spec', subtitle: 'Capture the selected context as durable work', group: 'Create', icon: 'action', insertText: '/save as spec', tierLevel: 1, keywords: ['persist capture'] },
  { id: 'action:generate-report', mode: 'action', title: 'Generate report', subtitle: 'Create a written artifact from selected context', group: 'Create', icon: 'action', insertText: '/generate report', tierLevel: 1, keywords: ['document export'] },
  { id: 'action:show-spend', mode: 'action', title: 'Show spend', subtitle: 'Review cost and budget impact', group: 'Review', icon: 'action', insertText: '/show spend', tierLevel: 0, keywords: ['cost budget analytics'] },
  { id: 'action:search', mode: 'action', title: 'Search current project', subtitle: 'Find specs, jobs, files, or context', group: 'Navigate', icon: 'action', insertText: '/search', tierLevel: 0, keywords: ['find'] },
  { id: 'action:search-all', mode: 'action', title: 'Search all projects', subtitle: 'Fan out across registered projects', group: 'Navigate', icon: 'action', insertText: '/search all projects', tierLevel: 0, keywords: ['global home'] },
  { id: 'action:open', mode: 'action', title: 'Open item', subtitle: 'Open the selected object in Specrails', group: 'Navigate', icon: 'action', insertText: '/open', tierLevel: 0, keywords: ['navigate'] },
  { id: 'action:wait', mode: 'action', title: 'Wait for result', subtitle: 'Follow a running job or trace', group: 'Review', icon: 'action', insertText: '/wait for result', tierLevel: 0, keywords: ['watch running'] },
  { id: 'action:show-diff', mode: 'action', title: 'Show diff', subtitle: 'Inspect changes from the selected job', group: 'Review', icon: 'action', insertText: '/show diff', tierLevel: 0, keywords: ['files changes'] },
  { id: 'action:diagnostic', mode: 'action', title: 'Export diagnostic', subtitle: 'Collect job telemetry and logs', group: 'Review', icon: 'action', insertText: '/export diagnostic', tierLevel: 0, keywords: ['zip logs telemetry'] },
  { id: 'action:cancel-job', mode: 'action', title: 'Cancel job', subtitle: 'Stop or delete a selected job', group: 'Clean up', icon: 'action', insertText: '/cancel job', tierLevel: 3, risk: 'destructive', keywords: ['stop kill'] },
  { id: 'action:refine-contract', mode: 'action', title: 'Refine contract', subtitle: 'Add or refresh the Contract Layer', group: 'Refine', icon: 'action', insertText: '/refine contract', tierLevel: 2, risk: 'cost', keywords: ['contract'] },
  { id: 'action:split-epic', mode: 'action', title: 'Split epic', subtitle: 'Decompose a large spec into children', group: 'Refine', icon: 'action', insertText: '/split epic', tierLevel: 2, risk: 'cost', keywords: ['smash children'] },
  { id: 'action:files-touched', mode: 'action', title: 'Show files touched', subtitle: 'Inspect provenance for selected work', group: 'Review', icon: 'action', insertText: '/show files touched', tierLevel: 0, keywords: ['provenance'] },
  { id: 'action:connect-jira', mode: 'action', title: 'Connect Jira', subtitle: 'Start the Jira connection flow', group: 'Integrate', icon: 'action', insertText: '/connect Jira', tierLevel: 1, keywords: ['integration'] },
  { id: 'action:sync-jira', mode: 'action', title: 'Sync Jira', subtitle: 'Refresh Jira-backed specs', group: 'Integrate', icon: 'action', insertText: '/sync Jira', tierLevel: 1, keywords: ['integration'] },
  { id: 'action:install-plugin', mode: 'action', title: 'Install plugin', subtitle: 'Preview and install an integration', group: 'Integrate', icon: 'action', insertText: '/install plugin', tierLevel: 1, keywords: ['mcp integration'] },
  { id: 'action:set-budget', mode: 'action', title: 'Set budget', subtitle: 'Adjust spend guardrails', group: 'Configure', icon: 'action', insertText: '/set budget', tierLevel: 1, keywords: ['cost limit'] },
]

function actionScore(action: AgentPaletteItem, chips: AgentContextChip[], state: PaletteSourceState): number {
  const kinds = new Set(chips.map((c) => c.kind))
  let score = 0
  if (chips.length === 0) {
    if (['action:create-spec', 'action:search', 'action:status', 'action:diagnose', 'action:show-spend'].includes(action.id)) score += 40
    if (state.pinnedProjectId && action.id === 'action:launch-all') score += 30
  }
  if (kinds.has('project')) {
    if (['action:status', 'action:search', 'action:launch-all', 'action:show-spend', 'action:sync-jira', 'action:install-plugin'].includes(action.id)) score += 50
  }
  if (kinds.has('spec')) {
    if (['action:update-spec', 'action:assign-rail', 'action:launch-rail', 'action:refine-contract', 'action:split-epic', 'action:files-touched', 'action:show-spend'].includes(action.id)) score += 70
  }
  if (kinds.has('job') || kinds.has('trace')) {
    if (['action:open', 'action:wait', 'action:compare', 'action:show-diff', 'action:diagnostic', 'action:cancel-job'].includes(action.id)) score += 80
  }
  if (kinds.has('file')) {
    if (['action:summarize', 'action:show-diff', 'action:files-touched'].includes(action.id)) score += 60
  }
  return score
}

export function buildActionItems(state: PaletteSourceState): AgentPaletteItem[] {
  return [...ACTIONS]
    .sort((a, b) => actionScore(b, state.chips, state) - actionScore(a, state.chips, state))
    .map((action) => ({
      ...action,
      chip: {
        kind: 'action',
        id: action.id,
        label: action.title,
        token: action.insertText ?? `/${action.title.toLowerCase()}`,
        detail: action.subtitle,
        metadata: {
          tierLevel: action.tierLevel,
          risk: action.risk ?? null,
        },
      },
    }))
}

export function buildPaletteItems(mode: AgentPaletteMode, state: PaletteSourceState): AgentPaletteItem[] {
  if (mode === 'reference') return buildReferenceItems(state)
  if (mode === 'trace') return buildTraceItems(state)
  return buildActionItems(state)
}

export function buildNoResultPaletteItems(mode: AgentPaletteMode, query: string): AgentPaletteItem[] {
  const q = query.trim()
  if (!q) return []
  const safe = q.slice(0, 80)
  const items: AgentPaletteItem[] = [
    {
      id: `fallback:search-all:${mode}:${safe}`,
      mode,
      title: 'Search all Specrails',
      subtitle: `Find "${safe}" across every project`,
      group: 'No matches',
      icon: 'action',
      insertText: `/search all projects ${safe}`,
      tierLevel: 0,
      keywords: ['fallback global search all'],
    },
    {
      id: `fallback:ask-agent:${mode}:${safe}`,
      mode,
      title: `Ask agent about "${safe}"`,
      subtitle: 'Keep the wording and let the agent resolve it',
      group: 'No matches',
      icon: 'action',
      insertText: safe,
      tierLevel: 0,
      keywords: ['fallback ask agent clarify'],
    },
  ]
  if (mode !== 'trace') {
    items.splice(1, 0, {
      id: `fallback:create-spec:${mode}:${safe}`,
      mode,
      title: `Create "${safe}"`,
      subtitle: 'Turn this unmatched reference into a spec',
      group: 'No matches',
      icon: 'action',
      insertText: `/create spec ${safe}`,
      tierLevel: 2,
      risk: 'cost',
      keywords: ['fallback create new spec'],
    })
  } else {
    items.splice(1, 0, {
      id: `fallback:archived:${mode}:${safe}`,
      mode,
      title: 'Include archived results',
      subtitle: `Search completed, canceled, and old traces for "${safe}"`,
      group: 'No matches',
      icon: 'action',
      insertText: `/search all projects archived ${safe}`,
      tierLevel: 0,
      keywords: ['fallback archived old completed canceled'],
    })
  }
  return items
}

export function insertPaletteSelection(
  text: string,
  trigger: Pick<AgentPaletteTrigger, 'start' | 'end'> | null,
  item: AgentPaletteItem,
): { text: string; caret: number } {
  const insert = item.insertText ?? item.chip?.token ?? item.title
  const start = trigger?.start ?? text.length
  const end = trigger?.end ?? text.length
  const before = text.slice(0, start)
  const after = text.slice(end)
  const prefix = before && !/\s$/.test(before) ? ' ' : ''
  const suffix = after && !/^\s/.test(after) ? ' ' : ''
  const next = `${before}${prefix}${insert}${suffix}${after}`
  return { text: next, caret: before.length + prefix.length + insert.length + suffix.length }
}
