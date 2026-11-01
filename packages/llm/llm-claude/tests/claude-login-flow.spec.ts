/**
 * Server-side Claude login-flow tests: start/submit/cancel/dispose and
 * session state, all against a scripted console stand-in. Snapshots must
 * never carry token material.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { ClaudeLoginFlow } from '../src/claude-login-flow.ts'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

/** Scripted console: token endpoint answers one queued exchange. */
async function mockConsole(exchange: unknown = {
  access_token: 'sk-ant-oat01-access',
  refresh_token: 'sk-ant-oat01-refresh',
  expires_in: 3600,
}): Promise<string> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume()
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (request.method === 'POST' && url.pathname === '/v1/oauth/token') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(exchange))
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: 'unknown route' }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('console mock has no address')
  return `http://127.0.0.1:${String(address.port)}`
}

function flowOf(consoleBase: string, options: {
  stored?: Map<string, string>
  values?: Map<string, string>
} = {}): { flow: ClaudeLoginFlow; stored: Map<string, string> } {
  const stored = options.stored ?? new Map<string, string>()
  const values = options.values ?? new Map<string, string>()
  const ref = credentialRef('CLAUDE_CODE_OAUTH')
  const flow = new ClaudeLoginFlow({
    credentialsOf: () => ({
      resolve: async (name: string) => {
        const value = values.get(name)
        return value === undefined ? undefined : { value }
      },
    }),
    store: async (name, value) => {
      stored.set(String(name), value)
    },
    oauthRefOf: () => ref,
    consoleBase,
  })
  return { flow, stored }
}

function leakedSecrets(snapshot: unknown): string[] {
  const text = JSON.stringify(snapshot)
  return ['verifier', 'sk-ant-oat01'].filter(secret => text.includes(secret))
}

describe('ClaudeLoginFlow', () => {
  it('starts a login showing only the approval link', async () => {
    const base = await mockConsole()
    const { flow } = flowOf(base)
    try {
      const started = flow.start()
      expect(started.status).toBe('pending')
      expect(started.verificationUri).toContain('/oauth/authorize')
      // The paste-back snapshot exposes progress only — no device-code field.
      expect(Object.keys(started).sort()).toEqual(['loginId', 'status', 'verificationUri'])
      expect(leakedSecrets(started)).toEqual([])
      expect(leakedSecrets(flow.snapshot(started.loginId))).toEqual([])
    } finally {
      flow.dispose()
    }
  })

  it('redeems a matching paste and stores the session', async () => {
    const base = await mockConsole()
    const { flow, stored } = flowOf(base)
    try {
      const started = flow.start()
      const link = new URL(started.verificationUri!)
      const state = link.searchParams.get('state')!
      const done = await flow.submit(started.loginId, `past-ed#${state}`)
      expect(done.status).toBe('done')
      expect(leakedSecrets(done)).toEqual([])
      const saved = JSON.parse(stored.get('CLAUDE_CODE_OAUTH')!) as Record<string, unknown>
      expect(saved).toMatchObject({ access: 'sk-ant-oat01-access', refresh: 'sk-ant-oat01-refresh' })
    } finally {
      flow.dispose()
    }
  })

  it('refuses foreign states, blanks, and settled logins', async () => {
    const base = await mockConsole()
    const { flow, stored } = flowOf(base)
    try {
      const started = flow.start()
      await expect(flow.submit(started.loginId, 'past-ed#foreign')).rejects.toThrow(/not for this login attempt/)
      await expect(flow.submit(started.loginId, '  ')).rejects.toThrow(/empty/)
      await expect(flow.submit('login_missing', 'past-ed')).rejects.toThrow(/unknown/)
      expect(stored.has('CLAUDE_CODE_OAUTH')).toBe(false)
      const done = await flow.submit(started.loginId, 'past-ed')
      expect(done.status).toBe('done')
      await expect(flow.submit(started.loginId, 'past-ed')).rejects.toThrow(/no paste is open/)
    } finally {
      flow.dispose()
    }
  })

  it('records exchange failures without storing', async () => {
    const base = await mockConsole({ error: 'invalid_grant' })
    const { flow, stored } = flowOf(base)
    try {
      const started = flow.start()
      await expect(flow.submit(started.loginId, 'past-ed')).rejects.toThrow(/invalid_grant/)
      expect(flow.snapshot(started.loginId)?.status).toBe('failed')
      expect(stored.has('CLAUDE_CODE_OAUTH')).toBe(false)
    } finally {
      flow.dispose()
    }
  })

  it('cancels pending logins and answers unknown ids', async () => {
    const base = await mockConsole()
    const { flow } = flowOf(base)
    try {
      const started = flow.start()
      expect(flow.snapshot('login_missing')).toBeUndefined()
      expect(flow.cancel('login_missing')).toBeUndefined()
      expect(flow.cancel(started.loginId)?.status).toBe('cancelled')
      expect(flow.snapshot(started.loginId)?.status).toBe('cancelled')
    } finally {
      flow.dispose()
    }
  })

  it('caps concurrent pending logins and reports session state', async () => {
    const base = await mockConsole()
    const { flow } = flowOf(base)
    try {
      const ids: string[] = []
      for (let index = 0; index < 5; index += 1) ids.push(flow.start().loginId)
      expect(() => flow.start()).toThrow(/too many pending/)
      expect(await flow.hasSession()).toBe(false)
      for (const id of ids) flow.cancel(id)
    } finally {
      flow.dispose()
    }
  })

  it('sees a valid stored session', async () => {
    const base = await mockConsole()
    const values = new Map<string, string>([[
      'CLAUDE_CODE_OAUTH',
      JSON.stringify({ access: 'a', refresh: 'r', expiresAt: Date.now() + 3_600_000 }),
    ]])
    const { flow } = flowOf(base, { values })
    try {
      expect(await flow.hasSession()).toBe(true)
    } finally {
      flow.dispose()
    }
  })

  it('disposes pending logins', async () => {
    const base = await mockConsole()
    const { flow } = flowOf(base)
    const started = flow.start()
    flow.dispose()
    expect(flow.snapshot(started.loginId)?.status).toBe('cancelled')
  })
})
