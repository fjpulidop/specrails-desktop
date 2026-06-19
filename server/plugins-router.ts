import { Router, Request, Response } from 'express'
import type { ProjectContext } from './project-registry'
import {
  PluginAlreadyInstalledError,
  PluginInstallError,
  PluginNotFoundError,
  PluginNotInstalledError,
} from './plugin-manager'
import { getPluginManager } from './plugins/manager'
import { installPrerequisite } from './plugins/prereq-installer'
import { augmentPathFromLoginShell } from './path-resolver'
import { disableMarketplacePlugin } from './plugins/claude-approval'
import { resolveProjectExecution } from './workspace-resolution'

/**
 * Relocate-artifacts gate: the dir the PluginManager mutates (`.mcp.json` +
 * `.specrails/plugins/` state + `.claude/agents/custom-*.md`). Relocated ⇒ the
 * workspace (so the relocated CLI, spawned with cwd=workspace, loads the
 * `.mcp.json` the manager wrote); legacy ⇒ project.path (byte-identical).
 */
function pluginRoot(project: { slug: string; path: string }): string {
  const exec = resolveProjectExecution({ slug: project.slug, path: project.path })
  return exec.relocated && exec.workspaceDir ? exec.workspaceDir : project.path
}

declare module 'express-serve-static-core' {
  interface Request {
    projectCtx?: ProjectContext
  }
}

function pluginsSectionEnabled(): boolean {
  return process.env.SPECRAILS_PLUGINS_SECTION !== 'false'
}

function handleError(res: Response, err: unknown): void {
  if (err instanceof PluginNotFoundError) {
    res.status(404).json({ error: err.message })
    return
  }
  if (err instanceof PluginNotInstalledError) {
    res.status(404).json({ error: err.message })
    return
  }
  if (err instanceof PluginAlreadyInstalledError) {
    res.status(409).json({ error: err.message })
    return
  }
  if (err instanceof PluginInstallError) {
    res.status(409).json({ error: err.message })
    return
  }
  const message = err instanceof Error ? err.message : 'unknown error'
  res.status(500).json({ error: message })
}

export function createPluginsRouter(): Router {
  const router = Router({ mergeParams: true })

  function ctx(req: Request): ProjectContext {
    return req.projectCtx!
  }

  router.use((_req, res, next) => {
    if (!pluginsSectionEnabled()) {
      res.status(404).json({ error: 'Plugins section disabled on this server' })
      return
    }
    next()
  })

  // GET /api/projects/:projectId/plugins — catalog
  router.get('/', async (req, res) => {
    try {
      const { project } = ctx(req)
      const list = await getPluginManager().listAvailable(pluginRoot(project), project.provider)
      res.json({ plugins: list })
    } catch (err) {
      handleError(res, err)
    }
  })

  // GET /api/projects/:projectId/plugins/:name/preview-install
  router.get('/:name/preview-install', async (req, res) => {
    try {
      const { project } = ctx(req)
      const result = await getPluginManager().previewInstall(pluginRoot(project), project.id, req.params.name)
      res.json(result)
    } catch (err) {
      handleError(res, err)
    }
  })

  // POST /api/projects/:projectId/plugins/:name/install
  router.post('/:name/install', async (req, res) => {
    try {
      const { project, broadcast } = ctx(req)
      await getPluginManager().install(pluginRoot(project), project.id, req.params.name, broadcast, project.provider)
      res.status(200).json({ ok: true })
    } catch (err) {
      handleError(res, err)
    }
  })

  // DELETE /api/projects/:projectId/plugins/:name — uninstall (or orphan removal)
  router.delete('/:name', async (req, res) => {
    try {
      const { project, broadcast } = ctx(req)
      await getPluginManager().uninstall(pluginRoot(project), project.id, req.params.name, broadcast, project.provider)
      res.status(200).json({ ok: true })
    } catch (err) {
      handleError(res, err)
    }
  })

  // POST /api/projects/:projectId/plugins/_prerequisites/:prereq/install
  // Streams installer output via the project broadcast as
  // `plugin.prereq_install_progress`; emits `plugin.prereq_installed` on done.
  router.post('/_prerequisites/:prereq/install', async (req, res) => {
    const { project, broadcast } = ctx(req)
    const prereq = req.params.prereq
    const allowed = ['uv']
    if (!allowed.includes(prereq)) {
      res.status(404).json({ error: `unknown prerequisite '${prereq}'` })
      return
    }
    res.status(202).json({ ok: true, message: 'install started' })
    try {
      const result = await installPrerequisite(prereq, project.id, broadcast)
      // After a successful install, the new binary lives in `~/.local/bin`
      // (POSIX) or `%USERPROFILE%\.local\bin` (Windows). Refresh the app's
      // PATH from a login shell so the next verify spawn finds it without a
      // app restart. On Windows this is a no-op — surface the hint as part
      // of the reason field instead.
      let hint: string | undefined
      if (result.ok) {
        if (process.platform === 'win32') {
          hint = 'Installed. If verify still fails, restart Specrails so Windows refreshes PATH.'
        } else {
          try {
            await augmentPathFromLoginShell({ timeoutMs: 3000 })
            hint = 'Installed. PATH refreshed.'
          } catch {
            hint = 'Installed. If verify still fails, restart Specrails.'
          }
        }
      }
      broadcast({
        type: 'plugin.prereq_installed',
        projectId: project.id,
        prereq,
        ok: result.ok,
        reason: result.ok ? hint : result.reason,
        timestamp: new Date().toISOString(),
      })
    } catch (err) {
      broadcast({
        type: 'plugin.prereq_installed',
        projectId: project.id,
        prereq,
        ok: false,
        reason: (err as Error)?.message ?? 'unknown error',
        timestamp: new Date().toISOString(),
      })
    }
  })

  // POST /api/projects/:projectId/plugins/_marketplace/disable
  // Body: { key: "<plugin-name>@<source>" } — sets enabledPlugins[key]=false
  // in `~/.claude/settings.json`. The only place the app mutates Claude's
  // per-user config; surfaced via an explicit user action.
  router.post('/_marketplace/disable', async (req, res) => {
    const { project, broadcast } = ctx(req)
    const key = (req.body as { key?: string } | undefined)?.key
    if (!key || typeof key !== 'string' || !key.includes('@')) {
      res.status(400).json({ error: 'body must be { key: "<plugin>@<source>" }' })
      return
    }
    const result = disableMarketplacePlugin(key)
    if (!result.ok) {
      res.status(500).json({ error: result.reason ?? 'unknown' })
      return
    }
    // Refetch catalog so UI updates conflicts/status without manual refresh.
    broadcast({
      type: 'plugin.health_changed',
      projectId: project.id,
      name: key.split('@')[0],
      status: 'unknown',
      reason: 'marketplace-disabled',
      timestamp: new Date().toISOString(),
    })
    res.json({ ok: true })
  })

// POST /api/projects/:projectId/plugins/:name/activate
  router.post('/:name/activate', async (req, res) => {
    try {
      const { project, broadcast } = ctx(req)
      await getPluginManager().setActive(pluginRoot(project), project.id, req.params.name, true, broadcast, project.provider)
      res.json({ ok: true })
    } catch (err) {
      handleError(res, err)
    }
  })

  // POST /api/projects/:projectId/plugins/:name/deactivate
  router.post('/:name/deactivate', async (req, res) => {
    try {
      const { project, broadcast } = ctx(req)
      await getPluginManager().setActive(pluginRoot(project), project.id, req.params.name, false, broadcast, project.provider)
      res.json({ ok: true })
    } catch (err) {
      handleError(res, err)
    }
  })

  // POST /api/projects/:projectId/plugins/:name/update — apply manifest drift
  router.post('/:name/update', async (req, res) => {
    try {
      const { project, broadcast } = ctx(req)
      await getPluginManager().updateMcpEntry(pluginRoot(project), project.id, req.params.name, broadcast, project.provider)
      res.json({ ok: true })
    } catch (err) {
      handleError(res, err)
    }
  })

  // GET /api/projects/:projectId/plugins/:name/health
  router.get('/:name/health', async (req, res) => {
    try {
      const { project, broadcast } = ctx(req)
      const result = await getPluginManager().verify(pluginRoot(project), project.id, req.params.name, broadcast)
      res.json(result)
    } catch (err) {
      handleError(res, err)
    }
  })

  return router
}
