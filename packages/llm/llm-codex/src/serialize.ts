/**
 * Serialize harness messages into Codex Responses input items. User text
 * becomes `message` items, assistant text `output_text` parts, assistant tool
 * calls `function_call` items, and tool results `function_call_output` items.
 * Reasoning effort maps the harness off/low/high/max vocabulary onto the
 * Codex wire levels (OpenAI has no "max"; `max` maps to `high`). Core image
 * blocks are resolved from the Harness attachment store as Responses
 * `input_image` content, keeping a selected Codex model usable after an
 * image-bearing turn.
 *
 * @module dsh-llm-codex/serialize
 */

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { WireContentPart, WireInputItem, WireRequest, WireTool } from './types.ts'

/** Adapter-level request defaults (from plugin config). */
export interface RequestDefaults {
  reasoningEffort?: 'off' | 'low' | 'high' | 'max' | undefined
}

/**
 * Map the harness effort vocabulary onto the Codex wire levels. `off` and
 * `undefined` both put nothing on the wire; the Codex backend's levels are
 * low/medium/high/xhigh, so the harness `low`→`low`, `high`→`high`, and
 * `max`→`xhigh` (the backend's maximum).
 * @param effort - the harness effort, or undefined to apply the default.
 * @returns the wire effort, or undefined when no field should be sent.
 */
export function reasoningEffortWire(
  effort: GenerateOptions['reasoningEffort'] | 'off' | 'low' | 'high' | 'max' | undefined,
): 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  switch (effort) {
    case undefined:
    case 'off':
      return undefined
    case 'low':
      return 'low'
    case 'high':
      return 'high'
    case 'max':
      return 'xhigh'
    default:
      throw new LlmError(`OpenAI Codex does not support reasoning effort "${effort}"`, 'UNSUPPORTED_REASONING_EFFORT')
  }
}

/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks: ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Reject images only when no durable attachment reader was supplied. */
function requireAttachments(blocks: readonly ContentBlock[], attachments: AttachmentStore | undefined): void {
  if (contentHasImage(blocks)) {
    if (attachments !== undefined) return
    throw new LlmError('OpenAI Codex image input requires the Harness attachment service.', 'UNSUPPORTED_CONTENT')
  }
}

/** Resolve text and image blocks into the Responses user-content vocabulary. */
async function userContent(
  blocks: readonly ContentBlock[],
  attachments: AttachmentStore,
  includeText = true,
): Promise<WireContentPart[]> {
  const content: WireContentPart[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (includeText && block.text.length > 0) content.push({ type: 'input_text', text: block.text })
      continue
    }
    if (block.type === 'image') {
      const stored = await attachments.readImage(block.attachment)
      content.push({
        type: 'input_image',
        image_url: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`,
      })
    }
  }
  return content
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `function_call_output` items; the harness puts each tool result in its own
 * user-role message, so a mixed user message contributes its text first and
 * its tool results as separate items after.
 * @param messages - the harness conversation, in order.
 * @returns the Responses input items; order preserved.
 */
export async function serializeInput(
  messages: Message[],
  attachments?: AttachmentStore,
): Promise<WireInputItem[]> {
  const items: WireInputItem[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      // The Responses `instructions` field is text-only; never discard an
      // in-history system image merely because it cannot be represented.
      requireAttachments(message.content, undefined)
      continue
    }
    if (message.role === 'assistant') {
      requireAttachments(message.content, undefined)
      const text = flattenText(message.content)
      const toolCalls = message.content.filter(block => block.type === 'tool-call')
      // A tool-call-only turn sends no message item; visible text becomes one.
      if (text.length > 0) {
        items.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        })
      }
      for (const call of toolCalls) {
        items.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        })
      }
      continue
    }
    // user role: tool results ride in user messages in the harness
    // vocabulary, but the Responses API wants function_call_output items.
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    requireAttachments(message.content, attachments)
    const directText = flattenText(message.content)
    const direct = attachments === undefined
      ? directText.length === 0 ? [] : [{ type: 'input_text', text: directText } satisfies WireContentPart]
      : await userContent(message.content, attachments)
    if (direct.length > 0 || toolResults.length === 0) {
      items.push({
        type: 'message',
        role: 'user',
        content: direct.length === 0 ? [{ type: 'input_text', text: '' }] : direct,
      })
    }
    for (const result of toolResults) {
      requireAttachments(result.content, attachments)
      items.push({
        type: 'function_call_output',
        call_id: result.toolCallId,
        // Empty tool output still needs SOME content on the wire.
        output: flattenText(result.content) || '(no output)',
      })
      // Function output is text-only on this wire. Preserve any image produced
      // by a tool as the immediately following user image turn instead of
      // silently dropping it from history.
      if (attachments !== undefined) {
        const images = await userContent(result.content, attachments, false)
        if (images.length > 0) items.push({ type: 'message', role: 'user', content: images })
      }
    }
  }
  return items
}

/**
 * Build the full Codex Responses request. Always streaming; optional fields
 * are omitted rather than sent as null, so provider defaults apply.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level reasoning defaults; undefined fields put nothing on the wire.
 * @returns the Responses request body.
 */
export async function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults = {},
  attachments?: AttachmentStore,
): Promise<WireRequest> {
  const effort = options.purpose === 'session-title'
    ? undefined
    : options.reasoningEffort === undefined
      ? defaults.reasoningEffort
      : options.reasoningEffort
  const wireEffort = reasoningEffortWire(effort)

  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }))

  return {
    model: options.model,
    ...options.system === undefined ? {} : { instructions: options.system },
    input: await serializeInput(options.messages, attachments),
    stream: true,
    store: false,
    ...wireEffort === undefined
      ? {}
      : { reasoning: { effort: wireEffort, summary: 'auto' } },
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
  }
}
