import type { DbInstance } from './types'
import type { ProposalRow } from './types'

// ─── Proposal DB functions ────────────────────────────────────────────────────

export function createProposal(db: DbInstance, opts: { id: string; idea: string }): void {
  db.prepare(
    'INSERT INTO proposals (id, idea, status) VALUES (?, ?, ?)'
  ).run(opts.id, opts.idea, 'input')
}

export function getProposal(db: DbInstance, id: string): ProposalRow | undefined {
  return db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as ProposalRow | undefined
}

export function listProposals(
  db: DbInstance,
  opts?: { limit?: number; offset?: number }
): { proposals: ProposalRow[]; total: number } {
  const limit = Math.min(opts?.limit ?? 20, 100)
  const offset = opts?.offset ?? 0

  const countRow = db
    .prepare('SELECT COUNT(*) as count FROM proposals')
    .get() as { count: number }

  const proposals = db
    .prepare('SELECT * FROM proposals ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(limit, offset) as ProposalRow[]

  return { proposals, total: countRow.count }
}

export function updateProposal(
  db: DbInstance,
  id: string,
  patch: {
    status?: string
    session_id?: string
    result_markdown?: string
    issue_url?: string
  }
): void {
  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [new Date().toISOString()]
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status) }
  if (patch.session_id !== undefined) { sets.push('session_id = ?'); params.push(patch.session_id) }
  if (patch.result_markdown !== undefined) { sets.push('result_markdown = ?'); params.push(patch.result_markdown) }
  if (patch.issue_url !== undefined) { sets.push('issue_url = ?'); params.push(patch.issue_url) }
  params.push(id)
  db.prepare(`UPDATE proposals SET ${sets.join(', ')} WHERE id = ?`).run(...params)
}

export function deleteProposal(db: DbInstance, id: string): void {
  db.prepare('DELETE FROM proposals WHERE id = ?').run(id)
}
