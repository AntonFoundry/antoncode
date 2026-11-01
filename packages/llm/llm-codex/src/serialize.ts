/**
 * Serialize harness messages into Codex Responses input items. User text
 * becomes `message` items, assistant text `output_text` parts, assistant tool
 * calls `function_call` items, and tool results `function_call_output` items.
 * Reasoning effort maps the harness's model-declared Codex levels onto the
 * Responses wire values; `off` omits the effort field. Core image
 * blocks are resolved from the Harness attachment store as Responses
 * `input_image` content, keeping a selected Codex model usable after an
 * image-bearing turn.
 *
 * @module dsh-llm-codex/serialize
 */

import { contentHasImage, LlmError, textOnlyImageText } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { WireContentPart, WireInputItem, WireRequest, WireTool } from './types.ts'

/** Adapter-level request defaults (from plugin config). */
export interface RequestDefaults {
  reasoningEffort?: 'off' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | undefined
}

/**
 * Preserve Codex model effort values on the Responses wire. `off` and
 * `undefined` both omit the effort field.
 * @param effort - the harness effort, or undefined to apply the default.
 * @returns the wire effort, or undefined when no field should be sent.
 */
export function reasoningEffortWire(
  effort: GenerateOptions['reasoningEffort'] | 'off' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | undefined,
): 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | undefined {
  switch (effort) {
    case undefined:
    case 'off':
      return undefined
    case 'none':
      return 'none'
    case 'minimal':
      return 'minimal'
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'high':
      return 'high'
    case 'xhigh':
      return 'xhigh'
    case 'max':
      return 'max'
    case 'ultra':
      return 'ultra'
    default:
      throw new LlmError(`OpenAI Codex does not support reasoning effort "${effort}"`, 'UNSUPPORTED_REASONING_EFFORT')
  }
}

/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Swap images for the omitted placeholder when no durable attachment reader can carry them. */
function withoutUnresolvableImages(blocks: readonly ContentBlock[], attachments: AttachmentStore | undefined): ContentBlock[] {
  if (attachments !== undefined || !contentHasImage(blocks)) return [...blocks]
  // The same placeholder the shared text-only projection writes, applied per
  // block because this transport degrades some block lists and not others.
  return blocks.map(block => block.type === 'image'
    ? { type: 'text' as const, text: textOnlyImageText(block.attachment) }
    : block)
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
  messages: readonly RequestMessage[],
  attachments?: AttachmentStore,
): Promise<WireInputItem[]> {
  const items: WireInputItem[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      // The Responses `instructions` field is text-only; an in-history system
      // image cannot be represented and degrades to the omitted placeholder.
      continue
    }
    if (message.role === 'assistant') {
      withoutUnresolvableImages(message.content, undefined)
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
    // A tool result is its own message now, carrying the call id.
    if (message.role === 'tool') {
      const resultBlocks = withoutUnresolvableImages(message.content, attachments)
      items.push({
        type: 'function_call_output',
        call_id: message.toolCallId,
        // Empty tool output still needs SOME content on the wire.
        output: flattenText(resultBlocks) || '(no output)',
      })
      // Function output is text-only on this wire. Preserve any image produced
      // by a tool as the immediately following user image turn instead of
      // silently dropping it from history.
      if (attachments !== undefined) {
        const images = await userContent(resultBlocks, attachments, false)
        if (images.length > 0) items.push({ type: 'message', role: 'user', content: images })
      }
      continue
    }
    const userBlocks = withoutUnresolvableImages(message.content, attachments)
    const directText = flattenText(userBlocks)
    const direct = attachments === undefined
      ? directText.length === 0 ? [] : [{ type: 'input_text', text: directText } satisfies WireContentPart]
      : await userContent(userBlocks, attachments)
    items.push({
      type: 'message',
      role: 'user',
      content: direct.length === 0 ? [{ type: 'input_text', text: '' }] : direct,
    })
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
