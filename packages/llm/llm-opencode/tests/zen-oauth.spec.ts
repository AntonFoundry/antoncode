/**
 * Device-flow OAuth tests against a scripted console stand-in: code issue,
 * approval polling, denial, expiry, refresh, workspace reads, and the
 * full login orchestration — no network, no browser.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  fetchAllowedModels,
  fetchOrgs,
  isAccessValid,
  parseOAuthState,
  pollDeviceToken,
  refreshAccessToken,
  requestDeviceCode,
  runZenLogin,
  type ZenLoginInteraction,
} from '../src/zen-oauth.ts'

const servers: Server[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

interface ConsoleScript {
  code?: Record<string, unknown>
  codeStatus?: number
  /** Token-endpoint answers in order; consumed per poll/refresh call. */
  tokens?: unknown[]
  tokenStatus?: number
  orgs?: unknown
  orgsStatus?: number
  config?: unknown
  configStatus?: number
}

/** Scripted OpenCode console: device flow, orgs, and workspace config. */
async function mockConsole(script: ConsoleScript = {}): Promise<{
  url: string
  requests: { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: unknown }[]
}> {
  const requests: { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: unknown }[] = []
  const tokens = [...(script.tokens ?? [])]
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
    })
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      let body: unknown
      try {
        body = raw.length > 0 ? JSON.parse(raw) as unknown : undefined
      } catch {
        body = undefined
      }
      const headers: Record<string, string | string[] | undefined> = {}
      for (const [name, value] of Object.entries(request.headers)) headers[name] = value
      requests.push({ method: request.method ?? '', path: url.pathname, headers, body })
      const send = (status: number, payload: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(payload))
      }
      if (request.method === 'POST' && url.pathname === '/auth/device/code') {
        if (script.codeStatus !== undefined) {
          send(script.codeStatus, { message: 'denied' })
          return
        }
        send(200, {
          device_code: 'dev-1',
          user_code: 'ABCD-1234',
          verification_uri: 'https://opencode.ai/device',
          verification_uri_complete: 'https://opencode.ai/device?code=ABCD-1234',
          interval: 1,
          expires_in: 600,
          ...script.code,
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/auth/device/token') {
        if (script.tokenStatus !== undefined) {
          send(script.tokenStatus, { message: 'denied' })
          return
        }
        const next = tokens.length > 0 ? tokens.shift() : { error: 'authorization_pending' }
        send(200, next)
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/orgs') {
        if (script.orgsStatus !== undefined) {
          send(script.orgsStatus, { message: 'denied' })
          return
        }
        send(200, script.orgs ?? [{ id: 'org-1', name: 'First' }])
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/config') {
        if (script.configStatus !== undefined) {
          send(script.configStatus, { message: 'denied' })
          return
        }
        send(200, script.config ?? { config: { provider: {} } })
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

const TOKEN = { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }

function interaction(over: Partial<ZenLoginInteraction> = {}): ZenLoginInteraction & { notified: string[] } {
  const notified: string[] = []
  return {
    notified,
    notify: (message: string) => {
      notified.push(message)
    },
    promptSelect: async () => undefined,
    ...over,
  }
}

describe('parseOAuthState', () => {
  it('parses a complete state and ignores malformed stores', () => {
    const full = {
      access: 'a',
      refresh: 'r',
      expiresAt: Date.now() + 3_600_000,
      orgID: 'org-1',
      allowedModels: ['m1', 'm2'],
    }
    expect(parseOAuthState(JSON.stringify(full))).toEqual(full)
    expect(parseOAuthState(JSON.stringify({ access: 'a', refresh: 'r', expiresAt: 1 }))).toMatchObject({
      access: 'a',
    })
    for (const bad of [
      undefined,
      '',
      'not json{',
      '[1,2]',
      JSON.stringify({ refresh: 'r', expiresAt: 1 }),
      JSON.stringify({ access: 'a', expiresAt: 1 }),
      JSON.stringify({ access: 'a', refresh: 'r', expiresAt: 'soon' }),
      JSON.stringify({ access: '', refresh: 'r', expiresAt: 1 }),
    ]) {
      expect(parseOAuthState(bad)).toBeUndefined()
    }
  })

  it('drops a non-string org and a non-string allowlist', () => {
    expect(parseOAuthState(JSON.stringify({
      access: 'a',
      refresh: 'r',
      expiresAt: 1,
      orgID: 7,
      allowedModels: ['m1', 9],
    }))).toEqual({ access: 'a', refresh: 'r', expiresAt: 1 })
  })
})

describe('isAccessValid', () => {
  it('honors the refresh-skew guard', () => {
    const now = 1_000_000
    expect(isAccessValid({ access: 'a', refresh: 'r', expiresAt: now + 300_001 }, now)).toBe(true)
    expect(isAccessValid({ access: 'a', refresh: 'r', expiresAt: now + 299_999 }, now)).toBe(false)
    expect(isAccessValid({ access: 'a', refresh: 'r', expiresAt: now - 1 }, now)).toBe(false)
  })
})

describe('requestDeviceCode', () => {
  it('reads the code payload with the complete link preferred', async () => {
    const { url, requests } = await mockConsole()
    const code = await requestDeviceCode({ consoleBase: url })
    expect(code).toMatchObject({
      deviceCode: 'dev-1',
      userCode: 'ABCD-1234',
      verificationUri: 'https://opencode.ai/device?code=ABCD-1234',
    })
    expect(requests[0]!.body).toMatchObject({ client_id: 'opencode-cli' })
  })

  it('falls back to the plain verification link and refuses broken payloads', async () => {
    const { url } = await mockConsole({ code: { verification_uri_complete: undefined, verification_uri: '/device' } })
    const code = await requestDeviceCode({ consoleBase: url })
    expect(code.verificationUri).toBe(`${url}/device`)
    const broken = await mockConsole({ code: { device_code: undefined } })
    await expect(requestDeviceCode({ consoleBase: broken.url })).rejects.toThrow(/device_code/)
    const down = await mockConsole({ codeStatus: 500 })
    await expect(requestDeviceCode({ consoleBase: down.url })).rejects.toThrow(/HTTP 500/)
  })
})

describe('pollDeviceToken', () => {
  const noSleep = async (): Promise<void> => {}

  it('waits through pending polls until approval', async () => {
    const { url, requests } = await mockConsole({
      tokens: [{ error: 'authorization_pending' }, { error: 'authorization_pending' }, TOKEN],
    })
    const code = await requestDeviceCode({ consoleBase: url })
    const tokens = await pollDeviceToken(code, { consoleBase: url, sleep: noSleep })
    expect(tokens.access).toBe('access-1')
    expect(tokens.expiresAt).toBeGreaterThan(Date.now())
    expect(requests.filter(entry => entry.path === '/auth/device/token')).toHaveLength(3)
  })

  it('backs off on slow_down and rejects denials', async () => {
    const sleeps: number[] = []
    const { url } = await mockConsole({
      tokens: [{ error: 'slow_down' }, TOKEN],
    })
    const code = await requestDeviceCode({ consoleBase: url })
    await pollDeviceToken(code, {
      consoleBase: url,
      sleep: async (ms: number) => {
        sleeps.push(ms)
      },
    })
    expect(sleeps).toEqual([1000, 6000])
    const denied = await mockConsole({ tokens: [{ error: 'access_denied', error_description: 'nope' }] })
    const deniedCode = await requestDeviceCode({ consoleBase: denied.url })
    await expect(pollDeviceToken(deniedCode, { consoleBase: denied.url, sleep: noSleep }))
      .rejects.toThrow(/access_denied.*nope/)
  })

  it('expires and aborts without hanging', async () => {
    const { url } = await mockConsole()
    const expired = { deviceCode: 'd', userCode: 'u', verificationUri: `${url}/`, intervalSeconds: 1, expiresInSeconds: 0 }
    await expect(pollDeviceToken(expired, { consoleBase: url, sleep: noSleep })).rejects.toThrow(/expired/)
    const controller = new AbortController()
    controller.abort(new Error('user stopped'))
    const code = await requestDeviceCode({ consoleBase: url })
    await expect(pollDeviceToken(code, { consoleBase: url, sleep: noSleep, signal: controller.signal }))
      .rejects.toThrow(/cancelled/)
  })
})

describe('fetchOrgs', () => {
  it('reads array and wrapped shapes with the bearer token', async () => {
    const { url, requests } = await mockConsole({ orgs: [{ id: 'o1', name: 'One' }, { id: 'o2' }] })
    expect(await fetchOrgs('tok', { consoleBase: url })).toEqual([
      { id: 'o1', name: 'One' },
      { id: 'o2', name: 'o2' },
    ])
    expect(requests[0]!.headers.authorization).toBe('Bearer tok')
    const wrapped = await mockConsole({ orgs: { orgs: [{ id: 'w1', name: 'W' }] } })
    expect(await fetchOrgs('tok', { consoleBase: wrapped.url })).toEqual([{ id: 'w1', name: 'W' }])
  })
})

describe('refreshAccessToken', () => {
  it('renews credentials keeping the workspace and refreshing the allowlist', async () => {
    const { url, requests } = await mockConsole({
      tokens: [{ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 60 }],
      config: { config: { provider: { opencode: { models: { 'chat-free': {} } } } } },
    })
    const next = await refreshAccessToken(
      { access: 'old', refresh: 'r1', expiresAt: 1, orgID: 'org-9', allowedModels: ['stale'] },
      { consoleBase: url },
    )
    expect(next.access).toBe('access-2')
    expect(next.orgID).toBe('org-9')
    expect(next.allowedModels).toEqual(['chat-free'])
    expect(requests[0]!.body).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'r1',
      client_id: 'opencode-cli',
    })
  })

  it('keeps the previous allowlist when the catalog read fails, and fails loud on token denial', async () => {
    const { url } = await mockConsole({
      tokens: [{ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 60 }],
      configStatus: 500,
    })
    const next = await refreshAccessToken(
      { access: 'old', refresh: 'r1', expiresAt: 1, orgID: 'org-9', allowedModels: ['stale'] },
      { consoleBase: url },
    )
    expect(next.allowedModels).toEqual(['stale'])
    const denied = await mockConsole({ tokens: [{ error: 'invalid_grant' }] })
    await expect(refreshAccessToken(
      { access: 'old', refresh: 'r1', expiresAt: 1 },
      { consoleBase: denied.url },
    )).rejects.toThrow(/invalid_grant/)
  })
})

describe('fetchAllowedModels', () => {
  it('keeps servable ids honoring lists and status', async () => {
    const { url } = await mockConsole({
      config: {
        config: {
          provider: {
            opencode: {
              models: {
                'chat-free': {},
                'old-free': { status: 'deprecated' },
                'off-model': { disabled: true },
                'test-smoke': {},
                'jev-1': {},
              },
            },
            other: {
              whitelist: ['chat-free', 'extra-free'],
              models: { 'chat-free': {}, 'extra-free': {}, 'hidden-free': {} },
            },
            blocked: {
              blacklist: ['chat-free'],
              models: { 'chat-free': {} },
            },
          },
        },
      },
    })
    expect(await fetchAllowedModels('tok', 'org-1', { consoleBase: url })).toEqual(['chat-free', 'extra-free'])
  })
})

describe('runZenLogin', () => {
  it('auto-picks a single workspace and never notifies token material', async () => {
    const { url } = await mockConsole({
      tokens: [TOKEN],
      config: { config: { provider: { opencode: { models: { 'chat-free': {} } } } } },
    })
    const seen = interaction()
    const state = await runZenLogin(seen, { consoleBase: url, sleep: async () => {} })
    expect(state.orgID).toBe('org-1')
    expect(state.allowedModels).toEqual(['chat-free'])
    expect(seen.notified.join('\n')).toContain('ABCD-1234')
    expect(seen.notified.join('\n')).not.toContain('access-1')
    expect(seen.notified.join('\n')).not.toContain('refresh-1')
  })

  it('prompts across workspaces and tolerates a skipped catalog', async () => {
    const { url } = await mockConsole({
      tokens: [TOKEN],
      orgs: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      configStatus: 500,
    })
    const picked: string[] = []
    const seen = interaction({
      promptSelect: async (_message, options) => {
        picked.push(...options.map(option => option.label))
        return 'b'
      },
    })
    const state = await runZenLogin(seen, { consoleBase: url, sleep: async () => {} })
    expect(state.orgID).toBe('b')
    expect(picked).toEqual(['A', 'B'])
    expect(state.allowedModels).toBeUndefined()
  })

  it('completes without a workspace when none exist or the pick is declined', async () => {
    const { url } = await mockConsole({ tokens: [TOKEN], orgs: [] })
    const state = await runZenLogin(interaction(), { consoleBase: url, sleep: async () => {} })
    expect(state.orgID).toBeUndefined()
    expect(state.access).toBe('access-1')
  })
})
