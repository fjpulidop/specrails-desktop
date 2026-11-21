import { z } from 'zod'
import { defineTool } from '../core/registry'
import { F } from '../core/views'

export const APP_SECTIONS = ['appearance', 'language', 'notifications', 'code', 'terminal', 'mobile', 'webhooks', 'external_mcp', 'connectors', 'role_prompts', 'agent_defaults'] as const
export const PROJECT_SECTIONS = ['general', 'runtime', 'subagents', 'branch', 'env', 'budget', 'telemetry', 'rules', 'retention', 'guardrails', 'loop_roles', 'verification', 'environment_plan'] as const

/** WP9. App and project settings by section; env scan; webhook test. Secrets are write-only. */
export const settingsTool = defineTool({
  name: 'specrails_settings',
  title: 'Settings',
  description: 'App and project settings by section (get/set; secrets write-only), env scan and status, webhook test.',
  owner: 'WP9',
  fields: {
    project: F.project,
    section: z.enum([...APP_SECTIONS, ...PROJECT_SECTIONS]),
    values: F.object().describe('set: fields to change'),
    lang: F.lang,
    confirm: F.confirm,
    dryRun: F.dryRun,
    options: F.options,
  },
  actions: {
    get: { tier: 'read', required: ['section'] },
    set: { tier: 'write', required: ['section', 'values'] },
    env_scan: { tier: 'read', required: ['project'] },
    env_status: { tier: 'read', required: ['project'] },
    webhook_test: { tier: 'write', confirm: 'external', required: ['options.webhookId'] },
  },
})
