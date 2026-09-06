import { afterEach, describe, expect, it } from 'vitest'
import type { ConfigEnv, UserConfig } from 'vite'
import config from '../../../vite.config'

const ORIGINAL_SERVER_PORT = process.env.SPECRAILS_DEV_SERVER_PORT
const ORIGINAL_CLIENT_PORT = process.env.SPECRAILS_DEV_CLIENT_PORT
const ORIGINAL_PORT = process.env.SPECRAILS_PORT

function resolveConfig(mode = 'development'): UserConfig {
  const factory = config as (env: ConfigEnv) => UserConfig
  return factory({ mode, command: 'serve', isSsrBuild: false, isPreview: false })
}

function serverConfig(cfg: UserConfig): { port?: number; proxy?: Record<string, string> } {
  return cfg.server as { port?: number; proxy?: Record<string, string> }
}

afterEach(() => {
  if (ORIGINAL_PORT === undefined) delete process.env.SPECRAILS_PORT
  else process.env.SPECRAILS_PORT = ORIGINAL_PORT
  if (ORIGINAL_SERVER_PORT === undefined) delete process.env.SPECRAILS_DEV_SERVER_PORT
  else process.env.SPECRAILS_DEV_SERVER_PORT = ORIGINAL_SERVER_PORT
  if (ORIGINAL_CLIENT_PORT === undefined) delete process.env.SPECRAILS_DEV_CLIENT_PORT
  else process.env.SPECRAILS_DEV_CLIENT_PORT = ORIGINAL_CLIENT_PORT
})

describe('vite dev port config', () => {
  it('preserves the default web dev ports', () => {
    delete process.env.SPECRAILS_DEV_SERVER_PORT
    delete process.env.SPECRAILS_DEV_CLIENT_PORT
    delete process.env.SPECRAILS_PORT

    const cfg = resolveConfig()
    expect(serverConfig(cfg).port).toBe(4201)
    expect(cfg.server?.strictPort).toBe(true)
    expect(serverConfig(cfg).proxy).toEqual({
      '/api': 'http://127.0.0.1:4200',
      '/hooks': 'http://127.0.0.1:4200',
    })
    expect((cfg.define as Record<string, string>).__WS_URL__).toBe(JSON.stringify('ws://127.0.0.1:4200'))
  })

  it('uses SPECRAILS_DEV_SERVER_PORT and SPECRAILS_DEV_CLIENT_PORT for web dev', () => {
    process.env.SPECRAILS_DEV_SERVER_PORT = '4300'
    process.env.SPECRAILS_DEV_CLIENT_PORT = '4301'

    const cfg = resolveConfig()
    expect(serverConfig(cfg).port).toBe(4301)
    expect(serverConfig(cfg).proxy).toEqual({
      '/api': 'http://127.0.0.1:4300',
      '/hooks': 'http://127.0.0.1:4300',
    })
    expect((cfg.define as Record<string, string>).__WS_URL__).toBe(JSON.stringify('ws://127.0.0.1:4300'))
  })

  it('keeps production builds from injecting a dev websocket URL', () => {
    process.env.SPECRAILS_DEV_SERVER_PORT = '4300'
    const cfg = resolveConfig('production')
    expect((cfg.define as Record<string, string>).__WS_URL__).toBe(JSON.stringify(''))
    expect((cfg.define as Record<string, string>).__API_ORIGIN__).toBe(JSON.stringify(''))
  })
})
