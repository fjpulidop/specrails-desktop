import { spawn } from 'child_process'
import type { PluginVerifyResult } from '../../types'
import { windowsSpawnEnv } from '../../util/win-spawn'

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
export async function verifySerena(): Promise<PluginVerifyResult> {
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
        resolve({ ok: true, reason: undefined, checkedAt })
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
