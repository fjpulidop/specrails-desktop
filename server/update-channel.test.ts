import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { appUpdaterManifestUrl, isUpdateChannel, parseUpdateChannel } from './update-channel'
import { initDesktopDb, getUpdateChannel, setUpdateChannel, setDesktopSetting } from './desktop-db'

describe('update channel', () => {
  it('accepts only latest and stable, defaulting to latest', () => {
    expect(isUpdateChannel('latest')).toBe(true)
    expect(isUpdateChannel('stable')).toBe(true)
    for (const value of ['beta', '', null, undefined, 1]) {
      expect(isUpdateChannel(value)).toBe(false)
      expect(parseUpdateChannel(value)).toBe('latest')
    }
  })

  it('persists in desktop settings and refuses unknown values', () => {
    const db = initDesktopDb(':memory:')
    expect(getUpdateChannel(db)).toBe('latest')
    setUpdateChannel(db, 'stable')
    expect(getUpdateChannel(db)).toBe('stable')
    expect(() => setUpdateChannel(db, 'beta' as never)).toThrow(/latest|stable/)
    setDesktopSetting(db, 'update_channel', 'garbage')
    expect(getUpdateChannel(db)).toBe('latest')
  })

  it('selects one updater manifest per channel, matching the native updater and tauri.conf', () => {
    const latest = appUpdaterManifestUrl('latest')
    const stable = appUpdaterManifestUrl('stable')
    expect(latest).toBe('https://github.com/fjpulidop/specrails-desktop/releases/latest/download/latest.json')
    expect(stable).toBe('https://github.com/fjpulidop/specrails-desktop/releases/download/stable/latest.json')
    const root = path.join(__dirname, '..', 'src-tauri')
    const rust = fs.readFileSync(path.join(root, 'src', 'app_updates.rs'), 'utf8')
    expect(rust).toContain(`"${latest}"`)
    expect(rust).toContain(`"${stable}"`)
    const conf = JSON.parse(fs.readFileSync(path.join(root, 'tauri.conf.json'), 'utf8'))
    expect(conf.plugins.updater.endpoints).toEqual([latest])
  })
})
