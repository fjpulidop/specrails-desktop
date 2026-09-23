// Per-project persistence for the SpecsBoard filter bar (labels + Jira
// epic/sprint). Mirrors the spec-sort / specs-view-tier helpers: one
// localStorage key per project so a project switch — and an app
// close/reopen — restores the exact filter the user left active.
//
// Epic/sprint are Jira-only (null on non-Jira projects); labels apply to
// every project. The whole filter set lives under a single JSON key.

export interface SpecFilters {
  /** Active label filter (OR-match). Empty set = no label filter. */
  labels: Set<string>
  /** Active Jira epic key, or null for "all epics". */
  epic: string | null
  /** Active Jira sprint id, or null for "all sprints". */
  sprint: string | null
  /** Active RAW Jira workflow status name, or null for "all Jira statuses". */
  jiraStatus: string | null
}

export const EMPTY_SPEC_FILTERS: SpecFilters = {
  labels: new Set<string>(),
  epic: null,
  sprint: null,
  jiraStatus: null,
}

const KEY = (projectId: string) => `specrails-desktop:spec-filters:${projectId}`

/** True when no filter is active (board shows every spec). */
export function isEmptySpecFilters(f: SpecFilters): boolean {
  return f.labels.size === 0 && f.epic === null && f.sprint === null && f.jiraStatus === null
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function emptyFilters(): SpecFilters {
  return { labels: new Set<string>(), epic: null, sprint: null, jiraStatus: null }
}

export function loadSpecFilters(projectId: string | null): SpecFilters {
  if (!projectId) return emptyFilters()
  try {
    const raw = localStorage.getItem(KEY(projectId))
    if (!raw) return emptyFilters()
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') {
      return emptyFilters()
    }
    const obj = parsed as Record<string, unknown>
    const labels = Array.isArray(obj.labels)
      ? new Set(obj.labels.filter((l): l is string => typeof l === 'string'))
      : new Set<string>()
    return {
      labels,
      epic: asStringOrNull(obj.epic),
      sprint: asStringOrNull(obj.sprint),
      // Additive field — absent in pre-existing blobs ⇒ null (no filter).
      jiraStatus: asStringOrNull(obj.jiraStatus),
    }
  } catch {
    // Malformed JSON / private mode / quota — fail to "no filter".
    return emptyFilters()
  }
}

export function saveSpecFilters(projectId: string | null, filters: SpecFilters): void {
  if (!projectId) return
  try {
    // Keep storage tidy: clearing every filter removes the key entirely so a
    // stale "no filter" blob never lingers.
    if (isEmptySpecFilters(filters)) {
      localStorage.removeItem(KEY(projectId))
      return
    }
    localStorage.setItem(
      KEY(projectId),
      JSON.stringify({
        labels: [...filters.labels],
        epic: filters.epic,
        sprint: filters.sprint,
        jiraStatus: filters.jiraStatus,
      }),
    )
  } catch {
    /* private mode / quota — best-effort */
  }
}
