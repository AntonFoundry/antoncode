import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as ToolZai from '@deepseek-ai/dsh-tool-zai'
import { TOOL_NAMES, type ToolZaiConfig } from '@deepseek-ai/dsh-tool-zai'
import {
  apiKeyRefOf,
  encodeImageSource,
  encodeVideoSource,
  mcpText,
  ZaiMcpError,
} from '@deepseek-ai/dsh-tool-zai/src/client.ts'

const testToolSignal = new AbortController().signal
const KEY_ENV = 'DSH_TEST_ZAI_KEY'

async function mountZai(config: Partial<ToolZaiConfig> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(ToolZai, { apiKeyEnv: KEY_ENV, ...config })
  return ctx
}

/** Minimal fetch stub dispatching on URL. */
type FetchHandler = (url: string, init: { headers: Record<string, string>; body: string }) => {
  status: number
  sessionId?: string
  body: string
}

/** Typed view of one stubbed-fetch call (`exactOptionalPropertyTypes` is on). */
interface RpcCall {
  url: string
  headers: Record<string, string>
  rpc: { method?: string | undefined; params?: { name?: string; arguments?: Record<string, unknown> } | undefined }
  chat: { model?: string | undefined; messages?: Array<{ content: Array<{ type: string }> }> | undefined }
}

function rpcCalls(): RpcCall[] {
  const mock = fetch as unknown as { mock: { calls: Array<[string, { headers: Record<string, string>; body: string }]> } }
  return mock.mock.calls.map(([url, init]) => {
    const both = JSON.parse(init.body) as {
      method?: string
      params?: { name?: string; arguments?: Record<string, unknown> }
      model?: string
      messages?: Array<{ content: Array<{ type: string }> }>
    }
    return {
      url,
      headers: init.headers,
      rpc: { method: both.method, params: both.params },
      chat: { model: both.model, messages: both.messages },
    }
  })
}

let handler: FetchHandler = () => { throw new Error('fetch not stubbed') }

const sse = (payload: unknown): string => `id:1\nevent:message\ndata:${JSON.stringify(payload)}\n\n`

const mcpInit = (): string => sse({
  jsonrpc: '2.0',
  id: 1,
  result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 't', version: '0' } },
})

const mcpResult = (text: string): string => sse({
  jsonrpc: '2.0',
  id: 2,
  result: { content: [{ type: 'text', text }] },
})

const chatResult = (text: string): string => JSON.stringify({ choices: [{ message: { content: text } }] })

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const out = handler(url, init)
    return {
      ok: out.status === 200,
      status: out.status,
      headers: new Headers(out.sessionId !== undefined ? { 'mcp-session-id': out.sessionId } : {}),
      text: async (): Promise<string> => out.body,
    }
  }))
}

/** Serve a canned MCP tools/call result for every RPC on an MCP endpoint. */
function serveMcp(text: string): void {
  handler = (url) => {
    if (!url.includes('/mcp/')) return { status: 200, body: chatResult(text) }
    return { status: 200, sessionId: 'sess-1', body: mcpInit() }
  }
  const calls: string[] = []
  const inner = handler
  handler = (url, init) => {
    const rpc = JSON.parse(init.body) as { method?: string }
    calls.push(rpc.method ?? 'call')
    if (rpc.method === 'tools/call') return { status: 200, sessionId: 'sess-1', body: mcpResult(text) }
    return inner(url, init)
  }
  void calls
}

describe('tool-zai registration', () => {
  beforeEach(() => {
    process.env[KEY_ENV] = 'test-key'
    stubFetch()
  })

  afterEach(() => {
    delete process.env.DSH_TEST_ZAI_KEY
    vi.unstubAllGlobals()
  })

  it('registers all thirteen tools by default', async () => {
    const ctx = await mountZai()
    expect([...TOOL_NAMES]).toHaveLength(13)
    for (const tool of TOOL_NAMES) expect(ctx.tools.get(tool)).toBeDefined()
  })

  it('registers only the enabled subset', async () => {
    const ctx = await mountZai({ enabledTools: ['web_search_prime', 'analyze_image'] })
    expect(ctx.tools.get('web_search_prime')).toBeDefined()
    expect(ctx.tools.get('analyze_image')).toBeDefined()
    expect(ctx.tools.get('webReader')).toBeUndefined()
  })

  it('fails loud on unknown enabledTools entries', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    let message = ''
    try {
      await ctx.plugin(ToolZai, { apiKeyEnv: KEY_ENV, enabledTools: ['nope'] })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('unknown tools')
  })
})

describe('tool-zai remote trio', () => {
  beforeEach(() => {
    process.env[KEY_ENV] = 'test-key'
    stubFetch()
    serveMcp('search-ok')
  })

  afterEach(() => {
    delete process.env.DSH_TEST_ZAI_KEY
    vi.unstubAllGlobals()
  })

  it('web_search_prime forwards the query and returns text', async () => {
    const ctx = await mountZai()
    const result = await executeToolFixture(ctx, {
      signal: testToolSignal, callId: ToolCallId('c1'), name: 'web_search_prime', arguments: { search_query: 'GLM' },
    })
    expect(result.content[0]).toEqual({ type: 'text', text: 'search-ok' })
    const calls = rpcCalls()
    expect(calls.map(call => call.rpc.method ?? 'call')).toContain('initialize')
    const call = calls.find(entry => entry.rpc.method === 'tools/call')
    expect(call?.rpc.params).toEqual({ name: 'web_search_prime', arguments: { search_query: 'GLM' } })
  })

  it('web_search_prime rejects a blank query', async () => {
    const ctx = await mountZai()
    const result = await executeToolFixture(ctx, {
      signal: testToolSignal, callId: ToolCallId('c1'), name: 'web_search_prime', arguments: { search_query: '  ' },
    })
    expect(JSON.stringify(result)).toContain('non-empty')
  })

  it('webReader forwards optional fields', async () => {
    const ctx = await mountZai()
    await executeToolFixture(ctx, {
      signal: testToolSignal, callId: ToolCallId('c1'), name: 'webReader',
      arguments: { url: 'https://example.com', return_format: 'text', no_cache: true },
    })
    const webCall = rpcCalls().find(entry => entry.rpc.method === 'tools/call')
    expect(webCall?.rpc.params?.arguments).toEqual({ url: 'https://example.com', return_format: 'text', no_cache: true })
  })

  it('zread tools call their endpoints', async () => {
    const ctx = await mountZai()
    for (const [tool, args] of [
      ['search_doc', { repo_name: 'o/r', query: 'q' }],
      ['read_file', { repo_name: 'o/r', file_path: 'src/a.ts' }],
      ['get_repo_structure', { repo_name: 'o/r' }],
    ] as const) {
      const result = await executeToolFixture(ctx, { signal: testToolSignal, callId: ToolCallId('c1'), name: tool, arguments: { ...args } })
      expect(result.content[0]).toEqual({ type: 'text', text: 'search-ok' })
    }
  })

  it('surfaces MCP endpoint errors as failures', async () => {
    handler = () => ({ status: 500, body: 'boom' })
    const ctx = await mountZai()
    const result = await executeToolFixture(ctx, {
      signal: testToolSignal, callId: ToolCallId('c1'), name: 'web_search_prime', arguments: { search_query: 'q' },
    })
    expect(JSON.stringify(result)).toContain('500')
  })

  it('reports a missing key instead of calling', async () => {
    delete process.env.DSH_TEST_ZAI_KEY
    const ctx = await mountZai()
    const result = await executeToolFixture(ctx, {
      signal: testToolSignal, callId: ToolCallId('c1'), name: 'web_search_prime', arguments: { search_query: 'q' },
    })
    expect(JSON.stringify(result)).toContain('no API key')
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('tool-zai vision', () => {
  let dir: string
  let png: string

  beforeEach(() => {
    process.env[KEY_ENV] = 'test-key'
    stubFetch()
    handler = () => ({ status: 200, body: chatResult('vision-ok') })
    dir = mkdtempSync(join(tmpdir(), 'tool-zai-'))
    png = join(dir, 'a.png')
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })

  afterEach(() => {
    delete process.env.DSH_TEST_ZAI_KEY
    vi.unstubAllGlobals()
    rmSync(dir, { recursive: true, force: true })
  })

  it('analyze_image posts chat completions and returns text', async () => {
    const ctx = await mountZai()
    const result = await executeToolFixture(ctx, {
      signal: testToolSignal, callId: ToolCallId('c1'), name: 'analyze_image',
      arguments: { image_source: png, prompt: 'describe' },
    })
    expect(result.content[0]).toEqual({ type: 'text', text: 'vision-ok' })
    const [chatCall] = rpcCalls()
    if (chatCall === undefined) throw new Error('expected a chat completion call')
    expect(chatCall.url).toContain('chat/completions')
    expect(chatCall.headers['Authorization']).toBe('Bearer test-key')
    expect(chatCall.chat.model).toBe('glm-5.3-flash')
    expect(chatCall.chat.messages?.[1]?.content[1]).toMatchObject({ type: 'image_url' })
  })

  it('ui_diff_check sends both images', async () => {
    const ctx = await mountZai()
    await executeToolFixture(ctx, {
      signal: testToolSignal, callId: ToolCallId('c1'), name: 'ui_diff_check',
      arguments: { expected_image_source: 'https://x/e.png', actual_image_source: 'https://x/a.png', prompt: 'diff' },
    })
    const [diffCall] = rpcCalls()
    if (diffCall === undefined) throw new Error('expected a ui_diff_check call')
    const diffParts = diffCall.chat.messages?.[1]?.content ?? []
    expect(diffParts.filter(part => part.type === 'image_url')).toHaveLength(2)
  })

  it('analyze_video sends a video_url part', async () => {
    const mp4 = join(dir, 'v.mp4')
    writeFileSync(mp4, Buffer.alloc(16))
    const ctx = await mountZai()
    await executeToolFixture(ctx, {
      signal: testToolSignal, callId: ToolCallId('c1'), name: 'analyze_video',
      arguments: { video_source: mp4, prompt: 'summarize' },
    })
    const [videoCall] = rpcCalls()
    if (videoCall === undefined) throw new Error('expected a video call')
    const videoParts = videoCall.chat.messages?.[1]?.content ?? []
    expect(videoParts[1]).toMatchObject({ type: 'video_url' })
  })

  it('rejects missing and oversized media', () => {
    expect(() => encodeImageSource(join(dir, 'nope.png'))).toThrow(/not found/)
    const bmp = join(dir, 'a.bmp')
    writeFileSync(bmp, Buffer.alloc(8))
    expect(() => encodeImageSource(bmp)).toThrow(/Unsupported image format/)
    expect(() => encodeImageSource(png, 0)).toThrow(/too large/)
    expect(() => encodeVideoSource(join(dir, 'v.avi'))).toThrow(/Video file not found|Unsupported video/)
  })

  it('rejects blank prompts', async () => {
    const ctx = await mountZai()
    const result = await executeToolFixture(ctx, {
      signal: testToolSignal, callId: ToolCallId('c1'), name: 'analyze_image',
      arguments: { image_source: png, prompt: ' ' },
    })
    expect(JSON.stringify(result)).toContain('non-empty')
  })
})

describe('tool-zai client units', () => {
  it('apiKeyRefOf defaults and trims', () => {
    expect(apiKeyRefOf(undefined).toString()).toBe('Z_AI_API_KEY')
    expect(apiKeyRefOf('  Z_AI_API_KEY  ').toString()).toBe('Z_AI_API_KEY')
  })

  it('mcpText joins text blocks and keeps links readable', () => {
    expect(mcpText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb')
    expect(mcpText([{ type: 'resource_link', name: 'n', uri: 'u' }])).toBe('n u')
    expect(mcpText([{ type: 'other', v: 1 }])).toBe(JSON.stringify({ type: 'other', v: 1 }))
  })

  it('ZaiMcpError carries its code', () => {
    expect(new ZaiMcpError(500, 'x').code).toBe(500)
  })
})
