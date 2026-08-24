import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime, { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { FinishReason } from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import * as LlmCodex from '@deepseek-ai/dsh-llm-codex'

const NS = settingsNamespace('llm-codex')

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
async function codexHome(dir: string): Promise<string> {
  const homeDir = join(dir, 'codex-home')
  await mkdir(homeDir, { recursive: true })
  await writeFile(
    join(homeDir, 'auth.json'),
    JSON.stringify({ tokens: { access_token: 'fake-access', refresh_token: '', account_id: 'acct-1' } }),
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
  await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  await ctx.plugin(LlmCodex, config)
  return ctx
}

interface RecordedRequest {
  path: string
  authorization: string | undefined
  accountId: string | undefined
}

/** A minimal complete Responses-protocol text generation. */
const HELLO_EVENTS = [
  JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg-1', role: 'assistant' } }),
  JSON.stringify({ type: 'response.content_part.added', item_id: 'msg-1', part: { type: 'output_text' } }),
  JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg-1', delta: 'hello' }),
  JSON.stringify({ type: 'response.completed', response: { id: 'resp-1', status: 'completed', usage: { input_tokens: 3, output_tokens: 1 } } }),
]

/** Codex backend stand-in: records each request, answers the one scripted generation. */
async function codexServer(): Promise<{ url: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      requests.push({
        path: request.url ?? '',
        authorization: request.headers.authorization,
        accountId: request.headers['openai-account-id'] as string | undefined,
      })
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
    expect(() => LlmCodex.assertServiceable({ providers: { 'codex-eu': {} } }))
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

  it('registers the route when settings supply its profile, streams through it, and unregisters on the page\'s removal mutation', async () => {
    const dir = await home()
    const codexDir = await codexHome(dir)
    const server = await codexServer()
    const ctx = await boot(dir, {})

    await ctx.settings.update(NS, {
      providers: { codex: { codexHome: codexDir, baseURL: server.url } },
    })
    // The subscription-login readiness rides the registration: a login on
    // disk at registration time reports as configured.
    expect(ctx.llm.listProviders()).toEqual([{ id: 'codex', name: 'OpenAI Codex', authConfigured: true }])

    expect(await streamText(ctx, 'gpt-5.5')).toBe('hello')
    expect(server.requests[0]?.path).toBe('/responses')
    expect(server.requests[0]?.authorization).toBe('Bearer fake-access')
    expect(server.requests[0]?.accountId).toBe('acct-1')

    // The exact mutation the Models page's delete flow performs.
    await ctx.settings.mutate(NS, [{ op: 'unset', path: ['providers', 'codex'] }])
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('re-registers the route in place when a captured fact changes', async () => {
    const dir = await home()
    const ctx = await boot(dir, { providers: { codex: {} } })

    await ctx.settings.update(NS, {
      retryPolicy: { mode: 'always', backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 } },
    })
    expect(ctx.llm.providerRetryPolicy('codex')).toEqual({
      mode: 'always',
      initialDelayMs: 25,
      maxDelayMs: 100,
      jitterRatio: 0.2,
    })

    await ctx.settings.update(NS, { providers: { codex: { displayName: 'Work Codex' } } })
    expect(ctx.llm.listProviders().map(provider => provider.name)).toEqual(['Work Codex'])
  })

  it('fails per request with MISSING_CREDENTIAL naming the profile codexHome when no login exists', async () => {
    const dir = await home()
    const ctx = await boot(dir, {})
    const emptyHome = join(dir, 'no-login')

    await ctx.settings.update(NS, { providers: { codex: { codexHome: emptyHome } } })
    expect(ctx.llm.listProviders()).toEqual([{ id: 'codex', name: 'OpenAI Codex', authConfigured: false }])

    const finish = await streamFinish(ctx, 'gpt-5.5')
    expect(finish.kind).toBe('error')
    if (finish.kind !== 'error') return
    expect(finish.failure.code).toBe('MISSING_CREDENTIAL')
    expect(finish.failure.message).toContain(`No OpenAI Codex login found at ${join(emptyHome, 'auth.json')}`)
  })

  it('refuses a settings write naming a route this adapter does not serve', async () => {
    const dir = await home()
    const ctx = await boot(dir, { providers: { codex: {} } })

    await expect(ctx.settings.update(NS, { providers: { 'codex-eu': {} } }))
      .rejects.toThrow(/not served by this adapter/)
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['codex'])
  })
})
