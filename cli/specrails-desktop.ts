#!/usr/bin/env node
import { parseArgs, DEFAULT_PORT } from './args'
import { printVersion, printHelp } from './help'
import { handleStatus, handleJobs } from './status'
import { handleDesktop, desktopStart, desktopStop, desktopStatus, desktopAdd, desktopRemove, desktopList, desktopServerPath, isPortInUse, readPid, isProcessRunning, DESKTOP_PID_FILE, DESKTOP_LOG_FILE } from './desktop-control'
import { cliLog, cliError, ansi, dim, red, bold, dimCyan, cliPrefix, cliWarn, isTTY } from './output'
import { detectWebManager, httpGet, httpPost, DETECTION_TIMEOUT_MS, HTTP_REQUEST_TIMEOUT_MS } from './desktop-client'
import { runViaWebManager, runDirect, resolveProjectFromCwd, EXIT_PATTERN } from './run-command'
import { formatJobDuration, formatJobStarted } from './format'
export { KNOWN_VERBS } from './args'
export { type ParsedArgs } from './args'
export { parseArgs } from './args'
export { getVersion } from './help'
export { type DetectionResult } from './desktop-client'
export { detectWebManager } from './desktop-client'
export { formatDuration } from './format'
export { formatTokens } from './format'
export { type SummaryData } from './output'
export { printSummary } from './output'


// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const parsed = parseArgs(argv)

  if (parsed.mode === 'version') {
    printVersion()
    process.exit(0)
  }

  if (parsed.mode === 'help') {
    printHelp()
    process.exit(0)
  }

  if (parsed.mode === 'status') {
    const code = await handleStatus(parsed.port)
    process.exit(code)
  }

  if (parsed.mode === 'jobs') {
    const code = await handleJobs(parsed.port)
    process.exit(code)
  }

  if (parsed.mode === 'desktop') {
    const code = await handleDesktop(parsed.subArgs, parsed.port)
    process.exit(code)
  }

  // Command or raw: resolve command string
  const command = parsed.resolved
  const port = parsed.port

  cliLog(`running: ${command}`)

  const detection = await detectWebManager(port)

  let exitCode: number

  const projectOverride = (parsed.mode === 'command' || parsed.mode === 'raw') ? parsed.projectOverride : undefined

  if (detection.running) {
    cliLog(`routing via manager at ${detection.baseUrl}`)
    exitCode = await runViaWebManager(command, detection.baseUrl, projectOverride)
  } else {
    cliLog('manager not running — invoking claude directly')
    exitCode = await runDirect(command)
  }

  process.exit(exitCode)
}


// Only run main() when this file is executed directly (not when imported in tests)
if (require.main === module) {
  main().catch((err: unknown) => {
    cliError((err as Error).message ?? String(err))
    process.exit(1)
  })
}


// ---------------------------------------------------------------------------
// Test-only exports — not part of the public API
// ---------------------------------------------------------------------------

export const _internal = {
  ansi, dim, red, bold, dimCyan, cliPrefix, cliLog, cliError, cliWarn,
  httpGet, httpPost, formatJobDuration, formatJobStarted, printVersion, printHelp,
  handleStatus, handleJobs, handleDesktop, desktopStart, desktopStop, desktopStatus, desktopAdd, desktopRemove, desktopList, desktopServerPath,
  resolveProjectFromCwd, runViaWebManager, runDirect, isPortInUse, readPid, isProcessRunning, main,
  isTTY, DESKTOP_PID_FILE, DESKTOP_LOG_FILE, EXIT_PATTERN, DEFAULT_PORT, DETECTION_TIMEOUT_MS, HTTP_REQUEST_TIMEOUT_MS,
}
