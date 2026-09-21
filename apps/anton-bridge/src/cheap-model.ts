import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The deployment's cheap-model route, shared by every bridge loop that needs
 * small LLM work (journal triage, consolidation distillation). Primary tier:
 * Kimi For Coding (Anthropic-messages at api.kimi.com/coding, credential
 * KIMI_CODING_API_KEY from the app's credentials store — the route class the
 * harness's own agent rides). When the coding subscription's weekly quota is
 * exhausted, calls fall back to the store's Z.ai key with glm-5.3-flash —
 * the standing cheap tier Phase 7a plans for the Blueant main loop.
 */

const BRIDGE_CREDENTIALS_PATH = join(homedir(), 'Library', 'Application Support', 'Anton', 'dsh', '.credentials.yaml')

/** Read one `NAME: value` line from the bridge credentials file. */
export function readCredential(name: string): string {
  try {
    for (const line of readFileSync(BRIDGE_CREDENTIALS_PATH, 'utf8').split('\n')) {
      if (line.startsWith(`${name}:`)) return line.slice(name.length + 1).trim()
    }
  } catch {
    // Absent credentials file: callers surface a named warning.
  }
  return ''
}

export interface CheapChatRequest {
  system: string
  user: string
  maxTokens: number
  /** Explicit model id; absence picks the tier's default. */
  model?: string
}

/**
 * One cheap-model completion. Returns the concatenated text content.
 * Quota-shaped failures on the Kimi tier (weekly exhaustion, 429, 403)
 * fall through to Z.ai glm-5.3-flash; every other error propagates.
 */
export async function cheapChat(request: CheapChatRequest): Promise<string> {
  const kimiKey = process.env.ANTON_TRIAGE_API_KEY ?? readCredential('KIMI_CODING_API_KEY')
  if (kimiKey !== '') {
    try {
      return await callAnthropicMessages('https://api.kimi.com/coding/v1/messages', kimiKey, request.model ?? process.env.ANTON_TRIAGE_MODEL ?? 'kimi-for-coding-highspeed', request)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Quota exhaustion on the coding subscription is expected weekly; the
      // Z.ai key is the standing fallback tier, not a second provider to
      // configure.
      if (!/usage limit|quota|rate.?limit|429|403/i.test(message)) throw error
      console.warn('[cheap-model] Kimi Coding quota exhausted — falling back to Z.ai glm-5.3-flash')
    }
  }
  const zaiKey = readCredential('ZAI_API_KEY')
  if (zaiKey === '') {
    throw new Error('no usable cheap-model credential (Kimi exhausted, no ZAI_API_KEY)')
  }
  return await callOpenAiCompatible('https://api.z.ai/api/paas/v4/chat/completions', zaiKey, request.model ?? 'glm-5.3-flash', request)
}

async function callAnthropicMessages(url: string, apiKey: string, model: string, request: CheapChatRequest): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`cheap model HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
  const payload = await response.json() as { content?: Array<{ type?: unknown; text?: unknown }> }
  return Array.isArray(payload.content)
    ? payload.content.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text as string).join('')
    : ''
}

async function callOpenAiCompatible(url: string, apiKey: string, model: string, request: CheapChatRequest): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
      temperature: 0,
      max_tokens: request.maxTokens,
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`cheap model HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
  const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }
  return typeof payload.choices?.[0]?.message?.content === 'string' ? payload.choices[0].message.content : ''
}

/**
 * Models wrap JSON in prose or markdown fences despite instructions; take
 * the outermost brace-to-brace span and parse that.
 */
export function extractJson(text: string): string {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return text
  return text.slice(start, end + 1)
}
