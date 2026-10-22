import { describe, expect, it } from 'vitest'
import { claudeAdapter, codexAdapter, geminiAdapter, kimiAdapter } from '.'
import { createLocalAdapter } from './local-adapter'
import { providerEnvAllowlist } from './runtime'
import { buildAgentEnv } from '../modules/execution'

const SOURCE: NodeJS.ProcessEnv = {
  PATH: '/bin',
  ANTHROPIC_API_KEY: 'a', ANTHROPIC_BASE_URL: 'b', CLAUDE_CONFIG_DIR: 'c', CLAUDE_CODE_USE_BEDROCK: 'd',
  CODEX_HOME: 'e', OPENAI_API_KEY: 'f', OPENAI_BASE_URL: 'g',
  GEMINI_API_KEY: 'h', GOOGLE_API_KEY: 'i', GOOGLE_CLOUD_PROJECT: 'j', GOOGLE_APPLICATION_CREDENTIALS: 'k',
  KIMI_SHELL_PATH: 'l', MOONSHOT_API_KEY: 'm',
  LOCAL_LLM_KEY: 'n', UNRELATED_SECRET: 'o',
}
const passed = (allowlist: readonly string[]) =>
  Object.keys(buildAgentEnv({ mode: 'minimal', sourceEnv: SOURCE, passthrough: {}, providerAllowlist: allowlist, platform: 'darwin' })).sort()

describe('provider envAllowlist (minimal agent environment)', () => {
  it('claude: Anthropic auth, config dir and CLI knobs only', () => {
    expect(passed(providerEnvAllowlist(claudeAdapter))).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CONFIG_DIR', 'PATH'])
  })
  it('codex: CODEX_HOME and OpenAI auth only', () => {
    expect(passed(providerEnvAllowlist(codexAdapter))).toEqual(['CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'PATH'])
  })
  it('gemini: Gemini and Google auth only', () => {
    expect(passed(providerEnvAllowlist(geminiAdapter))).toEqual(['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'PATH'])
  })
  it('kimi: Kimi config and Moonshot auth only', () => {
    expect(passed(providerEnvAllowlist(kimiAdapter))).toEqual(['KIMI_SHELL_PATH', 'MOONSHOT_API_KEY', 'PATH'])
  })
  it('local: only the API-key variable its connection names', () => {
    const local = createLocalAdapter({ id: 'local-test', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1', apiKeyEnv: 'LOCAL_LLM_KEY' })
    expect(passed(providerEnvAllowlist(local))).toEqual(['LOCAL_LLM_KEY', 'PATH'])
    const keyless = createLocalAdapter({ id: 'local-free', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1' })
    expect(passed(providerEnvAllowlist(keyless))).toEqual(['PATH'])
  })
  it('the union of several adapters is deduplicated', () => {
    const union = providerEnvAllowlist([claudeAdapter, codexAdapter, claudeAdapter])
    expect(new Set(union).size).toBe(union.length)
    expect(union).toEqual(expect.arrayContaining(['ANTHROPIC_*', 'CODEX_*']))
  })
})
