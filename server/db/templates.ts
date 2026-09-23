import type { DbInstance } from './types'

// ─── Job Template DB functions ────────────────────────────────────────────────

export interface JobTemplateRow {
  id: string
  name: string
  description: string | null
  commands: string  // JSON-encoded string[]
  created_at: string
  updated_at: string
}

export function createTemplate(
  db: DbInstance,
  t: { id: string; name: string; description?: string; commands: string[] }
): void {
  db.prepare(
    'INSERT INTO job_templates (id, name, description, commands) VALUES (?, ?, ?, ?)'
  ).run(t.id, t.name, t.description ?? null, JSON.stringify(t.commands))
}

export function listTemplates(db: DbInstance): JobTemplateRow[] {
  return db.prepare('SELECT * FROM job_templates ORDER BY created_at DESC').all() as JobTemplateRow[]
}

export function getTemplate(db: DbInstance, id: string): JobTemplateRow | undefined {
  return db.prepare('SELECT * FROM job_templates WHERE id = ?').get(id) as JobTemplateRow | undefined
}

export function updateTemplate(
  db: DbInstance,
  id: string,
  patch: { name?: string; description?: string | null; commands?: string[] }
): void {
  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [new Date().toISOString()]
  if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name) }
  if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description) }
  if (patch.commands !== undefined) { sets.push('commands = ?'); params.push(JSON.stringify(patch.commands)) }
  params.push(id)
  db.prepare(`UPDATE job_templates SET ${sets.join(', ')} WHERE id = ?`).run(...params)
}

export function deleteTemplate(db: DbInstance, id: string): void {
  db.prepare('DELETE FROM job_templates WHERE id = ?').run(id)
}
