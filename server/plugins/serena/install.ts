import fs from 'fs'
import path from 'path'
import type { PluginLifecycleContext } from '../../types'
import { PluginManager } from '../../plugin-manager'
import { SERENA_MCP_ENTRY, serenaManifest } from './manifest'
import { SERENA_INSTRUCTIONS_MD } from './instructions-content'
import { codexMcpAdd, codexMcpRemove, codexMcpList } from '../codex-mcp'
import { getAdapter, hasAdapter } from '../../providers'

/** Claude fragment lives in the core-protected `.claude/agents/custom-*.md`
 *  namespace; only written on claude projects. Codex doesn't honour that
 *  file convention, and the per-project AGENTS.md block (written by the
 *  shared-file contributor in plugin-manager) is the codex equivalent. */
const CLAUDE_FRAGMENT_REL = '.claude/agents/custom-serena.md'

function isCodex(ctx: PluginLifecycleContext): boolean {
  if (!ctx.providerId) return false
  if (!hasAdapter(ctx.providerId)) return false
  return getAdapter(ctx.providerId).mcpRegistration === 'cli-add'
}

/** Resolve the canonical per-project slug for codex-mcp CODEX_HOME isolation.
 *  PREFER the registry slug threaded through the lifecycle context (the SAME
 *  slug used by ~/.specrails/projects/<slug>/ everywhere else). Fall back to the
 *  path basename only when absent — basenames collide between same-named repos
 *  and would point CODEX_HOME at a shared/wrong dir. */
function resolveCodexSlug(ctx: PluginLifecycleContext): string {
  return ctx.slug && ctx.slug.trim().length > 0 ? ctx.slug : path.basename(ctx.projectPath)
}

export async function installSerena(ctx: PluginLifecycleContext): Promise<void> {
  if (isCodex(ctx)) {
    // Codex path: `codex mcp add` against per-project CODEX_HOME. The
    // declarative entry comes from the manifest's providerSupport.codex
    // so future plugins can declare their own without touching this file.
    const entry = serenaManifest.providerSupport?.codex?.mcpEntry
    if (!entry) {
      throw new Error('serena manifest is missing providerSupport.codex.mcpEntry')
    }
    const slug = resolveCodexSlug(ctx)
    ctx.log(`Registering serena MCP via 'codex mcp add' (CODEX_HOME=~/.specrails/projects/${slug}/codex-home/)`)
    const result = codexMcpAdd(slug, 'serena', entry)
    if (!result.ok) {
      const detail = result.stderr.trim() || result.stdout.trim() || '(no output)'
      throw new Error(`codex mcp add serena failed: ${detail}`)
    }
    return
  }

  const adapter = getAdapter(ctx.providerId ?? 'claude')
  const mcpFile = adapter.projectMcpPath?.(ctx.projectPath)
  ctx.log(`Adding mcpServers.serena to ${mcpFile ?? '.mcp.json'}`)
  await PluginManager.mergeMcpServers(
    ctx.projectPath,
    { serena: SERENA_MCP_ENTRY },
    adapter.id,
  )

  // Claude additionally receives its historical custom-agent fragment. Kimi
  // consumes the provider-aware AGENTS.md contributor and native MCP config;
  // its built-in subagents are not modelled as SpecRails roles.
  if (adapter.id === 'claude') {
    ctx.log(`Writing ${CLAUDE_FRAGMENT_REL}`)
    const fragmentDest = path.join(ctx.projectPath, CLAUDE_FRAGMENT_REL)
    fs.mkdirSync(path.dirname(fragmentDest), { recursive: true })
    fs.writeFileSync(fragmentDest, SERENA_INSTRUCTIONS_MD, 'utf8')
    ctx.recordInstalledFile(CLAUDE_FRAGMENT_REL)
  }
}

export async function uninstallSerena(ctx: PluginLifecycleContext): Promise<void> {
  if (isCodex(ctx)) {
    const slug = resolveCodexSlug(ctx)
    // Probe first so removing an already-removed server doesn't surface as an
    // error (e.g. the user uninstalled via terminal then via the app).
    const listing = codexMcpList(slug)
    if (listing.ok && !listing.servers.includes('serena')) {
      ctx.log('serena not present in codex mcp list — nothing to remove')
      return
    }
    ctx.log(`Removing serena via 'codex mcp remove' (CODEX_HOME=~/.specrails/projects/${slug}/codex-home/)`)
    const result = codexMcpRemove(slug, 'serena')
    if (!result.ok) {
      // Removal failures are warnings — the state.json entry is gone either
      // way and a subsequent install will overwrite. Don't block uninstall.
      ctx.log(`codex mcp remove warning: ${result.stderr.trim() || '(no output)'}`)
    }
    return
  }

  const adapter = getAdapter(ctx.providerId ?? 'claude')
  ctx.log(`Removing mcpServers.serena from ${adapter.projectMcpPath?.(ctx.projectPath) ?? '.mcp.json'}`)
  await PluginManager.removeMcpServers(ctx.projectPath, ['serena'], adapter.id)

  if (adapter.id === 'claude') {
    const fragmentDest = path.join(ctx.projectPath, CLAUDE_FRAGMENT_REL)
    if (fs.existsSync(fragmentDest)) {
      ctx.log(`Removing ${CLAUDE_FRAGMENT_REL}`)
      try { fs.unlinkSync(fragmentDest) } catch { /* best-effort */ }
    }
  }
}
