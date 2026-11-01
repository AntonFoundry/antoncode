import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime, { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { FinishReason } from '@deepseek-ai/dsh-llm'
import * as LlmCodex from '@deepseek-ai/dsh-llm-codex'


const cleanups: Array<() => Promise<void>> = []
const servers: Server[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  vi.unstubAllEnvs()
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-codex-dynamic-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** A Codex home holding a usable login: a non-JWT access token never expires locally. */
async function codexHome(dir: string, refreshToken = ''): Promise<string> {
  const homeDir = join(dir, 'codex-home')
  await mkdir(homeDir, { recursive: true })
  await writeFile(
    join(homeDir, 'auth.json'),
    JSON.stringify({ tokens: { access_token: 'fake-access', refresh_token: refreshToken, account_id: 'acct-1' } }),
    { mode: 0o600 },
  )
  return homeDir
}

/** Real dynamic composition mirroring the shipped bundle: the plugin mounts with no profile. */
async function boot(dir: string, config: LlmCodex.Config): Promise<Context> {
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmCodex, config)
  return ctx
}

interface RecordedRequest {
  path: string
  authorization: string | undefined
  accountId: string | undefined
  originator: string | undefined
}

/** A minimal complete Responses-protocol text generation. */
const HELLO_EVENTS = [
  JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg-1', role: 'assistant' } }),
  JSON.stringify({ type: 'response.content_part.added', item_id: 'msg-1', part: { type: 'output_text' } }),
  JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg-1', delta: 'hello' }),
  JSON.stringify({ type: 'response.completed', response: { id: 'resp-1', status: 'completed', usage: { input_tokens: 3, output_tokens: 1 } } }),
]

/** Codex backend stand-in: records each request, answers the one scripted generation. */
async function codexServer(options: { expireFirst?: boolean } = {}): Promise<{ url: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      requests.push({
        path: request.url ?? '',
        authorization: request.headers.authorization,
        accountId: request.headers['chatgpt-account-id'] as string | undefined,
        originator: request.headers.originator as string | undefined,
      })
      if (options.expireFirst === true && requests.length === 1) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { code: 'token_expired', message: 'expired' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of HELLO_EVENTS) response.write(`data: ${event}\n\n`)
      response.end()
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}`, requests }
}

/** Drive `ctx.llm.stream()` for the codex route and concatenate its text deltas. */
async function streamText(ctx: Context, model: string): Promise<string> {
  let text = ''
  for await (const chunk of ctx.llm.stream({ provider: 'codex', model, messages: [] })) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return text
}

/** Drive `ctx.llm.stream()` to its finish reason (adapter failures arrive as error finishes). */
async function streamFinish(ctx: Context, model: string): Promise<FinishReason> {
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({ provider: 'codex', model, messages: [] })) assembler.push(chunk)
  return assembler.finish
}

describe('resolveAdapterOptions', () => {
  it('resolves profile fields over the section defaults', () => {
    const config: LlmCodex.Config = {
      codexHome: '/shared/codex',
      baseURL: 'https://shared.example/codex/',
      providers: { codex: { codexHome: '/route/codex', displayName: 'Work Codex' } },
    }
    const resolved = LlmCodex.resolveAdapterOptions(config, 'codex')
    expect(resolved.codexHome).toBe('/route/codex')
    expect(resolved.displayName).toBe('Work Codex')
    expect(resolved.baseURL).toBe('https://shared.example/codex')
  })

  it('falls back to the public endpoint and default label without any configuration', () => {
    vi.stubEnv('CODEX_HOME', '/nonexistent-codex-home')
    const resolved = LlmCodex.resolveAdapterOptions({}, 'codex')
    expect(resolved.baseURL).toBe(LlmCodex.PUBLIC_BASE_URL)
    expect(resolved.displayName).toBe('OpenAI Codex')
    expect(resolved.codexHome).toBe('/nonexistent-codex-home')
  })

  it('rejects empty per-route overrides at resolution', () => {
    expect(() => LlmCodex.resolveAdapterOptions({ providers: { codex: { baseURL: '' } } }, 'codex'))
      .toThrow('llm-codex: provider "codex" has an empty baseURL')
    expect(() => LlmCodex.resolveAdapterOptions({ providers: { codex: { displayName: '' } } }, 'codex'))
      .toThrow('llm-codex: provider "codex" has an empty displayName')
  })

  it('refuses routes this adapter does not serve', () => {
    expect(() => { LlmCodex.assertServiceable({ providers: { 'codex-eu': {} } }) })
      .toThrow('llm-codex: provider route "codex-eu" is not served by this adapter; the only route is "codex"')
  })
})

describe('request-level dynamic profile', () => {
  it('mounts bare and dormant, with the declared route addressed inside the providers dict', async () => {
    const dir = await home()
    const ctx = await boot(dir, {})

    expect(ctx.llm.listProviders()).toEqual([])
    // Dormant ≠ invisible: the declared route keeps its settings address so
    // configuration surfaces can offer it before any profile exists.
    expect(ctx.llm.listConfigurableProviders()).toEqual([
      { provider: 'codex', displayName: 'OpenAI Codex', settingsNs: 'llm-codex', settingsPath: ['providers', 'codex'] },
    ])
  })

  it('registers the route when config supplies its profile and streams through it', async () => {
    const dir = await home()
    const codexDir = await codexHome(dir)
    const server = await codexServer()
    // Settings are Config-derived: an edit reloads the entry, so supplying the
    // profile as config is the path a settings edit takes.
    const ctx = await boot(dir, { providers: { codex: { codexHome: codexDir, baseURL: server.url } } })

    expect(ctx.llm.listProviders()).toEqual([{ id: 'codex', name: 'OpenAI Codex' }])

    // The shipped GPT-5.6 catalog keeps model-specific effort levels visible
    // even before the Codex CLI has populated models_cache.json.
    await expect(ctx.llm.resolveModelInfo('codex', 'gpt-5.6-luna')).resolves.toMatchObject({
      reasoning: {
        efforts: [
          { id: 'low' },
          { id: 'medium' },
          { id: 'high' },
          { id: 'xhigh' },
          { id: 'max' },
        ],
        defaultEffort: 'medium',
      },
    })

    expect(await streamText(ctx, 'gpt-5.5')).toBe('hello')
    expect(server.requests[0]?.path).toBe('/responses')
    expect(server.requests[0]?.authorization).toBe('Bearer fake-access')
    expect(server.requests[0]?.accountId).toBe('acct-1')
    expect(server.requests[0]?.originator).toBe('opencode')
  })

  it('uses discovered context capacity for cached models without a configured override', async () => {
    const dir = await home()
    const codexDir = await codexHome(dir)
    await writeFile(join(codexDir, 'models_cache.json'), JSON.stringify({
      models: [{ slug: 'private-small-model', display_name: 'Private Small', context_window: 128_000 }],
    }))
    const ctx = await boot(dir, { providers: { codex: { codexHome: codexDir } } })
    await expect(ctx.llm.resolveModelInfo('codex', 'private-small-model')).resolves.toMatchObject({
      id: 'private-small-model',
      context: { contextWindow: 128_000 },
    })
  })

  it('refreshes once when the Codex backend rejects the cached token as expired', async () => {
    const dir = await home()
    const codexDir = await codexHome(dir, 'refresh-1')
    const server = await codexServer({ expireFirst: true })
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
      if (requestUrl.startsWith('https://auth.openai.com/')) {
        return new Response(JSON.stringify({ access_token: 'fresh-access', refresh_token: 'refresh-2' }), { status: 200 })
      }
      return realFetch(input, init)
    })
    const ctx = await boot(dir, { providers: { codex: { codexHome: codexDir, baseURL: server.url } } })
    expect(await streamText(ctx, 'gpt-5.5')).toBe('hello')
    expect(server.requests.map(request => request.authorization)).toEqual([
      'Bearer fake-access',
      'Bearer fresh-access',
    ])
  })

  it('fails per request with MISSING_CREDENTIAL naming the profile codexHome when no login exists', async () => {
    const dir = await home()
    const emptyHome = join(dir, 'no-login')
    const ctx = await boot(dir, { providers: { codex: { codexHome: emptyHome } } })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'codex', name: 'OpenAI Codex' }])

    const finish = await streamFinish(ctx, 'gpt-5.5')
    expect(finish.kind).toBe('error')
    if (finish.kind !== 'error') return
    expect(finish.failure.code).toBe('MISSING_CREDENTIAL')
    expect(finish.failure.message).toContain(`No OpenAI Codex login found at ${join(emptyHome, 'auth.json')}`)
  })

})
