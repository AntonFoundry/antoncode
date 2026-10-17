/**
 * OpenCode-login RPC tests: start/status/select/cancel through the proxy
 * against a real login flow (scripted console) and a file credentials seam —
 * plus the unavailable-plugin and unknown-login branches.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { ZenLoginFlow } from '@deepseek-ai/dsh-llm-opencode'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

const servers: Server[] = []
const homes: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  await Promise.all(homes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`oauth-${String(nextRpc++)}`), payload }
}

/** Scripted console: instant codes, one queued approval, two workspaces. */
async function mockConsole(): Promise<string> {
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
          device_code: 'dev-1',
          user_code: 'ABCD-1234',
          verification_uri_complete: 'https://opencode.ai/device?code=ABCD-1234',
          interval: 0.05,
          expires_in: 600,
        })
        return
      }
      if (request.method === 'POST' && url.pathname === '/auth/device/token') {
        send({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 })
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/orgs') {
        send([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/config') {
        send({ config: { provider: { opencode: { models: { 'chat-free': {} } } } } })
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

async function harness(consoleBase: string, withFlow: boolean): Promise<{ ctx: Context; api: ReturnType<typeof createApiProxy> }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-oauth-rpc-'))
  homes.push(dir)
  const ctx = new Context()
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(LocalCredentialProvider, {
    path: join(dir, '.credentials.yaml'),
    dshHome: dir,
    watch: false,
  })
  if (withFlow) {
    const credentialsOf = (): { resolve: (ref: string) => Promise<{ value: string } | undefined> } | undefined => {
      const credentials = ctx.get('credentials')
      return credentials === undefined ? undefined : { resolve: ref => credentials.resolve(credentialRef(ref)) }
    }
    ctx.provide('opencodeOAuth', new ZenLoginFlow({
      credentialsOf,
      store: async (ref, value) => {
        const credentials = ctx.get('credentials')
        if (credentials === undefined) throw new Error('no credentials service')
        await credentials.set(ref, value)
      },
      oauthRefOf: () => credentialRef('OPENCODE_ZEN_OAUTH'),
      consoleBase,
    }))
  }
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
    cwd: '/tmp',
  })
  return { ctx, api }
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > 5_000) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('opencodeOAuth RPC', () => {
  it('drives start, approval, workspace pick, and persistence end to end', async () => {
    const base = await mockConsole()
    const { ctx, api } = await harness(base, true)
    try {
      const started = await api.opencodeOAuth.start(request({}))
      if (!started.result.ok) throw new Error(`start failed: ${started.result.error.message}`)
      expect(started.result.value.login.status).toBe('pending')
      expect(started.result.value.login.userCode).toBe('ABCD-1234')
      const loginId = started.result.value.login.loginId

      await waitFor(async () => {
        const snapshot = await api.opencodeOAuth.status(request({ loginId }))
        return snapshot.result.ok === true && snapshot.result.value.login.status === 'awaiting-org'
      }, 'workspace pick')
      const picked = await api.opencodeOAuth.select(request({ loginId, orgID: 'b' }))
      if (!picked.result.ok) throw new Error(`select failed: ${picked.result.error.message}`)
      expect(picked.result.value.login.status).toBe('done')
      expect(picked.result.value.login.orgID).toBe('b')

      const credentials = ctx.get('credentials')!
      const stored = await credentials.resolve(credentialRef('OPENCODE_ZEN_OAUTH'))
      expect(JSON.parse(stored!.value)).toMatchObject({ access: 'access-1', orgID: 'b' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects unknown logins and invalid transitions by code', async () => {
    const base = await mockConsole()
    const { ctx, api } = await harness(base, true)
    try {
      const missing = await api.opencodeOAuth.status(request({ loginId: 'login_nope' }))
      expect(missing.result.ok).toBe(false)
      if (missing.result.ok === false) expect(missing.result.error.code).toBe('opencode-login-not-found')

      const started = await api.opencodeOAuth.start(request({}))
      if (!started.result.ok) throw new Error('start failed')
      const loginId = started.result.value.login.loginId
      const early = await api.opencodeOAuth.select(request({ loginId, orgID: 'a' }))
      expect(early.result.ok).toBe(false)
      if (early.result.ok === false) expect(early.result.error.code).toBe('opencode-login-invalid')

      const cancelled = await api.opencodeOAuth.cancel(request({ loginId }))
      if (!cancelled.result.ok) throw new Error('cancel failed')
      expect(cancelled.result.value.login.status).toBe('cancelled')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports unavailable while llm-opencode is not installed', async () => {
    const base = await mockConsole()
    const { ctx, api } = await harness(base, false)
    try {
      const started = await api.opencodeOAuth.start(request({}))
      expect(started.result.ok).toBe(false)
      if (started.result.ok === false) {
        expect(started.result.error.code).toBe('opencode-oauth-unavailable')
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
