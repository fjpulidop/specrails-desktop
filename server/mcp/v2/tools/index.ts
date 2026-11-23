import type { V2ToolDef } from '../core/registry'
import { overviewTool } from './overview'
import { inboxTool } from './inbox'
import { waitTool } from './wait'
import { projectsTool } from './projects'
import { specsTool } from './specs'
import { blueprintTool } from './blueprint'
import { railsTool } from './rails'
import { runsTool } from './runs'
import { deliveriesTool } from './deliveries'
import { missionsTool } from './missions'
import { insightsTool } from './insights'
import { settingsTool } from './settings'
import { providersTool } from './providers'
import { integrationsTool } from './integrations'
import { systemTool } from './system'

/**
 * The 15 v2 tools in catalog order. Frozen by WP0: each work package edits only
 * its own tool file; adding a 16th tool is a design change (budget test).
 */
export const V2_TOOLS: readonly V2ToolDef[] = [
  overviewTool, inboxTool, waitTool, projectsTool, specsTool, blueprintTool, railsTool, runsTool,
  deliveriesTool, missionsTool, insightsTool, settingsTool, providersTool, integrationsTool, systemTool,
]
