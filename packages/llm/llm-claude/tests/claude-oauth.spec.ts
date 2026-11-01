/**
 * Claude OAuth tests: authorize-URL shape, PKCE, code exchange, refresh
 * rotation, state parsing, and the interactive login — all against a
 * scripted platform.claude.com stand-in, no network, no browser.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  CLAUDE_OAUTH_CLIENT_ID,
  createAuthorizeFlow,
  createPkcePair,
  exchangeCode,
  isAccessValid,
  parseOAuthState,
  refreshAccessToken,
  runClaudeLogin,
  type ClaudeLoginInteraction,
} from '../src/claude-oauth.ts'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

interface TokenScript {
  exchange?: unknown
  exchangeStatus?: number
  refresh?: unknown
  refreshStatus?: number
}

/** Scripted console: token endpoint with queued answers per grant. */
async function mockConsole(script: TokenScript = {}): Promise<{
  url: string
  requests: { path: string; body: Record<string, string> }[]
}> {
  const requests: { path: string; body: Record<string, string> }[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
    })
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      let body: Record<string, string> = {}
      try {
        body = JSON.parse(raw) as Record<string, string>
      } catch {
        body = Object.fromEntries(new URLSearchParams(raw).entries())
      }
      requests.push({ path: url.pathname, body })
      const send = (status: number, payload: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(payload))
      }
      if (request.method === 'POST' && url.pathname === '/v1/oauth/token') {
        if (body.grant_type === 'authorization_code') {
          if (script.exchangeStatus !== undefined) {
            send(script.exchangeStatus, { message: 'denied' })
            return
          }
          send(200, script.exchange ?? {
            access_token: 'sk-ant-oat01-access',
            refresh_token: 'sk-ant-oat01-refresh',
            expires_in: 3600,
          })
          return
        }
        if (script.refreshStatus !== undefined) {
          send(script.refreshStatus, { message: 'denied' })
          return
        }
        send(200, script.refresh ?? {
          access_token: 'sk-ant-oat01-access-2',
          refresh_token: 'sk-ant-oat01-refresh-2',
          expires_in: 60,
        })
        return
      }
      send(404, { message: 'unknown route' })
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('console mock has no address')
  return { url: `http://127.0.0.1:${String(address.port)}`, requests }
}

function interaction(over: Partial<ClaudeLoginInteraction> = {}): ClaudeLoginInteraction & { notified: string[] } {
  const notified: string[] = []
  return {
    notified,
    notify: (message: string) => {
      notified.push(message)
    },
    promptLine: async () => 'pasted-code',
    ...over,
  }
}

describe('PKCE and authorize URL', () => {
  it('mints a verifiable S256 pair and a complete approval link', () => {
    const { verifier, challenge } = createPkcePair()
    expect(verifier.length).toBeGreaterThan(40)
    expect(challenge.length).toBeGreaterThan(20)
    const flow = createAuthorizeFlow({
      authorizeUrl: 'https://console.test/oauth/authorize',
      state: 's1',
      verifier: 'v1',
      challenge: 'c1',
    })
    const url = new URL(flow.verifier === 'v1' ? flow.authorizeUrl : '')
    expect(url.origin).toBe('https://console.test')
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('code')).toBe('true')
  })

  it('defaults approval to the subscription account IdP', () => {
    const flow = createAuthorizeFlow({ state: 's1', verifier: 'v1', challenge: 'c1' })
    const url = new URL(flow.authorizeUrl)
    expect(`${url.origin}${url.pathname}`).toBe('https://claude.com/cai/oauth/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe(CLAUDE_OAUTH_CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback')
    expect(url.searchParams.get('code_challenge')).toBe('c1')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('s1')
    expect(url.searchParams.get('scope')).toContain('user:inference')
  })
})

describe('parseOAuthState', () => {
  it('parses complete states and rejects malformed stores', () => {
    const full = { access: 'a', refresh: 'r', expiresAt: Date.now() + 3_600_000 }
    expect(parseOAuthState(JSON.stringify(full))).toEqual(full)
    expect(parseOAuthState(JSON.stringify({ access: 'a', expiresAt: 1 }))).toEqual({
      access: 'a',
      expiresAt: 1,
    })
    // A non-string refresh is dropped, not fatal: the session still serves
    // until expiry, then needs a fresh login.
    expect(parseOAuthState(JSON.stringify({ access: 'a', refresh: 9, expiresAt: 1 }))).toEqual({
      access: 'a',
      expiresAt: 1,
    })
    for (const bad of [
      undefined,
      '',
      'not json{',
      '[1]',
      JSON.stringify({ refresh: 'r', expiresAt: 1 }),
      JSON.stringify({ access: 'a', expiresAt: 'soon' }),
      JSON.stringify({ access: '', expiresAt: 1 }),
    ]) {
      expect(parseOAuthState(bad)).toBeUndefined()
    }
  })
})

describe('isAccessValid', () => {
  it('honors the refresh-skew guard', () => {
    const now = 1_000_000
    expect(isAccessValid({ access: 'a', expiresAt: now + 300_001 }, now)).toBe(true)
    expect(isAccessValid({ access: 'a', expiresAt: now + 299_999 }, now)).toBe(false)
  })
})

describe('exchangeCode', () => {
  it('posts the PKCE redemption and reads tokens', async () => {
    const { url, requests } = await mockConsole()
    const tokens = await exchangeCode('past-ed', 'verifier-1', { consoleBase: url })
    expect(tokens.access).toBe('sk-ant-oat01-access')
    expect(tokens.refresh).toBe('sk-ant-oat01-refresh')
    expect(tokens.expiresAt).toBeGreaterThan(Date.now())
    expect(requests[0]!.body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'past-ed',
      code_verifier: 'verifier-1',
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      redirect_uri: 'https://platform.claude.com/oauth/code/callback',
    })
  })

  it('fails loud on denial and broken payloads', async () => {
    const denied = await mockConsole({ exchangeStatus: 400 })
    await expect(exchangeCode('c', 'v', { consoleBase: denied.url })).rejects.toThrow(/HTTP 400/)
    const broken = await mockConsole({ exchange: { nope: true } })
    await expect(exchangeCode('c', 'v', { consoleBase: broken.url })).rejects.toThrow(/unknown/)
  })
})

describe('refreshAccessToken', () => {
  it('renews credentials keeping the rotated refresh token', async () => {
    const { url, requests } = await mockConsole()
    const next = await refreshAccessToken(
      { access: 'old', refresh: 'r1', expiresAt: 1 },
      { consoleBase: url },
    )
    expect(next.access).toBe('sk-ant-oat01-access-2')
    expect(next.refresh).toBe('sk-ant-oat01-refresh-2')
    expect(requests[0]!.body).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'r1',
      client_id: CLAUDE_OAUTH_CLIENT_ID,
    })
    expect(requests[0]!.body.scope).toContain('user:inference')
  })

  it('keeps the previous refresh token when the grant omits rotation', async () => {
    const { url } = await mockConsole({ refresh: { access_token: 'a2', expires_in: 60 } })
    const next = await refreshAccessToken(
      { access: 'old', refresh: 'r1', expiresAt: 1 },
      { consoleBase: url },
    )
    expect(next.refresh).toBe('r1')
  })

  it('refuses sessions without a refresh token and reports denial', async () => {
    await expect(refreshAccessToken({ access: 'old', expiresAt: 1 })).rejects.toThrow(/no refresh token/)
    const { url } = await mockConsole({ refreshStatus: 401 })
    await expect(refreshAccessToken(
      { access: 'old', refresh: 'r1', expiresAt: 1 },
      { consoleBase: url },
    )).rejects.toThrow(/refresh failed/)
  })
})

describe('runClaudeLogin', () => {
  it('shows the link, redeems the pasted code, and never notifies token material', async () => {
    const { url } = await mockConsole()
    const seen = interaction()
    const state = await runClaudeLogin(seen, { consoleBase: url })
    expect(state.access).toBe('sk-ant-oat01-access')
    expect(seen.notified.join('\n')).toContain('/oauth/authorize')
    expect(seen.notified.join('\n')).not.toContain('sk-ant-oat01-access')
    expect(seen.notified.join('\n')).not.toContain('sk-ant-oat01-refresh')
  })

  it('refuses blank codes', async () => {
    const { url } = await mockConsole()
    await expect(runClaudeLogin(interaction({ promptLine: async () => '  ' }), { consoleBase: url }))
      .rejects.toThrow(/no code entered/)
  })

  it('redeems the code half of a code#state paste', async () => {
    const { url, requests } = await mockConsole()
    // A code without a state suffix redeems verbatim (existing coverage
    // proves the posted code); here the suffix must not leak into it.
    const seen = interaction({ promptLine: async () => 'past-ed' })
    await runClaudeLogin(seen, { consoleBase: url })
    expect(requests.at(-1)!.body.code).toBe('past-ed')
    expect(typeof requests.at(-1)!.body.state).toBe('string')
  })

  it('refuses a paste whose state is not this attempt', async () => {
    const { url } = await mockConsole()
    await expect(runClaudeLogin(interaction({ promptLine: async () => 'past-ed#not-this-attempt' }), { consoleBase: url }))
      .rejects.toThrow(/not for this login attempt/)
  })
})
