import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DEV_CLIENT_PORT,
  DEFAULT_DEV_SERVER_PORT,
  parseDevPort,
  resolveServerPort,
  resolveWebDevPorts,
} from './dev-ports'

describe('dev port resolution', () => {
  it('parses only positive integer TCP ports', () => {
    expect(parseDevPort('4300', 4200)).toBe(4300)
    expect(parseDevPort('0', 4200)).toBe(4200)
    expect(parseDevPort('-1', 4200)).toBe(4200)
    expect(parseDevPort('abc', 4200)).toBe(4200)
    expect(parseDevPort('65536', 4200)).toBe(4200)
    expect(parseDevPort(undefined, 4200)).toBe(4200)
  })

  it('resolves the server port from env with legacy fallback', () => {
    expect(resolveServerPort(['node', 'server'], {})).toBe(DEFAULT_DEV_SERVER_PORT)
    expect(resolveServerPort(['node', 'server'], { SPECRAILS_PORT: '4250' })).toBe(4250)
    expect(resolveServerPort(['node', 'server'], { SPECRAILS_PORT: '4250', SPECRAILS_DEV_SERVER_PORT: '4300' })).toBe(4300)
  })

  it('keeps --port above env defaults', () => {
    expect(resolveServerPort(['node', 'server', '--port', '4400'], { SPECRAILS_DEV_SERVER_PORT: '4300' })).toBe(4400)
    expect(resolveServerPort(['node', 'server', '--port', 'bad'], { SPECRAILS_DEV_SERVER_PORT: '4300' })).toBe(4300)
  })

  it('resolves the web dev frontend/backend pair', () => {
    expect(resolveWebDevPorts({})).toEqual({
      serverPort: DEFAULT_DEV_SERVER_PORT,
      clientPort: DEFAULT_DEV_CLIENT_PORT,
      serverOrigin: 'http://localhost:4200',
      wsUrl: 'ws://localhost:4200',
    })
    expect(resolveWebDevPorts({ SPECRAILS_DEV_SERVER_PORT: '4300', SPECRAILS_DEV_CLIENT_PORT: '4301' })).toEqual({
      serverPort: 4300,
      clientPort: 4301,
      serverOrigin: 'http://localhost:4300',
      wsUrl: 'ws://localhost:4300',
    })
  })
})
