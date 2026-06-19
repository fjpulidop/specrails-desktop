import { describe, it, expect } from 'vitest'
import { compareVersions, isNewer, isValidVersion } from './semver-lite'

describe('semver-lite', () => {
  describe('compareVersions', () => {
    it('orders by major, minor, patch', () => {
      expect(compareVersions('1.0.0', '2.0.0')).toBe(-1)
      expect(compareVersions('2.0.0', '1.0.0')).toBe(1)
      expect(compareVersions('1.2.0', '1.3.0')).toBe(-1)
      expect(compareVersions('1.2.3', '1.2.4')).toBe(-1)
      expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
      expect(compareVersions('4.9.0', '4.8.2')).toBe(1)
    })

    it('treats a prerelease as lower than the released version', () => {
      expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1)
      expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1)
    })

    it('compares prerelease identifiers per semver §11', () => {
      expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1) // shorter set lower
      expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2')).toBe(-1) // numeric
      expect(compareVersions('1.0.0-alpha.1', '1.0.0-beta')).toBe(-1) // numeric < non-numeric
      expect(compareVersions('1.0.0-beta', '1.0.0-alpha')).toBe(1) // lexical
      expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.1')).toBe(0)
    })

    it('tolerates leading v/= and whitespace, ignores build metadata', () => {
      expect(compareVersions(' v1.2.3 ', '=1.2.3')).toBe(0)
      expect(compareVersions('1.2.3+build.5', '1.2.3+build.9')).toBe(0)
    })

    it('treats unparseable input as 0.0.0', () => {
      expect(compareVersions('garbage', '0.0.0')).toBe(0)
      expect(compareVersions('1.0.0', 'nope')).toBe(1)
      // partial versions fill missing parts with 0
      expect(compareVersions('1', '1.0.0')).toBe(0)
      expect(compareVersions('1.2', '1.2.0')).toBe(0)
    })
  })

  describe('isNewer', () => {
    it('is true only when strictly greater', () => {
      expect(isNewer('4.9.0', '4.8.0')).toBe(true)
      expect(isNewer('4.8.0', '4.8.0')).toBe(false)
      expect(isNewer('4.7.0', '4.8.0')).toBe(false)
      expect(isNewer('5.0.0', '4.9.9')).toBe(true)
    })
  })

  describe('isValidVersion', () => {
    it('accepts well-formed versions', () => {
      expect(isValidVersion('1.2.3')).toBe(true)
      expect(isValidVersion('v4.8.0')).toBe(true)
      expect(isValidVersion('1.2.3-rc.1')).toBe(true)
      expect(isValidVersion('1.2.3+build')).toBe(true)
    })
    it('rejects malformed versions', () => {
      expect(isValidVersion('1.2')).toBe(false)
      expect(isValidVersion('latest')).toBe(false)
      expect(isValidVersion('')).toBe(false)
      expect(isValidVersion('x.y.z')).toBe(false)
    })
  })
})
