/**
 * Serialize harness messages into OpenAI chat completions (the same protocol
 * served by local OpenAI-compatible installations). User text is joined;
 * assistant text becomes `content`, tool calls become `tool_calls`, and tool
 * results become separate tool messages. Reasoning effort preserves the
 * model-declared OpenAI values; legacy `off` omits the field and `max` maps to
 * `high`, except under a provider dialect whose documented labels go out
 * verbatim. Output capping uses `max_completion_tokens` for o-series/gpt-5
 * (which reject `max_tokens`) and `max_tokens` for everything else, keeping
 * both the official API and local servers happy. Core image blocks are
 * rejected explicitly because this wire route is text-only; unknown
 * declaration-merged block types retain the adapter's documented extension
 * fallback.
 *
 * @module dsh-llm-openai/serialize
 */

import { LlmError, projectImagesForTextModel } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { WireMessage, WireRequest, WireTool } from './types.ts'

/** Adapter-level request defaults (from plugin config). */
export interface RequestDefaults {
  reasoningEffort?: 'off' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined
  /**
   * The provider's documented effort vocabulary, when it is not OpenAI's own.
   * Both dialects send their labels verbatim (including `max`), but they
   * disagree on `off`: OpenRouter spells it `none`, while OpenGateway uses it
   * for the provider default and sends no field.
   */
  reasoningDialect?: 'openrouter' | 'gateway'
}

/** Reasoning-model classes that require `max_completion_tokens`. */
const REASONING_MODEL = /^(o\d|gpt-5)/i

/**
 * Effort labels the documented provider dialects accept verbatim, in the order
 * OpenGateway and OpenRouter publish them. A dialect provider's own
 * configuration vocabulary derives from this list, so a configured level can
 * never reach a wire that would reject it.
 */
export const VERBATIM_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** One effort label a verbatim dialect accepts. */
export type VerbatimReasoningEffort = typeof VERBATIM_REASONING_EFFORTS[number]

/**
 * Validate one route's verbatim effort ladder. An empty ladder is the explicit
 * opt-out that hides a route's effort control; a repeated or undocumented
 * label is a configuration error, because the provider would receive a value
 * it does not define.
 * @param efforts - the configured ladder, or undefined for the route default.
 * @param fallback - the route default used when `efforts` is undefined.
 * @param owner - package name prefixed to a validation error.
 * @returns the detached, validated ladder.
 * @throws when a label is undocumented or repeats.
 */
export function resolveVerbatimReasoningEfforts(
  efforts: readonly VerbatimReasoningEffort[] | undefined,
  fallback: readonly VerbatimReasoningEffort[],
  owner: string,
): VerbatimReasoningEffort[] {
  const levels = efforts ?? fallback
  const seen = new Set<VerbatimReasoningEffort>()
  for (const level of levels) {
    if (!VERBATIM_REASONING_EFFORTS.includes(level)) {
      throw new Error(`${owner}: unknown reasoning effort ${JSON.stringify(level)}`)
    }
    if (seen.has(level)) throw new Error(`${owner}: reasoningEfforts repeats ${JSON.stringify(level)}`)
    seen.add(level)
  }
  return [...levels]
}

/**
 * Map the harness effort vocabulary onto the OpenAI wire levels. `off` and
 * `undefined` both put nothing on the wire (provider default); OpenAI has no
 * "max" level, so the harness `max` maps to the highest wire level `high`.
 * The `openrouter` and `gateway` dialects send the labels the caller's
 * catalog advertises verbatim.
 * @param effort - the harness effort, or undefined to apply the default.
 * @param dialect - the wire vocabulary the provider documents, when it is not OpenAI's own.
 * @returns the wire effort, or undefined when no field should be sent.
 * @throws LlmError when a verbatim dialect receives a label it does not document.
 */
export function reasoningEffortWire(
  effort: GenerateOptions['reasoningEffort'] | 'off' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined,
  dialect?: 'openrouter' | 'gateway',
): 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  if (dialect !== undefined) {
    if (effort === undefined) return undefined
    if (effort === 'off') return dialect === 'openrouter' ? 'none' : undefined
    if (VERBATIM_REASONING_EFFORTS.includes(effort as typeof VERBATIM_REASONING_EFFORTS[number])) {
      return effort as typeof VERBATIM_REASONING_EFFORTS[number]
    }
    throw new LlmError(
      `${dialect === 'openrouter' ? 'OpenRouter' : 'OpenGateway'} does not support reasoning effort "${effort}"`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  switch (effort) {
    case undefined:
    case 'off':
      return undefined
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'high':
      return 'high'
    case 'none':
    case 'minimal':
    case 'xhigh':
      return String(effort) as 'none' | 'minimal' | 'xhigh'
    case 'max':
      return 'high'
    default:
      throw new LlmError(`OpenAI does not support reasoning effort "${effort}"`, 'UNSUPPORTED_REASONING_EFFORT')
  }
}

/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Serialize one assistant message (text + tool calls). */
function serializeAssistant(message: Message): WireMessage {
  const text = flattenText(message.content)
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))

  return {
    role: 'assistant',
    // Text-less turns send "" — NEVER null. Pure tool-call turns replay
    // content verbatim (which is "") per the official samples, and some
    // gateways reject null outright.
    content: text,
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages; the harness puts each tool result in its own
 * user-role message, so a mixed user message contributes its text first and
 * its tool results as separate wire messages after.
 * @param messages - the harness conversation, in order.
 * @returns the wire messages; order preserved, each tool result expanded into its own entry.
 */
export function serializeMessages(messages: readonly RequestMessage[]): WireMessage[] {
  const wire: WireMessage[] = []
  // This adapter cannot carry image content, so images become deterministic
  // placeholder text before anything is serialized.
  for (const message of projectImagesForTextModel(messages)) {
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    // A tool result is its own message now, carrying the call id.
    if (message.role === 'tool') {
      wire.push({
        role: 'tool',
        tool_call_id: message.toolCallId,
        // Empty tool output still needs SOME content on the wire.
        content: flattenText(message.content) || '(no output)',
      })
      continue
    }
    wire.push({ role: 'user', content: flattenText(message.content) })
  }
  return wire
}

/**
 * Build the full wire request. Always streaming (`stream: true`, usage
 * reporting on); optional fields are omitted rather than sent as null, so
 * provider defaults apply.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level reasoning defaults; undefined fields put nothing on the wire.
 * @returns the chat-completions request body.
 */
export function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults = {},
): WireRequest {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...serializeMessages(options.messages))

  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
  // A short title budget must produce visible text without spending the
  // reasoning budget; conversation and compaction calls keep the configured
  // effort default.
  const effort = options.purpose === 'session-title'
    ? undefined
    : options.reasoningEffort === undefined
      ? defaults.reasoningEffort
      : options.reasoningEffort
  const wireEffort = reasoningEffortWire(effort, defaults.reasoningDialect)

  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...wireEffort === undefined ? {} : { reasoning_effort: wireEffort },
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined
      ? {}
      : REASONING_MODEL.test(options.model)
        ? { max_completion_tokens: options.maxTokens }
        : { max_tokens: options.maxTokens },
    ...options.stop !== undefined ? { stop: options.stop } : {},
  }
}
