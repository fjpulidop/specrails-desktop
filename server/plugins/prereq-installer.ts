import { spawn } from 'child_process'
import type { WsMessage } from '../types'
import { windowsSpawnEnv } from '../util/win-spawn'

export type PrereqBroadcast = (msg: WsMessage) => void

interface InstallerCommand {
  /** Pretty label for logs. */
  label: string
  /** Shell command line — executed via the user's default shell. */
  shell: string
}

/**
 * Returns the official installer command for `name` on the current platform.
 * Returns `null` for unsupported (name, platform) pairs — caller should treat
 * as "tell the user to install manually".
 */
function resolveInstallerCommand(name: string): InstallerCommand | null {
  if (name !== 'uv') return null
  if (process.platform === 'darwin' || process.platform === 'linux') {
    return {
      label: 'Astral uv installer (curl)',
      shell: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
    }
  }
  if (process.platform === 'win32') {
    // PowerShell installer is the cross-version path. winget would be nicer
    // but isn't always present. The Astral installer adds uv to PATH for the
    // user; the app's PATH augmentation on next start picks it up.
    return {
      label: 'Astral uv installer (PowerShell)',
      shell: 'powershell -ExecutionPolicy ByPass -NoProfile -Command "irm https://astral.sh/uv/install.ps1 | iex"',
    }
  }
  return null
}

export interface InstallPrereqResult {
  ok: boolean
  exitCode: number | null
  reason?: string
}

/**
 * Run the platform-appropriate installer for `name` and stream stdout+stderr
 * to `broadcast` as `plugin.prereq_install_progress` events. Resolves once the
 * child exits — never throws.
 */
export async function installPrerequisite(
  name: string,
  projectId: string,
  broadcast: PrereqBroadcast,
): Promise<InstallPrereqResult> {
  const cmd = resolveInstallerCommand(name)
  if (!cmd) {
    return { ok: false, exitCode: null, reason: `no installer for '${name}' on ${process.platform}` }
  }

  const log = (line: string) => {
    broadcast({
      type: 'plugin.prereq_install_progress',
      projectId,
      prereq: name,
      line,
      timestamp: new Date().toISOString(),
    } as WsMessage)
  }

  log(`Running: ${cmd.label}`)
  log(`> ${cmd.shell}`)

  // Escape hatch for tests that exercise the router but don't want a real
  // network installer to spawn. Set SPECRAILS_PREREQ_NOOP=1 to short-circuit.
  if (process.env.SPECRAILS_PREREQ_NOOP === '1') {
    log('(SPECRAILS_PREREQ_NOOP=1 — skipping real installer)')
    return { ok: true, exitCode: 0, reason: 'noop' }
  }

  return new Promise<InstallPrereqResult>((resolve) => {
    const isWin = process.platform === 'win32'
    // Use shell:true so pipes / irm / iex work. Inputs are not user-controlled.
    const child = spawn(cmd.shell, [], {
      shell: isWin ? 'powershell.exe' : true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // PowerShell needs SystemRoot/windir to start; backfill for a stripped env.
      env: windowsSpawnEnv(),
    })

    let settled = false
    const finish = (result: InstallPrereqResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    child.stdout?.on('data', (b) => { for (const line of b.toString().split(/\r?\n/)) if (line) log(line) })
    child.stderr?.on('data', (b) => { for (const line of b.toString().split(/\r?\n/)) if (line) log(line) })

    child.on('error', (err) => {
      log(`error: ${err.message}`)
      finish({ ok: false, exitCode: null, reason: err.message })
    })

    child.on('close', (code) => {
      if (code === 0) {
        log('Installer finished successfully.')
        finish({ ok: true, exitCode: 0 })
      } else {
        log(`Installer exited with code ${code}`)
        finish({ ok: false, exitCode: code, reason: `exit-code-${code}` })
      }
    })

    // Hard cap: 5 minutes. Long enough for slow networks, prevents hangs.
    setTimeout(() => {
      if (settled) return
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      log('Installer timed out after 5 minutes')
      finish({ ok: false, exitCode: null, reason: 'timeout' })
    }, 5 * 60 * 1000).unref?.()
  })
}
