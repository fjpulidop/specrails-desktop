import type { McpToolSpec } from './types'
import { projectsTools } from './projects'
import { appTools } from './app-settings'
import { watchTool } from './watch'
import { metaTools } from './meta'
import { specsTools } from './specs'
import { railsTools } from './rails'
import { jobsTools } from './jobs'
import { chatTools } from './chat'
import { agentsTools } from './agents'
import { pluginsTools } from './plugins'
import { jiraTools } from './jira'
import { loopsTools } from './loops'
import { codeTools } from './code'
import { setupTools } from './setup'
import { analyticsTools } from './analytics'
import { gitTools } from './git'
import { supportTools } from './support'
import { envTools } from './env'
import { contextTools } from './context'
import { missionTools } from './mission'

/**
 * The full MCP tool catalog. Domain-facade tools each expose an `action` enum
 * and call the app's REST API over loopback (see apiCall). Meta tools receive a
 * lazy getter so `search`/`describe` can see the whole list.
 */
export function buildToolSpecs(): McpToolSpec[] {
  const specs: McpToolSpec[] = []
  // App-level + meta + watch
  specs.push(...projectsTools())
  specs.push(...contextTools())
  specs.push(...missionTools())
  specs.push(...appTools())
  specs.push(watchTool())
  // Per-project domains
  specs.push(...specsTools())
  specs.push(...railsTools())
  specs.push(...jobsTools())
  specs.push(...chatTools())
  specs.push(...agentsTools())
  specs.push(...pluginsTools())
  specs.push(...jiraTools())
  specs.push(...loopsTools())
  specs.push(...codeTools())
  specs.push(...setupTools())
  specs.push(...analyticsTools())
  specs.push(...gitTools())
  specs.push(...envTools())
  specs.push(...supportTools())
  // Meta last (needs the full list for search/describe)
  specs.push(...metaTools(() => specs))
  return specs
}
