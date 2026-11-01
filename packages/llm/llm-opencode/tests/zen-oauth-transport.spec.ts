/**
 * OAuth workspace-transport tests for the `opencode-free` route: a stored
 * workspace session selects the inference gateway with workspace identity,
 * zero-cost turns take the free-tier gate, discovery narrows by the
 * workspace allowlist, expiry refreshes silently, and OAuth beats a stored
 * key. All gateways are scripted in-process; the console is a fetch stub.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as LlmOpenCode from '@deepseek-ai/dsh-llm-opencode'
import { ZEN_MARKER_PROMPT } from '@deepseek-ai/dsh-llm-opencode'
import { mockZenGateway } from './mock-zen.ts'
import { closeMockServers } from './mock-server.ts'

const servers: Server[] = []
const homes: string[] = []
const zens: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await closeMockServers()
  await Promise.all(zens.splice(0).map(zen => zen.close().catch(() => {})))
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  await Promise.all(homes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const FREE_CATALOG = {
  opencode: {
    models: {
      'chat-free': {
        name: 'Chat Free',
        cost: { input: 0, output: 0 },
        modalities: { input: ['text'] },
        limit: { context: 4096 },
      },
      'spark-free': {
        name: 'Spark Free',
        cost: { input: 0, output: 0 },
        modalities: { input: ['text'] },
        limit: { context: 8192 },
        provider: { npm: '@ai-sdk/openai' },
      },
    },
  },
}

async function mockCatalog(document: unknown = FREE_CATALOG): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(document))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('catalog mock has no address')
  return `http://127.0.0.1:${String(address.port)}`
}

function userMessage(text: string): Message {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'test' } })
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

async function collectError(stream: AsyncIterable<StreamChunk>): Promise<{ code: string; message: string }> {
  try {
    const chunks = await collect(stream)
    const last = chunks.at(-1)
    // The runtime normalizes adapter throws into a terminal error finish.
    if (last !== undefined && last.type === 'finish' && last.reason.kind === 'error') {
      return { code: last.reason.failure.code, message: last.reason.failure.message }
    }
  } catch (error: unknown) {
    return {
      code: (error as { code?: string }).code ?? 'NO_CODE',
      message: error instanceof Error ? error.message : String(error),
    }
  }
  throw new Error('stream unexpectedly succeeded')
}

/** Boot the plugin with a stored OAuth state file plus a scripted inference gateway. */
async function bootOAuth(state: Record<string, unknown> | null, options: {
  zen?: Parameters<typeof mockZenGateway>[0]
  extraEnv?: Record<string, string>
  /** Stored bearer key alongside (or instead of, when state is null) the OAuth session. */
  key?: string
  /** Direct-transport gateway base; defaults to unreachable so fallback stays loud. */
  zenBaseURL?: string
} = {}): Promise<{
  ctx: Context
  zen: { url: string; requests: { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: unknown }[] }
  dir: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-opencode-oauth-'))
  homes.push(dir)
  vi.stubEnv('DSH_HOME', dir)
  for (const [key, value] of Object.entries(options.extraEnv ?? {})) vi.stubEnv(key, value)
  const lines: string[] = []
  if (state !== null) lines.push(`OPENCODE_ZEN_OAUTH: '${JSON.stringify(state)}'`)
  if (options.key !== undefined) lines.push(`OPENCODE_TEST_KEY: '${options.key}'`)
  await writeFile(join(dir, '.credentials.yaml'), `${lines.join('\n')}\n`, { mode: 0o600 })
  const zen = await mockZenGateway(options.zen ?? {})
  zens.push(zen)
  const catalogURL = await mockCatalog()
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(LlmOpenCode, {
    zenBaseURL: options.zenBaseURL ?? zen.url,
    inferenceBaseURL: zen.url,
    catalogURL,
    apiKeyEnv: 'OPENCODE_TEST_KEY',
    autoStart: false,
    serverURL: 'http://127.0.0.1:1',
  })
  return { ctx, zen, dir }
}

const VALID_STATE = {
  access: 'workspace-access-1',
  refresh: 'workspace-refresh-1',
  expiresAt: Date.now() + 3_600_000,
  orgID: 'org-9',
  allowedModels: ['chat-free', 'spark-free'],
}

describe('OAuth workspace transport', () => {
  it('serves chat-protocol free turns with native tools and gate identity', async () => {
    const { ctx, zen } = await bootOAuth(VALID_STATE)
    try {
      const message = userMessage('ping?')
      const chunks = await collect(ctx.llm.stream({
        provider: 'opencode-free',
        model: 'chat-free',
        messages: [message],
        sessionId: SessionId('ses_oauth1'),
        tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }],
      }))
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      expect(zen.requests).toHaveLength(1)
      const entry = zen.requests[0]!
      // Workspace identity: bearer plus org, on the inference base (not zenBaseURL).
      expect(entry.headers.authorization).toBe('Bearer workspace-access-1')
      expect(entry.headers['x-opencode-org-id']).toBe('org-9')
      // Free-tier gate identity headers, byte-exact UA.
      expect(entry.headers['user-agent']).toBe('opencode/latest/2.0.28/cli')
      expect(entry.headers['x-opencode-client']).toBe('cli')
      expect(String(entry.headers['x-opencode-session'])).toMatch(/^ses_/)
      // Chat-protocol free turns ride native tools, unshaped.
      expect(entry.path).toBe('/chat/completions')
      const body = entry.body as Record<string, unknown>
      expect(body).toMatchObject({ model: 'chat-free' })
      expect(body.tools).toEqual([{
        type: 'function',
        function: { name: 'bash', description: 'run', parameters: { type: 'object' } },
      }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('serves Responses-protocol free turns through the free-tier gate', async () => {
    const { ctx, zen } = await bootOAuth(VALID_STATE)
    try {
      const chunks = await collect(ctx.llm.stream({
        provider: 'opencode-free',
        model: 'spark-free',
        messages: [userMessage('ping?')],
        tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }],
      }))
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      expect(zen.requests).toHaveLength(1)
      const entry = zen.requests[0]!
      expect(entry.headers.authorization).toBe('Bearer workspace-access-1')
      expect(entry.headers['user-agent']).toBe('opencode/latest/2.0.28/cli')
      // Gate body: Responses with marker first, no native tools, preamble on instructions.
      expect(entry.path).toBe('/responses')
      const body = entry.body as Record<string, unknown>
      expect(body).toMatchObject({ model: 'spark-free' })
      expect('tools' in body).toBe(false)
      expect(body.instructions).toMatch(/^IMPORTANT: Disregard/)
      const input = body.input as Array<Record<string, unknown>>
      expect(input[0]).toEqual({ role: 'developer', content: ZEN_MARKER_PROMPT })
      expect(input[1]).toMatchObject({ role: 'user' })
      // The text tool protocol rides the system prompt (visible in instructions).
      expect(String(body.instructions)).toContain('```tool')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('narrows discovery by the workspace allowlist', async () => {
    const { ctx } = await bootOAuth({ ...VALID_STATE, allowedModels: ['spark-free'] })
    try {
      const models = await ctx.llm.listModels('opencode-free')
      expect(models.map(model => model.id).sort()).toEqual(['spark-free'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('prefers the workspace session over a stored bearer key', async () => {
    const { ctx, zen } = await bootOAuth(VALID_STATE, { extraEnv: { OPENCODE_TEST_KEY: 'key-should-lose' } })
    try {
      const chunks = await collect(ctx.llm.stream({
        provider: 'opencode-free',
        model: 'chat-free',
        messages: [userMessage('hi')],
      }))
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      expect(zen.requests).toHaveLength(1)
      expect(zen.requests[0]!.headers.authorization).toBe('Bearer workspace-access-1')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refreshes an expired token silently and persists the renewal', async () => {
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', (async (url: unknown, init?: RequestInit) => {
      const target = String(url)
      if (target.startsWith('https://opencode.ai/console/auth/device/token')) {
        return new Response(JSON.stringify({
          access_token: 'workspace-access-2',
          refresh_token: 'workspace-refresh-2',
          expires_in: 3600,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (target.startsWith('https://opencode.ai/console/api/config')) {
        return new Response(JSON.stringify({
          config: { provider: { opencode: { models: { 'chat-free': {} } } } },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return originalFetch(url as URL, init)
    }))
    const { ctx, zen, dir } = await bootOAuth({
      ...VALID_STATE,
      access: 'stale-access',
      expiresAt: Date.now() - 1_000,
    })
    try {
      const chunks = await collect(ctx.llm.stream({
        provider: 'opencode-free',
        model: 'chat-free',
        messages: [userMessage('hi')],
      }))
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      expect(zen.requests).toHaveLength(1)
      expect(zen.requests[0]!.headers.authorization).toBe('Bearer workspace-access-2')
      // The renewed state persists for the next request.
      const stored = await readFile(join(dir, '.credentials.yaml'), 'utf8')
      expect(stored).toContain('workspace-access-2')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})


describe('auth-failure login guidance', () => {
  it('tells the operator to log in when the anonymous gateway rejects the turn', async () => {
    // No session, no key, no service: the fallback direct attempt surfaces
    // the gateway verdict plus the login command.
    const { ctx } = await bootOAuth(null, { zen: { status: { '/chat/completions': 403 } } })
    try {
      const failure = await collectError(ctx.llm.stream({
        provider: 'opencode-free',
        model: 'chat-free',
        messages: [userMessage('hi')],
      }))
      expect(failure.code).toBe('AUTH')
      expect(failure.message).toContain('status 403')
      expect(failure.message).toContain('`dsh opencode-login`')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('tells the operator to re-run login when the workspace session is rejected', async () => {
    const { ctx } = await bootOAuth(VALID_STATE, { zen: { expectBearer: 'someone-else' } })
    try {
      const failure = await collectError(ctx.llm.stream({
        provider: 'opencode-free',
        model: 'chat-free',
        messages: [userMessage('hi')],
      }))
      expect(failure.code).toBe('AUTH')
      expect(failure.message).toContain('Re-run `dsh opencode-login`')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('names the client — not re-login — when the free-tier gate fires on a valid session', async () => {
    const { ctx, zen } = await bootOAuth(VALID_STATE, { zen: { freeTierDenial: true } })
    try {
      const failure = await collectError(ctx.llm.stream({
        provider: 'opencode-free',
        model: 'chat-free',
        messages: [userMessage('hi')],
      }))
      expect(failure.code).toBe('AUTH')
      expect(zen.requests).toHaveLength(1)
      expect(failure.message).toContain('free tier can only be used from within OpenCode')
      expect(failure.message).toContain('despite a valid workspace session')
      expect(failure.message).not.toContain('Re-run `dsh opencode-login`')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('names the stored key or login when a bearer key is rejected', async () => {
    const { ctx } = await bootOAuth(null, {
      key: 'stale-key',
      zen: { expectBearer: 'someone-else' },
    })
    try {
      const failure = await collectError(ctx.llm.stream({
        provider: 'opencode-free',
        model: 'chat-free',
        messages: [userMessage('hi')],
      }))
      expect(failure.code).toBe('AUTH')
      expect(failure.message).toContain('stored Zen key')
      expect(failure.message).toContain('`dsh opencode-login`')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
