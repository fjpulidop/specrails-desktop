import { z } from 'zod'
import { getDesktopSetting, setDesktopSetting } from '../../desktop-db'
import type { McpToolSpec } from './types'
import { isMcpEnabled, isTierEnabled } from '../mcp-tiers'
import { apiCall } from './types'

// App-level settings the MCP may read/write. NOTE: the MCP enable flag and the
// permission-tier toggles are intentionally NOT writable here — an external LLM
// must never be able to escalate its own permissions. Those are user-only,
// changed in the Settings ▸ MCP panel.
const WRITABLE_THEMES = ['specrails', 'dracula', 'aurora-light', 'obsidian-dark', 'code-rain', 'galaxy']
const WRITABLE_LANGS = ['en', 'es', 'fr', 'de', 'pt', 'it', 'zh', 'ja']
const LEGACY_THEME_ID_MAP: Record<string, string> = {
  'star-wars': 'galaxy',
  matrix: 'code-rain',
}

export function appTools(): McpToolSpec[] {
  return [
    {
      name: 'specrails_settings',
      title: 'App settings',
      description:
        'Read or update app-level Specrails settings (theme, language, daily budget, cost-alert threshold, Code Explorer summary language + monthly summary budget). ' +
        'Actions: get, set, runtime_providers.list (connections + live status), runtime_providers.test (probe an OpenAI-compatible baseUrl without saving), runtime_providers.save (replace the connections list — local AI engines re-register live). ' +
        'The MCP enable flag and permission tiers are read-only here (user-controlled in the app). ' +
        'dailyBudgetUsd here is APP-WIDE (all projects combined); per-project caps live in specrails_analytics(budget_set).',
      hintTier: 'read',
      tier: (args) => (args.action === 'set' || args.action === 'runtime_providers.save' ? 'write' : 'read'),
      inputSchema: {
        action: z.enum(['get', 'set', 'runtime_providers.list', 'runtime_providers.test', 'runtime_providers.save']).describe('Operation'),
        baseUrl: z.string().optional().describe('runtime_providers.test: OpenAI-compatible base URL (e.g. http://127.0.0.1:11434/v1)'),
        apiKeyEnv: z.string().optional().describe('runtime_providers.test: env var NAME holding the API key (never the key itself)'),
        providers: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe('runtime_providers.save: the FULL connections list ({ id, kind: "cli", cli } | { id, kind: "openai-compatible", baseUrl, apiKeyEnv?, label?, defaultModel?, rates?, supportsReasoningEffort? })'),
        theme: z.enum(WRITABLE_THEMES as [string, ...string[]]).optional(),
        language: z.enum(WRITABLE_LANGS as [string, ...string[]]).optional(),
        dailyBudgetUsd: z
          .number()
          .min(0)
          .nullable()
          .optional()
          .describe('APP-WIDE daily budget cap USD across all projects; null clears it. Per-project caps live in specrails_analytics(budget_set).'),
        costAlertThresholdUsd: z.number().min(0).nullable().optional(),
        summaryLanguage: z
          .enum(['en', 'es'])
          .optional()
          .describe('Code Explorer file-summary language (app-wide)'),
        summaryMonthlyBudgetUsd: z
          .number()
          .min(0)
          .optional()
          .describe('Code Explorer monthly AI file-summary budget in USD (app-wide, default 5)'),
      },
      handler: async (ctx, args) => {
        const db = ctx.desktopDb
        // Provider connections (local AI engines) — mirror the REST routes over
        // loopback so validation, adapter re-sync and broadcasts stay identical.
        if (args.action === 'runtime_providers.list') {
          return apiCall(ctx, 'GET', '/runtime-providers')
        }
        if (args.action === 'runtime_providers.test') {
          if (typeof args.baseUrl !== 'string' || !args.baseUrl) throw new Error('runtime_providers.test requires baseUrl.')
          return apiCall(ctx, 'POST', '/runtime-providers/test', {
            baseUrl: args.baseUrl,
            ...(typeof args.apiKeyEnv === 'string' && args.apiKeyEnv ? { apiKeyEnv: args.apiKeyEnv } : {}),
          })
        }
        if (args.action === 'runtime_providers.save') {
          if (!Array.isArray(args.providers) || !args.providers.length) throw new Error('runtime_providers.save requires a non-empty providers list.')
          return apiCall(ctx, 'PUT', '/runtime-providers', { providers: args.providers })
        }
        if (args.action === 'get') {
          const theme = normalizeStoredTheme(db)
          return {
            theme,
            language: getDesktopSetting(db, 'ui_language') ?? null,
            dailyBudgetUsd: num(getDesktopSetting(db, 'desktop_daily_budget_usd')),
            costAlertThresholdUsd: num(getDesktopSetting(db, 'cost_alert_threshold_usd')),
            // Code Explorer settings (same keys + defaults as GET /api/code-explorer-settings)
            summaryLanguage: getDesktopSetting(db, 'summary_language') === 'es' ? 'es' : 'en',
            summaryMonthlyBudgetUsd: nonNegNum(getDesktopSetting(db, 'summary_monthly_budget_usd')) ?? 5.0,
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
        // Code Explorer settings — same validation as PATCH /api/code-explorer-settings.
        if (args.summaryLanguage !== undefined) {
          if (args.summaryLanguage !== 'en' && args.summaryLanguage !== 'es') {
            throw new Error("summaryLanguage must be one of: 'en', 'es'.")
          }
          setDesktopSetting(db, 'summary_language', args.summaryLanguage)
          changed.push('summaryLanguage')
        }
        if (args.summaryMonthlyBudgetUsd !== undefined) {
          const v = args.summaryMonthlyBudgetUsd
          if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
            throw new Error('summaryMonthlyBudgetUsd must be a non-negative number.')
          }
          setDesktopSetting(db, 'summary_monthly_budget_usd', String(v))
          changed.push('summaryMonthlyBudgetUsd')
        }
        if (!changed.length) {
          throw new Error(
            'set requires at least one field (theme, language, dailyBudgetUsd, costAlertThresholdUsd, summaryLanguage, summaryMonthlyBudgetUsd).',
          )
        }
        return { ok: true, changed }
      },
    },
  ]
}

function normalizeStoredTheme(db: Parameters<typeof getDesktopSetting>[0]): string {
  const stored = getDesktopSetting(db, 'ui_theme')
  if (!stored) return 'specrails'
  const migrated = LEGACY_THEME_ID_MAP[stored]
  if (migrated) {
    setDesktopSetting(db, 'ui_theme', migrated)
    return migrated
  }
  return WRITABLE_THEMES.includes(stored) ? stored : 'specrails'
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Mirror of the code-explorer-settings route parsing: finite AND >= 0, else null. */
function nonNegNum(v: string | undefined): number | null {
  const n = num(v)
  return n !== null && n >= 0 ? n : null
}

function writeNumOrClear(db: Parameters<typeof setDesktopSetting>[0], key: string, value: number | null): void {
  if (value === null) setDesktopSetting(db, key, '')
  else setDesktopSetting(db, key, String(value))
}
