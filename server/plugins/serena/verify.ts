import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { PluginLifecycleContext, PluginVerifyResult } from '../../types'
import { windowsSpawnEnv } from '../../util/win-spawn'
import { getAdapter, hasAdapter } from '../../providers'
import { codexMcpList } from '../codex-mcp'

const TIMEOUT_MS = 1800

/**
 * Verify Serena availability. We only probe `uv --version` here — proxy for
 * "uvx will be able to launch serena-mcp-server when claude actually calls it".
 *
 * We intentionally do NOT shell out to `uvx --from git+... serena-mcp-server`:
 * that would download the git repo + dependencies on every verify, which is
 * slow (multi-second) and would fail offline. The Claude CLI itself triggers
 * the lazy install through uvx's own cache, so as long as `uv` is on PATH and
 * executable, install + spawn-time verify can both pass quickly.
 *
 * Cross-platform spawn: on Windows we set `shell: true` so PATH resolution
 * picks up `uv.exe` (or, if astral installed via winget, the .cmd shim) the
 * same way it does in `setup-prerequisites.ts`.
 */
type SerenaVerifyContext = Pick<
  PluginLifecycleContext,
  'projectPath' | 'projectId' | 'providerId' | 'slug'
>

function registrationProblem(ctx?: SerenaVerifyContext): string | null {
  // Direct callers from the pre-provider API used verifySerena() as a cheap uv
  // probe. Keep that contract; PluginManager always supplies provider context
  // and therefore receives the stronger registration check below.
  if (!ctx?.providerId) return null
  if (!hasAdapter(ctx.providerId)) return `unknown-provider:${ctx.providerId}`
  const adapter = getAdapter(ctx.providerId)

  if (adapter.mcpRegistration === 'cli-add') {
    const slug = ctx.slug?.trim() || path.basename(ctx.projectPath)
    const listing = codexMcpList(slug)
    if (!listing.ok) return 'mcp-registry-unavailable'
    return listing.servers.includes('serena') ? null : 'mcp-registration-missing'
  }

  const file = adapter.projectMcpPath?.(ctx.projectPath)
  if (!file || !fs.existsSync(file)) return 'mcp-registration-missing'
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      mcpServers?: Record<string, unknown>
    }
    if (
      !parsed.mcpServers ||
      typeof parsed.mcpServers !== 'object' ||
      Array.isArray(parsed.mcpServers)
    ) {
      return 'mcp-registration-invalid'
    }
    return Object.prototype.hasOwnProperty.call(parsed.mcpServers, 'serena')
      ? null
      : 'mcp-registration-missing'
  } catch {
    return 'mcp-registration-invalid'
  }
}

export async function verifySerena(ctx?: SerenaVerifyContext): Promise<PluginVerifyResult> {
  const checkedAt = new Date().toISOString()
  const isWin = process.platform === 'win32'
  return new Promise<PluginVerifyResult>((resolve) => {
    let settled = false
    let stderr = ''
    let stdout = ''
    let child
    try {
      child = spawn('uv', ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: isWin,
        // SystemRoot/ComSpec so cmd.exe (shell:true) can start under a stripped
        // packaged-sidecar env; else uv is wrongly reported not-on-path.
        env: windowsSpawnEnv(),
      })
    } catch {
      resolve({ ok: false, reason: 'uv-not-on-path', checkedAt })
      return
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      resolve({ ok: false, reason: 'verify-timeout', checkedAt })
    }, TIMEOUT_MS)

    child.stdout?.on('data', (b) => { stdout += b.toString() })
    child.stderr?.on('data', (b) => { stderr += b.toString() })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') resolve({ ok: false, reason: 'uv-not-on-path', checkedAt })
      else resolve({ ok: false, reason: `verify-exception: ${err.message}`, checkedAt })
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        const reason = registrationProblem(ctx)
        resolve(reason
          ? { ok: false, reason, checkedAt }
          : { ok: true, reason: undefined, checkedAt })
      } else {
        resolve({
          ok: false,
          reason: `uv-non-zero-exit: code=${code} ${stderr.trim().slice(0, 200) || stdout.trim().slice(0, 200)}`,
          checkedAt,
        })
      }
    })
  })
}
