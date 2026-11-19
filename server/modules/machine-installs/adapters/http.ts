/**
 * Settings ▸ remembered installs. `GET /api/machine-installs` lists the approvals the person gave;
 * `DELETE /api/machine-installs` `{ command }` revokes one, so the next run that needs it asks again.
 */
import type { Request, Response, Router } from 'express'
import type { MachineInstalls } from '../application'

export function registerMachineInstallRoutes(router: Router, installs: Pick<MachineInstalls, 'list' | 'revoke'>): void {
  router.get('/machine-installs', (_req: Request, res: Response) => { res.json({ approvals: installs.list() }) })
  router.delete('/machine-installs', (req: Request, res: Response) => {
    const command = (req.body ?? {}).command
    if (typeof command !== 'string' || !command.trim() || command.length > 300) { res.status(400).json({ error: 'command is required' }); return }
    if (!installs.revoke(command.trim())) { res.status(404).json({ error: 'No remembered approval for this command' }); return }
    res.json({ ok: true, approvals: installs.list() })
  })
}
