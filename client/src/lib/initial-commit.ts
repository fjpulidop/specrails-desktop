import type { TFunction } from 'i18next'
import { API_ORIGIN } from './origin'

/**
 * "Create initial commit" for a project whose primary repository has no
 * commits yet (`repository_has_no_commits`). The server runs only an empty
 * `git commit --allow-empty -m "Initial commit"`; nothing is staged or added.
 */
export type InitialCommitOutcome = { ok: true; sha: string } | { ok: false; code: string }

export async function createInitialCommit(projectId: string): Promise<InitialCommitOutcome> {
  try {
    const res = await fetch(`${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/git/initial-commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    let body: Record<string, unknown> = {}
    try { body = await res.json() as Record<string, unknown> } catch { /* no body */ }
    if (res.ok && typeof body.sha === 'string') return { ok: true, sha: body.sha }
    return { ok: false, code: typeof body.error === 'string' ? body.error : `http_${res.status}` }
  } catch {
    return { ok: false, code: 'network' }
  }
}

/** Localized reason a "Create initial commit" request was refused. */
export function initialCommitErrorMessage(t: TFunction, code: string): string {
  if (code === 'git_identity_missing' || code === 'repository_has_commits') return t(`common:initialCommit.errors.${code}`)
  return t('common:initialCommit.errors.generic')
}
