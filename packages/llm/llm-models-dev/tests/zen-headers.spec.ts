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
  it('stamps matching antoncode and opencode headers for an opencode route', () => {
    const headers = resolveZenHeaders('opencode-free', 'ses_test123')
    expect(headers['x-antoncode-session']).toBe('ses_test123')
    expect(headers['x-opencode-session']).toBe('ses_test123')
    expect(headers['x-antoncode-project']).toBe('global')
    expect(headers['x-opencode-project']).toBe('global')
    expect(headers['x-antoncode-client']).toBe('cli')
    expect(headers['x-opencode-client']).toBe('cli')
    expect(headers['x-antoncode-request']).toMatch(/^msg_/)
    expect(headers['x-opencode-request']).toBe(headers['x-antoncode-request'])
    expect(headers).not.toHaveProperty('user-agent')
    expect(headers).not.toHaveProperty('x-session-id')
  })

  it('honors OPENCODE_CLIENT like opencode itself', () => {
    vi.stubEnv('OPENCODE_CLIENT', 'web')
    const headers = resolveZenHeaders('opencode-free', 'ses_test123')
    expect(headers['x-antoncode-client']).toBe('web')
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

  it('sends nothing for non-opencode routes in the family', () => {
    expect(resolveZenHeaders('openrouter-free', 'ses_test123')).toEqual({})
  })
})
