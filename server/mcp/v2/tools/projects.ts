import { z } from 'zod'
import { defineTool } from '../core/registry'
import { WRITE_FIELDS } from '../core/views'

/** WP2 (app-level). Projects, setup and repositories. */
export const projectsTool = defineTool({
  name: 'specrails_projects',
  title: 'Projects',
  description: 'Projects and setup: list, select the session default, add or clone, provision, repositories, sample project.',
  owner: 'WP2',
  fields: {
    ...WRITE_FIELDS,
    path: z.string().describe('add: local folder'),
    url: z.string().describe('clone: git URL'),
    name: z.string(),
    repository: z.string().describe('Repository id'),
  },
  actions: {
    list: { tier: 'read' },
    get: { tier: 'read', required: ['project'] },
    select: { tier: 'read', required: ['project'] },
    add: { tier: 'write', required: ['path'] },
    clone: { tier: 'write', required: ['url'] },
    provision: { tier: 'ai-spawn', confirm: 'costly', required: ['project'] },
    install_status: { tier: 'read', required: ['project'] },
    abort_install: { tier: 'write', required: ['project'] },
    repositories: { tier: 'read', required: ['project'] },
    repository_add: { tier: 'write', required: ['project', 'path'] },
    repository_update: { tier: 'write', required: ['project', 'repository'] },
    repository_remove: { tier: 'destructive', confirm: 'irreversible', required: ['project', 'repository'] },
    unregister: { tier: 'destructive', confirm: 'irreversible', required: ['project'] },
    sample_create: { tier: 'write' },
    sample_remove: { tier: 'destructive', confirm: 'irreversible' },
    prerequisites: { tier: 'read' },
  },
})
