/**
 * Guards for the Zen client headers: the route stamps the same session facts
 * antoncode-ui's opencode provider sends, under both the fork (`x-antoncode-*`)
 * and upstream (`x-opencode-*`) names, scoped to `opencode*` routes only.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveZenHeaders } from '@deepseek-ai/dsh-llm-models-dev'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('resolveZenHeaders', () => {
  it('stamps OpenCode identity headers for an opencode route', () => {
    const headers = resolveZenHeaders('opencode-free', 'ses_test123')
    expect(headers['x-opencode-session']).toBe('ses_test123')
    expect(headers['x-opencode-client']).toBe('cli')
    expect(headers['x-opencode-session-id']).toBe('ses_test123')
    expect(headers['user-agent']).toBe('opencode/harness')
    expect(headers['x-opencode-request']).toMatch(/^msg_/)
    expect(headers).not.toHaveProperty('x-opencode-project')
    expect(headers).not.toHaveProperty('x-session-id')
  })

  it('honors OPENCODE_CLIENT like opencode itself', () => {
    vi.stubEnv('OPENCODE_CLIENT', 'web')
    const headers = resolveZenHeaders('opencode-free', 'ses_test123')
    expect(headers['x-opencode-client']).toBe('web')
  })

  it('falls back to a stable session id when the request carries none', () => {
    const first = resolveZenHeaders('opencode-free', undefined)
    const second = resolveZenHeaders('opencode-free', undefined)
    expect(first['x-opencode-session']).toBe(second['x-opencode-session'])
    expect(first['x-opencode-session']).not.toBe('')
  })

  it('issues a fresh request id per call', () => {
    const first = resolveZenHeaders('opencode-free', 'ses_test123')
    const second = resolveZenHeaders('opencode-free', 'ses_test123')
    expect(first['x-opencode-request']).not.toBe(second['x-opencode-request'])
  })

  it('uses the assembled user message id as the OpenCode request id', () => {
    const headers = resolveZenHeaders('opencode-free', 'ses_test123', 'msg_user123')
    expect(headers['x-opencode-request']).toBe('msg_user123')
  })

  it('sends nothing for non-opencode routes in the family', () => {
    expect(resolveZenHeaders('openrouter-free', 'ses_test123')).toEqual({})
  })
})
