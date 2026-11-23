import { describe, it, expect } from 'vitest'
import { isStaticFileCheck } from './static-check'

describe('isStaticFileCheck', () => {
  it('flags checks that only read file text (the live Unity case)', () => {
    expect(isStaticFileCheck(`python3 -c import pathlib; t = pathlib.Path('Assets/Scripts/Health.cs').read_text(); assert 'Heal(' in t`)).toBe(true)
    expect(isStaticFileCheck(`node -e const s=require('fs').readFileSync('index.html','utf8'); if(!s.includes('<title>')) process.exit(1)`)).toBe(true)
    expect(isStaticFileCheck('grep -q runs-on .github/workflows/ci.yml')).toBe(true)
    expect(isStaticFileCheck('/usr/bin/test -f docs/rollbacks.md')).toBe(true)
  })
  it('keeps real runs of the code as host commands', () => {
    expect(isStaticFileCheck('npm test')).toBe(false)
    expect(isStaticFileCheck('node --test')).toBe(false)
    expect(isStaticFileCheck('cargo test')).toBe(false)
    expect(isStaticFileCheck(`python3 -c from app.main import total; assert total([]) == 0`)).toBe(false)
    expect(isStaticFileCheck(`python3 -c import subprocess; open('x'); subprocess.run(['pytest'])`)).toBe(false)
    expect(isStaticFileCheck(`node -e require('./src/cart.js'); require('fs').readFileSync('x')`)).toBe(false)
    expect(isStaticFileCheck('python3 tests/check.py')).toBe(false)
    expect(isStaticFileCheck('')).toBe(false)
    expect(isStaticFileCheck(null)).toBe(false)
  })
})
