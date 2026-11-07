import { describe, expect, it } from 'vitest'
import {
  isDesktopPath,
  isLoopbackAuthority,
  LAN_COOKIE,
  lanChallengeResponse,
  lanCookie,
  lanDecision,
  lanTokenFromCookies,
  readLanAccess,
  tokensMatch,
} from '../src/lan-access.ts'

const enabled = { enabled: true, token: 'lan-token-0123456789' }

/** Build a request the way a remote browser would. */
function lanRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`http://192.168.1.20:3742${path}`, init)
}

describe('readLanAccess', () => {
  it('stays disabled when nothing enables it', () => {
    expect(readLanAccess({}, {})).toEqual({ enabled: false, token: '' })
    expect(readLanAccess(null, {})).toEqual({ enabled: false, token: '' })
  })

  it('reads the document and lets the environment win', () => {
    expect(readLanAccess({ lanAccess: { enabled: true, token: 'from-document-1234' } }, {}))
      .toEqual({ enabled: true, token: 'from-document-1234' })
    expect(readLanAccess({ lanAccess: { enabled: true, token: 'from-document-1234' } }, { ANTON_BRIDGE_LAN_TOKEN: 'from-env-12345678' }))
      .toEqual({ enabled: true, token: 'from-env-12345678' })
    expect(readLanAccess({ lanAccess: { enabled: false } }, { ANTON_BRIDGE_LAN: '1', ANTON_BRIDGE_LAN_TOKEN: 'env-token-123456' }))
      .toEqual({ enabled: true, token: 'env-token-123456' })
  })

  it('refuses to open the door without a usable token', () => {
    expect(() => readLanAccess({ lanAccess: { enabled: true } }, {})).toThrow(/at least 16 characters/)
    expect(() => readLanAccess({}, { ANTON_BRIDGE_LAN: 'true', ANTON_BRIDGE_LAN_TOKEN: 'short' })).toThrow(/at least 16 characters/)
  })
})

describe('token handling', () => {
  it('compares tokens without an identity shortcut', () => {
    expect(tokensMatch('lan-token-0123456789', enabled.token)).toBe(true)
    expect(tokensMatch('lan-token-012345678', enabled.token)).toBe(false)
    expect(tokensMatch('', enabled.token)).toBe(false)
    // An empty configured token never matches, so a mis-read config cannot open the door.
    expect(tokensMatch('', '')).toBe(false)
  })

  it('round-trips the cookie', () => {
    const header = lanCookie(enabled.token)
    expect(header).toContain(`${LAN_COOKIE}=`)
    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Lax')
    expect(lanTokenFromCookies(`other=1; ${header.split(';')[0]}; another=2`)).toBe(enabled.token)
    expect(lanTokenFromCookies(null)).toBe('')
    expect(lanTokenFromCookies('other=1')).toBe('')
    expect(lanTokenFromCookies(`${LAN_COOKIE}=%E0%A4%A`)).toBe('')
  })
})

describe('lanDecision', () => {
  it('leaves every loopback authority ungated', () => {
    for (const host of ['127.0.0.1', 'localhost', 'antoncode.localhost', '[::1]']) {
      expect(isLoopbackAuthority(host)).toBe(true)
      expect(lanDecision(new Request(`http://${host}:3742/`), { enabled: false, token: '' })).toEqual({ kind: 'local' })
    }
    expect(isLoopbackAuthority('192.168.1.20')).toBe(false)
  })

  it('denies a remote client when access is disabled', () => {
    expect(lanDecision(lanRequest('/'), { enabled: false, token: '' })).toEqual({ kind: 'denied' })
  })

  it('challenges a navigation carrying the token and grants the cookie afterwards', () => {
    expect(lanDecision(lanRequest(`/?token=${enabled.token}`), enabled)).toEqual({ kind: 'challenge' })
    expect(lanDecision(lanRequest('/', { headers: { cookie: lanCookie(enabled.token).split(';')[0] ?? '' } }), enabled))
      .toEqual({ kind: 'granted' })
  })

  it('denies a wrong or absent token, and never forms a write from a query token', () => {
    expect(lanDecision(lanRequest('/'), enabled)).toEqual({ kind: 'denied' })
    expect(lanDecision(lanRequest('/?token=wrong-token-000000'), enabled)).toEqual({ kind: 'denied' })
    expect(lanDecision(lanRequest(`/?token=${enabled.token}`, { method: 'POST' }), enabled)).toEqual({ kind: 'denied' })
    expect(lanDecision(lanRequest('/api/remote', { headers: { cookie: 'other=1' } }), enabled)).toEqual({ kind: 'denied' })
  })
})

describe('desktop surface', () => {
  it('keeps control paths off the network', () => {
    expect(isDesktopPath('/bridge')).toBe(true)
    expect(isDesktopPath('/bridge/')).toBe(true)
    expect(isDesktopPath('/bridge/api/harness/restart')).toBe(true)
    expect(isDesktopPath('/')).toBe(false)
    expect(isDesktopPath('/bridgewater')).toBe(false)
  })
})

describe('lanChallengeResponse', () => {
  it('redirects without the token and sets the cookie', async () => {
    const response = lanChallengeResponse(lanRequest(`/session/abc?token=${enabled.token}&keep=1`), enabled)
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/session/abc?keep=1')
    expect(response.headers.get('set-cookie')).toContain(`${LAN_COOKIE}=`)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await response.body?.cancel()
  })
})
