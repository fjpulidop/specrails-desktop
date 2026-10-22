import type { Request, Response, Router } from 'express'
import { specFromRule } from '../domain'
import { readProjectRules, runRulesInventory, type RulesInventoryRunResult, type RulesProject } from '../runtime/rules-store'

/** Ports the composition binds per request (project-scoped, no global state). */
export interface ProjectRulesHttpPorts {
  project: RulesProject & { id: string }
  /** True when the active Core announces `rulesInventory: 1`. */
  supported: () => Promise<boolean>
  /** Persist a new ticket (source `rules`) and broadcast it; returns the stored ticket. */
  createRuleSpec: (fields: { title: string; description: string; labels: string[]; nonGoals: string[]; ruleSource: string | null }) => unknown
  runInventory?: (project: RulesProject) => Promise<RulesInventoryRunResult>
}

/**
 * Project rules (task 4.4):
 *  - `GET  /:projectId/rules`            — the inventory and whether Core supports it.
 *  - `POST /:projectId/rules/inventory`  — re-run Core's inventory (one at a time per project).
 *  - `POST /:projectId/rules/specs`      — turn an `automatable` rule into a spec (`{ id }` or `{ index }`).
 * Without the Core capability every write answers 409 `rules_inventory_unsupported`
 * and the read reports `supported: false`; an existing file is still shown.
 */
export function registerProjectRulesHttp(router: Router, portsFor: (req: Request) => ProjectRulesHttpPorts): void {
  const running = new Set<string>()

  const read = (ports: ProjectRulesHttpPorts) => {
    const result = readProjectRules(ports.project)
    return result.state === 'ok'
      ? { state: 'ok' as const, file: result.file, modifiedAt: result.modifiedAt, inventory: result.inventory }
      : result.state === 'invalid' ? { state: 'invalid' as const, file: result.file, message: result.message } : { state: 'missing' as const }
  }

  router.get('/:projectId/rules', async (req: Request, res: Response) => {
    try {
      const ports = portsFor(req)
      res.json({ supported: await ports.supported(), running: running.has(ports.project.id), ...read(ports) })
    } catch (error) {
      console.error('[project-rules] read failed:', error)
      res.status(500).json({ error: 'rules_read_failed' })
    }
  })

  router.post('/:projectId/rules/inventory', async (req: Request, res: Response) => {
    const ports = portsFor(req)
    if (!(await ports.supported())) { res.status(409).json({ error: 'rules_inventory_unsupported', message: 'Update Core to a version with the project rules inventory' }); return }
    if (running.has(ports.project.id)) { res.status(409).json({ error: 'rules_inventory_running', message: 'The inventory is already running for this project' }); return }
    running.add(ports.project.id)
    try {
      const run = await (ports.runInventory ?? runRulesInventory)(ports.project)
      const after = read(ports)
      res.status(run.ok ? 200 : 502).json({ ok: run.ok, exitCode: run.exitCode, output: run.output, ...after })
    } catch (error) {
      console.error('[project-rules] inventory failed:', error)
      res.status(500).json({ error: 'rules_inventory_failed' })
    } finally {
      running.delete(ports.project.id)
    }
  })

  router.post('/:projectId/rules/specs', async (req: Request, res: Response) => {
    const ports = portsFor(req)
    if (!(await ports.supported())) { res.status(409).json({ error: 'rules_inventory_unsupported', message: 'Update Core to a version with the project rules inventory' }); return }
    // Core's stable rule id (preferred) or the rule's position in the file.
    const id = typeof req.body?.id === 'string' && req.body.id.trim() ? req.body.id.trim() : null
    const index = req.body?.index
    if (id === null && (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0)) { res.status(400).json({ error: 'id or a non-negative index is required' }); return }
    const current = readProjectRules(ports.project)
    if (current.state !== 'ok') { res.status(404).json({ error: 'rules_missing', message: 'No rules inventory for this project' }); return }
    const rule = current.inventory.rules.find((entry) => id !== null ? entry.id === id : entry.index === index)
    if (!rule) { res.status(404).json({ error: 'rule_not_found' }); return }
    if (rule.status !== 'automatable') { res.status(400).json({ error: 'rule_not_automatable', message: 'Only automatable rules become specs' }); return }
    try {
      const ticket = ports.createRuleSpec({ ...specFromRule(rule), ruleSource: rule.source })
      res.status(201).json({ ticket })
    } catch (error) {
      console.error('[project-rules] create spec failed:', error)
      res.status(500).json({ error: 'rule_spec_failed' })
    }
  })
}
