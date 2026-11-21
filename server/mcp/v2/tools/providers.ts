import { z } from 'zod'
import { defineTool } from '../core/registry'
import { F, WRITE_FIELDS } from '../core/views'

/** WP9. AI providers, models, runtime providers, agent profiles and the agent studio catalog. */
export const providersTool = defineTool({
  name: 'specrails_providers',
  title: 'Providers',
  description: 'AI providers (sign-in, CLI versions), models, runtime providers, agent profiles (profiles_*) and studio agents (catalog_*).',
  owner: 'WP9',
  fields: {
    ...WRITE_FIELDS,
    provider: z.string(),
    id: z.string().describe('Profile or agent id'),
    name: z.string(),
    values: F.object(),
    message: z.string().describe('catalog_generate/refine'),
  },
  actions: {
    list: { tier: 'read' },
    models: { tier: 'read', required: ['provider'] },
    test: { tier: 'write', required: ['provider'] },
    runtime_list: { tier: 'read' },
    runtime_save: { tier: 'write', required: ['values'] },
    runtime_test: { tier: 'write', required: ['id'] },
    profiles_list: { tier: 'read' },
    profiles_get: { tier: 'read', required: ['id'] },
    profiles_create: { tier: 'write', required: ['name'] },
    profiles_update: { tier: 'write', required: ['id', 'values'] },
    profiles_delete: { tier: 'destructive', confirm: 'irreversible', required: ['id'] },
    profiles_duplicate: { tier: 'write', required: ['id'] },
    profiles_rename: { tier: 'write', required: ['id', 'name'] },
    catalog_list: { tier: 'read' },
    catalog_get: { tier: 'read', required: ['id'] },
    catalog_create: { tier: 'write', required: ['values'] },
    catalog_update: { tier: 'write', required: ['id', 'values'] },
    catalog_delete: { tier: 'destructive', confirm: 'irreversible', required: ['id'] },
    catalog_generate: { tier: 'ai-spawn', confirm: 'costly', required: ['message'] },
    catalog_test: { tier: 'ai-spawn', confirm: 'costly', required: ['id'] },
    catalog_refine: { tier: 'ai-spawn', confirm: 'costly', required: ['id'], doc: 'options.step: start | turn | apply | cancel | list | get' },
  },
})
