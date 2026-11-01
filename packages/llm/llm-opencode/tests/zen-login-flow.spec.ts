/**
 * Server-side login-flow tests: start/snapshot/select/cancel/dispose and
 * session state, all against a scripted console stand-in. Snapshots must
 * never carry token material.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { ZenLoginFlow } from '../src/zen-login-flow.ts'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

interface ConsoleScript {
  tokens?: unknown[]
  orgs?: unknown
  config?: unknown
}

/** Scripted console: instant device codes, queued token answers, orgs, config. */
async function mockConsole(script: ConsoleScript = {}): Promise<string> {
  const tokens = [...(script.tokens ?? [])]
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume()
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const send = (payload: unknown): void => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(payload))
      }
      if (request.method === 'POST' && url.pathname === '/auth/device/code') {
        send({
          device_code: `dev-${tokens.length}`,
          user_code: 'ABCD-1234',
          verification_uri_complete: 'https://opencode.ai/device?code=ABCD-1234',
          interval: 0.05,
          expires_in: 600,
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/auth/device/token') {
        send(tokens.length > 0 ? tokens.shift() : { error: 'authorization_pending' })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/orgs') {
        send(script.orgs ?? [{ id: 'org-1', name: 'First' }])
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/config') {
        send(script.config ?? { config: { provider: { opencode: { models: { 'chat-free': {} } } } } })
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

const TOKEN = { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }

function flowOf(consoleBase: string, options: {
  stored?: Map<string, string>
  values?: Map<string, string>
} = {}): { flow: ZenLoginFlow; stored: Map<string, string>; values: Map<string, string> } {
  const stored = options.stored ?? new Map<string, string>()
  const values = options.values ?? new Map<string, string>()
  const ref = credentialRef('OPENCODE_ZEN_OAUTH')
  const flow = new ZenLoginFlow({
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
  return { flow, stored, values }
}

async function waitFor(
  check: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function leakedSecrets(snapshot: unknown): string[] {
  const text = JSON.stringify(snapshot)
  return ['dev-', 'access-1', 'refresh-1'].filter(secret => text.includes(secret))
}

describe('ZenLoginFlow', () => {
  it('starts a login showing only the code and link', async () => {
    const base = await mockConsole()
    const { flow } = flowOf(base)
    try {
      const started = await flow.start()
      expect(started.status).toBe('pending')
      expect(started.userCode).toBe('ABCD-1234')
      expect(started.verificationUri).toContain('https://opencode.ai/device')
      expect(leakedSecrets(started)).toEqual([])
      expect(leakedSecrets(flow.snapshot(started.loginId))).toEqual([])
    } finally {
      flow.dispose()
    }
  })

  it('auto-completes a single workspace and stores the session', async () => {
    const base = await mockConsole({ tokens: [TOKEN] })
    const { flow, stored } = flowOf(base)
    try {
      const started = await flow.start()
      await waitFor(() => flow.snapshot(started.loginId)?.status === 'done', 'auto-complete')
      const done = flow.snapshot(started.loginId)!
      expect(done.orgID).toBe('org-1')
      expect(done.allowedModelCount).toBe(1)
      expect(leakedSecrets(done)).toEqual([])
      const saved = JSON.parse(stored.get('OPENCODE_ZEN_OAUTH')!) as Record<string, unknown>
      expect(saved).toMatchObject({ access: 'access-1', refresh: 'refresh-1', orgID: 'org-1' })
      expect(saved.allowedModels).toEqual(['chat-free'])
    } finally {
      flow.dispose()
    }
  })

  it('waits for the pick across workspaces and validates it', async () => {
    const base = await mockConsole({
      tokens: [TOKEN],
      orgs: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    })
    const { flow, stored } = flowOf(base)
    try {
      const started = await flow.start()
      await waitFor(() => flow.snapshot(started.loginId)?.status === 'awaiting-org', 'org pick')
      const waiting = flow.snapshot(started.loginId)!
      expect(waiting.orgs).toEqual([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])
      await expect(flow.select(started.loginId, 'nope')).rejects.toThrow(/not offered/)
      const done = await flow.select(started.loginId, 'b')
      expect(done.status).toBe('done')
      expect(done.orgID).toBe('b')
      expect((JSON.parse(stored.get('OPENCODE_ZEN_OAUTH')!) as { orgID?: string }).orgID).toBe('b')
      await expect(flow.select(started.loginId, 'a')).rejects.toThrow(/no workspace pick is open/)
    } finally {
      flow.dispose()
    }
  })

  it('completes without a workspace when none exist', async () => {
    const base = await mockConsole({ tokens: [TOKEN], orgs: [] })
    const { flow, stored } = flowOf(base)
    try {
      const started = await flow.start()
      await waitFor(() => flow.snapshot(started.loginId)?.status === 'done', 'empty orgs')
      expect((JSON.parse(stored.get('OPENCODE_ZEN_OAUTH')!) as { orgID?: string }).orgID).toBeUndefined()
    } finally {
      flow.dispose()
    }
  })

  it('reports denial without storing', async () => {
    const base = await mockConsole({ tokens: [{ error: 'access_denied' }] })
    const { flow, stored } = flowOf(base)
    try {
      const started = await flow.start()
      await waitFor(() => {
        const status = flow.snapshot(started.loginId)?.status
        return status === 'denied' || status === 'expired'
      }, 'denial')
      const terminal = flow.snapshot(started.loginId)!
      expect(terminal.status).toBe('denied')
      expect(terminal.error).toContain('access_denied')
      expect(stored.has('OPENCODE_ZEN_OAUTH')).toBe(false)
    } finally {
      flow.dispose()
    }
  })

  it('cancels a pending login and answers unknown ids', async () => {
    const base = await mockConsole()
    const { flow } = flowOf(base)
    try {
      const started = await flow.start()
      expect(flow.snapshot('login_missing')).toBeUndefined()
      await expect(flow.select('login_missing')).rejects.toThrow(/unknown/)
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
      for (let index = 0; index < 5; index += 1) {
        ids.push((await flow.start()).loginId)
      }
      await expect(flow.start()).rejects.toThrow(/too many pending/)
      expect(await flow.hasSession()).toBe(false)
      for (const id of ids) flow.cancel(id)
    } finally {
      flow.dispose()
    }
  })

  it('sees a valid stored session', async () => {
    const base = await mockConsole()
    const values = new Map<string, string>([[
      'OPENCODE_ZEN_OAUTH',
      JSON.stringify({ access: 'a', refresh: 'r', expiresAt: Date.now() + 3_600_000 }),
    ]])
    const { flow } = flowOf(base, { values })
    try {
      expect(await flow.hasSession()).toBe(true)
    } finally {
      flow.dispose()
    }
  })

  it('disposes pending drivers without unhandled rejections', async () => {
    const base = await mockConsole()
    const { flow } = flowOf(base)
    const started = await flow.start()
    flow.dispose()
    expect(flow.snapshot(started.loginId)?.status).toBe('cancelled')
  })
})
