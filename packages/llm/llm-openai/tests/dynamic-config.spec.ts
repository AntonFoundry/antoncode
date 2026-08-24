import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime, { BlockAssembler, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { FinishReason } from '@deepseek-ai/dsh-llm'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import * as LlmOpenAI from '@deepseek-ai/dsh-llm-openai'

const NS = settingsNamespace('llm-openai')

/** Minimal foreign adapter: only needs to own a route the plugin then wants. */
class StubAdapter extends LlmAdapter {

  override async * stream(): AsyncIterable<never> {
    throw new Error('stub adapter must never stream')
  }
}

const cleanups: Array<() => Promise<void>> = []
const servers: Server[] = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
  vi.unstubAllEnvs()
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-openai-dynamic-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Real dynamic composition mirroring the shipped bundle: the plugin mounts with no profiles. */
async function boot(dir: string, config: LlmOpenAI.Config): Promise<Context> {
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(LlmOpenAI, config)
  return ctx
}

interface RecordedRequest {
  path: string
  authorization: string | undefined
}

/** A minimal complete chat-completions text generation. */
const HELLO_EVENTS = [
  JSON.stringify({ choices: [{ delta: { role: 'assistant', content: null } }] }),
  JSON.stringify({ choices: [{ delta: { content: 'hello' } }] }),
  JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
  '[DONE]',
]

/** Local OpenAI stand-in: records each request, answers the one scripted generation. */
async function openAiServer(): Promise<{ url: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      requests.push({ path: request.url ?? '', authorization: request.headers.authorization })
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

/** Drive `ctx.llm.stream()` for one route and concatenate its text deltas. */
async function streamText(ctx: Context, provider: string, model: string): Promise<string> {
  let text = ''
  for await (const chunk of ctx.llm.stream({ provider, model, messages: [] })) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return text
}

/** Drive `ctx.llm.stream()` to its finish reason (adapter failures arrive as error finishes). */
async function streamFinish(ctx: Context, provider: string, model: string): Promise<FinishReason> {
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream({ provider, model, messages: [] })) assembler.push(chunk)
  return assembler.finish
}

describe('resolveAdapterOptions', () => {
  it('derives the credential reference per route when neither profile nor section names one', () => {
    expect(LlmOpenAI.resolveAdapterOptions({}, 'openai').apiKeyEnv).toBe('OPENAI_API_KEY')
    expect(LlmOpenAI.resolveAdapterOptions({}, 'openai-compatible').apiKeyEnv).toBe('OPENAI_COMPATIBLE_API_KEY')
  })

  it('resolves profile fields over the section defaults, per route', () => {
    const config: LlmOpenAI.Config = {
      apiKeyEnv: 'SHARED_KEY',
      baseURL: 'https://shared.example/v1',
      providers: {
        'openai-compatible': { apiKeyEnv: 'LOCAL_KEY', baseURL: 'http://127.0.0.1:1234/v1', displayName: 'Local vLLM' },
      },
    }
    const local = LlmOpenAI.resolveAdapterOptions(config, 'openai-compatible')
    expect(local.apiKeyEnv).toBe('LOCAL_KEY')
    expect(local.baseURL).toBe('http://127.0.0.1:1234/v1')
    expect(local.displayName).toBe('Local vLLM')
    const official = LlmOpenAI.resolveAdapterOptions(config, 'openai')
    expect(official.apiKeyEnv).toBe('SHARED_KEY')
    expect(official.baseURL).toBe('https://shared.example/v1')
    expect(official.displayName).toBe('OpenAI')
  })

  it('falls back to the public API and declared labels without any configuration', () => {
    const official = LlmOpenAI.resolveAdapterOptions({}, 'openai')
    expect(official.baseURL).toBe(LlmOpenAI.PUBLIC_BASE_URL)
    expect(official.displayName).toBe('OpenAI')
    expect(LlmOpenAI.resolveAdapterOptions({}, 'openai-compatible').displayName).toBe('OpenAI Compatible')
    // An undeclared route key labels itself.
    expect(LlmOpenAI.resolveAdapterOptions({}, 'my-gateway').displayName).toBe('my-gateway')
  })

  it('rejects empty per-route overrides at resolution', () => {
    expect(() => LlmOpenAI.resolveAdapterOptions({ providers: { openai: { baseURL: '' } } }, 'openai'))
      .toThrow('llm-openai: provider "openai" has an empty baseURL')
    expect(() => LlmOpenAI.resolveAdapterOptions({ providers: { openai: { apiKeyEnv: '' } } }, 'openai'))
      .toThrow('llm-openai: provider "openai" has an empty apiKeyEnv')
    expect(() => LlmOpenAI.resolveAdapterOptions({ providers: { openai: { displayName: '' } } }, 'openai'))
      .toThrow('llm-openai: provider "openai" has an empty displayName')
  })
})

describe('request-level dynamic profiles', () => {
  it('mounts bare and dormant, with both declared routes addressed inside the providers dict', async () => {
    const dir = await home()
    const ctx = await boot(dir, {})

    expect(ctx.llm.listProviders()).toEqual([])
    // Dormant ≠ invisible: the declared routes keep their settings addresses
    // so configuration surfaces can offer them before any profile exists.
    expect(ctx.llm.listConfigurableProviders()).toEqual([
      { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-openai', settingsPath: ['providers', 'openai'] },
      { provider: 'openai-compatible', displayName: 'OpenAI Compatible', settingsNs: 'llm-openai', settingsPath: ['providers', 'openai-compatible'] },
    ])
  })

  it('registers a route the moment settings supply its profile, and unregisters on the page\'s removal mutation', async () => {
    vi.stubEnv('OPENAI_DYNAMIC_KEY', '')
    const dir = await home()
    await writeFile(join(dir, '.credentials.yaml'), 'OPENAI_DYNAMIC_KEY: sk-from-settings\n', { mode: 0o600 })
    const server = await openAiServer()
    const ctx = await boot(dir, {})

    await ctx.settings.update(NS, {
      providers: { openai: { apiKeyEnv: 'OPENAI_DYNAMIC_KEY', baseURL: server.url } },
    })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])

    expect(await streamText(ctx, 'openai', 'gpt-4o')).toBe('hello')
    expect(server.requests[0]?.authorization).toBe('Bearer sk-from-settings')
    expect(server.requests[0]?.path).toBe('/chat/completions')

    // The exact mutation the Models page's delete flow performs.
    await ctx.settings.mutate(NS, [{ op: 'unset', path: ['providers', 'openai'] }])
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('resolves each route against its own profile, not a shared connection', async () => {
    vi.stubEnv('OPENAI_OFFICIAL_KEY', '')
    vi.stubEnv('OPENAI_LOCAL_KEY', '')
    const dir = await home()
    await writeFile(
      join(dir, '.credentials.yaml'),
      'OPENAI_OFFICIAL_KEY: sk-official\nOPENAI_LOCAL_KEY: sk-local\n',
      { mode: 0o600 },
    )
    const official = await openAiServer()
    const local = await openAiServer()
    const ctx = await boot(dir, {
      providers: {
        openai: { apiKeyEnv: 'OPENAI_OFFICIAL_KEY', baseURL: official.url },
        'openai-compatible': { apiKeyEnv: 'OPENAI_LOCAL_KEY', baseURL: `${local.url}/v1` },
      },
    })

    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai', 'openai-compatible'])
    expect(await streamText(ctx, 'openai', 'gpt-4o')).toBe('hello')
    expect(await streamText(ctx, 'openai-compatible', 'local-model')).toBe('hello')
    expect(official.requests[0]?.authorization).toBe('Bearer sk-official')
    expect(local.requests[0]?.authorization).toBe('Bearer sk-local')
    expect(local.requests[0]?.path).toBe('/v1/chat/completions')
  })

  it('resolves the derived per-route credential reference for a profile that names none', async () => {
    // The Models page stores a typed key under `<ROUTE>_API_KEY`; a reference-free
    // profile must resolve exactly that reference for the page's cleanup to match.
    vi.stubEnv('OPENAI_API_KEY', '')
    vi.stubEnv('OPENAI_COMPATIBLE_API_KEY', '')
    const dir = await home()
    await writeFile(
      join(dir, '.credentials.yaml'),
      'OPENAI_API_KEY: sk-derived-official\nOPENAI_COMPATIBLE_API_KEY: sk-derived-local\n',
      { mode: 0o600 },
    )
    const official = await openAiServer()
    const local = await openAiServer()
    const ctx = await boot(dir, {
      providers: {
        openai: { baseURL: official.url },
        'openai-compatible': { baseURL: local.url },
      },
    })

    expect(await streamText(ctx, 'openai', 'gpt-4o')).toBe('hello')
    expect(await streamText(ctx, 'openai-compatible', 'local-model')).toBe('hello')
    expect(official.requests[0]?.authorization).toBe('Bearer sk-derived-official')
    expect(local.requests[0]?.authorization).toBe('Bearer sk-derived-local')
  })

  it('re-registers routes in place when a captured fact changes', async () => {
    const dir = await home()
    const ctx = await boot(dir, { providers: { openai: {} } })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'openai', name: 'OpenAI' }])

    // The retry policy is section-level and captured at registration.
    await ctx.settings.update(NS, {
      retryPolicy: { mode: 'always', backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 } },
    })
    expect(ctx.llm.providerRetryPolicy('openai')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })

    // So is a route's selector label, through its profile.
    await ctx.settings.update(NS, { providers: { openai: { displayName: 'My OpenAI' } } })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'openai', name: 'My OpenAI' }])
  })

  it('refuses a settings write this adapter could not serve, leaving its routes alone', async () => {
    const dir = await home()
    const ctx = await boot(dir, { providers: { openai: {} } })

    await expect(ctx.settings.update(NS, { providers: { openai: { baseURL: '' } } }))
      .rejects.toThrow(/empty baseURL/)
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai'])
  })

  it('keeps serving the previous routes when a settings-born route collides with another adapter', async () => {
    const dir = await home()
    const ctx = await boot(dir, { providers: { openai: {} } })
    ctx.llm.registerAdapter(['other-route'], new StubAdapter())

    // The registry refuses the whole candidate set: openai keeps serving and
    // the conflicting route stays with its owner.
    await ctx.settings.update(NS, { providers: { openai: {}, 'other-route': {} } })
    expect(ctx.llm.listProviders().map(provider => provider.id).sort()).toEqual(['openai', 'other-route'])

    // Reverting to the working configuration re-applies.
    await ctx.settings.mutate(NS, [{ op: 'unset', path: ['providers', 'other-route'] }])
    expect(ctx.llm.listProviders().map(provider => provider.id).sort()).toEqual(['openai', 'other-route'])
  })

  it('fails per request with MISSING_CREDENTIAL naming the route when no key resolves', async () => {
    vi.stubEnv('OPENAI_API_KEY', '')
    const dir = await home()
    const ctx = await boot(dir, { providers: { openai: {} } })

    const finish = await streamFinish(ctx, 'openai', 'gpt-4o')
    expect(finish.kind).toBe('error')
    if (finish.kind !== 'error') return
    expect(finish.failure.code).toBe('MISSING_CREDENTIAL')
    expect(finish.failure.message).toMatch(/no API key for provider route "openai".*OPENAI_API_KEY/)
  })
})
