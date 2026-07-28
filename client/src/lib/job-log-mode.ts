/**
 * Which altitude the job log surfaces open at (nontech-review-experience Wave 3b).
 *
 * Deliberately ONE app-level key rather than per-project: this is a reading
 * preference about the person, not data about a project, and splitting it made
 * the routed page and the mission-mode modal disagree about what the same user
 * had chosen. Narrated is the default, matching the Code explorer's Story|Log
 * precedent — a reader who wants raw logs is one click away, a reader who
 * cannot read them never has to find the switch.
 */
export type JobLogMode = 'narrated' | 'log'

export const JOB_LOG_MODE_KEY = 'specrails-desktop:job-log-mode'

export function loadJobLogMode(): JobLogMode {
  try {
    const stored = localStorage.getItem(JOB_LOG_MODE_KEY)
    return stored === 'log' || stored === 'narrated' ? stored : 'narrated'
  } catch {
    return 'narrated'
  }
}

export function saveJobLogMode(mode: JobLogMode): void {
  try {
    localStorage.setItem(JOB_LOG_MODE_KEY, mode)
  } catch {
    /* storage unavailable — the session-local choice still applies */
  }
}
