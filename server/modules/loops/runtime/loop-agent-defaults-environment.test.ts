import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultLoopAgents } from './loop-agents'
import { validateLoopRuntimeSettings } from '../../agent-runtime/runtime/agent-runtime-settings'

/** Shared wording with Core `prompts.ts` (builtin developer step 4 / boundaries, fixer step 7). Keep both in sync verbatim. */
export const CORE_ENVIRONMENT_RULES = {
  developerBypass: "Never validate with a temporary configuration, alternate runner or local browser the host verification plan does not use, and never delete such a file to hide it: the host runs the plan as-is. When a required tool is missing, install it through the project's documented command or report it as a blocker.",
  toolchainInstall: 'Installing a documented, idempotent toolchain artifact inside the admitted workspace (for example a Playwright browser with `npx playwright install <browser>`, or a Python virtualenv) is allowed and must be reported under verification; editing package-manager, registry, credential, CI or environment configuration remains forbidden.',
  fixerBlocker: 'When the diagnosed cause is a host precondition or environment blocker (missing network, credentials, environment variable, toolchain, setup command or an out-of-scope repository), make no speculative edits, state in summary that the candidate was intentionally left unchanged, and return `blocker` as {"kind":"network|credential|environment-variable|toolchain|setup|environment|scope","command":"…","cwd":"…","evidence":"exact error","requiredAction":"one imperative sentence the host can act on"}.',
} as const

describe('loop role defaults: environment blockers', () => {
  const prompts = defaultLoopAgents().rolePrompts!
  it('developer forbids temporary verification bypasses and installs or reports a missing tool', () => {
    expect(prompts.developer).toContain(CORE_ENVIRONMENT_RULES.developerBypass)
    expect(prompts.developer).toContain(CORE_ENVIRONMENT_RULES.toolchainInstall)
    expect(prompts.developer).toContain('never edit package-manager, registry, credential, CI or environment configuration')
  })
  it('fixer returns the structured blocker, leaves the candidate unchanged on purpose and may install documented toolchain artifacts', () => {
    expect(prompts.fixer).toContain(CORE_ENVIRONMENT_RULES.fixerBlocker)
    expect(prompts.fixer).toContain(CORE_ENVIRONMENT_RULES.toolchainInstall)
    expect(prompts.fixer).toContain('Never edit outside the admitted repository/workspace, credentials, environment or unrelated configuration.')
    for (const kind of ['network', 'credential', 'environment-variable', 'toolchain', 'setup', 'environment', 'scope']) expect(prompts.fixer).toContain(kind)
  })
  it('lengthened defaults remain valid loop agent settings', () => {
    expect(() => validateLoopRuntimeSettings(defaultLoopAgents())).not.toThrow()
    for (const text of Object.values(prompts)) expect(text.length).toBeLessThanOrEqual(20_000)
  })
  it('matches the Core builtin sentences verbatim when the paired Core source is checked out beside this repository', () => {
    const source = join(process.cwd(), '..', 'specrails-core', 'src', 'agent-runtime', 'prompts.ts')
    if (!existsSync(source)) return
    const text = readFileSync(source, 'utf8')
    for (const sentence of Object.values(CORE_ENVIRONMENT_RULES)) expect(text).toContain(sentence.replace(/'/g, "\\'"))
  })
})
