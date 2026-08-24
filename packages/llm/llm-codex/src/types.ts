/**
 * OpenAI Codex backend wire format: the Responses protocol served by
 * `https://chatgpt.com/backend-api/codex/responses` for ChatGPT/Codex
 * subscription auth (no API key). Types only.
 *
 * Source of truth: the openai/codex CLI wire shape, cross-checked against
 * OpenCode's `openai-responses-language-model` (2026-08).
 *
 * @module dsh-llm-codex/types
 */

/** Request body for `POST {baseURL}/responses`. */
export interface WireRequest {
  model: string
  /** System prompt. */
  instructions?: string
  /** Conversation items (messages, tool calls, tool outputs). */
  input: WireInputItem[]
  stream: true
  /** The Codex backend REQUIRES the explicit false (its default is true). */
  store: false
  tools?: WireTool[]
  tool_choice?: 'auto' | 'none' | 'required'
  /** Reasoning effort + summary for gpt-5.x-codex class models. */
  reasoning?: { effort?: 'low' | 'medium' | 'high' | 'xhigh'; summary?: 'auto' | 'concise' | 'detailed' | 'none' }
}

/** One entry of the request `input` array. */
export type WireInputItem =
  | WireMessageItem
  | WireFunctionCallItem
  | WireFunctionCallOutputItem

/** A user/assistant message item. */
export interface WireMessageItem {
  type: 'message'
  role: 'user' | 'assistant'
  content: WireContentPart[]
}

/** Text content part. */
export interface WireInputTextPart {
  type: 'input_text'
  text: string
}

/** A durable user image resolved into an inline Responses input image. */
export interface WireInputImagePart {
  type: 'input_image'
  image_url: string
}

/** Assistant visible text part (replayed history). */
export interface WireOutputTextPart {
  type: 'output_text'
  text: string
}

export type WireContentPart = WireInputTextPart | WireInputImagePart | WireOutputTextPart

/** A completed tool call replayed on assistant history. */
export interface WireFunctionCallItem {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string
}

/** The result of one tool call. */
export interface WireFunctionCallOutputItem {
  type: 'function_call_output'
  call_id: string
  output: string
}

/** One entry of the request `tools` array; `parameters` is a JSON Schema object. */
export interface WireTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  strict: boolean
}

/* ── Streamed events (SSE `data:` JSON) ──────────────────────────────────── */

/** `response.created` */
export interface WireResponseCreated {
  type: 'response.created'
  response: { id: string }
}

/** `response.output_item.added` — opens a message or function_call item. */
export interface WireOutputItemAdded {
  type: 'response.output_item.added'
  output_index: number
  item: WireItemSummary
}

export interface WireItemSummary {
  type: 'message' | 'function_call'
  id: string
  role?: 'user' | 'assistant'
  name?: string
}

/** `response.content_part.added` — opens an output_text part. */
export interface WireContentPartAdded {
  type: 'response.content_part.added'
  item_id: string
  part: { type: 'output_text'; text?: string }
}

/** `response.output_text.delta` */
export interface WireOutputTextDelta {
  type: 'response.output_text.delta'
  item_id: string
  delta: string
}

/** `response.output_text.done` — closes the text part. */
export interface WireOutputTextDone {
  type: 'response.output_text.done'
  item_id: string
  text: string
}

/** `response.reasoning_summary_part.added` — opens a reasoning summary part. */
export interface WireReasoningSummaryPartAdded {
  type: 'response.reasoning_summary_part.added'
  item_id: string
  part: { type: 'reasoning_summary'; summary?: unknown[] }
}

/** `response.reasoning_summary_text.delta` */
export interface WireReasoningSummaryTextDelta {
  type: 'response.reasoning_summary_text.delta'
  item_id: string
  delta: string
}

/** `response.function_call_arguments.delta` */
export interface WireFunctionCallArgumentsDelta {
  type: 'response.function_call_arguments.delta'
  output_index: number
  item_id: string
  delta: string
}

/** `response.function_call_arguments.done` */
export interface WireFunctionCallArgumentsDone {
  type: 'response.function_call_arguments.done'
  output_index: number
  item_id: string
  arguments: string
}

/** `response.output_item.done` — closes a message or function_call item. */
export interface WireOutputItemDone {
  type: 'response.output_item.done'
  output_index: number
  item: { type: 'message' | 'function_call'; id: string; name?: string }
}

/** `response.completed` — terminal success. */
export interface WireResponseCompleted {
  type: 'response.completed'
  response: {
    id: string
    status: 'completed' | 'incomplete' | 'failed'
    incomplete_details?: { reason?: string }
    usage?: WireUsage
  }
}

/** `response.failed` — terminal failure. */
export interface WireResponseFailed {
  type: 'response.failed'
  response: {
    id: string
    status: 'failed'
    error?: { code?: string; message?: string }
  }
}

/** Every SSE event type the adapter understands. */
export type WireEvent =
  | WireResponseCreated
  | WireOutputItemAdded
  | WireContentPartAdded
  | WireOutputTextDelta
  | WireOutputTextDone
  | WireReasoningSummaryPartAdded
  | WireReasoningSummaryTextDelta
  | WireFunctionCallArgumentsDelta
  | WireFunctionCallArgumentsDone
  | WireOutputItemDone
  | WireResponseCompleted
  | WireResponseFailed

/** Wire token accounting (Responses API shape). */
export interface WireUsage {
  input_tokens: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens: number
  output_tokens_details?: { reasoning_tokens?: number }
}

/** Non-2xx error body: either `{"error": {...}}` or the backend's `{"detail": "..."}`. */
export interface WireError {
  error?: { message?: string; type?: string; code?: string }
  detail?: string
}
