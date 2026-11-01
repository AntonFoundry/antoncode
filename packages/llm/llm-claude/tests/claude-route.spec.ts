/**
 * `claude-code` route tests: config resolution, mounted registration and
 * discovery, subscription turns through the real pi-ai Anthropic transport
 * (asserting Claude Code identity headers on the wire), silent refresh with
 * write-back, and the login guidance on credential failures — all against
 * scripted in-process gateways, no network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmError, MessageId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { authContextFrom, catalogModels, credentialStoreFrom } from '@deepseek-ai/dsh-llm-pi-ai'
import { CLAUDE_CATALOG_PROVIDER } from '../src/claude.ts'
import * as LlmClaude from '@deepseek-ai/dsh-llm-claude'
import {
  ClaudeCodeAdapter,
  createInnerAdapter,
  resolveAdapterOptions,
} from '@deepseek-ai/dsh-llm-claude'

const servers: Server[] = []
const homes: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  await Promise.all(homes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

interface GatewayScript {
  status?: number
  text?: string[]
}

/** Scripted Anthropic Messages gateway: SSE text turns, request log. */
async function mockGateway(script: GatewayScript = {}): Promise<{
  url: string
  requests: { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: unknown }[]
}> {
  const requests: { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: unknown }[] = []
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
      requests.push({ method: request.method ?? '', path: `${url.pathname}${url.search}`, headers, body })
      if (script.status !== undefined) {
        response.writeHead(script.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `status ${script.status}` } }))
        return
      }
      const payloads = [
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'm', stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        ...(script.text ?? ['hello']).map(text => ({
          type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text },
        })),
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const payload of payloads) response.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`)
      response.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('gateway mock has no address')
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
  }
}

function userText(text: string): {
  id: MessageId
  role: 'user'
  content: [{ type: 'text'; text: string }]
  source: { kind: 'user' }
} {
  messageCounter += 1
  return {
    id: MessageId(`msg-claude-${messageCounter}`),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}
let messageCounter = 0

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

async function collectError(stream: AsyncIterable<StreamChunk>): Promise<{ code: string; message: string }> {
  try {
    const chunks = await collect(stream)
    const last = chunks.at(-1)
    // pi-ai normalizes adapter throws into a terminal error finish.
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

/** Mount the real plugin (bundled catalog models, offline). */
async function boot(keyFile?: Record<string, string>, baseURL?: string): Promise<{ ctx: Context; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-claude-'))
  homes.push(dir)
  vi.stubEnv('DSH_HOME', dir)
  if (keyFile !== undefined) {
    await writeFile(
      join(dir, '.credentials.yaml'),
      Object.entries(keyFile).map(([ref, value]) => `${ref}: '${value}'`).join('\n') + '\n',
      { mode: 0o600 },
    )
  }
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  if (keyFile !== undefined) {
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  }
  await ctx.plugin(LlmClaude, baseURL === undefined ? {} : { baseURL })
  if (ctx.llm.listProviders().every(entry => entry.id !== 'claude-code')) {
    throw new Error('claude-code route did not register')
  }
  return { ctx, dir }
}

/**
 * Same mount as {@link boot} plus the durable attachment service, which is
 * what image conversion requires. Separate helper so existing tests keep
 * mounting exactly what they did before.
 */
async function bootWithAttachments(
  keyFile: Record<string, string>,
  baseURL: string,
): Promise<{ ctx: Context; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-claude-img-'))
  homes.push(dir)
  vi.stubEnv('DSH_HOME', dir)
  await writeFile(
    join(dir, '.credentials.yaml'),
    Object.entries(keyFile).map(([ref, value]) => `${ref}: '${value}'`).join('\n') + '\n',
    { mode: 0o600 },
  )
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(LocalAttachmentStore, { dshHome: dir })
  await ctx.plugin(LlmClaude, { baseURL })
  if (ctx.llm.listProviders().every(entry => entry.id !== 'claude-code')) {
    throw new Error('claude-code route did not register')
  }
  return { ctx, dir }
}

/** A context the pi-ai auth injectables read through; no services needed. */
const stackContext = new Context()

/** Adapter stack identical to the plugin's, aimed at a scripted gateway. */
function stackFor(gatewayURL: string, resolveAccess: () => Promise<string>): ClaudeCodeAdapter {
  const models = [...catalogModels('anthropic').values()].map(model => ({ ...model, baseUrl: gatewayURL }))
  if (models.length === 0) throw new Error('installed pi-ai catalog ships no anthropic models')
  const resolved = resolveAdapterOptions({})
  return new ClaudeCodeAdapter({
    inner: createInnerAdapter({
      displayName: resolved.displayName,
      streamIdleTimeoutMs: resolved.streamIdleTimeoutMs,
      retryPolicy: resolved.retryPolicy,
      oauthRef: resolved.oauthRef,
      models,
      resolveAccess,
      // The adapter requires the auth injectables. A bare context is enough
      // here: both read through it lazily and every case resolves its own
      // access token directly.
      auth: { credentials: credentialStoreFrom(stackContext), authContext: authContextFrom(stackContext) },
    }),
  })
}

const VALID_STATE = {
  access: 'sk-ant-oat01-access',
  refresh: 'sk-ant-oat01-refresh',
  expiresAt: Date.now() + 3_600_000,
}

describe('resolveAdapterOptions', () => {
  it('resolves defaults for an empty section', () => {
    expect(resolveAdapterOptions({})).toMatchObject({ displayName: 'Claude Code' })
    expect(String(resolveAdapterOptions({}).oauthRef)).toBe('CLAUDE_CODE_OAUTH')
    expect(resolveAdapterOptions({}).retryPolicy).toMatchObject({ mode: 'normal' })
  })

  it('rejects empty string fields and out-of-bound numerics', () => {
    expect(() => resolveAdapterOptions({ oauthRef: '' })).toThrow(/oauthRef must be non-empty/)
    expect(() => resolveAdapterOptions({ displayName: '' })).toThrow(/displayName must be non-empty/)
    expect(() => resolveAdapterOptions({ defaultContextWindow: 0 })).toThrow(/positive integer/)
    expect(() => resolveAdapterOptions({ streamIdleTimeoutMs: -1 })).toThrow(/positive finite/)
  })
})

describe('mounted route', () => {
  it('registers claude-code with catalog discovery', async () => {
    // Discovery reports models only once the session resolves: pi-ai withholds
    // a route's catalog while its credential resolver throws.
    const { ctx } = await boot({ CLAUDE_CODE_OAUTH: JSON.stringify(VALID_STATE) })
    try {
      expect(ctx.llm.listProviders()).toContainEqual({ id: 'claude-code', name: 'Claude Code' })
      const models = await ctx.llm.listModels('claude-code')
      expect(models.length).toBeGreaterThan(0)
      expect(models[0]!.provider).toBe('claude-code')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses unauthenticated turns naming the login fix', async () => {
    const gateway = await mockGateway()
    const adapter = stackFor(gateway.url, async () => {
      throw new LlmError('claude-code has no usable Claude subscription session.', 'MISSING_CREDENTIAL')
    })
    // listModels withholds while the session is missing, so the call under
    // test names a catalog model directly.
    const model = [...catalogModels(CLAUDE_CATALOG_PROVIDER).values()][0]!
    const failure = await collectError(adapter.stream({
      provider: 'claude-code',
      model: model.id,
      messages: [userText('hi')],
    }))
    expect(failure.code).toBe('MISSING_CREDENTIAL')
    expect(failure.message).toContain('dsh claude-login')
    expect(gateway.requests).toHaveLength(0)
  })
})

describe('subscription turns', () => {
  it('sends Claude Code identity with the workspace bearer', async () => {
    const gateway = await mockGateway()
    const adapter = stackFor(gateway.url, async () => VALID_STATE.access)
    const models = await adapter.listModels('claude-code')
    const chunks = await collect(adapter.stream({
      provider: 'claude-code',
      model: models[0]!.id,
      messages: [userText('hi')],
    }))
    const last = chunks.at(-1)!
    expect(last.type).toBe('finish')
    if (last.type === 'finish') expect(last.reason.kind).toBe('stop')
    expect(gateway.requests).toHaveLength(1)
    const entry = gateway.requests[0]!
    expect(entry.path).toBe('/v1/messages?beta=true')
    expect(entry.headers.authorization).toBe(`Bearer ${VALID_STATE.access}`)
    expect(String(entry.headers['anthropic-beta'])).toContain('oauth-2025-04-20')
    expect(entry.headers['x-app']).toBe('cli')
    expect((entry.body as Record<string, unknown>).model).toBe(models[0]!.id)
  })

  it('maps gateway auth rejection to AUTH with the login hint', async () => {
    const gateway = await mockGateway({ status: 401 })
    const adapter = stackFor(gateway.url, async () => VALID_STATE.access)
    const model = [...catalogModels(CLAUDE_CATALOG_PROVIDER).values()][0]!
    const failure = await collectError(adapter.stream({
      provider: 'claude-code',
      model: model.id,
      messages: [userText('hi')],
    }))
    expect(failure.code).toBe('AUTH')
    expect(failure.message).toContain('dsh claude-login')
  })

  it('refreshes an expired session silently with write-back', async () => {
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', (async (url: unknown, init?: RequestInit) => {
      if (String(url).startsWith('https://platform.claude.com/v1/oauth/token')) {
        return new Response(JSON.stringify({
          access_token: 'sk-ant-oat01-access-2',
          refresh_token: 'sk-ant-oat01-refresh-2',
          expires_in: 3600,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return originalFetch(url as URL, init)
    }))
    const gateway = await mockGateway()
    const { ctx, dir } = await boot(
      {
        CLAUDE_CODE_OAUTH: JSON.stringify({ ...VALID_STATE, access: 'stale', expiresAt: Date.now() - 1_000 }),
      },
      gateway.url,
    )
    try {
      const models = await ctx.llm.listModels('claude-code')
      const chunks: StreamChunk[] = []
      // Drive through the mounted route so refresh + write-back run for real.
      for await (const chunk of ctx.llm.stream({
        provider: 'claude-code',
        model: models[0]!.id,
        messages: [userText('hi')],
      })) chunks.push(chunk)
      const last = chunks[chunks.length - 1]!
      if (last.type !== 'finish' || last.reason.kind !== 'stop') {
        throw new Error(`expected a text finish, got ${JSON.stringify(last).slice(0, 200)}`)
      }
      expect(gateway.requests).toHaveLength(1)
      expect(gateway.requests[0]!.headers.authorization).toBe('Bearer sk-ant-oat01-access-2')
      const stored = await readFile(join(dir, '.credentials.yaml'), 'utf8')
      expect(stored).toContain('sk-ant-oat01-access-2')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

/**
 * Image input over the route. Regression guard for a silent degradation:
 * this route built its inner pi-ai adapter WITHOUT `resolveAttachments`, so
 * pi-ai's adapter took its "no attachment service" branch and replaced every
 * image with placeholder text — even though the installed Anthropic catalog
 * declares `input: ['text','image']` for these models. Nothing errored;
 * images simply never reached the gateway. That is exactly the kind of
 * missing-wire omission no existing test caught, so it is asserted on the
 * wire rather than by inspecting adapter internals.
 */
describe('image input', () => {
  it('declares image input in the installed catalog', () => {
    // The other half of pi-ai's strip condition: if the catalog ever stops
    // declaring image support, images are dropped before attachments matter.
    const models = [...catalogModels('anthropic').values()]
    const withImages = models.filter(model => (model as { input?: readonly string[] }).input?.includes('image'))
    expect(withImages.length).toBeGreaterThan(0)
  })

  it('sends image content to the gateway instead of placeholder text', async () => {
    const gateway = await mockGateway()
    const { ctx } = await bootWithAttachments(
      { CLAUDE_CODE_OAUTH: JSON.stringify(VALID_STATE) },
      gateway.url,
    )
    try {
      const models = await ctx.llm.listModels('claude-code')
      const model = models.find(entry => (entry as { input?: readonly string[] }).input?.includes('image'))
        ?? models[0]!
      // 1x1 transparent PNG.
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      const store = ctx.get('attachments')
      if (store === undefined) throw new Error('attachment service did not register')
      const saved = await store.saveImage({
        data: new Uint8Array(Buffer.from(png, 'base64')),
        mediaType: 'image/png',
      })
      messageCounter += 1
      const imgChunks = await collect(ctx.llm.stream({
        provider: 'claude-code',
        model: model.id,
        messages: [{
          id: MessageId(`msg-claude-img-${messageCounter}`),
          role: 'user',
          content: [
            { type: 'text', text: 'describe' },
            { type: 'image', attachment: saved },
          ],
          source: { kind: 'user' },
        }] as never,
      }))
      if (gateway.requests.length !== 1) {
        // Surface the stream failure rather than a bare length mismatch.
        throw new Error(`no gateway request; chunks=${JSON.stringify(imgChunks).slice(0, 600)}`)
      }
      const wire = JSON.stringify(gateway.requests[0]!.body)
      // The exact symptom this guards: placeholder text reaching the wire.
      expect(wire).not.toContain('image omitted')
      // Positive side: real image content was serialized for the gateway.
      expect(wire).toContain('base64')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
