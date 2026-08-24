/**
 * Translate between the Harness LLM vocabulary and the Google Antigravity wire
 * format.
 *
 * Antigravity speaks a Gemini-style API: requests carry `contents[]` with
 * `parts[]` and responses stream cumulative snapshots over SSE. The
 * non-obvious requirements handled here:
 *
 *  1. **Schema cleaning** — Antigravity rejects JSON-Schema features Claude
 *     tool schemas often carry (`const`, `$ref`, `$defs`, `default`, …).
 *  2. **Tool-name sanitization** — `[a-zA-Z0-9_.:-]`, first char a letter or
 *     underscore, max 64 chars.
 *  3. **Cumulative snapshot deltas** — each SSE `data:` line re-sends the full
 *     accumulated `parts[]`; this module buffers the last snapshot and emits
 *     only the growth as {@link StreamChunk}s.
 *
 * @module @deepseek-ai/dsh-llm-antigravity/translate
 */

import { CallId, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, TokenUsage, ContentBlock, Message } from '@deepseek-ai/dsh-llm'

/* ── Wire types ─────────────────────────────────────────────────────────── */

/** One Gemini-style content turn inside `contents[]`. */
export interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

/** One Gemini-style part. */
export type GeminiPart =
  | { text: string }
  | { thought?: boolean; thoughtSignature?: string; text?: string }
  | { functionCall: { name: string; args: Record<string, unknown>; id?: string }; thoughtSignature?: string }
  | { functionResponse: { name: string; id?: string; response: unknown } }

/**
 * Sentinel the gateway accepts in place of a real thought signature on a
 * replayed function call (the reference plugin's documented escape hatch —
 * harness history does not retain provider signatures).
 */
export const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator'

/** One Antigravity tool declaration. */
export interface AntigravityFunctionDeclaration {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** The complete Antigravity `generateContent` body. */
export interface AntigravityRequestBody {
  project: string
  model: string
  request: {
    contents: GeminiContent[]
    systemInstruction?: { parts: { text: string }[] }
    generationConfig?: {
      maxOutputTokens?: number
      temperature?: number
      thinkingConfig?: { thinkingBudget?: number; includeThoughts?: boolean }
    }
    tools?: { functionDeclarations: AntigravityFunctionDeclaration[] }[]
  }
  userAgent: string
  requestId: string
}

/** One parsed Antigravity SSE snapshot. */
export interface AntigravitySseEvent {
  response?: {
    candidates?: {
      content?: { role?: string; parts?: GeminiPart[] }
      finishReason?: string
    }[]
    usageMetadata?: {
      promptTokenCount?: number
      candidatesTokenCount?: number
      thoughtsTokenCount?: number
      cachedContentTokenCount?: number
      totalTokenCount?: number
    }
    modelVersion?: string
    responseId?: string
  }
  traceId?: string
}

/* ── Tool-name sanitization ─────────────────────────────────────────────── */

/**
 * Antigravity validates function names: first char a letter or underscore,
 * then letters/digits/underscore/dash/dot/colon, max 64 chars. Anything else
 * is replaced with an underscore and prefixed when needed.
 */
export function sanitizeToolName(name: string): string {
  let cleaned = name.replace(/[^a-zA-Z0-9_.:-]/g, '_')
  if (!/^[a-zA-Z_]/.test(cleaned)) cleaned = `_${cleaned}`
  return cleaned.slice(0, 64)
}

/* ── JSON Schema cleaning ───────────────────────────────────────────────── */

const SCHEMA_KEEP: readonly string[] = [
  'type', 'properties', 'required', 'description', 'enum', 'items',
]

/**
 * Return an Antigravity-safe JSON Schema: keep the allowlist, convert `const`
 * to `enum`, and recurse into `properties`/`items`.
 */
export function cleanSchema(schema: unknown): Record<string, unknown> | undefined {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return undefined
  const source = schema as Record<string, unknown>
  const cleaned: Record<string, unknown> = {}
  if ('const' in source) {
    cleaned.enum = [source.const]
  }
  for (const key of SCHEMA_KEEP) {
    if (!(key in source)) continue
    const value = source[key]
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      const props: Record<string, unknown> = {}
      for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
        props[name] = cleanSchema(sub) ?? {}
      }
      cleaned.properties = props
    } else if (key === 'items') {
      cleaned.items = cleanSchema(value) ?? {}
    } else if (key === 'type') {
      cleaned.type = typeof value === 'string' ? value.toLowerCase() : value
    } else {
      cleaned[key] = value
    }
  }
  if (cleaned.type === 'object'
    && (cleaned.properties === undefined || Object.keys(cleaned.properties as Record<string, unknown>).length === 0)) {
    cleaned.properties = { _placeholder: { type: 'boolean', description: 'Placeholder. Always pass true.' } }
  }
  return cleaned
}

/* ── Request translation ────────────────────────────────────────────────── */

/** Parse a tool-call arguments JSON string, tolerating malformed input. */
export function safeParseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return { _raw: raw }
  }
}

/** Translate one Harness message into a Gemini content turn. */
export function translateMessage(
  message: Message,
  callNameById?: ReadonlyMap<string, string>,
): GeminiContent | null {
  if (message.role === 'system') return null
  const parts: GeminiPart[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        parts.push({ text: block.text })
        break
      case 'reasoning':
        // Reasoning is model-side only; Antigravity regenerates thinking.
        break
      case 'tool-call': {
        // The gateway validates replayed function calls for a thought
        // signature (verified live: HTTP 400 "Function call is missing a
        // thought_signature"). Harness history carries no signatures, so the
        // FIRST functionCall part of each replayed block carries the reference
        // plugin's sentinel; later (parallel) calls must NOT.
        const call: GeminiPart = {
          functionCall: {
            name: sanitizeToolName(block.name),
            args: safeParseArgs(block.arguments),
            ...block.id === '' ? {} : { id: block.id },
          },
        }
        const seenCall = parts.some(part => 'functionCall' in part)
        parts.push(seenCall ? call : { ...call, thoughtSignature: SKIP_THOUGHT_SIGNATURE })
        break
      }
      case 'tool-result': {
        const text = block.content
          .filter((part): part is Extract<ContentBlock, { type: 'text' }> => part.type === 'text')
          .map(part => part.text)
          .join('\n')
        const toolName = (callNameById?.get(block.toolCallId) ?? '') || 'tool'
        parts.push({
          functionResponse: {
            name: sanitizeToolName(toolName),
            ...block.toolCallId === '' ? {} : { id: block.toolCallId },
            response: { content: text, ...block.isError === undefined ? {} : { isError: block.isError } },
          },
        })
        break
      }
      case 'image':
        // Text-only declaration; images are not translated in this adapter.
        break
    }
  }
  if (parts.length === 0) return null
  return { role: message.role === 'assistant' ? 'model' : 'user', parts }
}

/**
 * Map a harness model id + reasoning effort onto the Antigravity wire model id.
 *
 * Verified against the live gateway: Gemini 3.x **Pro** models REQUIRE a
 * thinking-tier suffix (`gemini-3.1-pro-low/high`) — the bare id is rejected —
 * while Flash and Claude models use their bare names (the tier rides in
 * generationConfig for those). The opencode-style `antigravity-` quota prefix
 * is stripped: it is a selector, never a wire id.
 * @param modelId - the harness model id from GenerateOptions.
 * @param effort - the requested reasoning effort, when one was selected.
 * @returns the exact wire model string for the request body.
 */
export function wireModelOf(modelId: string, effort?: string): string {
  const stripped = modelId.replace(/^antigravity-/i, '')
  const isPro = /^gemini-3(\.\d+)?-pro/i.test(stripped)
  const hasTier = /-(low|medium|high)$/i.test(stripped)
  if (!isPro || hasTier) return stripped
  const tier = effort === 'high' ? 'high' : 'low'
  return `${stripped}-${tier}`
}

/** Translate the full assembled request into an Antigravity body. */
export function translateRequest(
  options: GenerateOptions,
  projectId: string,
  requestId: string,
  modelId: string,
): AntigravityRequestBody {
  const callNameById = new Map<string, string>()
  for (const message of options.messages) {
    for (const block of message.content) {
      if (block.type === 'tool-call') {
        callNameById.set(block.id, block.name)
      }
    }
  }
  const contents: GeminiContent[] = []
  for (const message of options.messages) {
    const translated = translateMessage(message, callNameById)
    if (translated !== null) contents.push(translated)
  }
  const body: AntigravityRequestBody = {
    project: projectId,
    model: wireModelOf(modelId, options.reasoningEffort),
    request: { contents },
    userAgent: 'antigravity',
    requestId: `agent-${requestId}`,
  }
  if (options.system !== undefined && options.system !== '') {
    body.request.systemInstruction = { parts: [{ text: options.system }] }
  }
  if (options.maxTokens !== undefined || options.temperature !== undefined || options.reasoningEffort !== undefined) {
    const generationConfig: NonNullable<AntigravityRequestBody['request']['generationConfig']> = {}
    if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens
    if (options.temperature !== undefined) generationConfig.temperature = options.temperature
    if (options.reasoningEffort !== undefined) {
      const budget = options.reasoningEffort === 'fast'
        ? 0
        : options.reasoningEffort === 'low'
          ? 4096
          : options.reasoningEffort === 'medium'
            ? 8192
            : options.reasoningEffort === 'high'
              ? 16384
              : 32768
      generationConfig.thinkingConfig = { thinkingBudget: budget, includeThoughts: true }
    }
    body.request.generationConfig = generationConfig
  }
  if (options.tools !== undefined && options.tools.length > 0) {
    const declarations: AntigravityFunctionDeclaration[] = options.tools.map(tool => {
      const declaration: AntigravityFunctionDeclaration = {
        name: sanitizeToolName(tool.name),
        description: tool.description ?? '',
        parameters: cleanSchema(tool.parameters) ?? { type: 'object' },
      }
      return declaration
    })
    body.request.tools = [{ functionDeclarations: declarations }]
  }
  return body
}

/* ── SSE parsing + cumulative snapshot deltas ───────────────────────────── */

/** Tracked state of one streamed part (cumulative snapshot dedupe buffer). */
interface PartState {
  text: string
  reasoning: string
  toolName: string | undefined
  toolArgs: string
  toolId: string | undefined
}

/** Running snapshot state across SSE events. */
export interface SnapshotState {
  parts: PartState[]
}

export function initialSnapshotState(): SnapshotState {
  return { parts: [] }
}

function renderPartText(part: GeminiPart): string {
  if ('text' in part && typeof part.text === 'string') return part.text
  return ''
}

/**
 * Compare one cumulative parts array to the snapshot state and emit the
 * growth as stream chunks. Function calls arrive complete in one snapshot.
 * @param parts - the cumulative parts from this SSE event.
 * @param state - the running snapshot state (mutated).
 * @param baseIndex - the block index stamped on emitted chunks.
 */
export function translateSnapshot(
  parts: GeminiPart[] | undefined,
  state: SnapshotState,
  baseIndex: number,
): StreamChunk[] {
  const chunks: StreamChunk[] = []
  if (!Array.isArray(parts)) return chunks
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!
    const known = state.parts[index]
    if (known === undefined) {
      if ('functionCall' in part && part.functionCall) {
        const call = part.functionCall
        const id = CallId(call.id ?? `antigravity-call-${index}`)
        const args = JSON.stringify(call.args ?? {})
        const next: PartState = { text: '', reasoning: '', toolName: call.name, toolArgs: args, toolId: call.id }
        state.parts[index] = next
        chunks.push({ type: 'block-start', index: baseIndex, blockType: 'tool-call' })
        chunks.push({ type: 'tool-call-delta', index: baseIndex, id, name: call.name, argumentsDelta: args })
        chunks.push({
          type: 'block-end', index: baseIndex,
          block: { type: 'tool-call', id, name: call.name, arguments: args },
        })
        continue
      }
      const text = renderPartText(part)
      const next: PartState = { text: '', reasoning: '', toolName: undefined, toolArgs: '', toolId: undefined }
      state.parts[index] = next
      if ('thought' in part && (part.thought === true || part.thoughtSignature !== undefined)) {
        next.reasoning = text
        if (text !== '') chunks.push({ type: 'reasoning-delta', index: baseIndex, text })
      } else if (text !== '') {
        next.text = text
        chunks.push({ type: 'text-delta', index: baseIndex, text })
      }
      continue
    }
    const text = renderPartText(part)
    if (text.length > known.text.length && known.toolName === undefined) {
      const delta = text.slice(known.text.length)
      known.text = text
      if ('thought' in part && part.thought === true) {
        chunks.push({ type: 'reasoning-delta', index: baseIndex, text: delta })
      } else {
        chunks.push({ type: 'text-delta', index: baseIndex, text: delta })
      }
    }
  }
  return chunks
}

/** Translate an SSE event's usageMetadata into a usage chunk. */
export function translateUsage(event: AntigravitySseEvent): StreamChunk | undefined {
  const metadata = event.response?.usageMetadata
  if (metadata === undefined) return undefined
  const cached = metadata.cachedContentTokenCount ?? 0
  const prompt = metadata.promptTokenCount ?? 0
  return {
    type: 'usage',
    usage: {
      inputTokens: Math.max(0, prompt - cached),
      outputTokens: metadata.candidatesTokenCount ?? 0,
      ...cached > 0 ? { cacheReadTokens: cached } : {},
      ...metadata.thoughtsTokenCount === undefined ? {} : { reasoningTokens: metadata.thoughtsTokenCount },
    } satisfies TokenUsage,
  }
}

/** Map a Gemini finishReason onto a harness finish reason. */
export function mapFinishReason(reason: string, hasToolCall: boolean): StreamChunk {
  if (reason === 'STOP' || reason === 'stop') {
    return { type: 'finish', reason: hasToolCall ? { kind: 'tool-calls' } : { kind: 'stop' } }
  }
  if (reason === 'MAX_TOKENS' || reason === 'max_tokens') {
    return { type: 'finish', reason: { kind: 'max-tokens' } }
  }
  // SAFETY, RECITATION, BLOCKLIST, PROHIBITED_CONTENT, OTHER, … are failures.
  return {
    type: 'finish',
    reason: { kind: 'error', failure: { message: `Antigravity stopped with finishReason ${reason}`, code: 'RESPONSE_FAILED' } },
  }
}

/** Map a non-2xx HTTP status onto an {@link LlmError} with Antigravity semantics. */
export function mapHttpError(status: number, detail: string, retryAfterMs?: number): LlmError {
  const code = status === 401 || status === 403 ? 'AUTH'
    : status === 429 ? 'RATE_LIMITED'
      : status === 404 ? 'MODEL_NOT_FOUND'
        : status >= 500 ? 'SERVER' : 'PROVIDER_ERROR'
  return new LlmError(detail, code, {
    status,
    ...retryAfterMs === undefined || !Number.isFinite(retryAfterMs) ? {} : { providerRetryAfterMs: retryAfterMs },
  })
}

/** Extract the provider `Retry-After` header (seconds) when present. */
export function retryAfterSeconds(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}

/** Parse a Google `RetryInfo.retryDelay` ("3.95s") from error details. */
export function retryDelayMs(details: readonly unknown[] | undefined): number | undefined {
  if (!Array.isArray(details)) return undefined
  for (const entry of details) {
    const record = entry as { '@type'?: unknown; retryDelay?: unknown }
    if (record['@type'] === 'type.googleapis.com/google.rpc.RetryInfo' && typeof record.retryDelay === 'string') {
      const seconds = Number.parseFloat(record.retryDelay.replace(/s$/, ''))
      if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
    }
  }
  return undefined
}
