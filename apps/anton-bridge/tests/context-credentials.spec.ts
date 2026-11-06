import { describe, expect, it } from 'vitest'
import { credentialRef } from '../src/context-credentials.ts'

/** The live layout: a versioned document with references under `refs`. */
const versioned = [
  '# Anton credentials. The harness reads this file, never edits it.',
  'version: 1',
  'refs:',
  '  DEEPSEEK_API_KEY: sk-other',
  '  ANTON_CONTEXT_API_KEY: ctx_fixture0000000000000000000000abcd',
  'records:',
  '  deepseek-account-platform/default:',
  '    kind: grant',
  '    payload:',
  '      token: not-a-reference',
  '',
].join('\n')

describe('credentialRef', () => {
  it('reads a reference nested under refs', () => {
    expect(credentialRef(versioned, 'ANTON_CONTEXT_API_KEY')).toBe('ctx_fixture0000000000000000000000abcd')
  })

  it('still reads the flat document earlier builds wrote', () => {
    expect(credentialRef('DEEPSEEK_API_KEY: sk-flat\nANTON_CONTEXT_API_KEY: ctx_flat\n', 'ANTON_CONTEXT_API_KEY')).toBe('ctx_flat')
  })

  it('unquotes a value and drops a trailing comment', () => {
    expect(credentialRef("refs:\n  ANTON_CONTEXT_API_KEY: 'ctx_quoted'\n", 'ANTON_CONTEXT_API_KEY')).toBe('ctx_quoted')
    expect(credentialRef('refs:\n  ANTON_CONTEXT_API_KEY: ctx_plain # engine key\n', 'ANTON_CONTEXT_API_KEY')).toBe('ctx_plain')
  })

  it('answers empty for an absent, empty, or unrelated reference', () => {
    expect(credentialRef(versioned, 'MISSING_KEY')).toBe('')
    expect(credentialRef('refs:\n  ANTON_CONTEXT_API_KEY:\n', 'ANTON_CONTEXT_API_KEY')).toBe('')
    expect(credentialRef(versioned, 'DEEPSEEK_API_KEY')).toBe('sk-other')
  })
})
