/** Remembered install approvals in the app database (`machine_install_approvals`, desktop migration 41). */
import type { DbInstance } from '../../../db'
import type { InstallApproval, InstallApprovalStore } from '../application'

interface Row { command: string; manager: string; tool: string; approved_at: string; last_used_at: string | null; uses: number }
const toApproval = (row: Row): InstallApproval => ({ command: row.command, manager: row.manager, tool: row.tool, approvedAt: row.approved_at, lastUsedAt: row.last_used_at, uses: row.uses })

export function createSqliteApprovalStore(db: DbInstance): InstallApprovalStore {
  return {
    get: command => {
      const row = db.prepare('SELECT * FROM machine_install_approvals WHERE command = ?').get(command) as Row | undefined
      return row ? toApproval(row) : null
    },
    remember: ({ command, manager, tool }) => {
      db.prepare(`INSERT INTO machine_install_approvals (command, manager, tool) VALUES (?, ?, ?)
        ON CONFLICT(command) DO UPDATE SET tool = excluded.tool`).run(command, manager, tool)
    },
    markUsed: command => { db.prepare("UPDATE machine_install_approvals SET last_used_at = datetime('now'), uses = uses + 1 WHERE command = ?").run(command) },
    list: () => (db.prepare('SELECT * FROM machine_install_approvals ORDER BY approved_at DESC, command').all() as Row[]).map(toApproval),
    revoke: command => db.prepare('DELETE FROM machine_install_approvals WHERE command = ?').run(command).changes > 0,
  }
}
