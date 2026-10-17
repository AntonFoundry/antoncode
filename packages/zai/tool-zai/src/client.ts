/**
 * Direct-HTTPS clients for the Z.AI backends behind the ZAI MCP servers.
 *
 * Two transports, zero server processes:
 * - The remote trio (web_search_prime, web_reader, zread) speaks MCP
 *   Streamable HTTP. Instead of a persistent bridged connection, each tool
 *   call opens a short-lived session (initialize -> tools/call) and closes
 *   it. Same wire behavior per call, no supervisor, no reconnect state.
 * - The vision tools call the same `chat/completions` endpoint the
 *   `@z_ai/mcp-server` child process calls, with the same vendored system
 *   prompts (`./prompts.ts`), model, and sampling config.
 *
 * @module tool-zai/client
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

/** Default credential reference when config names none. */
export const DEFAULT_API_KEY_REF = 'Z_AI_API_KEY'

/** Remote MCP endpoint roots (Streamable HTTP, server-side, no local port). */
export const ENDPOINTS = {
  webSearchPrime: 'https://api.z.ai/api/mcp/web_search_prime/mcp',
  webReader: 'https://api.z.ai/api/mcp/web_reader/mcp',
  zread: 'https://api.z.ai/api/mcp/zread/mcp',
} as const

/** Vision chat-completions endpoint used by `@z_ai/mcp-server`. */
export const VISION_URL = 'https://api.z.ai/api/paas/v4/chat/completions'

/** Vision model used by `@z_ai/mcp-server` unless overridden in config. */
export const VISION_MODEL = 'glm-5.3-flash'

/** Resolve the API key exactly like `llm-deepseek`: seam first, ambient env otherwise. */
export async function resolveApiKey(ctx: Context, plugin: string, ref: CredentialRef): Promise<string> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const hit = await credentials.resolve(ref)
    if (hit !== undefined && hit.value.length > 0) return hit.value
  } else {
    const ambient = launchEnvironmentOf(ctx).get(ref)
    if (ambient !== undefined && ambient.value.length > 0) return ambient.value
  }
  throw new Error(
    `${plugin}: no API key for reference "${ref}"; store it through the credentials`
    + ` service (the Plugins settings card writes it), or export ${ref} in the launching environment`,
  )
}

/** Normalize a configured env-name string into a validated credential reference. */
export function apiKeyRefOf(configured: string | undefined): CredentialRef {
  return credentialRef(configured?.trim() || DEFAULT_API_KEY_REF)
}

/** One JSON-RPC error from the Z.AI MCP endpoints. */
export class ZaiMcpError extends Error {
  readonly code: number | string
  constructor(code: number | string, message: string) {
    super(`Z.AI MCP error ${code}: ${message}`)
    this.code = code
  }
}

/** Extract the first JSON payload from an SSE (`data:`) or plain-JSON body. */
function firstJsonPayload(body: string): Record<string, unknown> {
  const text = body.trim()
  if (text.startsWith('{')) return JSON.parse(text) as Record<string, unknown>
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') continue
    try {
      return JSON.parse(payload) as Record<string, unknown>
    } catch {
      // keep scanning: keep-alive comments and partial frames carry no payload
    }
  }
  throw new ZaiMcpError('E_SSE', 'no JSON payload in MCP response')
}

/**
 * One short-lived MCP call: initialize (captures the session id), send the
 * initialized notification, invoke `tools/call`, and return the result blocks.
 * The session is scoped to this call; nothing persists between calls.
 */
export async function mcpCall(
  endpoint: string,
  apiKey: string,
  toolName: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ content: unknown[]; structuredContent?: unknown }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${apiKey}`,
  }
  const post = async (payload: Record<string, unknown>, sessionId?: string): Promise<{ headers: Headers; body: string }> => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: sessionId !== undefined ? { ...headers, 'Mcp-Session-Id': sessionId } : headers,
      body: JSON.stringify(payload),
      signal,
    })
    const body = await response.text()
    if (!response.ok && response.status !== 200) {
      throw new ZaiMcpError(response.status, body.slice(0, 500))
    }
    return { headers: response.headers, body }
  }
  const init = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-tool-zai', version: '0.1.0' } },
  })
  const sessionId = init.headers.get('mcp-session-id') ?? undefined
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId)
  const { body } = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: args } }, sessionId)
  const message = firstJsonPayload(body)
  if (typeof message['error'] === 'object' && message['error'] !== null) {
    const err = message['error'] as { code?: number | string; message?: string }
    throw new ZaiMcpError(err.code ?? 'E_RPC', err.message ?? 'unknown MCP error')
  }
  const result = message['result'] as { content?: unknown[]; structuredContent?: unknown; isError?: boolean } | undefined
  if (!result || !Array.isArray(result.content)) throw new ZaiMcpError('E_SHAPE', 'MCP result carried no content blocks')
  if (result.isError === true) {
    const text = result.content.map((block) => {
      if (typeof block === 'object' && block !== null && 'text' in block && typeof block.text === 'string') {
        return block.text
      }
      return JSON.stringify(block)
    }).join('\n')
    throw new ZaiMcpError('E_TOOL', text.slice(0, 2000))
  }
  return { content: result.content, structuredContent: result.structuredContent }
}

/** Render one non-text value without ever hitting Object's default stringifier. */
function valueText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  return JSON.stringify(value)
}

/** Join MCP text blocks the way the bridge projects them: text runs with newlines. */
export function mcpText(content: unknown[]): string {
  return content.map((block) => {
    if (typeof block === 'object' && block !== null) {
      const record = block as Record<string, unknown>
      if (record['type'] === 'text' && typeof record['text'] === 'string') return record['text']
      if (record['type'] === 'resource_link') return `${valueText(record['name'])} ${valueText(record['uri'])}`.trim()
    }
    return JSON.stringify(block)
  }).join('\n')
}

/** Chat message part for the vision completions endpoint. */
export type VisionPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'video_url'; video_url: { url: string } }

/**
 * Call the vision chat-completions endpoint exactly as `@z_ai/mcp-server`
 * does (model, thinking block, sampling), returning the message text.
 */
export async function visionChat(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  media: VisionPart[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  const onAbort = (): void => { controller.abort() }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(VISION_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'dsh-tool-zai',
        'Accept-Language': 'en-US,en',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: [{ type: 'text', text: userPrompt }, ...media] },
        ],
        thinking: { type: 'enabled' },
        stream: false,
        temperature: 0.8,
        top_p: 0.6,
        max_tokens: 131072,
      }),
      signal: controller.signal,
    })
    const body = await response.text()
    if (!response.ok) throw new ZaiMcpError(response.status, body.slice(0, 500))
    const parsed = JSON.parse(body) as { choices?: Array<{ message?: { content?: string } }> }
    const text = parsed.choices?.[0]?.message?.content
    if (!text) throw new ZaiMcpError('E_SHAPE', 'vision response carried no message content')
    return text
  } catch (error) {
    if (error instanceof ZaiMcpError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ZaiMcpError('E_TIMEOUT', signal.aborted ? 'vision request aborted' : `vision request timed out after ${timeoutMs}ms`)
    }
    throw new ZaiMcpError('E_NETWORK', error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v'])

function isHttpUrl(source: string): boolean {
  try {
    const url = new URL(source)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Mirror `@z_ai/mcp-server` file handling: URLs pass through, local files become data URLs. */
export function encodeImageSource(imageSource: string, maxSizeMB = 5): string {
  if (isHttpUrl(imageSource)) return imageSource
  if (!existsSync(imageSource)) throw new Error(`Image file not found: ${imageSource}`)
  const sizeMB = statSync(imageSource).size / (1024 * 1024)
  if (sizeMB > maxSizeMB) throw new Error(`Image file too large: ${sizeMB.toFixed(2)}MB. Maximum allowed: ${maxSizeMB}MB`)
  const ext = extname(imageSource).toLowerCase()
  if (!IMAGE_EXTS.has(ext)) throw new Error(`Unsupported image format: ${ext}. Supported formats: .jpg, .jpeg, .png`)
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg'
  return `data:${mime};base64,${readFileSync(imageSource).toString('base64')}`
}

/** Mirror `@z_ai/mcp-server` video handling: URLs pass through, local files become data URLs. */
export function encodeVideoSource(videoSource: string, maxSizeMB = 8): string {
  if (isHttpUrl(videoSource)) return videoSource
  if (!existsSync(videoSource)) throw new Error(`Video file not found: ${videoSource}`)
  const sizeMB = statSync(videoSource).size / (1024 * 1024)
  if (sizeMB > maxSizeMB) throw new Error(`Video file size (${sizeMB.toFixed(2)}MB) exceeds maximum allowed size (${maxSizeMB}MB)`)
  const ext = extname(videoSource).toLowerCase()
  if (!VIDEO_EXTS.has(ext)) throw new Error(`Unsupported video format: ${ext}. Supported formats: .mp4, .mov, .m4v`)
  return `data:video/mp4;base64,${readFileSync(videoSource).toString('base64')}`
}
