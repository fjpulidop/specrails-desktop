import { describe, expect, it } from 'vitest'
import {
  CUSTOM_MODEL_ALIAS_MAX_LENGTH,
  isSafeCustomModelAlias,
} from '../model-alias'

describe('custom model alias contract', () => {
  it.each([
    'k3',
    'kimi-code/k3',
    'moonshot-team/private-coder:v2',
    'Private_Coder-2.1',
    `a${'b'.repeat(CUSTOM_MODEL_ALIAS_MAX_LENGTH - 1)}`,
  ])('accepts a CLI-safe alias byte-for-byte: %s', (alias) => {
    expect(isSafeCustomModelAlias(alias)).toBe(true)
  })

  it.each([
    '',
    '--yolo',
    '-m',
    ' moonshot-team/private-coder',
    'moonshot team/private-coder',
    'moonshot-team/private-coder\n--yolo',
    'moonshot-team/"private-coder"',
    'moonshot-team/$MODEL',
    `a${'b'.repeat(CUSTOM_MODEL_ALIAS_MAX_LENGTH)}`,
  ])('rejects an alias that could alter CLI argument semantics: %j', (alias) => {
    expect(isSafeCustomModelAlias(alias)).toBe(false)
  })
})
