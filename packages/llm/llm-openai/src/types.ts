/**
 * OpenAI chat-completions wire format (also the de-facto standard for local
 * OpenAI-compatible "installations": LM Studio, vLLM, llama.cpp, Ollama's
 * `/v1` bridge). Types only.
 *
 * Source of truth: platform.openai.com/docs/api-reference/chat, cross-checked
 * against the OpenAI-compatible surface of common local servers (2026-08).
 *
 * @module dsh-llm-openai/types
 */

/** Request body for `POST {baseURL}/chat/completions`. */
export interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: true
  stream_options: { include_usage: true }
  /**
   * Reasoning effort for o-series / gpt-5 class models. Harness effort
   * vocabulary maps off→omitted, low→low, high→high, max→high (OpenAI has no
   * "max" level). Non-reasoning models ignore the field.
   */
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high'
  tools?: WireTool[]
  temperature?: number
  /** Output cap for classic models (gpt-4o class). */
  max_tokens?: number
  /** Output cap for reasoning models (o-series / gpt-5), which reject `max_tokens`. */
  max_completion_tokens?: number
  /** Stop sequences; generation halts at the first occurrence. */
  stop?: string[]
}

/** System-role message: a single string of instructions. */
export interface WireSystemMessage {
  role: 'system'
  content: string
}

/** User-role message: a single string of user input. */
export interface WireUserMessage {
  role: 'user'
  content: string
}

/** Tool-role message: the result of one tool call, keyed by its call id. */
export interface WireToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

/**
 * Assistant-role history message. Text-less turns send `""` — NEVER null:
 * official samples replay `content` verbatim and some gateways reject null.
 * No reasoning passback is sent: OpenAI history carries visible text and tool
 * calls only (unlike DeepSeek's `reasoning_content` requirement).
 */
export interface WireAssistantMessage {
  role: 'assistant'
  content: string
  tool_calls?: WireToolCall[]
}

/** One entry of the request `messages` array, discriminated on `role`. */
export type WireMessage =
  | WireSystemMessage
  | WireUserMessage
  | WireAssistantMessage
  | WireToolMessage

/** A completed tool call replayed on an assistant history message; `arguments` is the raw JSON string. */
export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** One entry of the request `tools` array; `parameters` is a JSON Schema object. */
export interface WireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** One parsed SSE `data:` payload (a chat.completion.chunk). */
export interface WireChunk {
  choices?: WireChoice[]
  /** Arrives attached to the finish chunk and/or as a trailing usage-only chunk. */
  usage?: WireUsage | null
}

/** One streamed choice (requests always ask for a single one); `finish_reason` is non-null only on its terminal chunk. */
export interface WireChoice {
  delta?: WireDelta
  finish_reason?: string | null
}

/** The incremental content of one streamed choice; any subset of fields may be present per chunk. */
export interface WireDelta {
  role?: string
  /** Visible text. Null/empty on reasoning/tool-call chunks. */
  content?: string | null
  /**
   * CoT streamed by reasoning-capable OpenAI-compatible local servers (never
   * by the official API). The FIRST chunk often carries an empty string
   * (must not open a reasoning block).
   */
  reasoning_content?: string | null
  tool_calls?: WireToolCallDelta[]
}

/** A streamed fragment of one tool call; fragments sharing an `index` concatenate into one call. */
export interface WireToolCallDelta {
  /** Disambiguates parallel tool calls; stable across a call's deltas. */
  index: number
  /** Present on the first delta of each call only. */
  id?: string
  type?: 'function'
  function?: {
    /** Present on the first delta of each call only. */
    name?: string
    /** Argument JSON fragment (concatenate across deltas). */
    arguments?: string
  }
}

/**
 * Wire token accounting (OpenAI native shape). `prompt_tokens` INCLUDES cache
 * reads; `mapUsage` subtracts `prompt_tokens_details.cached_tokens` to keep
 * the harness convention of disjoint counts.
 */
export interface WireUsage {
  prompt_tokens: number
  completion_tokens: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** Non-2xx error body. */
export interface WireError {
  error?: { message?: string; type?: string; code?: string; param?: string }
}
