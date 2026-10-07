import fs from 'node:fs'
import path from 'node:path'

import { findCoreAgentRuntimeCli, loadCoreAgentRuntime } from '../../agent-runtime/runtime/agent-runtime-loader'
import { parseCoreSessionsFlag, resolveCoreSessionsAvailability, type CoreSessionsAvailability } from '../domain/availability'
import { checkSessionContract, type SessionContractBlock } from '../domain/protocol'

/** Read `agentRuntime.sessions` from the selected Core package next to its runtime CLI. */
export function readSelectedSessionContract(cli = findCoreAgentRuntimeCli()): SessionContractBlock | null {
  if (!cli) return null
  const contract = path.resolve(path.dirname(cli), '..', '..', 'integration-contract.json')
  if (!fs.existsSync(contract)) return null
  try {
    return (JSON.parse(fs.readFileSync(contract, 'utf8')) as { agentRuntime?: { sessions?: SessionContractBlock } }).agentRuntime?.sessions ?? null
  } catch {
    return null
  }
}

/**
 * Decide once per call whether Core sessions are usable now. Any failure to
 * probe Core degrades to legacy transports with an explicit reason.
 */
export async function coreSessionsAvailability(env: NodeJS.ProcessEnv = process.env): Promise<CoreSessionsAvailability> {
  const flag = parseCoreSessionsFlag(env.SPECRAILS_CORE_SESSIONS)
  if (flag === 'off') return resolveCoreSessionsAvailability(flag, null)
  try {
    const runtime = await loadCoreAgentRuntime()
    const contract = checkSessionContract(readSelectedSessionContract())
    return resolveCoreSessionsAvailability(flag, runtime.api?.capabilities, contract.compatible)
  } catch (error) {
    return { enabled: false, flag, reason: `Core runtime probe failed: ${(error as Error).message}` }
  }
}
