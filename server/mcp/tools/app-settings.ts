import { z } from 'zod'
import { getDesktopSetting, setDesktopSetting } from '../../desktop-db'
import type { McpToolSpec } from './types'
import { isMcpEnabled, isTierEnabled } from '../mcp-tiers'

// App-level settings the MCP may read/write. NOTE: the MCP enable flag and the
// permission-tier toggles are intentionally NOT writable here — an external LLM
// must never be able to escalate its own permissions. Those are user-only,
// changed in the Settings ▸ MCP panel.
const WRITABLE_THEMES = ['specrails', 'dracula', 'aurora-light', 'obsidian-dark', 'matrix']
const WRITABLE_LANGS = ['en', 'es', 'fr', 'de', 'pt', 'it', 'zh', 'ja']

export function appTools(): McpToolSpec[] {
  return [
    {
      name: 'specrails_settings',
      title: 'App settings',
      description:
        'Read or update app-level Specrails settings (theme, language, daily budget, cost-alert threshold). ' +
        'Actions: get, set. The MCP enable flag and permission tiers are read-only here (user-controlled in the app).',
      hintTier: 'read',
      tier: (args) => (args.action === 'set' ? 'write' : 'read'),
      inputSchema: {
        action: z.enum(['get', 'set']).describe('Operation'),
        theme: z.enum(WRITABLE_THEMES as [string, ...string[]]).optional(),
        language: z.enum(WRITABLE_LANGS as [string, ...string[]]).optional(),
        dailyBudgetUsd: z.number().min(0).nullable().optional(),
        costAlertThresholdUsd: z.number().min(0).nullable().optional(),
      },
      handler: (ctx, args) => {
        const db = ctx.desktopDb
        if (args.action === 'get') {
          return {
            theme: getDesktopSetting(db, 'ui_theme') ?? 'specrails',
            language: getDesktopSetting(db, 'ui_language') ?? null,
            dailyBudgetUsd: num(getDesktopSetting(db, 'desktop_daily_budget_usd')),
            costAlertThresholdUsd: num(getDesktopSetting(db, 'cost_alert_threshold_usd')),
            mcp: {
              enabled: isMcpEnabled(db),
              tierWrite: isTierEnabled(db, 'write'),
              tierAiSpawn: isTierEnabled(db, 'ai-spawn'),
              tierDestructive: isTierEnabled(db, 'destructive'),
            },
          }
        }
        // set
        const changed: string[] = []
        if (args.theme !== undefined) {
          setDesktopSetting(db, 'ui_theme', String(args.theme))
          changed.push('theme')
        }
        if (args.language !== undefined) {
          setDesktopSetting(db, 'ui_language', String(args.language))
          changed.push('language')
        }
        if (args.dailyBudgetUsd !== undefined) {
          writeNumOrClear(db, 'desktop_daily_budget_usd', args.dailyBudgetUsd as number | null)
          changed.push('dailyBudgetUsd')
        }
        if (args.costAlertThresholdUsd !== undefined) {
          writeNumOrClear(db, 'cost_alert_threshold_usd', args.costAlertThresholdUsd as number | null)
          changed.push('costAlertThresholdUsd')
        }
        if (!changed.length) throw new Error('set requires at least one field (theme, language, dailyBudgetUsd, costAlertThresholdUsd).')
        return { ok: true, changed }
      },
    },
  ]
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function writeNumOrClear(db: Parameters<typeof setDesktopSetting>[0], key: string, value: number | null): void {
  if (value === null) setDesktopSetting(db, key, '')
  else setDesktopSetting(db, key, String(value))
}
